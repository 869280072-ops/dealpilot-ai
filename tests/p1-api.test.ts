import { beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ user: vi.fn(), list: vi.fn(), execute: vi.fn() }));
vi.mock('@/lib/db/queries', () => ({ getUser: f.user }));
vi.mock('@/lib/db/drizzle', () => ({ db: {} }));
vi.mock('@/lib/dealpilot/service', () => ({ createDealPilotService: () => ({ list: f.list, execute: f.execute }), BusinessError: class extends Error {}, RateLimitError: class extends Error {} }));
import { RateLimitError } from '@/lib/dealpilot/service';
import { GET, POST } from '@/app/api/dealpilot/route';
const request = (body = '{}', origin = 'http://localhost', type = 'application/json') => new Request('http://localhost/api/dealpilot', { method: 'POST', headers: { origin, 'content-type': type }, body });
beforeEach(() => { vi.clearAllMocks(); f.user.mockResolvedValue({ id: 1 }); f.list.mockResolvedValue({ requirements: [] }); f.execute.mockResolvedValue({ id: 1 }); });
it('requires an authenticated session for reads and writes', async () => { f.user.mockResolvedValue(null); expect((await GET()).status).toBe(401); expect((await POST(request())).status).toBe(401); expect(f.list).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled(); });
it.each(['https://evil.example', '', 'null'])('denies cross-origin writes: %s', async origin => { expect((await POST(request('{}', origin))).status).toBe(403); expect(f.execute).not.toHaveBeenCalled(); });
it('rejects unsupported content types, malformed JSON, oversized request bodies', async () => {
  expect((await POST(request('{}', 'http://localhost', 'text/plain'))).status).toBe(415);
  expect((await POST(request('not-json'))).status).toBe(400);
  expect((await POST(request('x'.repeat(64001)))).status).toBe(400);
  expect(f.execute).not.toHaveBeenCalled();
});
it('uses private no-store responses and forwards a valid command', async () => { expect((await GET()).headers.get('cache-control')).toBe('private, no-store'); const r = await POST(request('{"action":"analyze","id":7,"revision":1}')); expect(r.status).toBe(200); expect(f.execute).toHaveBeenCalledWith({ action: 'analyze', id: 7, revision: 1 }); });
it('does not expose database errors or secret-bearing exceptions', async () => { f.execute.mockRejectedValue(new Error('private database password')); const log = vi.spyOn(console, 'error').mockImplementation(() => {}); const r = await POST(request()); expect(r.status).toBe(503); expect(await r.text()).not.toContain('password'); expect(JSON.stringify(log.mock.calls)).not.toContain('password'); log.mockRestore(); });

it('returns 429 and retry guidance for a server-side model quota denial', async () => { f.execute.mockRejectedValue(new RateLimitError('调用配额已用尽')); const r = await POST(request()); expect(r.status).toBe(429); expect(r.headers.get('retry-after')).toBe('60'); expect((await r.json()).error).toContain('配额'); });
