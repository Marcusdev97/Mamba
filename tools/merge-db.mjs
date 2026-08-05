// 把另一台电脑的 mamba.sqlite 并进这台的资料。
//
//   node tools/merge-db.mjs --from campaign-data/incoming/xxx.sqlite            # 只对账,不写任何东西
//   node tools/merge-db.mjs --from campaign-data/incoming/xxx.sqlite --apply    # 产生新档案
//   node tools/merge-db.mjs --from ... --apply --out campaign-data/merged.sqlite
//
// 安全设计(照 campaign-app/migrate_v2_to_v3.mjs 的规矩):
//   · 预设 --dry-run:只数、只出报告,一个字都不写。
//   · --apply 也**绝不改动 base 库**,只产生一个新档案(预设 campaign-data/mamba.merged.sqlite)。
//   · base 用 VACUUM INTO 复制,连 WAL 里还没落盘的资料一起带走。
//   · 冲突用 updated_at 决胜:来源那台比较新才覆盖,否则保留这台的。
//   · 跑完自动 PRAGMA quick_check + foreign_key_check,任一失败就中止。
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseSchemaText } from './lib/parse-schema.mjs';
import { ROOT, DEFAULT_DB } from './lib/snapshot.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const APPLY = argv.includes('--apply');

// 这几张是「每台电脑自己的配置和队列」,不是业务资料,跨机合并只会互相打架:
//   metadata            expected_sender_key / storage_mode 之类,是本机身份
//   sync_worker_state   本机 sync worker 的状态
//   sync_jobs           本机待同步 Notion 的队列 —— 并过来等于让这台去跑她的任务
//   instance_identity   本机 Evolution instance 的身份
//   schema_migrations   本机迁移记录
// 真的要连配置一起并,加 --include-config。
const CONFIG_TABLES = new Set(['metadata', 'sync_worker_state', 'sync_jobs', 'instance_identity', 'schema_migrations']);
const SKIP = new Set([
  ...(argv.includes('--include-config') ? [] : CONFIG_TABLES),
  ...(flag('--skip', '') || '').split(',').filter(Boolean),
]);

const fromPath = flag('--from');
if (!fromPath) {
  console.error('要指定来源:--from campaign-data/incoming/xxx.sqlite');
  process.exit(1);
}
const FROM = path.resolve(ROOT, fromPath);
const BASE = path.resolve(ROOT, flag('--base', DEFAULT_DB));
const OUT = path.resolve(ROOT, flag('--out', 'campaign-data/mamba.merged.sqlite'));

for (const [label, p] of [['来源', FROM], ['base', BASE]]) {
  if (!existsSync(p)) { console.error(`${label}库不存在:${p}`); process.exit(1); }
}

// WAL 库若少了 -shm,唯读打不开;immutable 告诉 SQLite「这档案不会变」,直接读。
const openRead = (p) => new DatabaseSync(`file:${p}?immutable=1`, { readOnly: true });

