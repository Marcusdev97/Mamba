// Build mamba-sql.html — a standalone viewer/editor for the Mamba database.
//
//   node tools/sql-html/build.mjs                     # 带上真实数据快照
//   node tools/sql-html/build.mjs --no-data           # 只要空壳(可分享)
//   node tools/sql-html/build.mjs --db path/to.sqlite # 换一个库
//   node tools/sql-html/build.mjs --max-rows 2000     # 每张表最多导多少行
//
// 表结构以 **真实数据库** 为准(sqlite_master),再把 docs/mamba-schema*.sql 里的
// 中文注释贴回去;只存在于文档里的表(比如还没迁的 v4)标成「设计中」。
// 生成的 HTML 不依赖服务器、CDN 或 Mamba 任何代码。
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { parseSchema, parseSchemaText } from '../lib/parse-schema.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT = join(ROOT, 'mamba-sql.html');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const WITH_DATA = !argv.includes('--no-data');
const DB_PATH = resolve(ROOT, flag('--db', 'campaign-data/mamba.sqlite'));
const MAX_ROWS = Number(flag('--max-rows', '0')) || Infinity;

// ---------------------------------------------------------------------------
// 1. 文档里的 schema —— 只为了拿中文注释和分层
// ---------------------------------------------------------------------------
const docTables = parseSchema([
  { path: join(ROOT, 'docs/mamba-schema.sql'), version: 'v3' },
  { path: join(ROOT, 'docs/mamba-schema-v4.sql'), version: 'v4' },
]);
const docByName = Object.fromEntries(docTables.map((t) => [t.name, t]));

// ---------------------------------------------------------------------------
// 2. 真实库的 schema + 数据
// ---------------------------------------------------------------------------
let liveTables = [];
let data = {};
let dbInfo = null;

if (WITH_DATA) {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });   // 只读,绝不碰生产数据
  const ddl = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('table','index') AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type DESC")
    .all()
    .map((r) => normalize(r.sql))
    .join(';\n');

  liveTables = parseSchemaText(ddl, 'live');

  let rows = 0;
  for (const t of liveTables) {
    const n = db.prepare(`SELECT count(*) AS n FROM "${t.name}"`).get().n;
    const list = db.prepare(`SELECT * FROM "${t.name}"${MAX_ROWS === Infinity ? '' : ` LIMIT ${MAX_ROWS}`}`).all();
    // BigInt / Buffer 不能直接 JSON 序列化
    data[t.name] = list.map((r) =>
      Object.fromEntries(Object.entries(r).map(([k, v]) => [
        k, typeof v === 'bigint' ? String(v) : Buffer.isBuffer(v) ? `<${v.length} bytes>` : v,
      ]))
    );
    t.totalRows = n;
    t.truncated = n > data[t.name].length;
    rows += data[t.name].length;
  }
  db.close();
  dbInfo = {
    path: relative(ROOT, DB_PATH),
    size: statSync(DB_PATH).size,
    at: new Date().toISOString(),
    rows,
  };
}

function normalize(sql) {
  return sql
    .replace(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["`[]?(\w+)["`\]]?\s*\(/i, 'CREATE TABLE IF NOT EXISTS $1 (')
    .replace(/^CREATE (UNIQUE )?INDEX\s+(?:IF NOT EXISTS\s+)?["`[]?(\w+)["`\]]?\s*ON\s+["`[]?(\w+)["`\]]?\s*\(/i,
      (_, u, n, t) => `CREATE ${u || ''}INDEX IF NOT EXISTS ${n}\n  ON ${t}(`);
}

// ---------------------------------------------------------------------------
// 3. 合并:真实库为准,文档补注释;文档独有的表标成「设计中」
// ---------------------------------------------------------------------------
const tables = [];
for (const t of liveTables) {
  const doc = docByName[t.name];
  if (doc) {
    t.desc = doc.desc;
    t.section = doc.section;
    t.version = doc.version;
    for (const c of t.columns) {
      const dc = doc.columns.find((x) => x.name === c.name);
      if (dc && dc.note) c.note = dc.note;
    }
  } else {
    t.section = '附加表(库里有,文档 schema 未收录)';
    t.version = 'live';
  }
  tables.push(t);
}
const liveNames = new Set(liveTables.map((t) => t.name));
for (const t of docTables) {
  if (liveNames.has(t.name)) continue;
  tables.push({ ...t, designOnly: true, totalRows: 0, section: `${t.version} 设计(库里还没建这张表)` });
}
if (!WITH_DATA) tables.length = 0, tables.push(...docTables);

const payload = {
  generated: new Date().toISOString(),
  db: dbInfo,
  tables,
};

const template = readFileSync(join(HERE, 'template.html'), 'utf8');
for (const ph of ['__SCHEMA__', '__DATA__']) {
  if (!template.includes(ph)) throw new Error(`template.html 里找不到 ${ph} 占位符`);
}
writeFileSync(
  OUT,
  template.replace('__SCHEMA__', JSON.stringify(payload)).replace('__DATA__', JSON.stringify(data))
);

const mb = (statSync(OUT).size / 1024 / 1024).toFixed(1);
console.log(`✓ ${OUT}  (${mb} MB)`);
console.log(`  ${tables.length} 张表` + (dbInfo ? ` · ${dbInfo.rows} 行来自 ${dbInfo.path}` : ' · 无数据(--no-data)'));
if (dbInfo) {
  const cut = tables.filter((t) => t.truncated);
  if (cut.length) console.log(`  已截断: ${cut.map((t) => `${t.name} ${data[t.name].length}/${t.totalRows}`).join(', ')}`);
}
