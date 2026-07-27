// Build mamba-sql.html — a standalone viewer for the Mamba database.
//
//   node tools/sql-html/build.mjs                     # 带上真实数据快照
//   node tools/sql-html/build.mjs --no-data           # 只要空壳(可分享)
//   node tools/sql-html/build.mjs --db path/to.sqlite # 换一个库
//   node tools/sql-html/build.mjs --max-rows 2000     # 每张表最多导多少行
//
// 生成的 HTML 不依赖服务器、CDN 或 Mamba 任何代码。
// 想让另一台电脑实时看,用 tools/sql-html/serve.mjs。
import { writeFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildSnapshot, renderPage, ROOT, DEFAULT_DB } from '../lib/snapshot.mjs';

const OUT = join(ROOT, 'mamba-sql.html');
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};

const withData = !argv.includes('--no-data');
const dbPath = argv.includes('--db') ? resolve(ROOT, flag('--db')) : DEFAULT_DB;
const maxRows = Number(flag('--max-rows', '0')) || Infinity;

const snapshot = buildSnapshot({ dbPath, maxRows, withData });
writeFileSync(OUT, renderPage(snapshot));

const { payload, data } = snapshot;
console.log(`✓ ${OUT}  (${(statSync(OUT).size / 1024 / 1024).toFixed(1)} MB)`);
console.log(`  ${payload.tables.length} 张表` +
  (payload.db ? ` · ${payload.db.rows} 行来自 ${payload.db.path}` : ' · 无数据(--no-data)'));
const cut = payload.tables.filter((t) => t.truncated);
if (cut.length) console.log(`  已截断: ${cut.map((t) => `${t.name} ${data[t.name].length}/${t.totalRows}`).join(', ')}`);
