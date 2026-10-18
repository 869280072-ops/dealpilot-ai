import { beforeEach, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { getUser, getTeamForUser, getAuthenticatedUser } from '@/lib/db/queries';
import { GET as userAPI } from '@/app/api/user/route';
import { GET as teamAPI } from '@/app/api/team/route';
import { credentialVersion, signToken } from '@/lib/auth/session';

const f = vi.hoisted(() => ({ cookie: vi.fn(), select: vi.fn(), where: vi.fn(), findFirst: vi.fn(), limit: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: f.cookie }) }));
vi.mock('@/lib/db/drizzle', () => ({ db: {
  select: f.select,
  query: { teamMembers: { findFirst: f.findFirst } }
} }));
const user = { id: 7, name: 'Synthetic User', email: 'synthetic@example.invalid', passwordHash: 'private-hash', role: 'owner', deletedAt: null };
const dialect = new PgDialect();

beforeEach(async () => {
  vi.clearAllMocks();
  const token = await signToken({ user: { id: 7 }, expires: new Date(Date.now() + 60_000).toISOString(), credentialVersion: credentialVersion(user.passwordHash) });
  f.cookie.mockReturnValue({ value: token });
  f.select.mockReturnValue({ from: () => ({ where: f.where }) });
  f.where.mockReturnValue({ limit: f.limit });
  f.limit.mockResolvedValue([user]);
  f.findFirst.mockResolvedValue({ team: { id: 10, name: 'Synthetic team', teamMembers: [] } });
});

it('allowlists API and root-layout user data, excluding hashes and future fields', async () => {
  const expected = { id: 7, name: user.name, email: user.email };
  expect(await getUser()).toEqual(expected);
  const response = await userAPI();
  expect(await response.json()).toEqual(expected);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
});
it('selects only the signed-in active user, never a supplied foreign ID', async () => {
  await getUser();
  const query = dialect.sqlToQuery(f.where.mock.calls[0][0]);
  expect(query.params).toEqual([7]);
  expect(query.sql).toContain('"users"."id" =');
  expect(query.sql).toContain('"users"."deleted_at" is null');
});
it('scopes team reads to the signed-in membership and restricts nested user columns', async () => {
  await getTeamForUser();
  const options = f.findFirst.mock.calls[0][0];
  expect(dialect.sqlToQuery(options.where).params).toEqual([7]);
  expect(dialect.sqlToQuery(options.where).sql).toContain('"team_members"."user_id"');
  expect(options.with.team.with.teamMembers.with.user.columns).toEqual({ id: true, name: true, email: true });
  expect(options.with.team.columns).toEqual({ id: true, name: true, planName: true, subscriptionStatus: true });
});
it('returns no foreign team when membership is absent', async () => {
  f.findFirst.mockResolvedValue(undefined);
  expect(await getTeamForUser()).toBeNull();
});
it('does not query users or teams for unsigned/invalid cookies', async () => {
  f.cookie.mockReturnValue({ value: 'invalid-token' });
  expect(await (await userAPI()).json()).toBeNull();
  expect(await (await teamAPI()).json()).toBeNull();
  expect(f.select).not.toHaveBeenCalled();
  expect(f.findFirst).not.toHaveBeenCalled();
});
it('rejects tokens issued before a password change', async () => {
  f.limit.mockResolvedValue([{ ...user, passwordHash: 'changed' }]);
  expect(await getAuthenticatedUser()).toBeNull();
});
it('rejects removed/deleted users', async () => {
  f.limit.mockResolvedValue([]);
  expect(await getUser()).toBeNull();
});
