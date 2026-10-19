import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

const url = process.env.P1_MIGRATION_DATABASE_URL;
if (!url) throw new Error('Explicit isolated migration test database required');
const target = new URL(url);
if (!['localhost', '127.0.0.1'].includes(target.hostname) || !/^\/dealpilot_p1_test_[a-z0-9_]+$/.test(target.pathname)) throw new Error('Migration regression requires a local dealpilot_p1_test_* database');
const sql = postgres(url, { max: 1, connect_timeout: 3 });
const oldFolder = await mkdtemp(join(tmpdir(), 'dealpilot-old-migrations-'));
try {
  assert.equal((await sql`select tablename from pg_tables where schemaname='public'`).length, 0, 'Database must start empty');
  const journal = JSON.parse(await readFile('lib/db/migrations/meta/_journal.json', 'utf8'));
  await mkdir(join(oldFolder, 'meta'));
  await writeFile(join(oldFolder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.filter(e => e.idx < 3) }));
  for (const entry of journal.entries.filter(e => e.idx < 3)) await writeFile(join(oldFolder, `${entry.tag}.sql`), await readFile(`lib/db/migrations/${entry.tag}.sql`));
  const db = drizzle(sql);
  await migrate(db, { migrationsFolder: oldFolder });
  const [user] = await sql`insert into users(email,password_hash) values ('migration@example.invalid','synthetic-only') returning id`;
  const [team] = await sql`insert into teams(name) values ('虚构迁移团队') returning id`;
  await sql`insert into team_members(user_id,team_id,role) values (${user.id},${team.id},'owner')`;
  const [req] = await sql`insert into requirements(user_id,team_id,title,content,service,language) values (${user.id},${team.id},'虚构历史需求','虚构历史内容，迁移不应覆盖。','website','zh') returning id`;
  const result = JSON.stringify({ service: 'website', budget: null, currency: null, delivery: null, requirements: [], missing: [], questions: [] });
  const [analysis] = await sql`insert into requirement_analyses(requirement_id,revision,mode,model,result) values (${req.id},1,'demo','legacy',${result}::jsonb) returning id`;
  const data = JSON.stringify({ currency: 'CNY', language: 'zh', description: '虚构历史报价', lines: [{ name: '旧服务', quantity: 1, unitCents: 10000 }], totalCents: 10000 });
  const [quote] = await sql`insert into quotations(requirement_id,requirement_revision,analysis_id,data) values (${req.id},1,${analysis.id},${data}::jsonb) returning id`;
  await sql`insert into quotation_history(quotation_id,revision,status,data,actor_id) values (${quote.id},1,'draft',${data}::jsonb,${user.id})`;
  await sql`insert into service_catalog(team_id,name,service,currency,unit_cents) values (${team.id},'冲突项目','website','CNY',10000),(${team.id},'冲突项目','website','CNY',20000)`;
  const beforeQuote = await sql`select * from quotations`, beforeHistory = await sql`select * from quotation_history`;
  await assert.rejects(migrate(db, { migrationsFolder: 'lib/db/migrations' }));
  assert.equal((await sql`select count(*)::int as n from drizzle.__drizzle_migrations`)[0].n, 3);
  assert.equal((await sql`select to_regclass('public.ai_runs') as table_name`)[0].table_name, null);
  assert.equal((await sql`select count(*)::int as n from information_schema.columns where table_schema='public' and table_name='service_catalog' and column_name='archived_at'`)[0].n, 0);
  assert.deepEqual((await sql`select unit_cents from service_catalog order by id`).map(r => r.unit_cents), [10000, 20000]);
  // Synthetic operator review: normalize this fixture's prices, then retry.
  await sql`update service_catalog set unit_cents=10000 where team_id=${team.id}`;
  await migrate(db, { migrationsFolder: 'lib/db/migrations' });
  assert.equal((await sql`select count(*)::int as n from service_catalog where archived_at is null`)[0].n, 1);
  assert.equal((await sql`select count(*)::int as n from service_catalog where archived_at is not null`)[0].n, 1);
  assert.equal((await sql`select policy_version from requirement_analyses where id=${analysis.id}`)[0].policy_version, 'legacy');
  assert.deepEqual(await sql`select * from quotations`, beforeQuote);
  assert.deepEqual(await sql`select * from quotation_history`, beforeHistory);
  await migrate(db, { migrationsFolder: 'lib/db/migrations' });
  assert.equal((await sql`select count(*)::int as n from drizzle.__drizzle_migrations`)[0].n, 4);
  console.log('PASS: ambiguous prices roll back all new DDL/data changes; identical duplicates archive safely; quote/history snapshots preserved; rerun is a no-op');
} finally {
  await sql.end();
  await rm(oldFolder, { recursive: true, force: true });
}
