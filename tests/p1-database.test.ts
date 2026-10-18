import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { createDealPilotService, RateLimitError } from '@/lib/dealpilot/service';
import { demoCases } from '@/lib/dealpilot/domain';
const databaseURL = process.env.P1_TEST_DATABASE_URL;

describe.skipIf(!databaseURL)('P1 isolated real PostgreSQL acceptance', () => {
  let sql: ReturnType<typeof postgres>;
  let database: ReturnType<typeof drizzle<typeof schema>>;
  let owner: ReturnType<typeof createDealPilotService>, member: typeof owner, outsider: typeof owner;
  let ownerId: number, memberId: number, teamId: number;
  let r: typeof schema.requirements.$inferSelect;
  let q: typeof schema.quotations.$inferSelect;
  let migrationDuplicates: { active: number; archived: number };
  beforeAll(async () => {
    const target = new URL(databaseURL!);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || !/^\/dealpilot_p1_test_[a-z0-9_]+$/.test(target.pathname)) throw new Error('P1 integration requires a fresh local dealpilot_p1_test_* database');
    sql = postgres(databaseURL!, { max: 5, connect_timeout: 3 }); database = drizzle(sql, { schema });
    if ((await sql`select tablename from pg_tables where schemaname='public'`).length) throw new Error('Test database must start empty');
    const journal = JSON.parse(await readFile('lib/db/migrations/meta/_journal.json', 'utf8'));
    for (const entry of journal.entries) {
      for (const statement of (await readFile(`lib/db/migrations/${entry.tag}.sql`, 'utf8')).split('--> statement-breakpoint')) if (statement.trim()) await sql.unsafe(statement);
      if (entry.idx === 2) {
        const [legacyTeam] = await sql`insert into teams(name) values ('虚构旧价目团队') returning id`;
        await sql`insert into service_catalog(team_id,name,service,currency,unit_cents) values (${legacyTeam.id},'相同旧项目','website','CNY',10000),(${legacyTeam.id},'相同旧项目','website','CNY',10000)`;
      }
    }
    const [counts] = await sql`select count(*) filter(where archived_at is null)::int as active, count(*) filter(where archived_at is not null)::int as archived from service_catalog`;
    migrationDuplicates = { active: counts.active, archived: counts.archived };
    const u = await database.insert(schema.users).values(['owner', 'member', 'outsider'].map(name => ({ email: `${name}@example.invalid`, passwordHash: 'synthetic-no-login', role: 'owner' }))).returning();
    const teams = await database.insert(schema.teams).values([{ name: '虚构 A' }, { name: '虚构 B' }]).returning();
    [ownerId, memberId] = u.map(x => x.id); teamId = teams[0].id;
    await database.insert(schema.teamMembers).values([{ userId: ownerId, teamId, role: 'owner' }, { userId: memberId, teamId, role: 'member' }, { userId: u[2].id, teamId: teams[1].id, role: 'owner' }]);
    owner = createDealPilotService(database, ownerId); member = createDealPilotService(database, memberId); outsider = createDealPilotService(database, u[2].id);
    vi.stubEnv('DEALPILOT_AI_MODE', 'demo');
  });
  afterAll(async () => { await sql?.end(); vi.unstubAllEnvs(); });
  it('archives identical legacy catalog duplicates without deleting historical rows', () => { expect(migrationDuplicates).toEqual({ active: 1, archived: 1 }); });
  it('rejects ambiguous legacy prices before archiving any duplicate', async () => {
    const statements = (await readFile('lib/db/migrations/0003_odd_payback.sql', 'utf8')).split('--> statement-breakpoint');
    const preflight = statements.find(s => s.includes("RAISE EXCEPTION 'Conflicting catalog prices"))!;
    await sql.begin(async transaction => {
      await transaction.unsafe('CREATE TEMP TABLE service_catalog (id int, team_id int, name text, service text, currency text, unit_cents int, archived_at timestamp) ON COMMIT DROP');
      await transaction`insert into service_catalog values (1,1,'虚构冲突','website','CNY',100,null),(2,1,'虚构冲突','website','CNY',200,null)`;
      await expect(transaction.savepoint(async savepoint => { await savepoint.unsafe(preflight); })).rejects.toThrow('Conflicting catalog prices');
      expect(await transaction`select unit_cents from service_catalog where archived_at is null order by id`).toEqual([{ unit_cents: 100 }, { unit_cents: 200 }]);
    });
  });
  it('creates Chinese requirements and persists them', async () => {
    r = await owner.execute({ action: 'saveRequirement', data: demoCases[0] }) as typeof r;
    expect((await owner.list()).requirements[0].content).toBe(demoCases[0].content);
  });
  it('isolates private requirements even from same-team members and other owners', async () => {
    expect((await member.list()).requirements).toHaveLength(0); expect((await outsider.list()).requirements).toHaveLength(0);
    for (const actor of [member, outsider]) {
      await expect(actor.execute({ action: 'saveRequirement', id: r.id, revision: 1, data: demoCases[1] })).rejects.toThrow();
      await expect(actor.execute({ action: 'analyze', id: r.id, revision: 1 })).rejects.toThrow();
      await expect(actor.execute({ action: 'generateQuote', requestId: randomUUID(), id: r.id, currency: 'CNY' })).rejects.toThrow();
    }
  });
  it('rejects forged scope and global role escalation', async () => {
    await expect(member.execute({ action: 'saveRequirement', data: { ...demoCases[0], userId: ownerId } })).rejects.toThrow();
    await expect(member.execute({ action: 'saveCatalog', requestId: randomUUID(), data: { name: 'x', service: 'website', currency: 'CNY', unitCents: 100 } })).rejects.toThrow();
  });
  it('requires analysis before quoting', async () => { await expect(owner.execute({ action: 'generateQuote', requestId: randomUUID(), id: r.id, currency: 'CNY' })).rejects.toThrow('请先分析'); });
  it('persists analysis and shares catalog only within the team', async () => {
    await owner.execute({ action: 'analyze', id: r.id, revision: 1 });
    await owner.execute({ action: 'saveCatalog', requestId: randomUUID(), data: { name: '虚构网站包', service: 'website', currency: 'CNY', unitCents: 1800000 } });
    expect((await owner.list()).analyses[0].result.budget).toBe('人民币 18000 元'); expect((await member.list()).catalog).toHaveLength(1); expect((await outsider.list()).catalog).toHaveLength(0);
  });
  it('does not automatically exchange currencies', async () => { await expect(owner.execute({ action: 'generateQuote', requestId: randomUUID(), id: r.id, currency: 'USD' })).rejects.toThrow('不会自动换汇'); });
  it('creates deterministic draft and atomic initial history', async () => {
    q = await owner.execute({ action: 'generateQuote', requestId: randomUUID(), id: r.id, currency: 'CNY' }) as typeof q;
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
    const draft = await owner.execute({ action: 'generateQuote', requestId: randomUUID(), id: r.id, currency: 'CNY' }) as typeof q;
    r = await owner.execute({ action: 'saveRequirement', id: r.id, revision: 1, data: demoCases[2] }) as typeof r;
    await expect(owner.execute({ action: 'generateQuote', requestId: randomUUID(), id: r.id, currency: 'CNY' })).rejects.toThrow('请先分析');
    await expect(owner.execute({ action: 'confirmQuote', id: draft.id, revision: draft.revision, confirmed: true })).rejects.toThrow('需求已修改');
    await owner.execute({ action: 'analyze', id: r.id, revision: r.revision });
    expect((await owner.list()).analyses[0].result.budget).toBeNull();
  });
  it('supports English requirements, analysis and English quotation text', async () => {
    const en = await member.execute({ action: 'saveRequirement', data: demoCases[1] }) as typeof r;
    await member.execute({ action: 'analyze', id: en.id, revision: 1 });
    await owner.execute({ action: 'saveCatalog', requestId: randomUUID(), data: { name: 'Fictional logo package', service: 'design', currency: 'USD', unitCents: 250000 } });
    const english = await member.execute({ action: 'generateQuote', requestId: randomUUID(), id: en.id, currency: 'USD' }) as typeof q;
    expect(english.data.description).toContain('Draft based'); expect(english.data.currency).toBe('USD'); expect(english.data.totalCents).toBe(250000);
  });
  it('survives a new database connection (not an in-memory repository)', async () => {
    const second = postgres(databaseURL!, { max: 1 });
    try { const reconnected = createDealPilotService(drizzle(second, { schema }), ownerId); expect((await reconnected.list()).quotations.find(x => x.id === q.id)?.status).toBe('confirmed'); } finally { await second.end(); }
  });
  it('deduplicates identical catalog entries across request keys and rejects conflicting prices', async () => {
    const data = { name: '幂等咨询包', service: 'consulting', currency: 'EUR', unitCents: 10000 };
    const requestId = randomUUID();
    const items = await Promise.all(Array.from({ length: 8 }, (_, i) => owner.execute({ action: 'saveCatalog', requestId: i < 4 ? requestId : randomUUID(), data })));
    expect(new Set(items.map(x => x.id)).size).toBe(1);
    await expect(owner.execute({ action: 'saveCatalog', requestId, data: { ...data, unitCents: 1 } })).rejects.toThrow('请求标识');
    await expect(owner.execute({ action: 'saveCatalog', requestId: randomUUID(), data: { ...data, unitCents: 1 } })).rejects.toThrow('单价不同');
  });
  it('creates one draft and one snapshot for eight repeated requests, without double pricing', async () => {
    const requirement = await owner.execute({ action: 'saveRequirement', data: { ...demoCases[0], service: 'consulting' } }) as typeof r;
    await owner.execute({ action: 'analyze', id: requirement.id, revision: 1 });
    const command = { action: 'generateQuote', requestId: randomUUID(), id: requirement.id, currency: 'EUR' };
    const drafts = await Promise.all(Array.from({ length: 8 }, () => owner.execute(command))) as typeof q[];
    expect(new Set(drafts.map(x => x.id)).size).toBe(1); expect(drafts[0].data.lines).toHaveLength(1); expect(drafts[0].data.totalCents).toBe(10000);
    expect((await owner.list()).history.filter(x => x.quotationId === drafts[0].id)).toHaveLength(1);
    await expect(owner.execute({ ...command, currency: 'CNY' })).rejects.toThrow('请求标识');
    await expect(outsider.execute(command)).rejects.toThrow();
    const fresh = await owner.execute({ ...command, requestId: randomUUID() }) as typeof q;
    expect(fresh.id).not.toBe(drafts[0].id);
  });
  it('requires UUID idempotency keys and does not accept old analysis policy for new quotes', async () => {
    await expect(owner.execute({ action: 'saveCatalog', data: { name: 'x', service: 'website', currency: 'CNY', unitCents: 1 } })).rejects.toThrow();
    const requirement = await owner.execute({ action: 'saveRequirement', data: demoCases[0] }) as typeof r;
    const [legacy] = await database.insert(schema.analyses).values({ requirementId: requirement.id, revision: 1, mode: 'demo', model: 'legacy', result: { service: 'website', budget: null, currency: null, delivery: null, requirements: [], missing: [], questions: [] } }).returning();
    const [oldDraft] = await database.insert(schema.quotations).values({ requirementId: requirement.id, requirementRevision: 1, analysisId: legacy.id, data: { currency: 'CNY', language: 'zh', description: '虚构旧草稿', lines: [{ name: 'x', quantity: 1, unitCents: 100 }], totalCents: 100 } }).returning();
    await expect(owner.execute({ action: 'confirmQuote', id: oldDraft.id, revision: 1, confirmed: true })).rejects.toThrow('旧安全策略');
    await expect(owner.execute({ action: 'generateQuote', requestId: randomUUID(), id: requirement.id, currency: 'CNY' })).rejects.toThrow('旧安全策略');
  });
  it('8 identical concurrent live analyses call the simulated provider once and reuse the result across connections', async () => {
    const requirement = await owner.execute({ action: 'saveRequirement', data: demoCases[2] }) as typeof r;
    vi.stubEnv('DEALPILOT_AI_MODE', 'live'); vi.stubEnv('DEALPILOT_AI_API_KEY', 'synthetic-only'); vi.stubEnv('DEALPILOT_AI_MODEL', 'mock-provider');
    let release!: () => void, entered!: () => void, denied!: () => void;
    const gate = new Promise<void>(r => release = r), started = new Promise<void>(r => entered = r), duplicates = new Promise<void>(r => denied = r);
    const fetcher = vi.fn().mockImplementation(async () => { entered(); await gate; return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ service: 'translation', budget: null, currency: null, delivery: null, requirements: [], missing: [], questions: [] }) } }] })); });
    vi.stubGlobal('fetch', fetcher);
    let pending = 0;
    const command = { action: 'analyze', id: requirement.id, revision: 1 };
    try {
      const requests = Array.from({ length: 8 }, () => owner.execute(command).then(value => ({ value }), error => { if (++pending === 7) denied(); return { error }; }));
      await started; await duplicates; expect(fetcher).toHaveBeenCalledTimes(1); release();
      const results = await Promise.all(requests);
      expect(results.filter(x => 'value' in x)).toHaveLength(1); expect(results.filter(x => 'error' in x)).toHaveLength(7);
      for (const result of results) if ('error' in result) expect(result.error.message).toContain('正在处理');
      const retries = await Promise.all(Array.from({ length: 8 }, () => owner.execute(command)));
      expect(new Set(retries.map(x => x.id)).size).toBe(1); expect(fetcher).toHaveBeenCalledTimes(1);
      const second = postgres(databaseURL!, { max: 1 });
      try { expect((await createDealPilotService(drizzle(second, { schema }), ownerId).execute(command)).id).toBe(retries[0].id); } finally { await second.end(); }
      await expect(outsider.execute(command)).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { release(); vi.unstubAllGlobals(); vi.stubEnv('DEALPILOT_AI_MODE', 'demo'); }
  });
  it('records failed/uncertain model calls durably and never automatically repeats them', async () => {
    const requirement = await owner.execute({ action: 'saveRequirement', data: demoCases[2] }) as typeof r;
    vi.stubEnv('DEALPILOT_AI_MODE', 'live'); vi.stubEnv('DEALPILOT_AI_API_KEY', 'synthetic-only'); vi.stubEnv('DEALPILOT_AI_MODEL', 'mock-provider');
    const fetcher = vi.fn().mockRejectedValue(new Error('simulated timeout')); vi.stubGlobal('fetch', fetcher);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const command = { action: 'analyze', id: requirement.id, revision: 1 };
      await expect(owner.execute(command)).rejects.toThrow('AI 分析暂时不可用');
      await expect(owner.execute(command)).rejects.toThrow('不会自动重试'); expect(fetcher).toHaveBeenCalledTimes(1);
      expect((await database.select().from(schema.aiRuns).where(eq(schema.aiRuns.requirementId, requirement.id)))[0].status).toBe('failed');
    } finally { log.mockRestore(); vi.unstubAllGlobals(); vi.stubEnv('DEALPILOT_AI_MODE', 'demo'); }
  });
  it.each(['DEALPILOT_AI_USER_HOURLY_LIMIT', 'DEALPILOT_AI_USER_DAILY_LIMIT', 'DEALPILOT_AI_GLOBAL_DAILY_LIMIT'])('enforces %s before any simulated provider call', async limit => {
    const actor = limit === 'DEALPILOT_AI_GLOBAL_DAILY_LIMIT' ? member : owner;
    const requirement = await actor.execute({ action: 'saveRequirement', data: demoCases[2] }) as typeof r;
    vi.stubEnv('DEALPILOT_AI_MODE', 'live'); vi.stubEnv(limit, '1');
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    try { await expect(actor.execute({ action: 'analyze', id: requirement.id, revision: 1 })).rejects.toBeInstanceOf(RateLimitError); expect(fetcher).not.toHaveBeenCalled(); }
    finally { delete process.env[limit]; vi.unstubAllGlobals(); vi.stubEnv('DEALPILOT_AI_MODE', 'demo'); }
  });
  it('blocks another live call while one is pending, and discards a result after requirement changes', async () => {
    const first = await owner.execute({ action: 'saveRequirement', data: demoCases[2] }) as typeof r;
    const second = await owner.execute({ action: 'saveRequirement', data: demoCases[2] }) as typeof r;
    vi.stubEnv('DEALPILOT_AI_MODE', 'live'); vi.stubEnv('DEALPILOT_AI_API_KEY', 'synthetic-only'); vi.stubEnv('DEALPILOT_AI_MODEL', 'mock-provider');
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(r => release = r), started = new Promise<void>(r => entered = r);
    const fetcher = vi.fn().mockImplementation(async () => { entered(); await gate; return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ service: 'translation', budget: null, currency: null, delivery: null, requirements: [], missing: [], questions: [] }) } }] })); });
    vi.stubGlobal('fetch', fetcher);
    try {
      const operation = owner.execute({ action: 'analyze', id: first.id, revision: 1 }); const assertion = expect(operation).rejects.toThrow();
      await started;
      await expect(owner.execute({ action: 'analyze', id: second.id, revision: 1 })).rejects.toBeInstanceOf(RateLimitError);
      await owner.execute({ action: 'saveRequirement', id: first.id, revision: 1, data: { ...demoCases[2], title: '虚构版本已更改' } });
      release(); await assertion; expect(fetcher).toHaveBeenCalledTimes(1);
      expect((await owner.list()).analyses.filter(a => a.requirementId === first.id)).toHaveLength(0);
    } finally { release(); vi.unstubAllGlobals(); vi.stubEnv('DEALPILOT_AI_MODE', 'demo'); }
  });
  it('isolates v2 cached analyses and preserves confirmed quotes and history during v3 reanalysis', async () => {
    const requirement = await owner.execute({ action: 'saveRequirement', data: { ...demoCases[0], content: '预算人民币 10 万元。交付2026年12月15日。' } }) as typeof r;
    const [old] = await database.insert(schema.analyses).values({ requirementId: requirement.id, revision: 1, mode: 'demo', model: 'conservative-demo-v2', policyVersion: 'p1-safe-v2', result: { service: 'website', budget: '人民币 10', currency: 'CNY', delivery: '2026年12月15日', requirements: [], missing: [], questions: [] } }).returning();
    await database.insert(schema.aiRuns).values({ userId: ownerId, teamId, requirementId: requirement.id, revision: 1, mode: 'demo', profile: createHash('sha256').update('p1-safe-v2:conservative-demo-v2').digest('hex'), status: 'succeeded', analysisId: old.id, finishedAt: new Date() });
    const [oldDraft] = await database.insert(schema.quotations).values({ requirementId: requirement.id, requirementRevision: 1, analysisId: old.id, data: { currency: 'CNY', language: 'zh', description: '虚构旧策略草稿', lines: [{ name: '包', quantity: 1, unitCents: 100 }], totalCents: 100 } }).returning();
    await expect(owner.execute({ action: 'generateQuote', requestId: randomUUID(), id: requirement.id, currency: 'CNY' })).rejects.toThrow('旧安全策略');
    await expect(owner.execute({ action: 'confirmQuote', id: oldDraft.id, revision: 1, confirmed: true })).rejects.toThrow('旧安全策略');
    const before = await owner.list();
    const command = { action: 'analyze', id: requirement.id, revision: 1 };
    const fresh = await owner.execute(command) as typeof old;
    expect(fresh.id).not.toBe(old.id); expect(fresh.policyVersion).toBe('p1-safe-v3'); expect(fresh.result.budget).toBe('人民币 10 万元');
    expect((await owner.execute(command) as typeof old).id).toBe(fresh.id);
    expect((await database.select().from(schema.analyses).where(eq(schema.analyses.id, old.id)))[0]).toEqual(old);
    expect(await database.select().from(schema.aiRuns).where(eq(schema.aiRuns.requirementId, requirement.id))).toHaveLength(2);
    const after = await owner.list();
    expect(after.quotations).toEqual(before.quotations); expect(after.history).toEqual(before.history);
    expect(after.quotations.find(row => row.id === q.id)?.status).toBe('confirmed');
  });
  it('revoked team membership and deleted users cannot access persisted data', async () => {
    await database.delete(schema.teamMembers).where(eq(schema.teamMembers.userId, memberId));
    await expect(member.list()).rejects.toThrow(); await expect(member.execute({ action: 'saveRequirement', data: demoCases[0] })).rejects.toThrow();
    const cached = (await owner.list()).requirements[0];
    await owner.execute({ action: 'analyze', id: cached.id, revision: cached.revision });
    await database.update(schema.users).set({ deletedAt: new Date() }).where(eq(schema.users.id, ownerId));
    await expect(owner.list()).rejects.toThrow();
    await expect(owner.execute({ action: 'analyze', id: cached.id, revision: cached.revision })).rejects.toThrow();
  });
});