const schemaOf = (db) => {
  const ddl = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.sql.replace(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["`[]?(\w+)["`\]]?\s*\(/i, 'CREATE TABLE IF NOT EXISTS $1 ('))
    .join(';\n');
  return parseSchemaText(ddl);
};

const src = openRead(FROM);
const base = openRead(BASE);
const srcTables = schemaOf(src);
const baseTables = schemaOf(base);
const baseByName = Object.fromEntries(baseTables.map((t) => [t.name, t]));

// 父表先插,否则外键会拦
function fkOrder(tables) {
  const byName = Object.fromEntries(tables.map((t) => [t.name, t]));
  const done = new Set(), visiting = new Set(), order = [];
  const visit = (name) => {
    if (done.has(name) || visiting.has(name)) return;
    visiting.add(name);
    for (const c of byName[name].columns) {
      if (c.ref && c.ref.table !== name && byName[c.ref.table]) visit(c.ref.table);
    }
    visiting.delete(name);
    done.add(name);
    order.push(byName[name]);
  };
  tables.forEach((t) => visit(t.name));
  return order;
}

// ---------------------------------------------------------------------------
// 1. 对账:每张表会新增几行、更新几行、因为比较旧而略过几行
// ---------------------------------------------------------------------------
const plan = [];
const notes = [];

for (const t of fkOrder(srcTables)) {
  if (SKIP.has(t.name)) { notes.push(`跳过 ${t.name}:每台电脑自己的配置/队列,不跨机合并`); continue; }
  const baseT = baseByName[t.name];
  if (!baseT) { notes.push(`跳过 ${t.name}:这台的库没有这张表`); continue; }

  const shared = t.columns.map((c) => c.name).filter((n) => baseT.columns.some((c) => c.name === n));
  const onlyThere = t.columns.map((c) => c.name).filter((n) => !shared.includes(n));
  if (onlyThere.length) notes.push(`${t.name}:来源多出的栏位会被丢掉(${onlyThere.join(', ')})`);

  const pk = baseT.columns.filter((c) => c.pk).map((c) => c.name);
  const rows = src.prepare(`SELECT ${shared.map((c) => `"${c}"`).join(', ')} FROM "${t.name}"`).all();
  if (!rows.length) continue;

  const hasUpdatedAt = shared.includes('updated_at');
  let add = 0, update = 0, older = 0, same = 0, keep = 0;

  if (pk.length) {
    const where = pk.map((c) => `"${c}" = ?`).join(' AND ');
    const find = base.prepare(`SELECT ${hasUpdatedAt ? 'updated_at' : '1 AS updated_at'} FROM "${t.name}" WHERE ${where}`);
    for (const r of rows) {
      const hit = find.get(...pk.map((c) => r[c]));
      if (!hit) { add++; continue; }
      if (!hasUpdatedAt) { keep++; continue; }   // 没有 updated_at 可比,一律保留本机的
      const a = String(r.updated_at ?? ''), b = String(hit.updated_at ?? '');
      if (a > b) update++; else if (a < b) older++; else same++;
    }
  } else {
    add = rows.length;
    notes.push(`${t.name}:没有主键,一律当新增(可能产生重复行)`);
  }

  plan.push({ table: t.name, cols: shared, pk, rows, add, update, older: older + keep, same, hasUpdatedAt });
}

const total = plan.reduce((a, p) => ({
  add: a.add + p.add, update: a.update + p.update, older: a.older + p.older, same: a.same + p.same,
}), { add: 0, update: 0, older: 0, same: 0 });

console.log(`\n来源:${path.relative(ROOT, FROM)}`);
console.log(`base:${path.relative(ROOT, BASE)}\n`);
console.log('表'.padEnd(24) + '新增'.padStart(8) + '更新'.padStart(8) + '保留本机'.padStart(11) + '相同'.padStart(9));
console.log('─'.repeat(62));
for (const p of plan) {
  if (!p.add && !p.update && !p.older && !p.same) continue;
  console.log(
    p.table.padEnd(24) + String(p.add).padStart(8) + String(p.update).padStart(8) +
    String(p.older).padStart(11) + String(p.same).padStart(9)
  );
}
console.log('─'.repeat(62));
console.log('合计'.padEnd(24) + String(total.add).padStart(8) + String(total.update).padStart(8) +
  String(total.older).padStart(11) + String(total.same).padStart(9));
if (notes.length) console.log('\n注意:\n' + notes.map((n) => '  · ' + n).join('\n'));

src.close();
base.close();

if (!APPLY) {
  console.log('\n这是 dry-run,什么都没写。确认没问题再加 --apply。');
  console.log('--apply 会产生一个新档案,你现在的 mamba.sqlite 不会被动到。\n');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 2. --apply:复制 base → out,再把来源的资料 upsert 进去。原库全程不动。
// ---------------------------------------------------------------------------
if (existsSync(OUT)) {
  console.error(`\n输出档已存在,先移开或换个 --out:${OUT}`);
  process.exit(1);
}
mkdirSync(path.dirname(OUT), { recursive: true });

console.log(`\n复制 base → ${path.relative(ROOT, OUT)}(VACUUM INTO,连 WAL 一起带)…`);
{
  const b = new DatabaseSync(BASE, { readOnly: true });
  b.exec(`VACUUM INTO '${OUT.replace(/'/g, "''")}'`);
  b.close();
}

