// 把 Notion Blast Leads 上的「归属章」改成本机。
//
// 背景:合并另一台 Mac 的号码资料之后,本机 SQLite 已经是对的,但 Campaign 画面
// 读的是从 Notion 同步下来的 blast_leads_cache.json。Notion 那边还盖着来源那台的
// 章,所以这批客户会被判成「其他电脑的」而隐藏起来。
//
// 只改归属栏位。Flow 轮次、Cohort、STOP、回复记录、名字电话一概不碰。
// 判断依据是本机 SQLite —— 只有 project_leads 已经盖上本机章的那些页才会被改。
//
//   node scripts/maintenance/restamp-notion-ownership.mjs --number 60123456789
//   node scripts/maintenance/restamp-notion-ownership.mjs --number 60123456789 \
//     --apply --confirm RESTAMP_NOTION_OWNERSHIP
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadEnv, paths } from '../../campaign-app/campaign_core.mjs';
import { createNotionService } from '../../campaign-app/lib/notion-service.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const SQLITE = '/usr/bin/sqlite3';
const CONFIRM_TOKEN = 'RESTAMP_NOTION_OWNERSHIP';
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};
const has = (name) => argv.includes(name);

const apply = has('--apply');
const number = String(flag('--number', '')).replace(/[^0-9]/g, '');
const databasePath = path.resolve(ROOT, flag('--db', 'campaign-data/mamba.sqlite'));
const throttleMs = Number(flag('--throttle', 350));

const die = (message) => { console.error(`✗ ${message}`); process.exit(1); };
const clean = (value) => String(value ?? '').trim();
const sqlValue = (value) => `'${String(value).replaceAll("'", "''")}'`;

if (!number) die('缺少 --number');
if (apply && flag('--confirm', '') !== CONFIRM_TOKEN) die(`--apply 必须同时提供 --confirm ${CONFIRM_TOKEN}`);

function query(sql) {
  const out = execFileSync(SQLITE, ['-batch', '-json', databasePath, sql], {
    encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
  }).trim();
  return out ? JSON.parse(out) : [];
}

// ---------------------------------------------------------------- 本机的真相

const connection = query(`
SELECT connection_key AS k, instance_name AS inst FROM whatsapp_connections
WHERE replace(replace(whatsapp_number,'+',''),' ','')=${sqlValue(number)} LIMIT 1;`)[0];
if (!connection?.k) die(`本机没有 ${number} 的连接。`);
const targetKey = connection.k;
const targetDevice = String(targetKey).split('::')[0];
const targetInstance = clean(connection.inst);

// 只认本机 SQLite 已经盖章的那些 lead。Notion 上其他页一律不碰。
const owned = new Map();
for (const row of query(`
SELECT notion_page_id AS pageId, phone, name FROM project_leads
WHERE assigned_sender_key = ${sqlValue(targetKey)}
  AND notion_page_id IS NOT NULL AND notion_page_id <> '';`)) {
  owned.set(clean(row.pageId), row);
}
if (!owned.size) die(`本机 SQLite 里没有任何盖着 ${targetKey} 的 lead(带 Notion 页 ID)。`);

// ------------------------------------------------------- 快取里现在的章是什么

const cachePath = path.join(paths.dataDir, 'blast_leads_cache.json');
if (!fs.existsSync(cachePath)) die(`找不到 ${cachePath}`);
const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));

const FIELDS = [
  { property: 'Assigned Sender Key', type: 'rich_text', cacheKey: 'assignedSenderKey', next: targetKey },
  { property: 'Last Sender Key', type: 'rich_text', cacheKey: 'lastSenderKey', next: targetKey, onlyIfPresent: true },
  { property: 'Last Sent By Device', type: 'rich_text', cacheKey: 'lastSentByDevice', next: targetDevice, onlyIfPresent: true },
  { property: 'Sender Instance', type: 'select', cacheKey: 'senderInstance', next: targetInstance, onlyIfPresent: true },
];

