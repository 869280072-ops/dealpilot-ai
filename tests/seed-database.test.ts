import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { seedDevelopmentDatabase } from '@/lib/db/seed-runner';
import { comparePasswords } from '@/lib/auth/passwords';

const databaseURL = process.env.SEED_TEST_DATABASE_URL;
const exec = promisify(execFile);
// Opt-in only: never use the application's POSTGRES_URL or an existing database.
describe.skipIf(!databaseURL)('seed against an isolated real PostgreSQL database', () => {
  let sql: ReturnType<typeof postgres>;
  const seedEnv = {
    NODE_ENV: 'test' as const, ALLOW_DEV_SEED: 'true', POSTGRES_URL: databaseURL,
    SEED_EMAIL: 'seed@example.invalid', SEED_PASSWORD: 'synthetic-database-password'
  };
  beforeAll(async () => {
    const target = new URL(databaseURL!);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || !/^\/dealpilot_seed_test_[a-z0-9_]+$/.test(target.pathname)) {
      throw new Error('Seed integration tests require a dedicated local dealpilot_seed_test_* database');
    }
    sql = postgres(databaseURL!, { max: 1, connect_timeout: 3 });
    const existing = await sql`select tablename from pg_tables where schemaname = 'public'`;
    if (existing.length) throw new Error('Integration test database must start empty');
    const migration = await readFile('lib/db/migrations/0000_soft_the_anarchist.sql', 'utf8');
    for (const statement of migration.split('--> statement-breakpoint')) await sql.unsafe(statement);
  });
  afterAll(async () => { await sql?.end({ timeout: 5 }); });
  const counts = async () => (await sql`select (select count(*)::int from users) as users, (select count(*)::int from teams) as teams, (select count(*)::int from team_members) as members`)[0];

  it('unauthorized CLI invocation leaves the real database unchanged', async () => {
    const before = await counts();
    await expect(exec(process.execPath, ['--import', 'tsx', 'lib/db/seed.ts'], {
      env: { ...process.env, ...seedEnv, ALLOW_DEV_SEED: 'false', NODE_OPTIONS: '' }
    })).rejects.toHaveProperty('code', 1);
    expect(await counts()).toEqual(before);
  });
  it('creates a custom account via the actual CLI with a compatible hash and owner membership', async () => {
    const result = await exec(process.execPath, ['--import', 'tsx', 'lib/db/seed.ts'], {
      env: { ...process.env, ...seedEnv, NODE_OPTIONS: '' }
    });
    expect(result.stdout).toContain('Development account and team created');
    const [user] = await sql`select * from users where email = ${seedEnv.SEED_EMAIL}`;
    expect(await comparePasswords(seedEnv.SEED_PASSWORD, user.password_hash)).toBe(true);
    expect(user.role).toBe('member');
    const members = await sql`select * from team_members where user_id = ${user.id}`;
    expect(members).toHaveLength(1);
    expect(members[0].role).toBe('owner');
    expect(await counts()).toEqual({ users: 1, teams: 1, members: 1 });
  });
  it('repeated or concurrent seeds never overwrite an existing account or add teams', async () => {
    const before = await sql`select * from users order by id`;
    const originalCounts = await counts();
    expect(await seedDevelopmentDatabase({ ...seedEnv, SEED_PASSWORD: 'different-test-password' })).toBe('already-exists');
    expect(await sql`select * from users order by id`).toEqual(before);
    expect(await counts()).toEqual(originalCounts);
    const concurrent = { ...seedEnv, SEED_EMAIL: 'concurrent@example.invalid' };
    const results = await Promise.all([seedDevelopmentDatabase(concurrent), seedDevelopmentDatabase(concurrent)]);
    expect(results.sort()).toEqual(['already-exists', 'created']);
    expect(await counts()).toEqual({ users: 2, teams: 2, members: 2 });
  });
  it('leaves an unrelated pre-existing account unchanged and creates no membership for it', async () => {
    await sql`insert into users (email, password_hash, role) values ('existing@example.invalid', 'unchanged-synthetic-hash', 'member')`;
    const before = await sql`select * from users where email = 'existing@example.invalid'`;
    const originalCounts = await counts();
    expect(await seedDevelopmentDatabase({ ...seedEnv, SEED_EMAIL: 'existing@example.invalid' })).toBe('already-exists');
    expect(await sql`select * from users where email = 'existing@example.invalid'`).toEqual(before);
    expect(await counts()).toEqual(originalCounts);
  });
  it('rolls back user and team creation when membership insertion fails', async () => {
    const before = await counts();
    await sql.unsafe("create function reject_seed_member() returns trigger language plpgsql as $$ begin raise exception 'synthetic member failure'; end $$");
    await sql.unsafe('create trigger reject_seed_member before insert on team_members for each row execute function reject_seed_member()');
    try {
      await expect(seedDevelopmentDatabase({ ...seedEnv, SEED_EMAIL: 'rollback@example.invalid' })).rejects.toThrow();
      expect(await counts()).toEqual(before);
    } finally {
      await sql.unsafe('drop trigger reject_seed_member on team_members');
      await sql.unsafe('drop function reject_seed_member()');
    }
  });
});
