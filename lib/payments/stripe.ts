import 'server-only';
import { legacyPaymentsEnabled } from '@/lib/env';
import Stripe from 'stripe';
import { redirect } from 'next/navigation';
import { Team } from '@/lib/db/schema';
import {
  getTeamByStripeCustomerId,
  getUser,
  getCurrentMembership,
  updateTeamSubscription
} from '@/lib/db/queries';

let client: Stripe | undefined;
export function getStripe() {
  if (!legacyPaymentsEnabled()) throw new Error('Legacy payments are disabled');
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('Legacy Stripe configuration is missing');
  return client ??= new Stripe(key, { apiVersion: '2025-04-30.basil' });
}

export async function createCheckoutSession({
  team,
  priceId
}: {
  team: Team | null;
  priceId: string;
}): Promise<never> {
  const user = await getUser();

  if (!team || !user) {
    redirect(`/sign-up?redirect=checkout&priceId=${priceId}`);
  }

  const membership = await getCurrentMembership();
  if (!membership || membership.teamId !== team.id || membership.role !== 'owner') throw new Error('Forbidden');

  const session = await getStripe().checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [
      {
        price: priceId,
        quantity: 1
      }
    ],
    mode: 'subscription',
    metadata: { teamId: String(team.id) },
    success_url: `${process.env.BASE_URL}/api/stripe/checkout?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${process.env.BASE_URL}/pricing`,
    customer: team.stripeCustomerId || undefined,
    client_reference_id: user.id.toString(),
    allow_promotion_codes: true,
    subscription_data: {
      trial_period_days: 14
    }
  });

  redirect(session.url!);
}

export async function createCustomerPortalSession(team: Team) {
  const membership = await getCurrentMembership();
  if (!membership || membership.teamId !== team.id || membership.role !== 'owner') throw new Error('Forbidden');
  if (!team.stripeCustomerId || !team.stripeProductId) {
    redirect('/pricing');
  }

  let configuration: Stripe.BillingPortal.Configuration;
  const configurations = await getStripe().billingPortal.configurations.list();

  if (configurations.data.length > 0) {
    configuration = configurations.data[0];
  } else {
    const product = await getStripe().products.retrieve(team.stripeProductId);
    if (!product.active) {
      throw new Error("Team's product is not active in Stripe");
    }

    const prices = await getStripe().prices.list({
      product: product.id,
      active: true
    });
    if (prices.data.length === 0) {
      throw new Error("No active prices found for the team's product");
    }

    configuration = await getStripe().billingPortal.configurations.create({
      business_profile: {
        headline: 'Manage your subscription'
      },
      features: {
        subscription_update: {
          enabled: true,
          default_allowed_updates: ['price', 'quantity', 'promotion_code'],
          proration_behavior: 'create_prorations',
          products: [
            {
              product: product.id,
              prices: prices.data.map((price) => price.id)
            }
          ]
        },
        subscription_cancel: {
          enabled: true,
          mode: 'at_period_end',
          cancellation_reason: {
            enabled: true,
            options: [
              'too_expensive',
              'missing_features',
              'switched_service',
              'unused',
              'other'
            ]
          }
        },
        payment_method_update: {
          enabled: true
        }
      }
    });
  }

  return getStripe().billingPortal.sessions.create({
    customer: team.stripeCustomerId,
    return_url: `${process.env.BASE_URL}/dashboard`,
    configuration: configuration.id
  });
}

export async function handleSubscriptionChange(
  subscription: Stripe.Subscription
) {
  // Re-fetch authoritative state: duplicate or delayed signed events cannot restore stale rights.
  const current = await getStripe().subscriptions.retrieve(subscription.id, {
    expand: ['items.data.price.product']
  });
  const customerId = typeof current.customer === 'string' ? current.customer : current.customer.id;
  const team = await getTeamByStripeCustomerId(customerId);
  // Initial payment binding requires a persisted local order; browser redirects cannot create it.
  if (!team || team.stripeSubscriptionId !== current.id) throw new Error('Unbound subscription');
  const entitled = current.status === 'active' || current.status === 'trialing';
  const product = current.items.data[0]?.price.product;
  await updateTeamSubscription(team.id, {
    stripeSubscriptionId: current.id,
    stripeProductId: entitled ? (typeof product === 'string' ? product : product?.id ?? null) : null,
    planName: entitled && typeof product === 'object' && !('deleted' in product) ? product.name : null,
    subscriptionStatus: current.status
  });
}

export async function getStripePrices() {
  const prices = await getStripe().prices.list({
    expand: ['data.product'],
    active: true,
    type: 'recurring'
  });

  return prices.data.map((price) => ({
    id: price.id,
    productId:
      typeof price.product === 'string' ? price.product : price.product.id,
    unitAmount: price.unit_amount,
    currency: price.currency,
    interval: price.recurring?.interval,
    trialPeriodDays: price.recurring?.trial_period_days
  }));
}

export async function getStripeProducts() {
  const products = await getStripe().products.list({
    active: true,
    expand: ['data.default_price']
  });

  return products.data.map((product) => ({
    id: product.id,
    name: product.name,
    description: product.description,
    defaultPriceId:
      typeof product.default_price === 'string'
        ? product.default_price
        : product.default_price?.id
  }));
}
