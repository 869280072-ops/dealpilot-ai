import { beforeEach, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { inviteTeamMember, removeTeamMember, signIn, signUp, updateAccount, updatePassword, deleteAccount } from '@/app/(login)/actions';
import { withTeam } from '@/lib/auth/middleware';

const f = vi.hoisted(() => ({ user: vi.fn(), member: vi.fn(), team: vi.fn(), select: vi.fn(), insert: vi.fn(), remove: vi.fn(), update: vi.fn(), where: vi.fn(), returning: vi.fn(), limit: vi.fn(), compare: vi.fn(), cookieDelete: vi.fn() }));
vi.mock('@/lib/db/queries', () => ({
  getAuthenticatedUser: f.user, getUser: f.user, getCurrentMembership: f.member, getTeamForUser: f.team,
  getUserWithTeam: async () => ({ teamId: 10 })
}));
vi.mock('@/lib/auth/session', () => ({ comparePasswords: f.compare, hashPassword: vi.fn(), setSession: vi.fn() }));
vi.mock('@/lib/payments/stripe', () => ({ createCheckoutSession: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: (url: string) => { throw new Error('redirect:' + url); } }));
vi.mock('next/headers', () => ({ cookies: async () => ({ delete: f.cookieDelete }) }));
vi.mock('@/lib/db/drizzle', () => ({ db: { select: f.select, insert: f.insert, delete: f.remove, update: f.update } }));
const form = (values: Record<string, string>) => { const data = new FormData(); Object.entries(values).forEach(([k,v]) => data.set(k,v)); return data; };
const dialect = new PgDialect();

beforeEach(() => {
  vi.clearAllMocks();
  f.user.mockResolvedValue({ id: 1, role: 'owner', passwordHash: 'secret' });
  f.member.mockResolvedValue({ userId: 1, teamId: 10, role: 'member' });
  f.team.mockResolvedValue({ id: 10 });
  f.where.mockReturnValue({ returning: f.returning, limit: f.limit });
  f.remove.mockReturnValue({ where: f.where });
  const builder = { from: () => builder, leftJoin: () => builder, where: f.where };
  f.select.mockReturnValue(builder);
  f.limit.mockResolvedValue([]);
  f.insert.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
  f.update.mockReturnValue({ set: () => ({ where: f.where }) });
  f.returning.mockResolvedValue([]);
  f.compare.mockResolvedValue(false);
});
it('rejects member invitations despite a forged/global owner role', async () => {
  expect(await inviteTeamMember({}, form({ email: 'new@example.invalid', role: 'owner' }))).toEqual({ error: 'Forbidden' });
  expect(f.insert).not.toHaveBeenCalled();
});
it('rejects member removal before touching data', async () => {
  expect(await removeTeamMember({}, form({ memberId: '99' }))).toEqual({ error: 'Forbidden' });
  expect(f.remove).not.toHaveBeenCalled();
});
it('restricts owner deletion to own-team regular members, excluding self/owners', async () => {
  f.member.mockResolvedValue({ userId: 1, teamId: 10, role: 'owner' });
  const result = await removeTeamMember({}, form({ memberId: '99', teamId: '900' }));
  const query = dialect.sqlToQuery(f.where.mock.calls[0][0]);
  expect(query.params).toEqual([99, 10, 'member', 1]);
  expect(result).toEqual({ error: 'Member not found or protected' });
  expect(f.insert).not.toHaveBeenCalled();
});
it('allows a scoped regular-member removal and logs it', async () => {
  f.member.mockResolvedValue({ userId: 1, teamId: 10, role: 'owner' });
  f.returning.mockResolvedValue([{ id: 99 }]);
  expect(await removeTeamMember({}, form({ memberId: '99' }))).toHaveProperty('success');
  expect(f.insert).toHaveBeenCalledOnce();
});
it('ignores submitted user IDs when updating account data', async () => {
  await updateAccount({}, form({ name: 'Synthetic', email: 'user@example.invalid', userId: '900' }));
  expect(dialect.sqlToQuery(f.where.mock.calls[0][0]).params).toEqual([1]);
});
it('blocks unauthenticated mutations', async () => {
  f.user.mockResolvedValue(null);
  await expect(inviteTeamMember({}, form({ email: 'new@example.invalid', role: 'owner' }))).rejects.toThrow('not authenticated');
  expect(f.insert).not.toHaveBeenCalled();
});
it('blocks numeric invitation-based account/team takeover before writes', async () => {
  expect(await signUp({}, form({ email: 'victim@example.invalid', password: 'synthetic-password', inviteId: '1' }))).toHaveProperty('error');
  expect(f.insert).not.toHaveBeenCalled();
  expect(f.select).not.toHaveBeenCalled();
});
it('never echoes login or password-change/delete inputs in failure state', async () => {
  expect(await signIn({}, form({ email: 'user@example.invalid', password: 'synthetic-password' }))).not.toHaveProperty('password');
  const result = await updatePassword({}, form({ currentPassword: 'synthetic-old', newPassword: 'synthetic-new', confirmPassword: 'synthetic-new' }));
  expect(result).toEqual({ error: 'Current password is incorrect.' });
  expect(await deleteAccount({}, form({ password: 'synthetic-password' }))).toEqual({ error: 'Incorrect password. Account deletion failed.' });
});
it('blocks billing access for members or mismatched teams', async () => {
  const action = vi.fn();
  await expect(withTeam(action)(new FormData())).rejects.toThrow('Forbidden');
  f.member.mockResolvedValue({ teamId: 900, role: 'owner' });
  await expect(withTeam(action)(new FormData())).rejects.toThrow('Forbidden');
  expect(action).not.toHaveBeenCalled();
});
