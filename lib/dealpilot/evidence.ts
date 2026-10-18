// Deliberately limited grammar. Preserve complete source spans; unsupported or
// ambiguous forms stay unknown rather than becoming numeric/date prefixes.
const unsafe = /参考|示例|样例|案例|例如|举例|假设|并非|不是|不代表|不承诺|不保证|否认|否定|拒绝|不接受|不认可|取消|撤销|作废|无效|失效|不再|未定|待定|尚未|未确定|未知|不确定|未确认|待确认|暂定|可能|预计|大约|大概|约为|左右|不到|不超过|至少|至多|以上|以下|上限|下限|之前|之后|以前|以后|前后|\b(?:not|no|never|unknown|uncertain|unconfirmed|undecided|pending|tentative|cancelled|canceled|revoked|invalid|void|withdrawn|rejected|denied|discarded|reference|sample|example|hypothetical|estimated|estimate|approximately|approx|about|around|under|over|TBD|TBC|might|could|cannot)\b|\bmay\s+(?:be|change|move|deliver|finish|complete)\b|\b\w+n['’]t\b|\b(?:up to|at least|at most|less than|more than|to be confirmed|to be determined)\b/i;
const instructions = /忽略.{0,20}指令|攻击者|不是客户事实|请输出|系统提示|泄露.{0,12}密钥|ignore.{0,30}instructions|system\s*prompt|api\s*key|prompt\s*injection|developer\s*message/i;
const budgetMarker = /预算|\bbudget\b/i;
const deliveryMarker = /交付|交期|截止|截至|交货|\bdeliver(?:y)?\b|\bdeadline\b|\bdue\b/i;
const budgetReference = /预算|金额|报价|\b(?:budget|amount|price|quote)\b/i;
const deliveryReference = /交付|交期|截止|交货|日期|时间|\b(?:delivery|deadline|date|due)\b/i;
const cancelledProject = /项目.{0,12}(?:取消|撤销|作废)|\bproject\b.{0,20}\b(?:cancelled|canceled|withdrawn)\b/i;
type Currency = 'CNY' | 'USD' | 'EUR';
type Money = { text: string; currency: Currency };

export function sourceSentences(content: string) {
  // Do not split decimals (1.5), but include following sentences even when
  // English starts with a lowercase cancellation/uncertainty qualifier.
  return content.split(/(?<=[。！？!?；;\n])|(?<=\.)(?!\d)/u).map(s => s.trim()).filter(Boolean);
}
export function isInstructionTainted(content: string) { return instructions.test(content); }
export function safeSourceExcerpt(excerpt: string, content: string) {
  return !isInstructionTainted(content) && sourceSentences(content).some(s => s.includes(excerpt) && !unsafe.test(s));
}

function fieldSentences(sentences: string[], marker: RegExp, reference: RegExp) {
  const uncertain = (s: string) => unsafe.test(s) || /[?？]/.test(s);
  if (sentences.some(s => (reference.test(s) || cancelledProject.test(s)) && uncertain(s))) return [];
  return sentences.filter((s, i) => marker.test(s) &&
    ![sentences[i - 1], s, sentences[i + 1]].some(context => context && uncertain(context)));
}

// Whitespace alone is not an amount boundary: "USD 2 billion" must never
// become "USD 2". Only punctuation/end or explicit prose transitions qualify.
function completeBoundary(text: string, end: number) {
  const remaining = text.slice(end);
  if (/^[A-Za-z0-9_]/.test(remaining)) return false;
  const tail = remaining.trimStart();
  if (!tail) return true;
  if (/^[.,]/.test(tail)) return !/^[.,]\d/.test(tail);
  if (/^[，。；;!?！？)）\]]/.test(tail)) return true;
  if (/^[A-Za-z]/.test(tail)) return /^(?:and|for|with|including|excluding)\b/i.test(tail);
  return /^(?:用于|用来|包含|包括|且|并|交付|交期|截止)/u.test(tail);
}

