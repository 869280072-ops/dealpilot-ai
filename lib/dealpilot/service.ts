import 'server-only';
import { z } from 'zod';
import { and, eq, desc, isNull, sql } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import { createHash } from 'node:crypto';
import { requirements, analyses, catalog, quotations, quoteHistory, teamMembers, users, mutationReceipts, aiRuns } from '@/lib/db/schema';
import { requirementSchema, catalogSchema, quoteSchema, currencySchema, calculateQuote, ANALYSIS_POLICY_VERSION } from './domain';
import { analyzeRequirement, analysisProfile } from './ai';

const id = z.number().int().positive();
export const commandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('saveRequirement'), id: id.optional(), revision: id.optional(), data: requirementSchema }).strict(),
  z.object({ action: z.literal('analyze'), id, revision: id }).strict(),
  z.object({ action: z.literal('saveCatalog'), requestId: z.string().uuid(), data: catalogSchema }).strict(),
  z.object({ action: z.literal('generateQuote'), requestId: z.string().uuid(), id, currency: currencySchema }).strict(),
  z.object({ action: z.literal('editQuote'), id, revision: id, data: quoteSchema }).strict(),
  z.object({ action: z.literal('confirmQuote'), id, revision: id, confirmed: z.literal(true) }).strict()
]);
export class BusinessError extends Error {}
export class RateLimitError extends BusinessError {}
const deny = () => { throw new BusinessError('记录不存在、权限不足或版本已更新，请刷新后重试。'); };

