import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';
import { getAuthSecret } from '@/lib/env';
import { credentialVersion, matchesCredentialVersion, signToken, verifyToken, getSession, setSession } from '@/lib/auth/session';

const jar = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => jar }));
const payload = () => ({ user: { id: 1 }, expires: new Date(Date.now() + 60_000).toISOString(), credentialVersion: credentialVersion('test-hash') });

describe('session security', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it('validates real signed tokens', async () => {
    const token = await signToken(payload());
    expect((await verifyToken(token)).user.id).toBe(1);
  });
  it('rejects tampering', async () => {
    const token = await signToken(payload());
    const parts = token.split('.');
    parts[1] = Buffer.from(JSON.stringify({ ...payload(), user: { id: 2 } })).toString('base64url');
    await expect(verifyToken(parts.join('.'))).rejects.toThrow();
  });
  it('rejects expired tokens', async () => {
    await expect(verifyToken(await signToken({ ...payload(), expires: new Date(Date.now() - 5000).toISOString() }))).rejects.toThrow();
  });
  it('rejects malformed claims even with a valid signature', async () => {
    const token = await new SignJWT({ ...payload(), user: { id: '2' } }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(new TextEncoder().encode(getAuthSecret()));
    await expect(verifyToken(token)).rejects.toThrow();
  });
  it('treats malformed cookies as signed out', async () => {
    jar.get.mockReturnValue({ value: 'not-a-token' });
    expect(await getSession()).toBeNull();
  });
  it.each(['', 'short'])('fails closed on invalid AUTH_SECRET %s', (value) => {
    vi.stubEnv('AUTH_SECRET', value);
    expect(getAuthSecret).toThrow('AUTH_SECRET');
    vi.stubEnv('AUTH_SECRET', 'unit-test-only-secret-at-least-thirty-two-bytes');
  });
  it('revokes old credential versions on password changes', () => {
    const version = credentialVersion('old-hash');
    expect(matchesCredentialVersion('old-hash', version)).toBe(true);
    expect(matchesCredentialVersion('new-hash', version)).toBe(false);
  });
  it('sets secure, HttpOnly production cookies without raw password hashes', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await setSession({ id: 1, passwordHash: 'test-hash' });
    expect(jar.set).toHaveBeenCalledWith('session', expect.any(String), expect.objectContaining({ httpOnly: true, secure: true, sameSite: 'lax', path: '/' }));
    const body = Buffer.from(jar.set.mock.calls[0][1].split('.')[1], 'base64url').toString();
    expect(body).not.toContain('test-hash');
    vi.stubEnv('NODE_ENV', 'test');
  });
});
