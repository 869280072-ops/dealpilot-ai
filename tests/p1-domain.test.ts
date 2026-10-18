import { describe, expect, it } from 'vitest';
import { calculateQuote, demoCases, validateEvidence } from '@/lib/dealpilot/domain';
import { demoAnalysis } from '@/lib/dealpilot/ai';

const quote = { currency: 'CNY', language: 'zh', description: '虚构报价', lines: [{ name: '网站', quantity: 3, unitCents: 10001 }, { name: '设计', quantity: 2, unitCents: 2599 }] };
it('calculates exact integer minor units without floating-point rounding', () => expect(calculateQuote(quote).totalCents).toBe(35201));
it.each(['CNY', 'USD', 'EUR'])('preserves %s without exchange conversion', currency => expect(calculateQuote({ ...quote, currency }).totalCents).toBe(35201));
it.each([-1, 0.5, NaN, Infinity, 100000001])('rejects invalid unit prices %s', unitCents => expect(() => calculateQuote({ ...quote, lines: [{ name: 'x', quantity: 1, unitCents }] })).toThrow());
it.each([0, -1, 1.5, 10001])('rejects invalid quantity %s', quantity => expect(() => calculateQuote({ ...quote, lines: [{ name: 'x', quantity, unitCents: 1 }] })).toThrow());
it('rejects excessive total and empty line items', () => {
  expect(() => calculateQuote({ ...quote, lines: [] })).toThrow();
  expect(() => calculateQuote({ ...quote, lines: [{ name: 'x', quantity: 10000, unitCents: 100000000 }] })).toThrow();
});
describe('conservative bilingual demo', () => {
  it('extracts Chinese budget and deadline from exact source text', () => {
    const result = demoAnalysis(demoCases[0]); expect(result.budget).toBe('人民币 18000 元'); expect(result.currency).toBe('CNY'); expect(result.delivery).toBe('2026年12月15日');
  });
  it('extracts English source facts and asks English follow-ups', () => {
    const result = demoAnalysis(demoCases[1]); expect(result.budget).toBe('USD 2500'); expect(result.currency).toBe('USD'); expect(result.delivery).toBe('Delivery by December 20, 2026'); expect(result.questions[0]).toContain('Please');
  });
  it('does not invent missing budget or deadline', () => {
    const result = demoAnalysis(demoCases[2]); expect(result.budget).toBeNull(); expect(result.delivery).toBeNull(); expect(result.missing).toEqual(expect.arrayContaining(['budget', 'currency', 'delivery'])); expect(result.questions).toHaveLength(3);
  });
});
it('rejects unsupported facts, extra fields and guessed currencies', () => {
  const result = demoAnalysis(demoCases[2]);
  expect(() => validateEvidence({ ...result, budget: 'USD 5000' }, demoCases[2].content)).toThrow();
  expect(() => validateEvidence({ ...result, delivery: 'tomorrow' }, demoCases[2].content)).toThrow();
  expect(() => validateEvidence({ ...result, currency: 'USD' }, demoCases[2].content)).toThrow();
  expect(() => validateEvidence({ ...result, tool: 'read-secrets' }, demoCases[2].content)).toThrow();
});
