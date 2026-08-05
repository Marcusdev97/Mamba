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
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

let snapshotModule;
try {
  snapshotModule = await import('../lib/snapshot.mjs');
} catch (error) {
  if (error?.code !== 'ERR_UNKNOWN_BUILTIN_MODULE' || process.execArgv.includes('--experimental-sqlite')) throw error;
  const result = spawnSync(process.execPath, ['--experimental-sqlite', ...process.argv.slice(1)], {
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
}
const { buildSnapshot, renderPage, ROOT, DEFAULT_DB } = snapshotModule;

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const OUT = argv.includes('--out') ? resolve(ROOT, flag('--out')) : join(ROOT, 'mamba-sql.html');

const withData = !argv.includes('--no-data');
const dbPath = argv.includes('--db') ? resolve(ROOT, flag('--db')) : DEFAULT_DB;
const maxRows = Number(flag('--max-rows', '0')) || Infinity;

if (argv.includes('--global')) {
  console.error('Global PostgreSQL 已退役。SQL 面板只读取本机 SQLite。');
  process.exit(2);
}

const snapshot = buildSnapshot({ dbPath, maxRows, withData });
writeFileSync(OUT, renderPage(snapshot));

const { payload, data } = snapshot;
console.log(`✓ ${OUT}  (${(statSync(OUT).size / 1024 / 1024).toFixed(1)} MB)`);
console.log(`  ${payload.tables.length} 张表` +
  (payload.db ? ` · ${payload.db.rows} 行来自 ${payload.db.path}` : ' · 无数据(--no-data)'));
const cut = payload.tables.filter((t) => t.truncated);
if (cut.length) console.log(`  已截断: ${cut.map((t) => `${t.name} ${data[t.name].length}/${t.totalRows}`).join(', ')}`);
