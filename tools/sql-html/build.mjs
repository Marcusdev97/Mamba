// Build mamba-sql.html — a standalone viewer for the Mamba database.
//
//   node tools/sql-html/build.mjs                     # 带上真实数据快照
//   node tools/sql-html/build.mjs --no-data           # 只要空壳(可分享)
//   node tools/sql-html/build.mjs --db path/to.sqlite # 换一个库
//   node tools/sql-html/build.mjs --max-rows 2000     # 每张表最多导多少行
//   node tools/sql-html/build.mjs --global            # 读 Global Postgres(两台合起来)
//
// 生成的 HTML 不依赖服务器、CDN 或 Mamba 任何代码。
// 想让另一台电脑实时看,用 tools/sql-html/serve.mjs。
import { writeFileSync, statSync } from 'node:fs';
import path, { join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { buildSnapshot, renderPage, ROOT, DEFAULT_DB } from '../lib/snapshot.mjs';
import { buildPgSnapshot } from '../lib/pg-snapshot.mjs';

const OUT = join(ROOT, process.argv.includes('--global') ? 'mamba-sql-global.html' : 'mamba-sql.html');
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};

const withData = !argv.includes('--no-data');
const dbPath = argv.includes('--db') ? resolve(ROOT, flag('--db')) : DEFAULT_DB;
const maxRows = Number(flag('--max-rows', '0')) || Infinity;

// --global:资料来源换成 Global Postgres,看到的是两台合起来的全貌
const GLOBAL = argv.includes('--global');
function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL.trim();
  const f = path.join(ROOT, '.env.pg');
  if (existsSync(f)) {
    const m = readFileSync(f, 'utf8').match(/^(?:DATABASE_URL\s*=\s*)?["']?(postgres(?:ql)?:\/\/[^"'\s]+)/m);
    if (m) return m[1];
  }
  return '';
}

let snapshot;
if (GLOBAL) {
  const url = databaseUrl();
  if (!url) {
    console.error('找不到连线字串。设 DATABASE_URL,或在 .env.pg 写一行 postgresql://...');
    process.exit(1);
  }
  snapshot = buildPgSnapshot({ url, maxRows });
} else {
  snapshot = buildSnapshot({ dbPath, maxRows, withData });
}
writeFileSync(OUT, renderPage(snapshot));

const { payload, data } = snapshot;
console.log(`✓ ${OUT}  (${(statSync(OUT).size / 1024 / 1024).toFixed(1)} MB)`);
console.log(`  ${payload.tables.length} 张表` +
  (payload.db ? ` · ${payload.db.rows} 行来自 ${payload.db.path}` : ' · 无数据(--no-data)'));
const cut = payload.tables.filter((t) => t.truncated);
if (cut.length) console.log(`  已截断: ${cut.map((t) => `${t.name} ${data[t.name].length}/${t.totalRows}`).join(', ')}`);