const out = new DatabaseSync(OUT);
out.exec('PRAGMA foreign_keys = OFF');   // 依赖顺序已经排好,关掉可以快很多
out.exec('BEGIN');
let wrote = 0;
try {
  for (const p of plan) {
    if (!p.rows.length) continue;
    const cols = p.cols.map((c) => `"${c}"`).join(', ');
    const holes = p.cols.map(() => '?').join(', ');
    // created_at 是「这台什么时候第一次看到这行」,永远不该被别台覆盖。
    const rest = p.cols.filter((c) => !p.pk.includes(c) && c !== 'created_at');
    // 没有 updated_at 就没有裁决依据(例如 messages):已存在的行一律保留本机版本,
    // 只补新的。否则同一则讯息在两台的分类/方向不同时,会被对方的版本盖掉。
    const conflict = !p.pk.length || !rest.length || !p.hasUpdatedAt
      ? 'ON CONFLICT DO NOTHING'
      : `ON CONFLICT (${p.pk.map((c) => `"${c}"`).join(', ')}) DO UPDATE SET ` +
        rest.map((c) => `"${c}" = excluded."${c}"`).join(', ') +
        ` WHERE excluded.updated_at > "${p.table}".updated_at`;
    const stmt = out.prepare(`INSERT INTO "${p.table}" (${cols}) VALUES (${holes}) ${conflict}`);
    for (const r of p.rows) { stmt.run(...p.cols.map((c) => r[c] ?? null)); wrote++; }
  }
  out.exec('COMMIT');
} catch (error) {
  out.exec('ROLLBACK');
  out.close();
  rmSync(OUT, { force: true });
  console.error(`\n合并失败,已回滚并删掉输出档:${error.message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 3. 体检:坏了就不给你用
// ---------------------------------------------------------------------------
out.exec('PRAGMA foreign_keys = ON');
const quick = out.prepare('PRAGMA quick_check').get();
const fkBad = out.prepare('PRAGMA foreign_key_check').all();
const counts = {};
for (const t of ['contacts', 'project_leads', 'conversations', 'messages', 'devices', 'whatsapp_connections']) {
  try { counts[t] = out.prepare(`SELECT count(*) AS n FROM "${t}"`).get().n; } catch { /* 没这表 */ }
}
out.close();

const ok = Object.values(quick)[0] === 'ok' && !fkBad.length;
console.log(`\nquick_check: ${Object.values(quick)[0]}`);
console.log(`foreign_key_check: ${fkBad.length ? `${fkBad.length} 处问题` : '干净'}`);
if (!ok) {
  console.error('\n体检没过,输出档留着给你看,但别拿去用。');
  process.exit(1);
}

console.log('\n合并后的行数:');
for (const [t, n] of Object.entries(counts)) console.log(`  ${t.padEnd(22)} ${n}`);

const report = path.join(path.dirname(OUT), `merge-report-${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}.txt`);
writeFileSync(report, JSON.stringify({ from: FROM, base: BASE, out: OUT, total, plan: plan.map(({ rows, ...p }) => p), notes }, null, 2));

console.log(`\n✓ ${path.relative(ROOT, OUT)}`);
console.log(`  报告:${path.relative(ROOT, report)}`);
console.log(`\n你现在的 ${path.relative(ROOT, BASE)} 完全没被动过。`);
console.log('先用面板看看合并结果:');
console.log(`  node tools/sql-html/serve.mjs --db=${path.relative(ROOT, OUT)}\n`);
