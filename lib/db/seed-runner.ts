import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { z } from 'zod';
import { hashPassword } from '../auth/passwords';
import { users, teams, teamMembers } from './schema';

// No Next.js imports or database connection side effects at module load time.
export async function seedDevelopmentDatabase(env: NodeJS.ProcessEnv) {
  if (env.NODE_ENV === 'production' || env.ALLOW_DEV_SEED !== 'true') {
    throw new Error('Development seed requires explicit non-production opt-in');
  }
  const email = z.string().email().max(255).safeParse(env.SEED_EMAIL);
  const password = env.SEED_PASSWORD;
  if (!email.success || !password || password.length < 12 || Buffer.byteLength(password) > 72) {
    throw new Error('Provide a valid SEED_EMAIL and a 12-character minimum SEED_PASSWORD (maximum 72 bytes)');
  }
  if (!env.POSTGRES_URL) throw new Error('POSTGRES_URL is required for the development database');

  const passwordHash = await hashPassword(password);
  const client = postgres(env.POSTGRES_URL, { max: 1, connect_timeout: 3 });
  try {
    const db = drizzle(client);
    return await db.transaction(async (tx) => {
      // The existing unique email constraint serializes concurrent duplicate seeds.
      // Never change an existing account, password, team or membership.
      const [user] = await tx.insert(users).values({
        email: email.data, passwordHash, role: 'member'
      }).onConflictDoNothing({ target: users.email }).returning({ id: users.id });
      if (!user) return 'already-exists' as const;
      const [team] = await tx.insert(teams).values({ name: 'Development Team' }).returning({ id: teams.id });
      await tx.insert(teamMembers).values({ teamId: team.id, userId: user.id, role: 'owner' });
      return 'created' as const;
    });
  } finally {
    await client.end({ timeout: 5 });
  }
}
