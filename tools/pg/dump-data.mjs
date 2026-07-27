// Dump the whole local SQLite database as a PostgreSQL-ready .sql file.
//
//   node tools/pg/dump-data.mjs                      # → mamba-data.pg.sql
//   node tools/pg/dump-data.mjs --out /tmp/x.sql
//   node tools/pg/dump-data.mjs --db campaign-data/backups/xxx.sqlite
//   node tools/pg/dump-data.mjs --skip messages,lid_map
//   node tools/pg/dump-data.mjs --if-newer            # 合并第二台电脑时用这个
//
// 打开数据库用只读模式,绝不写生产库。
// 表的顺序按外键依赖拓扑排序(父表先插),每条 INSERT 带 ON CONFLICT DO NOTHING,
// 所以可以安全地重复执行。
//
// 上传:
//   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f docs/mamba-schema.postgres.sql
//   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f mamba-data.pg.sql
import { writeFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { parseSchemaText } from '../lib/parse-schema.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

const DB_PATH = resolve(ROOT, flag('--db', 'campaign-data/mamba.sqlite'));   // 绝对路径也能用
const OUT = resolve(ROOT, flag('--out', 'mamba-data.pg.sql'));
const SKIP = new Set((flag('--skip', '') || '').split(',').filter(Boolean));
const IF_NEWER = argv.includes('--if-newer');
const BATCH = 500;

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const ddl = db
  .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'")
  .all()
  .map((r) => r.sql.replace(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["`[]?(\w+)["`\]]?\s*\(/i, 'CREATE TABLE IF NOT EXISTS $1 ('))
  .join(';\n');
const tables = parseSchemaText(ddl);
const byName = Object.fromEntries(tables.map((t) => [t.name, t]));

// 这台电脑是谁 —— 每一行都会盖上这个章,之后在 Postgres 里就能分辨
// 「哪台电脑传上来的」。messages 这类本身没有归属栏位的表,全靠它。
const me = (() => {
  const dev = db.prepare('SELECT device_key, device_name FROM devices ORDER BY created_at LIMIT 1').get() || {};
  const phone = (() => {
    try { return db.prepare("SELECT value FROM metadata WHERE key='expected_sender_phone'").get()?.value || ''; }
    catch { return ''; }
  })();
  return { deviceKey: dev.device_key || '', deviceName: dev.device_name || '', phone };
})();
if (!me.deviceKey) {
  console.error('这个库里没有 devices 记录,认不出是哪台电脑。');
  process.exit(1);
}
const SYNCED_AT = new Date().toISOString();

// 父表先建 → 子表后插,否则 Postgres 的外键会拦下来
function fkOrder() {
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

const lit = (v) => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'bigint') return String(v);
  if (Buffer.isBuffer(v)) return `'\\x${v.toString('hex')}'::bytea`;
  return "'" + String(v).replace(/'/g, "''") + "'";
};

const out = [
  `-- Mamba 全量数据 → PostgreSQL`,
  `-- 源: ${relative(ROOT, DB_PATH)} (${(statSync(DB_PATH).size / 1024 / 1024).toFixed(1)} MB) · 导出于 ${new Date().toISOString()}`,
  `-- 先建表: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f docs/mamba-schema.postgres.sql`,
  `-- 再灌数据: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f ${relative(ROOT, OUT)}`,
  '',
  'BEGIN;',
  '',
];

let total = 0;
const summary = [];
for (const t of fkOrder()) {
  if (SKIP.has(t.name)) { summary.push(`${t.name}: 跳过`); continue; }
  const rows = db.prepare(`SELECT * FROM "${t.name}"`).all();
  if (!rows.length) continue;
  const cols = t.columns.map((c) => c.name);
  const stamped = [...cols, 'source_device_key', 'synced_at'];
  // 真正的 upsert:SQLite 的值永远赢。否则建表脚本种下的 metadata / schema_migrations
  // 会因为 DO NOTHING 一直压着你库里的真实值。
  const pk = t.columns.filter((c) => c.pk).map((c) => c.name);
  const rest = cols.filter((c) => !pk.includes(c));
  // --if-newer: 只有这台电脑的行确实更新才覆盖。两台电脑往同一个库推时,
  // contact_key / project_lead_key 都是按电话算的,一定会撞;没有这个守卫的话
  // 「后跑 psql 的那台赢」,可能把另一台更新的 next_flow / send_lock 盖掉。
  const hasUpdatedAt = IF_NEWER && cols.includes('updated_at') && !pk.includes('updated_at');
  const guard = hasUpdatedAt ? `\nWHERE EXCLUDED.updated_at > ${t.name}.updated_at` : '';
  const conflict = !pk.length || !rest.length
    ? 'ON CONFLICT DO NOTHING'
    : `ON CONFLICT (${pk.join(', ')}) DO UPDATE SET\n` +
      [...rest, 'source_device_key', 'synced_at'].map((c) => `  ${c} = EXCLUDED.${c}`).join(',\n') + guard;
  out.push(`-- ${t.name} (${rows.length} 行)`);
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    out.push(`INSERT INTO ${t.name} (${stamped.join(', ')}) VALUES`);
    out.push(chunk.map((r) =>
      '  (' + [...cols.map((c) => lit(r[c])), lit(me.deviceKey), lit(SYNCED_AT)].join(', ') + ')'
    ).join(',\n'));
    out.push(conflict + ';');
  }
  out.push('');
  total += rows.length;
  summary.push(`${t.name}: ${rows.length}`);
}
db.close();

// IDENTITY 列(SQLite 的 AUTOINCREMENT)灌完数据后要把序列推到 max(id),
// 否则下一条 INSERT 会从 1 开始撞主键。
const identity = tables.filter((t) => t.columns.some((c) => c.autoincrement));
if (identity.length) {
  out.push('-- 把自增序列推到当前最大值');
  for (const t of identity) {
    const c = t.columns.find((x) => x.autoincrement).name;
    out.push(`SELECT setval(pg_get_serial_sequence('${t.name}', '${c}'), COALESCE((SELECT max(${c}) FROM ${t.name}), 1), true);`);
  }
  out.push('');
}
out.push('-- 同步台账:这次是谁、什么时候、传了多少');
out.push('INSERT INTO sync_runs (source_device_key, device_name, sender_phone, started_at, rows_total, detail_json)');
out.push(`VALUES (${lit(me.deviceKey)}, ${lit(me.deviceName)}, ${lit(me.phone)}, ${lit(SYNCED_AT)}, ${total}, ${lit(JSON.stringify(summary))});`);
out.push('');
out.push('COMMIT;');

writeFileSync(OUT, out.join('\n') + '\n');
console.log(`✓ ${OUT}  (${(statSync(OUT).size / 1024 / 1024).toFixed(1)} MB)`);
console.log(`  ${total} 行 / ${summary.length} 张表`);
console.log(`  盖章为:${me.deviceName || me.deviceKey}${me.phone ? ' / ' + me.phone : ''}`);
