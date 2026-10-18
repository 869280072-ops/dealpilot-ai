import { z } from 'zod';
import { conservativeFacts, safeSourceExcerpt, isInstructionTainted, clarificationQuestions } from './evidence';

export const ANALYSIS_POLICY_VERSION = 'p1-safe-v2';

export const serviceSchema = z.enum(['website', 'design', 'translation', 'consulting']);
export const currencySchema = z.enum(['CNY', 'USD', 'EUR']);
export const requirementSchema = z.object({
  title: z.string().trim().min(1).max(120),
  content: z.string().trim().min(5).max(12000),
  service: serviceSchema,
  language: z.enum(['zh', 'en'])
}).strict();
export const analysisSchema = z.object({
  service: serviceSchema,
  budget: z.string().max(300).nullable(),
  currency: currencySchema.nullable(),
  delivery: z.string().max(300).nullable(),
  requirements: z.array(z.string().min(1).max(500)).max(12),
  missing: z.array(z.enum(['budget', 'currency', 'delivery', 'scope'])).max(4),
  questions: z.array(z.string().min(1).max(300)).max(8)
}).strict();
export type Analysis = z.infer<typeof analysisSchema>;
export const lineSchema = z.object({
  name: z.string().trim().min(1).max(120),
  quantity: z.number().int().min(1).max(10000),
  unitCents: z.number().int().min(0).max(100000000)
}).strict();
export const quoteSchema = z.object({
  currency: currencySchema,
  language: z.enum(['zh', 'en']),
  description: z.string().trim().min(1).max(4000),
  lines: z.array(lineSchema).min(1).max(20)
}).strict();
export type QuoteInput = z.infer<typeof quoteSchema>;
export const catalogSchema = lineSchema.omit({ quantity: true }).extend({
  service: serviceSchema, currency: currencySchema
}).strict();

export function calculateQuote(input: unknown) {
  const quote = quoteSchema.parse(input);
  const totalCents = quote.lines.reduce((total, line) => total + line.quantity * line.unitCents, 0);
  if (!Number.isSafeInteger(totalCents) || totalCents > 2000000000) throw new Error('报价金额超过上限');
  return { ...quote, totalCents };
}

// Facts must be literal excerpts, never inferred amounts or dates. Currency is
// accepted only with an explicit currency marker in the quoted budget excerpt.
export function validateEvidence(value: unknown, content: string, language: 'zh' | 'en' = 'zh', selectedService?: Analysis['service']): Analysis {
  const result = analysisSchema.parse(value);
  for (const excerpt of [result.budget, result.delivery, ...result.requirements]) {
    if (excerpt !== null && (!excerpt.trim() || !content.includes(excerpt))) throw new Error('Unsupported AI fact');
  }
  const markers = { CNY: /人民币|RMB|CNY|¥|￥/i, USD: /美元|USD|US\$|\$/i, EUR: /欧元|EUR|€/i };
  if (result.currency && (!result.budget || !markers[result.currency].test(result.budget))) throw new Error('Unsupported currency');
  const facts = conservativeFacts(content);
  const supported = (excerpt: string | null, fact: string | null) => excerpt && fact && /\d/.test(excerpt) && (excerpt.includes(fact) || fact.includes(excerpt));
  if (!supported(result.budget, facts.budget)) { result.budget = null; result.currency = null; }
  if (!supported(result.delivery, facts.delivery)) result.delivery = null;
  result.requirements = result.requirements.filter(s => safeSourceExcerpt(s, content));
  if (isInstructionTainted(content) && selectedService) result.service = selectedService;
  result.missing = [
    ...(!result.budget ? ['budget' as const] : []),
    ...(!result.currency ? ['currency' as const] : []),
    ...(!result.delivery ? ['delivery' as const] : []),
    ...(!result.requirements.length || result.missing.includes('scope') ? ['scope' as const] : [])
  ];
  // Model questions cannot introduce assumptions or numbers. Follow-ups are
  // generated from validated missing fields, in the requested language.
  result.questions = clarificationQuestions(result.missing, language);
  return result;
}

export const serviceLabels = { website: '网站开发', design: '品牌设计', translation: '翻译服务', consulting: '咨询服务' };
export const demoCases = [
  { title: '虚构案例 · 青禾咖啡', service: 'website' as const, language: 'zh' as const, content: '我们是虚构的青禾咖啡，需要一个中英双语品牌网站，包含菜单、门店信息和联系表单。预算人民币 18000 元，交付时间为 2026年12月15日。需要适配手机。' },
  { title: 'Fictional · Northstar Studio', service: 'design' as const, language: 'en' as const, content: 'We are fictional Northstar Studio. We need a logo and a short brand guide. Our budget is USD 2500. Delivery by December 20, 2026. Please include two revision rounds.' },
  { title: '虚构案例 · 星桥文创（待补充）', service: 'translation' as const, language: 'zh' as const, content: '我们是虚构的星桥文创，需要将产品介绍翻译成英文，并保持品牌语气。文档字数、项目预算和交付时间尚未确定，希望先讨论服务范围。' }
];