function moneyIn(sentence: string): Money[] | null {
  const values: Money[] = [];
  const covered: Array<[number, number]> = [];
  const numeric = /^(?:\d+|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d{1,2})?$/;
  for (const match of sentence.matchAll(/(?<![A-Za-z0-9_])(?:人民币|RMB|CNY|美元|USD|US\$|欧元|EUR|[¥￥$€])/gi)) {
    const start = match.index, afterCurrency = start + match[0].length;
    const number = sentence.slice(afterCurrency).match(/^\s*(\d(?:[\d,.]*\d)?)/);
    if (!number) return null;
    let end = afterCurrency + number[0].length;
    covered.push([start, end]);
    if (!numeric.test(number[1])) return null;
    const currency: Currency = /^(?:人民币|RMB|CNY|[¥￥])$/i.test(match[0]) ? 'CNY' : /^(?:美元|USD|US\$|\$)$/i.test(match[0]) ? 'USD' : 'EUR';
    const unit = sentence.slice(end).match(currency === 'CNY' ? /^\s*(?:万(?:\s*元)?|千(?:\s*元)?|元)/u : /^\s*(?:thousand|million)\b/i);
    if (unit) end += unit[0].length;
    if (!completeBoundary(sentence, end)) return null;
    const text = sentence.slice(start, end);
    if (text.length > 300) return null;
    values.push({ text, currency });
  }
  // A suffix 元 is explicit CNY, including bare "10万元" and "1.5 万元".
  // Skip numbers already covered by a currency-prefixed span; never reinterpret
  // an unsupported USD expression as a smaller, nested CNY expression.
  for (const match of sentence.matchAll(/(?<![A-Za-z0-9_.,])\d(?:[\d,.]*\d)?\s*(?:万\s*|千\s*)?元/gu)) {
    if (covered.some(([start, end]) => start <= match.index && match.index < end)) continue;
    const number = match[0].match(/^\d(?:[\d,.]*\d)?/)![0];
    if (!numeric.test(number) || !completeBoundary(sentence, match.index + match[0].length)) return null;
    // Do not infer CNY from a suffix inside an unsupported currency expression.
    const before = sentence.slice(0, match.index);
    if (!/(?:预算(?:总额|金额)?(?:已确认)?(?:为|是|共|总计)?|budget(?: is)?)[：:\s]*$/i.test(before)) return null;
    values.push({ text: match[0], currency: 'CNY' });
  }
  return values;
}

const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
function calendarDate(text: string) {
  const chinese = text.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/);
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const english = text.replace(/^(?:delivery by|deliver by)\s+/i, '').match(/^([A-Za-z]+) (\d{1,2}),\s*(\d{4})$/);
  const parts = chinese ?? iso;
  const year = parts ? Number(parts[1]) : english ? Number(english[3]) : 0;
  const month = parts ? Number(parts[2]) : english ? months.indexOf(english[1].toLowerCase()) + 1 : 0;
  const day = parts ? Number(parts[3]) : english ? Number(english[2]) : 0;
  return year >= 1000 && year <= 9999 && month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}
function datesIn(sentence: string): string[] | null {
  const values: string[] = [];
  const pattern = /(?<![A-Za-z0-9_])(?:\d{4}年\d{1,2}月\d{1,2}日|(?:\d{4}-\d{2}-\d{2})|(?:(?:Delivery by|deliver by)\s+)?(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2},\s*\d{4})/gi;
  for (const match of sentence.matchAll(pattern)) {
    if (!calendarDate(match[0]) || !completeBoundary(sentence, match.index + match[0].length)) return null;
    values.push(match[0]);
  }
  return values;
}
export function sameCompleteDate(excerpt: string | null, fact: string | null) {
  if (!excerpt || !fact) return false;
  // Both forms contain the complete date; only the optional delivery label may
  // differ. A year, month, day or numeric prefix alone can never validate.
  const withoutLabel = (s: string) => s.replace(/^(?:delivery by|deliver by)\s+/i, '');
  return calendarDate(excerpt) && withoutLabel(excerpt) === withoutLabel(fact);
}

export function conservativeFacts(content: string): { budget: string | null; currency: Currency | null; delivery: string | null } {
  const unknown = { budget: null, currency: null, delivery: null };
  if (isInstructionTainted(content)) return unknown;
  const sentences = sourceSentences(content);
  const budgets = fieldSentences(sentences, budgetMarker, budgetReference).map(moneyIn);
  const dates = fieldSentences(sentences, deliveryMarker, deliveryReference).map(datesIn);
  const money = budgets.some(v => v === null) ? [] : budgets.flatMap(v => v ?? []);
  const delivery = dates.some(v => v === null) ? [] : dates.flatMap(v => v ?? []);
  const uniqueMoney = [...new Map(money.map(v => [v.text, v])).values()];
  const uniqueDates = [...new Set(delivery)];
  return {
    budget: uniqueMoney.length === 1 ? uniqueMoney[0].text : null,
    currency: uniqueMoney.length === 1 ? uniqueMoney[0].currency : null,
    delivery: uniqueDates.length === 1 ? uniqueDates[0] : null
  };
}
export function clarificationQuestions(missing: string[], language: 'zh' | 'en') {
  const zh = language === 'zh';
  return [
    ...(missing.includes('budget') || missing.includes('currency') ? [zh ? '可接受的预算范围和币种是什么？' : 'What is the budget range and currency?'] : []),
    ...(missing.includes('delivery') ? [zh ? '期望何时交付？是否有硬性截止日期？' : 'What is the delivery deadline?'] : []),
    zh ? '请确认交付清单、数量和验收标准。' : 'Please confirm deliverables, quantities and acceptance criteria.'
  ];
}
