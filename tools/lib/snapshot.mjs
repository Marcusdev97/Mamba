// 把本机 SQLite 读成 SQL 面板要的那份 payload,并渲染成单页 HTML。
//
// tools/sql-html/build.mjs(生成静态文件)和 tools/sql-html/serve.mjs(给另一台
// 电脑看的只读 server)共用这里,免得两边的逻辑走岔。
//
// 打开数据库一律 readOnly —— 是 SQLite 自己拒绝写入,不是我们自己判断的,
// 所以就算这里写错一句 UPDATE 也弄不坏生产库。
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { parseSchema, parseSchemaText } from './parse-schema.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');
export const TEMPLATE = join(ROOT, 'tools/sql-html/template.html');
export const DEFAULT_DB = join(ROOT, 'campaign-data/mamba.sqlite');

const DOC_FILES = [
  { path: join(ROOT, 'docs/mamba-schema.sql'), version: 'v3' },
  { path: join(ROOT, 'docs/mamba-schema-v4.sql'), version: 'v4' },
];

function normalize(sql) {
  return sql
    .replace(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["`[]?(\w+)["`\]]?\s*\(/i, 'CREATE TABLE IF NOT EXISTS $1 (')
    .replace(/^CREATE (UNIQUE )?INDEX\s+(?:IF NOT EXISTS\s+)?["`[]?(\w+)["`\]]?\s*ON\s+["`[]?(\w+)["`\]]?\s*\(/i,
      (_, u, n, t) => `CREATE ${u || ''}INDEX IF NOT EXISTS ${n}\n  ON ${t}(`);
}

// 表结构以真实库为准,再把文档里的中文注释贴回去。
export function buildSnapshot({ dbPath = DEFAULT_DB, maxRows = Infinity, withData = true } = {}) {
  const docTables = parseSchema(DOC_FILES);
  const docByName = Object.fromEntries(docTables.map((t) => [t.name, t]));

  if (!withData) {
    return { payload: { generated: new Date().toISOString(), db: null, tables: docTables }, data: {} };
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const ddl = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('table','index') AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type DESC")
    .all()
    .map((r) => normalize(r.sql))
    .join(';\n');

  const liveTables = parseSchemaText(ddl, 'live');
  const data = {};
  let rows = 0;

  for (const t of liveTables) {
    const n = db.prepare(`SELECT count(*) AS n FROM "${t.name}"`).get().n;
    const list = db.prepare(`SELECT * FROM "${t.name}"${maxRows === Infinity ? '' : ` LIMIT ${maxRows}`}`).all();
    // BigInt / Buffer 不能直接 JSON 序列化
    data[t.name] = list.map((r) =>
      Object.fromEntries(Object.entries(r).map(([k, v]) => [
        k, typeof v === 'bigint' ? String(v) : Buffer.isBuffer(v) ? `<${v.length} bytes>` : v,
      ]))
    );
    t.totalRows = n;
    t.truncated = n > data[t.name].length;
    rows += data[t.name].length;

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
  }
  db.close();

  // 文档里有、库里还没建的表(比如没迁的 v4)也列出来,置灰标「设计中」
  const tables = [...liveTables];
  const liveNames = new Set(liveTables.map((t) => t.name));
  for (const t of docTables) {
    if (liveNames.has(t.name)) continue;
    tables.push({ ...t, designOnly: true, totalRows: 0, section: `${t.version} 设计(库里还没建这张表)` });
  }

  return {
    payload: {
      generated: new Date().toISOString(),
      db: { path: relative(ROOT, dbPath), size: statSync(dbPath).size, at: new Date().toISOString(), rows },
      tables,
    },
    data,
  };
}

export function renderPage({ payload, data }, templatePath = TEMPLATE) {
  const template = readFileSync(templatePath, 'utf8');
  for (const ph of ['__SCHEMA__', '__DATA__']) {
    if (!template.includes(ph)) throw new Error(`template.html 里找不到 ${ph} 占位符`);
  }
  return template.replace('__SCHEMA__', JSON.stringify(payload)).replace('__DATA__', JSON.stringify(data));
}
