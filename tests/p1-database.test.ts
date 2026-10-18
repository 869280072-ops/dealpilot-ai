import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { createDealPilotService } from '@/lib/dealpilot/service';
import { demoCases } from '@/lib/dealpilot/domain';
const databaseURL = process.env.P1_TEST_DATABASE_URL;

describe.skipIf(!databaseURL)('P1 isolated real PostgreSQL acceptance', () => {
  let sql: ReturnType<typeof postgres>;
  let database: ReturnType<typeof drizzle<typeof schema>>;
  let owner: ReturnType<typeof createDealPilotService>, member: typeof owner, outsider: typeof owner;
  let ownerId: number, memberId: number, teamId: number;
  let r: typeof schema.requirements.$inferSelect;
  let q: typeof schema.quotations.$inferSelect;
  beforeAll(async () => {
    const target = new URL(databaseURL!);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || !/^\/dealpilot_p1_test_[a-z0-9_]+$/.test(target.pathname)) throw new Error('P1 integration requires a fresh local dealpilot_p1_test_* database');
    sql = postgres(databaseURL!, { max: 5, connect_timeout: 3 }); database = drizzle(sql, { schema });
    if ((await sql`select tablename from pg_tables where schemaname='public'`).length) throw new Error('Test database must start empty');
    const journal = JSON.parse(await readFile('lib/db/migrations/meta/_journal.json', 'utf8'));
    for (const entry of journal.entries) for (const statement of (await readFile(`lib/db/migrations/${entry.tag}.sql`, 'utf8')).split('--> statement-breakpoint')) if (statement.trim()) await sql.unsafe(statement);
    const u = await database.insert(schema.users).values(['owner', 'member', 'outsider'].map(name => ({ email: `${name}@example.invalid`, passwordHash: 'synthetic-no-login', role: 'owner' }))).returning();
    const teams = await database.insert(schema.teams).values([{ name: '虚构 A' }, { name: '虚构 B' }]).returning();
    [ownerId, memberId] = u.map(x => x.id); teamId = teams[0].id;
    await database.insert(schema.teamMembers).values([{ userId: ownerId, teamId, role: 'owner' }, { userId: memberId, teamId, role: 'member' }, { userId: u[2].id, teamId: teams[1].id, role: 'owner' }]);
    owner = createDealPilotService(database, ownerId); member = createDealPilotService(database, memberId); outsider = createDealPilotService(database, u[2].id);
    vi.stubEnv('DEALPILOT_AI_MODE', 'demo');
  });
  afterAll(async () => { await sql?.end(); vi.unstubAllEnvs(); });
  it('creates Chinese requirements and persists them', async () => {
    r = await owner.execute({ action: 'saveRequirement', data: demoCases[0] }) as typeof r;
    expect((await owner.list()).requirements[0].content).toBe(demoCases[0].content);
  });
  it('isolates private requirements even from same-team members and other owners', async () => {
    expect((await member.list()).requirements).toHaveLength(0); expect((await outsider.list()).requirements).toHaveLength(0);
    for (const actor of [member, outsider]) {
      await expect(actor.execute({ action: 'saveRequirement', id: r.id, revision: 1, data: demoCases[1] })).rejects.toThrow();
      await expect(actor.execute({ action: 'analyze', id: r.id, revision: 1 })).rejects.toThrow();
      await expect(actor.execute({ action: 'generateQuote', id: r.id, currency: 'CNY' })).rejects.toThrow();
    }
  });
  it('rejects forged scope and global role escalation', async () => {
    await expect(member.execute({ action: 'saveRequirement', data: { ...demoCases[0], userId: ownerId } })).rejects.toThrow();
    await expect(member.execute({ action: 'saveCatalog', data: { name: 'x', service: 'website', currency: 'CNY', unitCents: 100 } })).rejects.toThrow();
  });
  it('requires analysis before quoting', async () => { await expect(owner.execute({ action: 'generateQuote', id: r.id, currency: 'CNY' })).rejects.toThrow('请先分析'); });
  it('persists analysis and shares catalog only within the team', async () => {
    await owner.execute({ action: 'analyze', id: r.id, revision: 1 });
    await owner.execute({ action: 'saveCatalog', data: { name: '虚构网站包', service: 'website', currency: 'CNY', unitCents: 1800000 } });
    expect((await owner.list()).analyses[0].result.budget).toBe('人民币 18000 元'); expect((await member.list()).catalog).toHaveLength(1); expect((await outsider.list()).catalog).toHaveLength(0);
  });
  it('does not automatically exchange currencies', async () => { await expect(owner.execute({ action: 'generateQuote', id: r.id, currency: 'USD' })).rejects.toThrow('不会自动换汇'); });
  it('creates deterministic draft and atomic initial history', async () => {
    q = await owner.execute({ action: 'generateQuote', id: r.id, currency: 'CNY' }) as typeof q;
    expect(q.status).toBe('draft'); expect(q.confirmedAt).toBeNull(); expect(q.data.totalCents).toBe(1800000); expect((await owner.list()).history).toHaveLength(1);
  });
  it('denies cross-user and cross-team quotation reads, updates and confirmations', async () => {
    for (const actor of [member, outsider]) {
      expect((await actor.list()).quotations).toHaveLength(0); expect((await actor.list()).analyses).toHaveLength(0); expect((await actor.list()).history).toHaveLength(0);
      await expect(actor.execute({ action: 'editQuote', id: q.id, revision: 1, data: { currency: q.data.currency, language: q.data.language, description: q.data.description, lines: q.data.lines } })).rejects.toThrow();
      await expect(actor.execute({ action: 'confirmQuote', id: q.id, revision: 1, confirmed: true })).rejects.toThrow();
    }
  });
  it('recalculates edited amounts, preserves snapshots, and rejects stale writes', async () => {
    const data = { currency: 'CNY', language: 'zh', description: '人工修订', lines: [{ name: '包', quantity: 3, unitCents: 12345 }] };
    await expect(owner.execute({ action: 'editQuote', id: q.id, revision: 1, data: { ...data, totalCents: 1 } })).rejects.toThrow();
    q = await owner.execute({ action: 'editQuote', id: q.id, revision: 1, data }) as typeof q;
    expect(q.data.totalCents).toBe(37035); expect((await owner.list()).history).toHaveLength(2);
    await expect(owner.execute({ action: 'editQuote', id: q.id, revision: 1, data })).rejects.toThrow();
  });
  it('requires explicit human confirmation and serializes concurrent confirmation', async () => {
    await expect(owner.execute({ action: 'confirmQuote', id: q.id, revision: q.revision, confirmed: false })).rejects.toThrow();
    const results = await Promise.allSettled([1, 2].map(() => owner.execute({ action: 'confirmQuote', id: q.id, revision: q.revision, confirmed: true })));
    expect(results.filter(x => x.status === 'fulfilled')).toHaveLength(1);
    q = (await owner.list()).quotations[0]; expect(q.status).toBe('confirmed'); expect(q.confirmedBy).toBe(ownerId); expect(q.confirmedAt).not.toBeNull(); expect((await owner.list()).history).toHaveLength(3);
  });
  it('makes confirmed quotes immutable', async () => {
    const { totalCents: _, ...data } = q.data; void _;
    await expect(owner.execute({ action: 'editQuote', id: q.id, revision: q.revision, data })).rejects.toThrow();
  });
  it('invalidates old analysis after edits and blocks stale quote confirmation', async () => {
    const draft = await owner.execute({ action: 'generateQuote', id: r.id, currency: 'CNY' }) as typeof q;
    r = await owner.execute({ action: 'saveRequirement', id: r.id, revision: 1, data: demoCases[2] }) as typeof r;
    await expect(owner.execute({ action: 'generateQuote', id: r.id, currency: 'CNY' })).rejects.toThrow('请先分析');
    await expect(owner.execute({ action: 'confirmQuote', id: draft.id, revision: draft.revision, confirmed: true })).rejects.toThrow('需求已修改');
    await owner.execute({ action: 'analyze', id: r.id, revision: r.revision });
    expect((await owner.list()).analyses[0].result.budget).toBeNull();
  });
  it('supports English requirements, analysis and English quotation text', async () => {
    const en = await member.execute({ action: 'saveRequirement', data: demoCases[1] }) as typeof r;
    await member.execute({ action: 'analyze', id: en.id, revision: 1 });
    await owner.execute({ action: 'saveCatalog', data: { name: 'Fictional logo package', service: 'design', currency: 'USD', unitCents: 250000 } });
    const english = await member.execute({ action: 'generateQuote', id: en.id, currency: 'USD' }) as typeof q;
    expect(english.data.description).toContain('Draft based'); expect(english.data.currency).toBe('USD'); expect(english.data.totalCents).toBe(250000);
  });
  it('survives a new database connection (not an in-memory repository)', async () => {
    const second = postgres(databaseURL!, { max: 1 });
    try { const reconnected = createDealPilotService(drizzle(second, { schema }), ownerId); expect((await reconnected.list()).quotations.find(x => x.id === q.id)?.status).toBe('confirmed'); } finally { await second.end(); }
  });
  it('revoked team membership and deleted users cannot access persisted data', async () => {
    await database.delete(schema.teamMembers).where(eq(schema.teamMembers.userId, memberId));
    await expect(member.list()).rejects.toThrow(); await expect(member.execute({ action: 'saveRequirement', data: demoCases[0] })).rejects.toThrow();
    await database.update(schema.users).set({ deletedAt: new Date() }).where(eq(schema.users.id, ownerId));
    await expect(owner.list()).rejects.toThrow();
  });
});
