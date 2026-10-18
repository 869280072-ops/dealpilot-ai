// Conservative extraction, not a semantic truth detector. Ambiguity stays unknown.
const unsafe = /参考|示例|案例|例如|并非|不是|不代表|不承诺|未定|待定|尚未|未确定|未知|不确定|待确认|\b(?:not|unknown|example|reference|sample|hypothetical|unconfirmed|tentative|TBD)\b/i;
const instructions = /忽略.{0,20}指令|攻击者|不是客户事实|请输出|系统提示|泄露.{0,12}密钥|ignore.{0,30}instructions|system\s*prompt|api\s*key|prompt\s*injection|developer\s*message/i;
const unknownBudget = /预算[^。！？\n]{0,30}(?:未定|未确定|尚未|未知|不确定|待定|待确认)|\bbudget\b[^.!?\n]{0,40}(?:unknown|not|undecided|TBD|to be confirmed|to be determined)|no\s+(?:confirmed\s+)?budget/i;
const unknownDelivery = /(?:交期|交付时间|截止日期|交货时间)[^。！？\n]{0,30}(?:未定|未确定|尚未|未知|不确定|待定|待确认)|\b(?:delivery|deadline|due date)\b[^.!?\n]{0,40}(?:unknown|not|undecided|TBD|to be confirmed|to be determined)|no\s+(?:confirmed\s+)?deadline/i;
export function sourceSentences(content: string) {
  return content.split(/(?<=[。！？!?；;\n])|(?<=\.)\s+(?=[A-Z])/u).map(s => s.trim()).filter(Boolean);
}
export function isInstructionTainted(content: string) { return instructions.test(content); }
export function safeSourceExcerpt(excerpt: string, content: string) {
  return !isInstructionTainted(content) && sourceSentences(content).some(s => s.includes(excerpt) && !unsafe.test(s));
}
export function conservativeFacts(content: string) {
  if (isInstructionTainted(content)) return { budget: null, delivery: null };
  const sentences = sourceSentences(content).filter(s => !unsafe.test(s) && !/[?？]/.test(s));
  const budgets = sentences.filter(s => /预算|\bbudget\b/i.test(s)).flatMap(s => [...s.matchAll(/(?:人民币|RMB|CNY|USD|美元|EUR|欧元|US\$|\$|￥|¥|€)\s*\d[\d,]*(?:\.\d{1,2})?(?:\s*元)?/gi)].map(m => m[0]));
  const dates = sentences.filter(s => /交付|交期|截止|交货|\bdeliver(?:y)?\b|\bdeadline\b|\bdue\b/i.test(s)).flatMap(s => [...s.matchAll(/\d{4}年\d{1,2}月\d{1,2}日|(?:Delivery by|deliver by)\s+[A-Za-z]+ \d{1,2}, \d{4}|\d{4}-\d{2}-\d{2}/gi)].map(m => m[0]));
  const uniqueBudget = [...new Set(budgets)], uniqueDates = [...new Set(dates)];
  return {
    budget: !unknownBudget.test(content) && uniqueBudget.length === 1 ? uniqueBudget[0] : null,
    delivery: !unknownDelivery.test(content) && uniqueDates.length === 1 ? uniqueDates[0] : null
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
