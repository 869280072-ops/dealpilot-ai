import 'server-only';
export function getAuthSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) throw new Error('AUTH_SECRET must contain at least 32 bytes');
  return secret;
}
export function legacyPaymentsEnabled(): boolean {
  return process.env.LEGACY_STRIPE_ENABLED === 'true';
}
