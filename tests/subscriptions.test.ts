import { beforeEach, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import { handleSubscriptionChange } from '@/lib/payments/stripe';
const f = vi.hoisted(() => ({ retrieve: vi.fn(), team: vi.fn(), update: vi.fn() }));
vi.mock('stripe', () => ({ default: class { subscriptions = { retrieve: f.retrieve }; } }));
vi.mock('@/lib/db/queries', () => ({ getTeamByStripeCustomerId: f.team, updateTeamSubscription: f.update, getUser: vi.fn(), getCurrentMembership: vi.fn() }));
const event = { id: 'sub_test', status: 'active' } as Stripe.Subscription;
beforeEach(() => {
 vi.clearAllMocks(); vi.stubEnv('LEGACY_STRIPE_ENABLED', 'true'); vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_synthetic');
 f.team.mockResolvedValue({ id: 10, stripeSubscriptionId: 'sub_test' });
 f.retrieve.mockResolvedValue({ id: 'sub_test', customer: 'cus_test', status: 'past_due', items: { data: [] } });
});
it('uses latest server state so replayed active events cannot restore overdue rights', async () => {
 await handleSubscriptionChange(event); await handleSubscriptionChange(event);
 expect(f.update).toHaveBeenLastCalledWith(10, { stripeSubscriptionId: 'sub_test', stripeProductId: null, planName: null, subscriptionStatus: 'past_due' });
});
it('rejects an unknown customer or a different subscription binding', async () => {
 f.team.mockResolvedValue(null); await expect(handleSubscriptionChange(event)).rejects.toThrow('Unbound');
 f.team.mockResolvedValue({ id: 10, stripeSubscriptionId: 'sub_other' }); await expect(handleSubscriptionChange(event)).rejects.toThrow('Unbound');
 expect(f.update).not.toHaveBeenCalled();
});
it('synchronizes a verified active subscription without relying on product type assertions', async () => {
 f.retrieve.mockResolvedValue({ id: 'sub_test', customer: 'cus_test', status: 'active', items: { data: [{ price: { product: { id: 'prod_test', name: 'Synthetic' } } }] } });
 await handleSubscriptionChange(event);
 expect(f.update).toHaveBeenCalledWith(10, expect.objectContaining({ stripeProductId: 'prod_test', planName: 'Synthetic', subscriptionStatus: 'active' }));
});
