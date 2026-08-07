// 把「另一台 Mac 的某个 WhatsApp 号码」的运行资料，合并进本机 v3 运行库。
//
// 用途：号码已经连到本机，但客户、对话与 Flow 状态还留在原来那台的资料库里，
// ChatRoom 与 Campaign 因此是空的。这个工具把那些资料搬进来，并把「归属章」
// 改成本机，让界面认得出它们是自己的。
//
// 这不是 handoff：它只搬资料，不动 v4 绑定、不吊销任何一台的发送权。
// 来源那台在停止发送之前，两台仍可能同时对同一个号码发送 —— 那要另外处理。
//
//   node scripts/maintenance/merge-remote-number.mjs \
//     --source mamba-archive/_snapshots/xxx.sqlite --number 60123456789
//
//   node scripts/maintenance/merge-remote-number.mjs \
//     --source ... --number ... --apply --confirm MERGE_REMOTE_NUMBER
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { backupSqliteDatabase } from './lib/sqlite-maintenance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SQLITE = '/usr/bin/sqlite3';
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};
const has = (name) => argv.includes(name);
const fromRoot = (value) => (path.isAbsolute(value) ? value : path.resolve(ROOT, value));

const CONFIRM_TOKEN = 'MERGE_REMOTE_NUMBER';
const apply = has('--apply');
const sourcePath = fromRoot(flag('--source', ''));
const targetPath = fromRoot(flag('--db', 'campaign-data/mamba.sqlite'));
const number = String(flag('--number', '')).replace(/[^0-9]/g, '');