// Actor identity comes exclusively from the verified server session, never JSON.
// Factory is also used by integration tests against their isolated database.
export function createDealPilotService(database: typeof db, userId: number) {
  async function authorized<T>(run: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0], membership: typeof teamMembers.$inferSelect) => Promise<T>) {
    return database.transaction(async tx => {
      const [user] = await tx.select({ id: users.id }).from(users).where(and(eq(users.id, userId), isNull(users.deletedAt))).for('share');
      if (!user) return deny();
      const [membership] = await tx.select().from(teamMembers).where(eq(teamMembers.userId, userId)).orderBy(teamMembers.id).limit(1).for('share');
      if (!membership) return deny();
      return run(tx, membership);
    });
  }
  async function list() {
    return authorized(async (tx, m) => {
      const scope = and(eq(requirements.userId, userId), eq(requirements.teamId, m.teamId));
      const ownRequirements = await tx.select().from(requirements).where(scope).orderBy(desc(requirements.updatedAt)).limit(100);
      const ownAnalyses = await tx.select({ analysis: analyses }).from(analyses).innerJoin(requirements, eq(analyses.requirementId, requirements.id)).where(scope).orderBy(desc(analyses.id)).limit(200);
      const ownQuotes = await tx.select({ quote: quotations }).from(quotations).innerJoin(requirements, eq(quotations.requirementId, requirements.id)).where(scope).orderBy(desc(quotations.id)).limit(200);
      const history = await tx.select({ event: quoteHistory }).from(quoteHistory).innerJoin(quotations, eq(quoteHistory.quotationId, quotations.id)).innerJoin(requirements, eq(quotations.requirementId, requirements.id)).where(scope).orderBy(desc(quoteHistory.id)).limit(300);
      return { requirements: ownRequirements, analyses: ownAnalyses.map(x => x.analysis), quotations: ownQuotes.map(x => x.quote), history: history.map(x => x.event), catalog: await tx.select().from(catalog).where(and(eq(catalog.teamId, m.teamId), isNull(catalog.archivedAt))).orderBy(catalog.id).limit(200), role: m.role };
    });
  }
  async function execute(raw: unknown) {
    const command = commandSchema.parse(raw);
    if (command.action === 'analyze') {
      const profile = analysisProfile();
      const claim = await authorized(async (tx, m) => {
        const [r] = await tx.select().from(requirements).where(and(eq(requirements.id, command.id), eq(requirements.userId, userId), eq(requirements.teamId, m.teamId), eq(requirements.revision, command.revision)));
        if (!r) return deny();
        // Global lock is held only while reserving live work and checking rolling
        // budgets, never during the provider request. Demo reservations use an
        // actor lock. Both are shared across all application processes.
        await tx.execute(sql`select pg_advisory_xact_lock(${profile.mode === 'live' ? 31100 : 31101}, ${profile.mode === 'live' ? 0 : userId})`);
        const [existing] = await tx.select().from(aiRuns).where(and(eq(aiRuns.userId, userId), eq(aiRuns.requirementId, r.id), eq(aiRuns.revision, r.revision), eq(aiRuns.mode, profile.mode), eq(aiRuns.profile, profile.profile)));
        if (existing) {
          if (existing.teamId !== m.teamId) return deny();
          if (existing.status === 'succeeded' && existing.analysisId) {
            const [cached] = await tx.select().from(analyses).where(eq(analyses.id, existing.analysisId));
            if (!cached) return deny();
            return { kind: 'cached' as const, analysis: cached };
          }
          throw new BusinessError(existing.status === 'running'
            ? '本版本分析正在处理或结果待核实；不会重复调用模型，请稍后查看。'
            : '本版本分析曾失败，为避免重复费用不会自动重试，请联系管理员核实调用记录。');
        }
        if (profile.mode === 'live') {
          const limit = (name: string, fallback: number, maximum: number) => z.coerce.number().int().min(0).max(maximum).parse(process.env[name] ?? fallback);
          const hourly = limit('DEALPILOT_AI_USER_HOURLY_LIMIT', 5, 100);
          const daily = limit('DEALPILOT_AI_USER_DAILY_LIMIT', 20, 1000);
          const globalDaily = limit('DEALPILOT_AI_GLOBAL_DAILY_LIMIT', 100, 10000);
          const [usage] = await tx.select({
            hour: sql<number>`count(*) filter (where ${aiRuns.userId} = ${userId} and ${aiRuns.createdAt} > now() - interval '1 hour')`,
            day: sql<number>`count(*) filter (where ${aiRuns.userId} = ${userId})`,
            global: sql<number>`count(*)`,
            running: sql<number>`count(*) filter (where ${aiRuns.userId} = ${userId} and ${aiRuns.status} = 'running')`
          }).from(aiRuns).where(and(eq(aiRuns.mode, 'live'), sql`${aiRuns.createdAt} > now() - interval '24 hours'`));
          // Also block an unresolved reservation older than the rolling window.
          const [unresolved] = await tx.select({ id: aiRuns.id }).from(aiRuns).where(and(eq(aiRuns.userId, userId), eq(aiRuns.mode, 'live'), eq(aiRuns.status, 'running'))).limit(1);
          if (unresolved || Number(usage.running)) throw new RateLimitError('已有真实模型调用尚未完成或待核实，暂不接受新的调用。');
          if (Number(usage.hour) >= hourly || Number(usage.day) >= daily || Number(usage.global) >= globalDaily) throw new RateLimitError('真实模型调用配额已用尽，请稍后重试或联系管理员。');
        }
        const [run] = await tx.insert(aiRuns).values({ userId, teamId: m.teamId, requirementId: r.id, revision: r.revision, ...profile }).returning();
        return { kind: 'claimed' as const, input: r, run };
      });
      if (claim.kind === 'cached') return claim.analysis;
      try {
        const input = claim.input;
        const output = await analyzeRequirement(requirementSchema.parse({ title: input.title, content: input.content, service: input.service, language: input.language }));
        return await authorized(async (tx, m) => {
          const [r] = await tx.select().from(requirements).where(and(eq(requirements.id, input.id), eq(requirements.userId, userId), eq(requirements.teamId, m.teamId), eq(requirements.revision, input.revision))).for('update');
          if (!r || claim.run.teamId !== m.teamId) return deny();
          const [saved] = await tx.insert(analyses).values({ requirementId: r.id, revision: r.revision, ...output }).returning();
          await tx.update(aiRuns).set({ status: 'succeeded', analysisId: saved.id, finishedAt: new Date() }).where(eq(aiRuns.id, claim.run.id));
          return saved;
        });
      } catch (error) {
        // Internal bookkeeping for this actor's already authorized reservation,
        // even if membership was revoked while the provider was running. Never
        // retry an uncertain/failed paid call automatically or release its slot.
        await database.update(aiRuns).set({ status: 'failed', finishedAt: new Date() }).where(and(eq(aiRuns.id, claim.run.id), eq(aiRuns.userId, userId), eq(aiRuns.status, 'running')));
        throw error;
      }
    }
    return authorized(async (tx, m) => {
      if (command.action === 'saveCatalog') {
        if (m.role !== 'owner') return deny();
        const hash = createHash('sha256').update(JSON.stringify(command)).digest('hex');
        await tx.execute(sql`select pg_advisory_xact_lock(31102, ${userId})`);
        const [receipt] = await tx.select().from(mutationReceipts).where(and(eq(mutationReceipts.userId, userId), eq(mutationReceipts.requestId, command.requestId)));
        if (receipt && (receipt.teamId !== m.teamId || receipt.action !== command.action || receipt.requestHash !== hash)) throw new BusinessError('请求标识已用于其他内容，请刷新后重试。');
        const match = and(eq(catalog.teamId, m.teamId), eq(catalog.service, command.data.service), eq(catalog.currency, command.data.currency), sql`lower(btrim(${catalog.name})) = lower(btrim(${command.data.name}))`, isNull(catalog.archivedAt));
        if (receipt) {
          const [saved] = await tx.select().from(catalog).where(and(match, eq(catalog.id, receipt.resultId)));
          if (!saved) return deny();
          return saved;
        }
        const [inserted] = await tx.insert(catalog).values({ ...command.data, teamId: m.teamId }).onConflictDoNothing().returning();
        const saved = inserted ?? (await tx.select().from(catalog).where(match))[0];
        if (!saved || saved.unitCents !== command.data.unitCents) throw new BusinessError('此服务项目已存在且单价不同，请人工核对，不会重复新增或覆盖。');
        await tx.insert(mutationReceipts).values({ userId, teamId: m.teamId, requestId: command.requestId, action: command.action, requestHash: hash, resultId: saved.id });
        return saved;
      }
      if (command.action === 'saveRequirement' && !command.id) {
        return (await tx.insert(requirements).values({ ...command.data, userId, teamId: m.teamId }).returning())[0];
      }
      if (command.action === 'editQuote' || command.action === 'confirmQuote') {
        const [record] = await tx.select({ q: quotations, r: requirements }).from(quotations).innerJoin(requirements, eq(quotations.requirementId, requirements.id)).where(and(eq(quotations.id, command.id), eq(requirements.userId, userId), eq(requirements.teamId, m.teamId))).for('update');
        if (!record || record.q.status !== 'draft' || record.q.revision !== command.revision) return deny();
        const { q, r } = record;
        if (command.action === 'confirmQuote' && q.requirementRevision !== r.revision) throw new BusinessError('需求已修改，请重新分析并生成报价后确认。');
        if (command.action === 'confirmQuote') {
          const [source] = await tx.select({ policyVersion: analyses.policyVersion }).from(analyses).where(eq(analyses.id, q.analysisId));
          if (source?.policyVersion !== ANALYSIS_POLICY_VERSION) throw new BusinessError('旧安全策略生成的草稿需要重新分析并生成后确认。');
        }
        const data = calculateQuote(command.action === 'editQuote' ? command.data : { currency: q.data.currency, language: q.data.language, description: q.data.description, lines: q.data.lines });
        const status = command.action === 'confirmQuote' ? 'confirmed' : 'draft';
        const [updated] = await tx.update(quotations).set({ data, status, revision: q.revision + 1, ...(status === 'confirmed' ? { confirmedAt: new Date(), confirmedBy: userId } : {}) }).where(eq(quotations.id, q.id)).returning();
        await tx.insert(quoteHistory).values({ quotationId: q.id, revision: updated.revision, status, data, actorId: userId });
        return updated;
      }
      const [r] = await tx.select().from(requirements).where(and(eq(requirements.id, command.id!), eq(requirements.userId, userId), eq(requirements.teamId, m.teamId))).for('update');
      if (!r) return deny();
      if (command.action === 'saveRequirement') {
        if (command.revision !== r.revision) return deny();
        return (await tx.update(requirements).set({ ...command.data, revision: r.revision + 1, updatedAt: new Date() }).where(eq(requirements.id, r.id)).returning())[0];
      }
      if (command.action !== 'generateQuote') return deny();
      const hash = createHash('sha256').update(JSON.stringify(command)).digest('hex');
      await tx.execute(sql`select pg_advisory_xact_lock(31102, ${userId})`);
      const [receipt] = await tx.select().from(mutationReceipts).where(and(eq(mutationReceipts.userId, userId), eq(mutationReceipts.requestId, command.requestId)));
      if (receipt) {
        if (receipt.teamId !== m.teamId || receipt.action !== command.action || receipt.requestHash !== hash) throw new BusinessError('请求标识已用于其他内容，请刷新后重试。');
        const [saved] = await tx.select().from(quotations).where(and(eq(quotations.id, receipt.resultId), eq(quotations.requirementId, r.id)));
        if (!saved) return deny();
        return saved;
      }
      const [a] = await tx.select().from(analyses).where(and(eq(analyses.requirementId, r.id), eq(analyses.revision, r.revision), eq(analyses.policyVersion, ANALYSIS_POLICY_VERSION))).orderBy(desc(analyses.id)).limit(1);
      if (!a || a.policyVersion !== ANALYSIS_POLICY_VERSION) throw new BusinessError('请先分析当前版本的需求；旧安全策略的分析需要重新生成。');
      const items = await tx.select().from(catalog).where(and(eq(catalog.teamId, m.teamId), eq(catalog.service, a.result.service), eq(catalog.currency, command.currency), isNull(catalog.archivedAt))).orderBy(catalog.id).limit(20);
      if (!items.length) throw new BusinessError('此服务与币种尚无价目表，请联系团队 owner 添加。不会自动换汇。');
      const description = r.language === 'zh' ? '根据需求分析与团队价目表生成的范围待确认草稿。每项暂按 1 单位，请人工核对工作量、单价、税费及交付范围；未包含自动换汇。' : 'Draft based on requirement analysis and the team catalog. Each item starts at one unit. Please review quantities, prices, taxes and scope. No currency conversion is applied.';
      const data = calculateQuote({ currency: command.currency, language: r.language, description, lines: items.map(i => ({ name: i.name, quantity: 1, unitCents: i.unitCents })) });
      const [q] = await tx.insert(quotations).values({ requirementId: r.id, requirementRevision: r.revision, analysisId: a.id, data }).returning();
      await tx.insert(quoteHistory).values({ quotationId: q.id, revision: 1, status: 'draft', data, actorId: userId });
      await tx.insert(mutationReceipts).values({ userId, teamId: m.teamId, requestId: command.requestId, action: command.action, requestHash: hash, resultId: q.id });
      return q;
    });
  }
  return { list, execute };
}
