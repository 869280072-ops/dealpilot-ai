import { legacyPaymentsEnabled } from '@/lib/env';
import Stripe from 'stripe';
import { handleSubscriptionChange, getStripe } from '@/lib/payments/stripe';
import { NextRequest, NextResponse } from 'next/server';

const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!;

export async function POST(request: NextRequest) {
  if (!legacyPaymentsEnabled() || !webhookSecret) return NextResponse.json({ error: 'Payments unavailable' }, { status: 503 });
  const payload = await request.text();
  const signature = request.headers.get('stripe-signature') as string;

  let event: Stripe.Event;

  try {
    event = getStripe().webhooks.constructEvent(payload, signature, webhookSecret);
  } catch {
    console.error('Webhook signature verification failed');
    return NextResponse.json(
      { error: 'Webhook signature verification failed.' },
      { status: 400 }
    );
  }

  try {
  switch (event.type) {
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      const subscription = event.data.object as Stripe.Subscription;
      await handleSubscriptionChange(subscription);
      break;
    default:
      break;
  }

  } catch {
    console.error('Subscription synchronization failed');
    return NextResponse.json({ error: 'Retry required' }, { status: 503 });
  }
  return NextResponse.json({ received: true });
}
