import { beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/stripe/checkout/route';
import { POST } from '@/app/api/stripe/webhook/route';
const f = vi.hoisted(() => ({ enabled: vi.fn(), user: vi.fn(), member: vi.fn(), retrieve: vi.fn(), construct: vi.fn(), change: vi.fn(), update: vi.fn() }));
vi.mock('@/lib/env', () => ({ legacyPaymentsEnabled: f.enabled }));
vi.mock('@/lib/db/queries', () => ({ getUser: f.user, getCurrentMembership: f.member }));
vi.mock('@/lib/db/drizzle', () => ({ db: { update: f.update } }));
vi.mock('@/lib/payments/stripe', () => ({ getStripe: () => ({ checkout: { sessions: { retrieve: f.retrieve } }, webhooks: { constructEvent: f.construct } }), handleSubscriptionChange: f.change }));
const request = () => new NextRequest('http://localhost/api/stripe/checkout?session_id=synthetic');
beforeEach(() => {
 vi.clearAllMocks(); f.enabled.mockReturnValue(true);
 f.user.mockResolvedValue({ id: 1 }); f.member.mockResolvedValue({ teamId: 10, role: 'owner' });
 f.retrieve.mockResolvedValue({ client_reference_id: '1', metadata: { teamId: '10' }, status: 'complete', payment_status: 'paid' });
});
it('disables the legacy payment entry by default', async () => {
 f.enabled.mockReturnValue(false); expect((await GET(request())).status).toBe(503); expect(f.retrieve).not.toHaveBeenCalled();
});
it('requires authentication before consulting Stripe', async () => {
 f.user.mockResolvedValue(null); expect((await GET(request())).status).toBe(401); expect(f.retrieve).not.toHaveBeenCalled();
});
it('rejects member billing access', async () => {
 f.member.mockResolvedValue({ teamId: 10, role: 'member' }); expect((await GET(request())).status).toBe(403); expect(f.retrieve).not.toHaveBeenCalled();
});
it.each([{ client_reference_id: '2', metadata: { teamId: '10' } }, { client_reference_id: '1', metadata: { teamId: '99' } }])('rejects another user or team checkout', async (session) => {
 f.retrieve.mockResolvedValue(session); expect((await GET(request())).status).toBe(403); expect(f.update).not.toHaveBeenCalled();
});
it('rejects incomplete sessions regardless of client success claims', async () => {
 f.retrieve.mockResolvedValue({ client_reference_id: '1', metadata: { teamId: '10' }, status: 'open', payment_status: 'unpaid' });
 expect((await GET(request())).status).toBe(400);
});
it('successful browser return neither writes entitlements nor sets login cookies', async () => {
 const response = await GET(request()); expect(response.status).toBe(307); expect(response.headers.get('set-cookie')).toBeNull(); expect(f.update).not.toHaveBeenCalled();
});
it('fails closed on a disabled webhook', async () => {
 f.enabled.mockReturnValue(false);
 expect((await POST(new NextRequest('http://localhost/api/stripe/webhook', { method: 'POST', body: '{}' }))).status).toBe(503);
 expect(f.change).not.toHaveBeenCalled();
});

it('rejects forged webhook signatures without synchronizing rights', async () => {
 f.construct.mockImplementation(() => { throw new Error('synthetic-secret-never-log'); });
 const log = vi.spyOn(console, 'error').mockImplementation(() => {});
 expect((await POST(new NextRequest('http://localhost/api/stripe/webhook', { method: 'POST', body: '{}' }))).status).toBe(400);
 expect(f.change).not.toHaveBeenCalled(); expect(JSON.stringify(log.mock.calls)).not.toContain('synthetic-secret'); log.mockRestore();
});
it('processes verified events and signals retry on failed synchronization', async () => {
 f.construct.mockReturnValue({ type: 'customer.subscription.updated', data: { object: { id: 'sub_synthetic' } } });
 f.change.mockResolvedValue(undefined);
 const req = () => new NextRequest('http://localhost/api/stripe/webhook', { method: 'POST', body: '{}' });
 expect((await POST(req())).status).toBe(200);
 f.change.mockRejectedValue(new Error('private-internal-details'));
 const log = vi.spyOn(console, 'error').mockImplementation(() => {});
 expect((await POST(req())).status).toBe(503); expect(JSON.stringify(log.mock.calls)).not.toContain('private-internal-details'); log.mockRestore();
});