const plan = [];
for (const record of cache.records || []) {
  const pageId = clean(record.id);
  if (!owned.has(pageId)) continue;
  const changes = [];
  for (const field of FIELDS) {
    const current = clean(record[field.cacheKey]);
    if (field.onlyIfPresent && !current) continue;   // 本来就空的不去填
    if (current === field.next) continue;            // 已经对了
    changes.push({ ...field, current });
  }
  if (changes.length) plan.push({ pageId, name: clean(record.name), phone: clean(record.phone), changes });
}

// ------------------------------------------------------------------ 报告

const perField = {};
for (const item of plan) for (const change of item.changes) perField[change.property] = (perField[change.property] || 0) + 1;

console.log('');
console.log(`  号码:${number}`);
console.log(`  本机 SQLite 已盖章的 lead:${owned.size} 笔`);
console.log(`  Notion 上需要改章的页面:${plan.length} 页`);
console.log('');
console.log('  栏位                    要改几页  改成');
console.log('  ──────────────────────  ──────  ────────────────────────────────────');
for (const field of FIELDS) {
  if (!perField[field.property]) continue;
  console.log(`  ${field.property.padEnd(22)}  ${String(perField[field.property]).padStart(6)}  ${field.next}`);
}
console.log('');
if (plan.length) {
  const sample = plan[0];
  console.log(`  抽一页看:${sample.name || '(无名)'} · ${sample.phone}`);
  for (const change of sample.changes) console.log(`    ${change.property.padEnd(22)} ${change.current}  →  ${change.next}`);
  console.log('');
}
console.log('  不会更动:Flow 轮次 / Cohort / STOP / 回复记录 / 名字 / 电话');
console.log('');

if (!plan.length) { console.log('  没有需要改的页面。'); process.exit(0); }

if (!apply) {
  console.log(`  【试跑】没有写入 Notion。确认后加上:  --apply --confirm ${CONFIRM_TOKEN}`);
  console.log('');
  process.exit(0);
}

// ------------------------------------------------------------------ 写入

const env = await loadEnv();
const { notion } = createNotionService({ env, logger: { log() {} } });

// 还原档必须在动手之前落地:写到一半失败时,这是唯一能把原值找回来的东西。
const reportDir = path.join(paths.dataDir, 'device-ownership');
fs.mkdirSync(reportDir, { recursive: true });
const rollbackPath = path.join(reportDir, `notion-restamp-rollback-${number}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(rollbackPath, `${JSON.stringify({
  number, targetKey, targetDevice, targetInstance,
  createdAt: new Date().toISOString(),
  pages: plan.map((item) => ({
    pageId: item.pageId,
    original: Object.fromEntries(item.changes.map((change) => [change.property, change.current])),
  })),
}, null, 2)}\n`);
console.log(`  还原档已存:${path.relative(ROOT, rollbackPath)}`);
console.log('');

const buildProperty = (field, value) => (field.type === 'select'
  ? { select: { name: value } }
  : { rich_text: [{ type: 'text', text: { content: value } }] });

let done = 0;
let failed = 0;
const errors = [];
for (const item of plan) {
  const properties = {};
  for (const change of item.changes) properties[change.property] = buildProperty(change, change.next);
  try {
    await notion('PATCH', `/pages/${item.pageId}`, { properties });
    done += 1;
  } catch (error) {
    failed += 1;
    errors.push(`${item.pageId} (${item.phone}): ${error.message}`);
    if (failed >= 10) { console.log('\n  ✗ 连续失败过多,停下来了。'); break; }
  }
  if ((done + failed) % 50 === 0) {
    process.stdout.write(`\r  进度 ${done + failed}/${plan.length}  成功 ${done}  失败 ${failed}   `);
  }
  if (throttleMs > 0) await new Promise((resolve) => setTimeout(resolve, throttleMs));
}

console.log(`\r  进度 ${done + failed}/${plan.length}  成功 ${done}  失败 ${failed}   `);
console.log('');
if (errors.length) {
  console.log('  前几个错误:');
  for (const message of errors.slice(0, 5)) console.log(`    ${message}`);
  console.log('');
}
console.log(`  还原档:${path.relative(ROOT, rollbackPath)}`);
console.log('');
console.log('  下一步:回 Mamba 点一次 Sync Notion Cache,再看 Campaign 画面。');
console.log('');
process.exit(failed ? 1 : 0);
