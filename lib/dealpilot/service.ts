import 'server-only';
import { z } from 'zod';
import { and, eq, desc, isNull } from 'drizzle-orm';
import { db } from '@/lib/db/drizzle';
import { requirements, analyses, catalog, quotations, quoteHistory, teamMembers, users } from '@/lib/db/schema';
import { requirementSchema, catalogSchema, quoteSchema, currencySchema, calculateQuote } from './domain';
import { analyzeRequirement } from './ai';

const id = z.number().int().positive();
export const commandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('saveRequirement'), id: id.optional(), revision: id.optional(), data: requirementSchema }).strict(),
  z.object({ action: z.literal('analyze'), id, revision: id }).strict(),
  z.object({ action: z.literal('saveCatalog'), data: catalogSchema }).strict(),
  z.object({ action: z.literal('generateQuote'), id, currency: currencySchema }).strict(),
  z.object({ action: z.literal('editQuote'), id, revision: id, data: quoteSchema }).strict(),
  z.object({ action: z.literal('confirmQuote'), id, revision: id, confirmed: z.literal(true) }).strict()
]);
export class BusinessError extends Error {}
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
      return { requirements: ownRequirements, analyses: ownAnalyses.map(x => x.analysis), quotations: ownQuotes.map(x => x.quote), history: history.map(x => x.event), catalog: await tx.select().from(catalog).where(eq(catalog.teamId, m.teamId)).orderBy(catalog.id).limit(200), role: m.role };
    });
  }
  async function execute(raw: unknown) {
    const command = commandSchema.parse(raw);
    if (command.action === 'analyze') {
      const input = await authorized(async (tx, m) => {
        const [r] = await tx.select().from(requirements).where(and(eq(requirements.id, command.id), eq(requirements.userId, userId), eq(requirements.teamId, m.teamId), eq(requirements.revision, command.revision)));
        if (!r) return deny();
        return r;
      });
      const output = await analyzeRequirement(requirementSchema.parse({ title: input.title, content: input.content, service: input.service, language: input.language }));
      // Reauthorize and verify the version after the external call, so a removed
      // member or changed requirement cannot receive a stale saved analysis.
      return authorized(async (tx, m) => {
        const [r] = await tx.select().from(requirements).where(and(eq(requirements.id, input.id), eq(requirements.userId, userId), eq(requirements.teamId, m.teamId), eq(requirements.revision, input.revision))).for('update');
        if (!r) return deny();
        return (await tx.insert(analyses).values({ requirementId: r.id, revision: r.revision, ...output }).returning())[0];
      });
    }
    return authorized(async (tx, m) => {
      if (command.action === 'saveCatalog') {
        if (m.role !== 'owner') return deny();
        return (await tx.insert(catalog).values({ ...command.data, teamId: m.teamId }).returning())[0];
      }
      if (command.action === 'saveRequirement' && !command.id) {
        return (await tx.insert(requirements).values({ ...command.data, userId, teamId: m.teamId }).returning())[0];
      }
      if (command.action === 'editQuote' || command.action === 'confirmQuote') {
        const [record] = await tx.select({ q: quotations, r: requirements }).from(quotations).innerJoin(requirements, eq(quotations.requirementId, requirements.id)).where(and(eq(quotations.id, command.id), eq(requirements.userId, userId), eq(requirements.teamId, m.teamId))).for('update');
        if (!record || record.q.status !== 'draft' || record.q.revision !== command.revision) return deny();
        const { q, r } = record;
        if (command.action === 'confirmQuote' && q.requirementRevision !== r.revision) throw new BusinessError('需求已修改，请重新分析并生成报价后确认。');
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
      const [a] = await tx.select().from(analyses).where(and(eq(analyses.requirementId, r.id), eq(analyses.revision, r.revision))).orderBy(desc(analyses.id)).limit(1);
      if (!a) throw new BusinessError('请先分析当前版本的需求。');
      const items = await tx.select().from(catalog).where(and(eq(catalog.teamId, m.teamId), eq(catalog.service, a.result.service), eq(catalog.currency, command.currency))).orderBy(catalog.id).limit(20);
      if (!items.length) throw new BusinessError('此服务与币种尚无价目表，请联系团队 owner 添加。不会自动换汇。');
      const description = r.language === 'zh' ? '根据需求分析与团队价目表生成的范围待确认草稿。每项暂按 1 单位，请人工核对工作量、单价、税费及交付范围；未包含自动换汇。' : 'Draft based on requirement analysis and the team catalog. Each item starts at one unit. Please review quantities, prices, taxes and scope. No currency conversion is applied.';
      const data = calculateQuote({ currency: command.currency, language: r.language, description, lines: items.map(i => ({ name: i.name, quantity: 1, unitCents: i.unitCents })) });
      const [q] = await tx.insert(quotations).values({ requirementId: r.id, requirementRevision: r.revision, analysisId: a.id, data }).returning();
      await tx.insert(quoteHistory).values({ quotationId: q.id, revision: 1, status: 'draft', data, actorId: userId });
      return q;
    });
  }
  return { list, execute };
}
