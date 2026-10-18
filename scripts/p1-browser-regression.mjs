import assert from 'node:assert/strict';
import fs from 'node:fs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const base = new URL(process.env.P1_BROWSER_BASE_URL ?? 'http://localhost:3100').origin;
if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('Browser acceptance requires a local disposable instance');
const email = process.env.P1_BROWSER_EMAIL, password = process.env.P1_BROWSER_PASSWORD;
if (!email?.endsWith('@example.invalid') || !password) throw new Error('Explicit fictional browser test account required');
const artifact = process.env.P1_BROWSER_ARTIFACT_DIR ?? 'work/browser';
fs.mkdirSync(artifact, { recursive: true });
(async () => {
 const browser = await chromium.launch({ executablePath: process.env.P1_CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
 const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, timezoneId: 'Asia/Shanghai' });
 const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 const results=[];
 const check=(name)=>{results.push(name); console.log('PASS '+name)};
 await page.goto(`${base}/dashboard/workbench`);
 await page.waitForURL('**/sign-in'); check('anonymous workbench redirects to sign-in');
 assert.equal((await page.request.get(`${base}/api/dealpilot`)).status(),401); check('anonymous API denied');
 assert.equal((await page.request.get(`${base}/api/stripe/checkout`)).status(),503); check('Stripe remains disabled');
 await page.getByLabel('Email',{exact:true}).fill(email);
 await page.getByLabel('Password',{exact:true}).fill(password);
 await page.getByRole('button',{name:'Sign in',exact:true}).click(); await page.waitForURL('**/dashboard');
 await page.goto(`${base}/dashboard/workbench`); await page.getByText('◌ Demo 演示模式').waitFor(); check('real login and workbench load');
 await page.getByRole('button',{name:'服务价目表',exact:true}).click();
 for (const row of [{name:'虚构网站基础包',service:'website',currency:'CNY',price:'1800000'},{name:'Fictional brand package',service:'design',currency:'USD',price:'250000'},{name:'虚构翻译服务包',service:'translation',currency:'CNY',price:'150000'}]) {
   await page.getByLabel('服务名称',{exact:true}).fill(row.name);
   await page.locator('select[name="service"]').selectOption(row.service);
   await page.locator('select[name="currency"]').selectOption(row.currency);
   await page.locator('input[name="unitCents"]').fill(row.price);
   await page.getByRole('button',{name:'添加价目',exact:true}).click(); await page.getByRole('status').filter({hasText:'服务价目已保存'}).waitFor();
 }
 check('owner adds three persisted price catalog entries');
 const cases=[{title:'虚构案例 · 青禾咖啡',currency:'CNY'},{title:'Fictional · Northstar Studio',currency:'USD'},{title:'虚构案例 · 星桥文创（待补充）',currency:'CNY'}];
 for (let i=0;i<cases.length;i++) {
   const c=cases[i];
   await page.getByRole('button',{name:`载入 ${c.title}`,exact:true}).click();
   await page.getByRole('button',{name:'保存需求',exact:true}).click(); await page.getByRole('status').filter({hasText:'需求已保存'}).waitFor();
   await page.getByRole('button',{name:'前往 AI 分析'}).click();
   await page.getByRole('button',{name:'分析客户需求',exact:true}).click(); await page.getByRole('status').filter({hasText:'分析已保存'}).waitFor();
   if(i===2) { assert.equal(await page.getByText('未知 · 待客户确认',{exact:true}).count(),2); }
   await page.screenshot({path:`${artifact}/case-${i+1}-analysis.png`,fullPage:true});
   await page.getByRole('button',{name:'下一步：生成报价'}).click();
   await page.getByLabel('报价币种').selectOption(c.currency);
   await page.getByRole('button',{name:'生成草稿',exact:true}).click(); await page.getByRole('status').filter({hasText:'报价草稿已生成'}).waitFor();
   const article=page.locator('article').last();
   assert.equal(await article.getByRole('button',{name:'人工确认正式报价'}).isDisabled(),true);
   if(i===0) {
     await article.getByLabel('数量',{exact:true}).fill('2');
     await article.getByRole('button',{name:'保存报价修改',exact:true}).click(); await page.getByRole('status').filter({hasText:'报价修改已保存'}).waitFor();
     assert.match(await page.locator('.dp-total').innerText(),/36,000/);
     check('quote edits recalculate exact CNY 36000 total');
   }
   await page.locator('article').last().getByRole('checkbox').check();
   await page.locator('article').last().getByRole('button',{name:'人工确认正式报价'}).click(); await page.getByRole('status').filter({hasText:'正式报价已人工确认'}).waitFor();
   await page.getByText('✓ 已人工确认',{exact:true}).waitFor();
   assert.equal(await page.locator('article').last().getByLabel('数量',{exact:true}).isDisabled(),true);
   await page.screenshot({path:`${artifact}/case-${i+1}-quote.png`,fullPage:true});
   check(`fictional case ${i+1}: save, analyze, draft, explicit confirm, lock`);
 }
 await page.getByRole('button',{name:'历史记录',exact:true}).click();
 assert.equal(await page.locator('details').count(),7); check('all seven creation/edit/confirmation snapshots visible');
 await page.reload(); await page.getByText('◌ Demo 演示模式').waitFor();
 await page.locator('.dp-requirement').nth(2).waitFor(); assert.equal(await page.locator('.dp-requirement').count(),3); check('three requirements persist after page reload');
 await page.screenshot({path:`${artifact}/workbench-desktop.png`,fullPage:true});
 await page.setViewportSize({width:390,height:844}); await page.getByRole('button',{name:'智能报价',exact:true}).click();
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
 await page.screenshot({path:`${artifact}/workbench-mobile.png`,fullPage:true}); check('390px mobile layout has no horizontal overflow');
 assert.deepEqual(errors,[]); check('no browser runtime errors');

 // B1: the editing version must not be silently upgraded by an unrelated load.
 await page.setViewportSize({ width: 1440, height: 1100 });
 async function post(command) {
   const response = await page.request.post(`${base}/api/dealpilot`, { headers: { origin: base, 'content-type': 'application/json' }, data: command });
   const data = await response.json(); assert.equal(response.status(), 200, JSON.stringify(data)); return data;
 }
 const req = (title, content) => ({ title, content, service: 'website', language: 'zh' });
 const original = req('虚构 B1-A', '虚构 A 初始需求，仅用于回归。');
 const remote = req('虚构 B1-A 已由另一个会话保存', '虚构 A 远端 V2，旧编辑器不得覆盖。');
 const a = await post({ action: 'saveRequirement', data: original });
 await page.reload(); await page.getByRole('button', { name: /虚构 B1-A/ }).click();
 await post({ action: 'saveRequirement', id: a.id, revision: 1, data: remote });
 await page.getByRole('button', { name: '服务价目表', exact: true }).click();
 await page.getByLabel('服务名称', { exact: true }).fill('虚构触发刷新价目');
 await page.locator('input[name=unitCents]').fill('100');
 await page.getByRole('button', { name: '添加价目', exact: true }).click();
 await page.getByRole('status').filter({ hasText: '服务价目已保存' }).waitFor();
 await page.getByRole('button', { name: '客户需求', exact: true }).click();
 assert.equal(await page.locator('textarea').inputValue(), original.content);
 await page.getByRole('button', { name: '保存需求', exact: true }).click();
 await page.getByRole('alert').filter({ hasText: '版本已更新' }).waitFor();
 let workspace = await (await page.request.get(`${base}/api/dealpilot`)).json();
 assert.equal(workspace.requirements.find(r => r.id === a.id).content, remote.content);
 check('B1: stale editor keeps V1 and cannot overwrite remote V2 after a workspace refresh');
 // B1: selection is locked during save, and only the matching editor is updated.
 const x = await post({ action: 'saveRequirement', data: req('虚构 B1-X', '虚构 X 初始需求，仅用于回归。') });
 const y = await post({ action: 'saveRequirement', data: req('虚构 B1-Y', '虚构 Y 独立需求，不应复制到 X。') });
 await page.reload(); await page.getByRole('button', { name: /虚构 B1-X/ }).click();
 await page.locator('textarea').fill('虚构 X 的新内容，必须保存到 X。');
 let entered, release;
 const arrived = new Promise(resolve => entered = resolve), gate = new Promise(resolve => release = resolve);
 const interceptor = async route => {
   const request = route.request(); const command = request.method() === 'POST' ? request.postDataJSON() : null;
   if (command?.action === 'saveRequirement' && command.id === x.id) { const response = await route.fetch(); entered(); await gate; await route.fulfill({ response }); }
   else await route.continue();
 };
 await page.route('**/api/dealpilot', interceptor);
 await page.getByRole('button', { name: '保存需求', exact: true }).click(); await arrived;
 assert.equal(await page.getByRole('button', { name: /虚构 B1-Y/ }).isDisabled(), true);
 assert.equal(await page.locator('textarea').isDisabled(), true);
 release(); await page.getByRole('status').filter({ hasText: '需求已保存' }).waitFor();
 await page.unroute('**/api/dealpilot', interceptor);
 assert.equal(await page.locator('.dp-requirement.active strong').innerText(), '虚构 B1-X');
 await page.getByRole('button', { name: /虚构 B1-Y/ }).click();
 assert.equal(await page.locator('textarea').inputValue(), '虚构 Y 独立需求，不应复制到 X。');
 workspace = await (await page.request.get(`${base}/api/dealpilot`)).json();
 assert.equal(workspace.requirements.find(r => r.id === x.id).content, '虚构 X 的新内容，必须保存到 X。');
 assert.equal(workspace.requirements.find(r => r.id === y.id).content, '虚构 Y 独立需求，不应复制到 X。');
 check('B1: in-flight save locks record switching; X and Y retain independent contents');
 assert.deepEqual(errors, []);
 await browser.close();
 fs.writeFileSync(`${artifact}/browser-result.json`,JSON.stringify({passed:results.length,results,errors},null,2));
})().catch(e=>{console.error(e);process.exit(1)});