const sqlValue = (value) => (value === null || value === undefined ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`);
const die = (message) => { console.error(`✗ ${message}`); process.exit(1); };

function run(file, sql, { attach = '' } = {}) {
  const prefix = attach ? `ATTACH ${sqlValue(attach)} AS src;\n` : '';
  return execFileSync(SQLITE, ['-batch', '-json', file, `${prefix}${sql}`], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  }).trim();
}
const queryOne = (file, sql, options) => {
  const out = run(file, sql, options);
  return out ? JSON.parse(out)[0] : null;
};
const scalar = (file, sql, options) => {
  const row = queryOne(file, sql, options);
  return row ? Number(Object.values(row)[0]) : 0;
};

// ------------------------------------------------------------------ 前置检查

if (!fs.existsSync(SQLITE)) die(`找不到 sqlite3:${SQLITE}`);
if (!flag('--source', '')) die('缺少 --source(来源资料库路径)');
if (!fs.existsSync(sourcePath)) die(`找不到来源资料库:${sourcePath}`);
if (!fs.existsSync(targetPath)) die(`找不到本机资料库:${targetPath}`);
if (!number) die('缺少 --number(要合并的 WhatsApp 号码)');
if (apply && flag('--confirm', '') !== CONFIRM_TOKEN) {
  die(`--apply 必须同时提供 --confirm ${CONFIRM_TOKEN}`);
}

// 本机必须已经有这个号码的连接，否则搬进来的资料会外键失败，界面也认不出。
const targetConnection = queryOne(targetPath, `
SELECT connection_key AS k, instance_name AS inst FROM whatsapp_connections
WHERE replace(replace(whatsapp_number,'+',''),' ','')=${sqlValue(number)} LIMIT 1;`);
if (!targetConnection?.k) {
  die(`本机没有 ${number} 的连接。请先在本机把这个号码连上 Evolution，再来合并。`);
}
const targetKey = targetConnection.k;
const targetDevice = String(targetKey).split('::')[0];

// 来源那台用的是哪个 device：从该号码的对话反查，不靠猜。
const sourceConnection = queryOne(sourcePath, `
SELECT connection_key AS k FROM conversations
WHERE connection_key LIKE ${sqlValue(`%::${number}`)} LIMIT 1;`);
if (!sourceConnection?.k) die(`来源资料库里找不到 ${number} 的对话。`);
const sourceKey = sourceConnection.k;
const sourceDevice = String(sourceKey).split('::')[0];

if (sourceDevice === targetDevice) die('来源与本机是同一台电脑,不需要合并。');

// 对话 id 的算法必须跟 conversation-log-service.mjs 的 conversationIdFor 一致,
// 否则 App 会算出另一个 id、找不到搬进来的对话,然后再建一条新的 —— 同一个客户
// 的对话被劈成两半。
const idSuffix = targetKey.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const newConversationId = (contactKeyExpr) => `('conv_' || ${contactKeyExpr} || '_' || ${sqlValue(idSuffix)})`;

// 归属章改写:凡是含来源 device 的栏位,一律换成本机 device。NULL 保持 NULL。
const restamp = (column) => `replace(${column}, ${sqlValue(sourceDevice)}, ${sqlValue(targetDevice)})`;

// ------------------------------------------------------------------ 合并计划

// 顺序 = 外键依赖顺序。被依赖的先进,否则 foreign_key_check 会炸。
const PLAN = [
  { table: 'projects', pk: 'project_code' },
  { table: 'devices', pk: 'device_key' },
  { table: 'contacts', pk: 'contact_key' },
  // campaign_runs.device_key 保留来源那台 —— 那些 Campaign 确实是在那台跑的,
  // 改成本机等于伪造历史。只有「决定现在归谁」的栏位才改章。
  { table: 'campaign_runs', pk: 'run_id' },
  { table: 'lead_groups', pk: 'group_id', restamp: ['device_key'] },
  { table: 'lead_group_members', pk: 'group_id, member_id' },
  { table: 'project_leads', pk: 'project_lead_key', restamp: ['assigned_sender_key', 'last_sender_key', 'last_sent_by_device'] },
];

function columnsOf(file, table) {
  const out = run(file, `PRAGMA table_info(${table});`);
  return out ? JSON.parse(out).map((row) => row.name) : [];
}

// 只搬两边都有的栏位:来源库 schema 若比本机新,多出来的栏位直接忽略。
function sharedColumns(table) {
  const target = new Set(columnsOf(targetPath, table));
  return columnsOf(sourcePath, table).filter((name) => target.has(name));
}

const steps = [];
for (const spec of PLAN) {
  const columns = sharedColumns(spec.table);
  if (!columns.length) continue;
  const restampSet = new Set(spec.restamp || []);
  const select = columns.map((name) => (restampSet.has(name) ? `${restamp(`s.${name}`)}` : `s.${name}`)).join(', ');
  steps.push({
    label: spec.table,
    sql: `INSERT OR IGNORE INTO main.${spec.table} (${columns.join(', ')})\nSELECT ${select} FROM src.${spec.table} s;`,
    countSql: `SELECT count(*) FROM src.${spec.table};`,
  });
}

// 对话:只搬这个号码的。connection_key 与 id 一起改写。
const conversationColumns = sharedColumns('conversations');
const conversationSelect = conversationColumns.map((name) => {
  if (name === 'id') return `${newConversationId('s.contact_key')} AS id`;
  if (name === 'connection_key') return `${sqlValue(targetKey)} AS connection_key`;
  return `s.${name}`;
}).join(', ');
steps.push({
  label: 'conversations',
  sql: `INSERT OR IGNORE INTO main.conversations (${conversationColumns.join(', ')})
SELECT ${conversationSelect} FROM src.conversations s
WHERE s.connection_key = ${sqlValue(sourceKey)};`,
  countSql: `SELECT count(*) FROM src.conversations WHERE connection_key=${sqlValue(sourceKey)};`,
});

// 讯息:去重必须用 external_message_id。两台各自生成的 idempotency_key 对同一条
// WhatsApp 讯息并不相同,拿它去重会把已经有的 423 条再插一次。
const messageColumns = sharedColumns('messages').filter((name) => name !== 'row_id');
const messageSelect = messageColumns.map((name) => {
  if (name === 'conversation_id') return `${newConversationId('v.contact_key')} AS conversation_id`;
  if (name === 'connection_key') return `${sqlValue(targetKey)} AS connection_key`;
  if (name === 'template_key') return `nullif(s.template_key,'') AS template_key`;
  return `s.${name}`;
}).join(', ');
const messageWhere = `v.connection_key = ${sqlValue(sourceKey)}
  AND NOT EXISTS (SELECT 1 FROM main.messages m WHERE m.external_message_id = s.external_message_id)`;
steps.push({
  label: 'messages',
  sql: `INSERT OR IGNORE INTO main.messages (${messageColumns.join(', ')})
SELECT ${messageSelect} FROM src.messages s
JOIN src.conversations v ON v.id = s.conversation_id
WHERE ${messageWhere};`,
  countSql: `SELECT count(*) FROM src.messages s JOIN src.conversations v ON v.id=s.conversation_id WHERE ${messageWhere};`,
});

// 发送记录:防重发要靠它,连接改章。
const sendJobColumns = sharedColumns('send_jobs');
const sendJobSelect = sendJobColumns.map((name) => {
  if (name === 'connection_key') return `${restamp('s.connection_key')} AS connection_key`;
  if (name === 'template_key') return `nullif(s.template_key,'') AS template_key`;
  return `s.${name}`;
}).join(', ');
steps.push({
  label: 'send_jobs',
  sql: `INSERT OR IGNORE INTO main.send_jobs (${sendJobColumns.join(', ')})\nSELECT ${sendJobSelect} FROM src.send_jobs s;`,
  countSql: 'SELECT count(*) FROM src.send_jobs;',
});

// instanceName 正规化 —— 少了这步，搬进来的对话会出现在别的号码底下。
//
// ChatRoom 不是按 connection_key 筛分页的，是按讯息 payload 里的 instanceName
// (conversation-log-service.mjs 的 inboxThreads)。而 wa_01 这类代号是「每台机器
// 自己的叫法」：来源那台的 wa_01 是这个号，本机的 wa_01 却是另一支号码。原样搬
// 进来，这些对话会被本机判读成别支号码的，跑到错的分页去。
//
// 所以把 payload 里的代号改成本机对这支号码的叫法，跟 connection_key 对齐。
// 原始代号在档案 (mamba-archive) 里仍然保留，这里只改本机运行库的判读依据。
const targetInstance = String(targetConnection.inst || '');
steps.push({
  label: 'instanceName 正规化',
  isUpdate: true,
  sql: `UPDATE main.messages
SET payload_json = json_set(payload_json, '$.instanceName', ${sqlValue(targetInstance)})
WHERE connection_key = ${sqlValue(targetKey)}
  AND json_valid(payload_json)
  AND coalesce(json_extract(payload_json,'$.instanceName'),'') <> ${sqlValue(targetInstance)};`,
  countSql: `SELECT count(*) FROM main.messages
WHERE connection_key = ${sqlValue(targetKey)}
  AND json_valid(payload_json)
  AND coalesce(json_extract(payload_json,'$.instanceName'),'') <> ${sqlValue(targetInstance)};`,
});

// ------------------------------------------------------------------ 报告

const before = {};
const tables = steps.filter((step) => !step.isUpdate).map((step) => step.label);
for (const table of tables) before[table] = scalar(targetPath, `SELECT count(*) FROM main.${table};`);

console.log('');
console.log(`  来源:${path.relative(ROOT, sourcePath)}`);
console.log(`  号码:${number}`);
console.log(`  归属章:${sourceDevice}`);
console.log(`      → ${targetDevice}  (本机 ${targetConnection.inst})`);
console.log('');
console.log('  表                    本机现有    来源笔数');
console.log('  ────────────────────  ────────  ────────');
for (const step of steps) {
  // 统一挂着来源库数:讯息那步要跟本机比对去重,其余的 src. 前缀也才解析得到。
  const incoming = scalar(targetPath, step.countSql, { attach: sourcePath });
  step.incoming = incoming;
  const existing = step.isUpdate ? '—' : String(before[step.label]);
  console.log(`  ${step.label.padEnd(20)}  ${existing.padStart(8)}  ${String(incoming).padStart(8)}`);
}
console.log('');

if (!apply) {
  console.log('  【试跑】没有写入任何东西。');
  console.log(`  确认无误后加上:  --apply --confirm ${CONFIRM_TOKEN}`);
  console.log('');
  process.exit(0);
}

// ------------------------------------------------------------------ 写入

const backupPath = backupSqliteDatabase({
  binary: SQLITE,
  rootDir: ROOT,
  databasePath: targetPath,
  prefix: `before-merge-${number}`,
});
console.log(`  已备份:${path.relative(ROOT, backupPath)}`);

const script = [
  `ATTACH ${sqlValue(sourcePath)} AS src;`,
  'PRAGMA foreign_keys=OFF;',
  'BEGIN IMMEDIATE;',
  ...steps.map((step) => step.sql),
  'COMMIT;',
].join('\n');

try {
  execFileSync(SQLITE, ['-batch', targetPath, script], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
} catch (error) {
  die(`合并失败,资料库未变更:${String(error?.stderr || error?.message || error).trim()}\n  可从备份还原:${backupPath}`);
}

const fkIssues = execFileSync(SQLITE, ['-batch', targetPath, 'PRAGMA foreign_key_check;'], { encoding: 'utf8' }).trim();
const quickCheck = execFileSync(SQLITE, ['-batch', targetPath, 'PRAGMA quick_check;'], { encoding: 'utf8' }).trim();

console.log('');
console.log('  表                    合并前    合并后      新增');
console.log('  ────────────────────  ──────  ──────  ────────');
for (const table of tables) {
  const after = scalar(targetPath, `SELECT count(*) FROM main.${table};`);
  const added = after - before[table];
  console.log(`  ${table.padEnd(20)}  ${String(before[table]).padStart(6)}  ${String(after).padStart(6)}  ${String(added > 0 ? `+${added}` : added).padStart(8)}`);
}
console.log('');
console.log(`  外键检查:${fkIssues ? `✗ 有问题\n${fkIssues}` : '✓ 通过'}`);
console.log(`  完整性检查:${quickCheck === 'ok' ? '✓ 通过' : `✗ ${quickCheck}`}`);
console.log(`  备份:${path.relative(ROOT, backupPath)}`);
console.log('');
if (fkIssues || quickCheck !== 'ok') {
  console.log('  ⚠️  检查没过。建议从上面那份备份还原后再找原因。');
  process.exit(1);
}
console.log('  ✓ 完成。重启 Mamba 后到 ChatRoom 查看。');
console.log('');
