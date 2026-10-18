import type { User } from '@/lib/db/schema';
export type PublicUser = Pick<User, 'id' | 'name' | 'email'>;
// Explicit allowlist keeps future server fields private by default.
export function toPublicUser(user: PublicUser): PublicUser {
  return { id: user.id, name: user.name, email: user.email };
}
