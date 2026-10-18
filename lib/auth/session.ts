import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';
import { z } from 'zod';
import type { User } from '@/lib/db/schema';
import { getAuthSecret } from '@/lib/env';

const sessionSchema = z.object({
  user: z.object({ id: z.number().int().positive() }),
  expires: z.string().datetime(),
  credentialVersion: z.string().length(64)
});
export type SessionData = z.infer<typeof sessionSchema>;
export { hashPassword, comparePasswords } from './passwords';

// Revokes tokens on password changes without putting password hashes in JWTs.
export function credentialVersion(passwordHash: string) {
  return createHmac('sha256', getAuthSecret()).update(passwordHash).digest('hex');
}
export function matchesCredentialVersion(passwordHash: string, version: string) {
  const expected = Buffer.from(credentialVersion(passwordHash));
  const actual = Buffer.from(version);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export async function signToken(payload: SessionData) {
  const data = sessionSchema.parse(payload);
  return new SignJWT(data).setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt().setExpirationTime(new Date(data.expires))
    .sign(new TextEncoder().encode(getAuthSecret()));
}
export async function verifyToken(input: string): Promise<SessionData> {
  const { payload } = await jwtVerify(input, new TextEncoder().encode(getAuthSecret()), { algorithms: ['HS256'] });
  const data = sessionSchema.parse(payload);
  if (Date.parse(data.expires) <= Date.now()) throw new Error('Expired session');
  return data;
}
export async function getSession() {
  const session = (await cookies()).get('session')?.value;
  if (!session) return null;
  getAuthSecret();
  try { return await verifyToken(session); } catch { return null; }
}
export async function setSession(user: Pick<User, 'id' | 'passwordHash'>) {
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const value = await signToken({ user: { id: user.id }, expires: expires.toISOString(), credentialVersion: credentialVersion(user.passwordHash) });
  (await cookies()).set('session', value, {
    expires, httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/'
  });
}
