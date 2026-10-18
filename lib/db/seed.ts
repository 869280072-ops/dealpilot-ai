import { db } from './drizzle';
import { users, teams, teamMembers } from './schema';
import { hashPassword } from '@/lib/auth/session';

async function seed() {
  if (process.env.NODE_ENV === 'production' || process.env.ALLOW_DEV_SEED !== 'true') {
    throw new Error('Development seed requires explicit non-production opt-in');
  }
  const email = process.env.SEED_EMAIL;
  const password = process.env.SEED_PASSWORD;
  if (!email || !password || password.length < 12 || Buffer.byteLength(password) > 72) {
    throw new Error('Provide SEED_EMAIL and a 12-character minimum SEED_PASSWORD (maximum 72 bytes)');
  }
  const passwordHash = await hashPassword(password);
  await db.transaction(async (tx) => {
    const [user] = await tx.insert(users).values({ email, passwordHash, role: 'member' }).returning();
    const [team] = await tx.insert(teams).values({ name: 'Development Team' }).returning();
    await tx.insert(teamMembers).values({ teamId: team.id, userId: user.id, role: 'owner' });
  });
}
seed().then(() => { process.exit(0); }).catch(() => {
  console.error('Development seed failed');
  process.exit(1);
});
