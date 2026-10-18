'use client';
import { useCallback, useEffect, useState } from 'react';
import { Sparkles, FileText, History, ListChecks, Plus, ArrowRight, CheckCircle2 } from 'lucide-react';
import { calculateQuote, demoCases, serviceLabels, type QuoteInput } from '@/lib/dealpilot/domain';
import type { createDealPilotService } from '@/lib/dealpilot/service';
import './workbench.css';

type Workspace = Awaited<ReturnType<ReturnType<typeof createDealPilotService>['list']>> & { mode: 'demo' | 'live' };
type Requirement = Workspace['requirements'][number];
type Quote = Workspace['quotations'][number];
const blank = { title: '', content: '', service: 'website', language: 'zh' };
const money = (n: number, currency: string) => new Intl.NumberFormat('zh-CN', { style: 'currency', currency }).format(n / 100);
const date = (v: unknown) => new Date(String(v)).toLocaleString('zh-CN');

export default function Workbench() {
  const [workspace, setWorkspace] = useState<Workspace>();
  const [tab, setTab] = useState('requirements');
  const [selected, setSelected] = useState<number>();
  const [form, setForm] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [currency, setCurrency] = useState('CNY');
  const load = useCallback(async () => {
    const response = await fetch('/api/dealpilot', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? '加载失败');
    setWorkspace(data);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/dealpilot', { cache: 'no-store', signal: controller.signal })
      .then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.error ?? '加载失败'); return data; })
      .then(data => setWorkspace(data)).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, []);
  async function execute(command: unknown, success: string) {
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch('/api/dealpilot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? '操作失败');
      await load(); setNotice(success); return result;
    } catch (e) { setError(e instanceof Error ? e.message : '操作失败'); return null; }
    finally { setBusy(false); }
  }
  const current = workspace?.requirements.find(r => r.id === selected);
  const analysis = workspace?.analyses.find(a => a.requirementId === selected && a.revision === current?.revision);
  const quotes = workspace?.quotations ?? [];
  function choose(r: Requirement) { setSelected(r.id); setForm({ title: r.title, content: r.content, service: r.service, language: r.language }); setNotice(''); }
  const tabs = [{ id: 'requirements', label: '客户需求', icon: FileText }, { id: 'analysis', label: 'AI 需求分析', icon: Sparkles }, { id: 'quotes', label: '智能报价', icon: ListChecks }, { id: 'history', label: '历史记录', icon: History }, { id: 'catalog', label: '服务价目表', icon: Plus }];
  return <div className="dp">
    <header className="dp-header"><div><p className="dp-eyebrow">DEALPILOT AI / WORKSPACE</p><h1>让需求更清晰，让报价更有据。</h1><p>从客户的一句话，到你确认的专业报价。</p></div><span className="dp-mode">{workspace?.mode === 'live' ? '● 真实模型模式' : '◌ Demo 演示模式'}</span></header>
    <div className="dp-stats"><div><strong>{workspace?.requirements.length ?? '—'}</strong><span>客户需求</span></div><div><strong>{quotes.filter(q => q.status === 'draft').length}</strong><span>待审核草稿</span></div><div><strong>{quotes.filter(q => q.status === 'confirmed').length}</strong><span>已确认报价</span></div></div>
    <nav className="dp-tabs" aria-label="工作台">{tabs.map(t => <button key={t.id} aria-current={tab === t.id ? 'page' : undefined} onClick={() => setTab(t.id)}><t.icon size={16}/>{t.label}</button>)}</nav>
    {error && <div role="alert" className="dp-error">{error} <button onClick={() => load().catch(e => setError(e.message))}>重新加载</button></div>}
    {notice && <div role="status" className="dp-notice">{notice}</div>}
    {!workspace && !error && <p role="status">正在加载工作台…</p>}
    <div className="dp-columns"><aside className="dp-panel dp-list"><div className="dp-panel-title"><h2>我的客户需求</h2><button aria-label="新建需求" onClick={() => { setSelected(undefined); setForm(blank); setTab('requirements'); }}><Plus size={18}/></button></div>
      {workspace?.requirements.length === 0 && <p className="dp-muted">还没有需求。创建第一条，或载入下方虚构案例。</p>}
      {workspace?.requirements.map(r => <button className={`dp-requirement ${selected === r.id ? 'active' : ''}`} key={r.id} onClick={() => choose(r)}><strong>{r.title}</strong><span>{serviceLabels[r.service as keyof typeof serviceLabels]} · V{r.revision}</span><small>{date(r.updatedAt)}</small></button>)}
      <div className="dp-demos"><p>虚构客户演示案例</p>{demoCases.map(c => <button key={c.title} onClick={() => { setSelected(undefined); setForm(c); setTab('requirements'); }}>载入 {c.title}<ArrowRight size={13}/></button>)}</div>
    </aside><section className="dp-main">
      {tab === 'requirements' && <form className="dp-panel" onSubmit={async e => { e.preventDefault(); const result = await execute({ action: 'saveRequirement', ...(current ? { id: current.id, revision: current.revision } : {}), data: form }, '需求已保存。修改后请重新分析；历史报价会保留。'); if (result) setSelected(result.id); }}>
        <div className="dp-panel-title"><div><p className="dp-eyebrow">01 / REQUIREMENTS</p><h2>{current ? '编辑客户需求' : '创建客户需求'}</h2></div><span className="dp-chip">仅本人可见</span></div>
        <label>需求名称<input required maxLength={120} value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="例如：青禾咖啡品牌网站"/></label>
        <div className="dp-row"><label>服务类型<select value={form.service} onChange={e => setForm({ ...form, service: e.target.value })}>{Object.entries(serviceLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label>分析与报价语言<select value={form.language} onChange={e => setForm({ ...form, language: e.target.value })}><option value="zh">中文</option><option value="en">English</option></select></label></div>
        <label>客户需求原文<textarea required minLength={5} maxLength={12000} rows={9} value={form.content} onChange={e => setForm({ ...form, content: e.target.value })} placeholder="粘贴中文或英文需求。可以包含服务范围、预算、币种、期望交期与核心要求。未知信息请留空。"/></label>
        <p className="dp-muted">支持中文与英文 · {form.content.length}/12000 · 请仅使用虚构演示数据</p><div className="dp-actions"><button className="dp-primary" disabled={busy}>保存需求</button>{current && <button type="button" onClick={() => setTab('analysis')}>前往 AI 分析 <ArrowRight size={15}/></button>}</div>
      </form>}
      {tab === 'analysis' && <div className="dp-panel"><p className="dp-eyebrow">02 / INTELLIGENCE</p><h2>AI 智能需求分析</h2><p className="dp-muted">{current ? current.title : '请先在左侧选择一条已保存的需求。'}</p><p className="dp-callout">{workspace?.mode === 'live' ? '真实模型分析 · 输出需要人工核实。' : 'Demo 模式 · 使用保守规则提取，未调用真实大模型。'} 未明确提供的预算和交期将标记为未知。</p>
        <button className="dp-primary" disabled={busy || !current} onClick={() => current && execute({ action: 'analyze', id: current.id, revision: current.revision }, '分析已保存。请核实原文摘录和待追问信息。')}><Sparkles size={16}/>{busy ? '处理中…' : analysis ? '重新分析' : '分析客户需求'}</button>
        {analysis && <div className="dp-analysis"><span className="dp-chip">{analysis.mode === 'demo' ? 'Demo' : '真实模型'} · 需求 V{analysis.revision}</span><dl><dt>建议服务</dt><dd>{serviceLabels[analysis.result.service]}</dd><dt>预算原文</dt><dd>{analysis.result.budget ?? '未知 · 待客户确认'}</dd><dt>币种</dt><dd>{analysis.result.currency ?? '未知'}</dd><dt>交期原文</dt><dd>{analysis.result.delivery ?? '未知 · 待客户确认'}</dd></dl><h3>核心要求（原文摘录）</h3>{analysis.result.requirements.length ? <ul>{analysis.result.requirements.map((s, i) => <li key={i}>{s}</li>)}</ul> : <p className="dp-muted">未提取核心要求，请人工核对客户原文。</p>}<h3>缺少的信息</h3><p>{analysis.result.missing.map(s => ({ budget: '预算', currency: '币种', delivery: '交付时间', scope: '详细范围' })[s]).join('、') || '模型未标记缺失项，请人工核实。'}</p><h3>建议追问（AI 建议）</h3><ul>{analysis.result.questions.map((s, i) => <li key={i}>{s}</li>)}</ul><button onClick={() => setTab('quotes')}>下一步：生成报价 <ArrowRight size={15}/></button></div>}
      </div>}
      {tab === 'quotes' && <><div className="dp-panel"><p className="dp-eyebrow">03 / QUOTATION</p><h2>生成报价草稿</h2><p className="dp-muted">{current?.title ?? '请先选择需求并完成分析。'} · AI 推荐服务，程序按价目表精确计算金额。</p><div className="dp-row"><label>报价币种<select value={currency} onChange={e => setCurrency(e.target.value)}><option>CNY</option><option>USD</option><option>EUR</option></select></label><button className="dp-primary" disabled={busy || !analysis} onClick={() => current && execute({ action: 'generateQuote', id: current.id, currency }, '报价草稿已生成。请编辑工作量、价格和说明后，人工确认。')}>生成草稿 <ArrowRight size={16}/></button></div><p className="dp-muted">不自动换汇。草稿不代表客户接受；每项默认 1 单位，需人工核对。</p></div>
        {quotes.filter(q => !selected || q.requirementId === selected).map(q => <QuoteEditor key={`${q.id}-${q.revision}`} quote={q} busy={busy} execute={execute}/>)}{quotes.length === 0 && <p className="dp-muted">报价历史为空，先为已分析的需求生成草稿。</p>}</>}
      {tab === 'history' && <div className="dp-panel"><p className="dp-eyebrow">04 / HISTORY</p><h2>报价历史与确认记录</h2><p className="dp-muted">每次保存与人工确认均保留独立快照。正式报价不可再修改。</p>{workspace?.history.map(event => <details className="dp-history" key={event.id}><summary><span>报价 #{event.quotationId} · V{event.revision} · {event.status === 'confirmed' ? '已人工确认' : '草稿'}</span><strong>{money(event.data.totalCents, event.data.currency)}</strong></summary><p>{date(event.createdAt)}</p><p>{event.data.description}</p>{event.data.lines.map((l, i) => <p key={i}>{l.name} × {l.quantity} · {money(l.unitCents, event.data.currency)}</p>)}</details>)}{!workspace?.history.length && <p className="dp-muted">暂无记录。生成第一份报价后会显示在这里。</p>}</div>}
      {tab === 'catalog' && <div className="dp-panel"><p className="dp-eyebrow">05 / SERVICE CATALOG</p><h2>团队服务价目表</h2><p className="dp-muted">团队成员可查看；仅 owner 可新增。单价按所选币种保存，无自动换汇。报价保留生成时的价格快照。</p><div className="dp-catalog">{workspace?.catalog.map(i => <div key={i.id}><strong>{i.name}</strong><span>{serviceLabels[i.service as keyof typeof serviceLabels]}</span><b>{money(i.unitCents, i.currency)}</b></div>)}</div>{workspace?.role === 'owner' ? <CatalogForm busy={busy} execute={execute}/> : <p className="dp-callout">请联系团队 owner 维护价目表。</p>}</div>}
    </section></div><footer className="dp-footer">DEALPILOT AI · P1 MVP · 人工决策，AI 辅助 · 支付未接入</footer>
  </div>;
}

type Executor = (command: unknown, success: string) => Promise<unknown>;
function QuoteEditor({ quote: q, busy, execute }: { quote: Quote; busy: boolean; execute: Executor }) {
  const [draft, setDraft] = useState<QuoteInput>({ currency: q.data.currency, language: q.data.language, description: q.data.description, lines: q.data.lines });
  const [confirmed, setConfirmed] = useState(false);
  const [edited, setEdited] = useState(false);
  let total = 0; let valid = true;
  try { total = calculateQuote(draft).totalCents; } catch { valid = false; }
  const locked = q.status === 'confirmed';
  function update(next: QuoteInput) { setDraft(next); setEdited(true); setConfirmed(false); }
  return <article className="dp-panel"><div className="dp-panel-title"><h2>报价 #{q.id} <span className="dp-muted">V{q.revision}</span></h2><span className="dp-chip">{locked ? '✓ 已人工确认' : '待审核草稿'}</span></div><p className="dp-muted">需求 #{q.requirementId} · 需求 V{q.requirementRevision}{q.confirmedAt ? ` · 确认于 ${date(q.confirmedAt)}` : ''}</p>
    <fieldset disabled={locked || busy}><div className="dp-row"><label>报价说明语言<select value={draft.language} onChange={e => update({ ...draft, language: e.target.value as 'zh' | 'en' })}><option value="zh">中文</option><option value="en">English</option></select></label><label>币种（金额不会换算）<select value={draft.currency} onChange={e => update({ ...draft, currency: e.target.value as QuoteInput['currency'] })}><option>CNY</option><option>USD</option><option>EUR</option></select></label></div>
    <label>报价说明<textarea rows={3} maxLength={4000} value={draft.description} onChange={e => update({ ...draft, description: e.target.value })}/></label>
    {draft.lines.map((line, i) => <div className="dp-quote-line" key={i}><label>服务项目<input maxLength={120} value={line.name} onChange={e => update({ ...draft, lines: draft.lines.map((l, j) => j === i ? { ...l, name: e.target.value } : l) })}/></label><label>数量<input type="number" min="1" max="10000" step="1" value={line.quantity} onChange={e => update({ ...draft, lines: draft.lines.map((l, j) => j === i ? { ...l, quantity: Number(e.target.value) } : l) })}/></label><label>单价（分 / cents）<input type="number" min="0" max="100000000" step="1" value={line.unitCents} onChange={e => update({ ...draft, lines: draft.lines.map((l, j) => j === i ? { ...l, unitCents: Number(e.target.value) } : l) })}/></label><button aria-label={`移除 ${line.name}`} onClick={() => update({ ...draft, lines: draft.lines.filter((_, j) => j !== i) })}>移除</button></div>)}
    {draft.lines.length < 20 && <button onClick={() => update({ ...draft, lines: [...draft.lines, { name: '新增服务', quantity: 1, unitCents: 0 }] })}><Plus size={14}/>添加项目</button>}</fieldset>
    <div className="dp-total"><span>报价总额 / Total</span><strong>{valid ? money(total, draft.currency) : '请检查金额与数量'}</strong></div>
    {!locked && <><button disabled={busy || !valid || !edited} onClick={() => execute({ action: 'editQuote', id: q.id, revision: q.revision, data: draft }, '报价修改已保存，历史快照已记录。')}>保存报价修改</button><label className="dp-confirm"><input type="checkbox" checked={confirmed} disabled={edited || busy} onChange={e => setConfirmed(e.target.checked)}/>我已核对服务范围、数量、币种、单价及说明，确认此报价成为正式报价。</label>{edited && <p className="dp-muted">请先保存修改，再执行人工确认。</p>}<button className="dp-primary" disabled={busy || !confirmed || edited || !valid} onClick={() => execute({ action: 'confirmQuote', id: q.id, revision: q.revision, confirmed: true }, '正式报价已人工确认并锁定。')}><CheckCircle2 size={16}/>人工确认正式报价</button></>}
  </article>;
}
function CatalogForm({ busy, execute }: { busy: boolean; execute: Executor }) {
  return <form onSubmit={async e => { e.preventDefault(); const target = e.currentTarget; const f = new FormData(target); const result = await execute({ action: 'saveCatalog', data: { name: f.get('name'), service: f.get('service'), currency: f.get('currency'), unitCents: Number(f.get('unitCents')) } }, '服务价目已保存。'); if (result) target.reset(); }}><h3>添加服务项目</h3><label>服务名称<input name="name" required maxLength={120} placeholder="例如：品牌网站基础包"/></label><div className="dp-row"><label>服务类型<select name="service">{Object.entries(serviceLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label><label>币种<select name="currency"><option>CNY</option><option>USD</option><option>EUR</option></select></label><label>单价（分 / cents）<input name="unitCents" required type="number" min="0" max="100000000" step="1" placeholder="1800000 = 18000.00"/></label></div><button className="dp-primary" disabled={busy}>添加价目</button></form>;
}
