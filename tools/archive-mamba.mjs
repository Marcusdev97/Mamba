// 把 Mamba 的运行事实导成「按号码分」的长期档案。
//
// 这个工具是独立的：它只需要一个 .sqlite 文件和 /usr/bin/sqlite3。
// 不需要 Mamba server 起着、不需要 Evolution、不 import 任何 campaign-app 的东西。
// Mamba 哪天跑不起来了，这个工具照样能把资料捞出来。
//
// 为什么按「号码」分而不是按「电脑」分:
//   deviceId 换台电脑就变，号码不会变。档案里一律只写号码，deviceId 在导出时丢掉。
//   两台电脑导到同一个目录树会按号码自然合并，不会打架。
//
//   node tools/archive-mamba.mjs --dry-run
//   node tools/archive-mamba.mjs
//   node tools/archive-mamba.mjs --out-dir /Volumes/BackupDisk/mamba-archive
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQLITE = '/usr/bin/sqlite3';
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};
const has = (name) => argv.includes(name);
const fromRoot = (value) => (path.isAbsolute(value) ? value : path.resolve(ROOT, value));

const dryRun = has('--dry-run');
const databasePath = fromRoot(flag('--db', 'campaign-data/mamba.sqlite'));
const outputDirectory = fromRoot(flag('--out-dir', 'mamba-archive'));

const sqlText = (value) => `'${String(value).replaceAll("'", "''")}'`;
const clean = (value) => String(value ?? '').trim();
const digits = (value) => clean(value).replace(/[^0-9]/g, '');

// sqlite3 CLI 的 JSON 模式：省掉一个 driver 依赖，也省掉 native 模块编译。
function query(file, sql) {
  const out = execFileSync(SQLITE, ['-batch', '-json', file, sql], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  }).trim();
  return out ? JSON.parse(out) : [];
}

// 档案的月份分片键。sent_at 缺了就退回 created_at，两个都没有才进 unknown。
function monthOf(row) {
  const stamp = clean(row.sent_at) || clean(row.created_at);
  const month = stamp.slice(0, 7);
  return /^\d{4}-\d{2}$/.test(month) ? month : 'unknown';
}

// 号码解析 —— 整个工具只有这一处决定「这条记录属于哪个号」。
//
// 1. connection_key 有值 → 取 :: 后面那截，deviceId 直接丢掉
// 2. 没有 → payload_json.instanceName (wa_01) → instance_identity 查号码
//    旧资料的 connection_key 大量是空的，payload 才是可靠来源。
// 3. 都没有 → unknown，不猜
function makeSenderResolver(instanceMap) {
  return (connectionKey, instanceName) => {
    const parts = clean(connectionKey).split('::');
    if (parts.length === 2 && digits(parts[1])) return digits(parts[1]);
    const viaInstance = instanceMap.get(clean(instanceName));
    return viaInstance || 'unknown';
  };
}

function ensureDir(dir) {
  if (!dryRun) fs.mkdirSync(dir, { recursive: true });
}

function writeShards(baseDir, kind, rowsByPhone) {
  const written = [];
  for (const [phone, rows] of rowsByPhone) {
    const byMonth = new Map();
    for (const row of rows) {
      const month = monthOf(row);
      if (!byMonth.has(month)) byMonth.set(month, []);
      byMonth.get(month).push(row);
    }
    for (const [month, monthRows] of [...byMonth].sort((a, b) => a[0].localeCompare(b[0]))) {
      // 同一片内排稳定，才能让内容哈希可重现。
      monthRows.sort((a, b) => clean(a.sent_at).localeCompare(clean(b.sent_at)));
      const body = `${monthRows.map((row) => JSON.stringify(row)).join('\n')}\n`;
      // 分片名带主机:同一个号码可能在两台电脑上都有记录,月份会重叠。若只用
      // 「月份.jsonl」,两边档案并到一起时同名文件互相覆盖,直接丢一边的数据。
      const fileName = `${month}.${sourceName}.jsonl`;
      const relative = path.join(phone, kind, fileName);
      if (!dryRun) {
        ensureDir(path.join(baseDir, phone, kind));
        fs.writeFileSync(path.join(baseDir, phone, kind, fileName), body);
      }
      written.push({
        phone,
        kind,
        month,
        file: relative,
        rows: monthRows.length,
        bytes: Buffer.byteLength(body),
        sha256: crypto.createHash('sha256').update(body).digest('hex'),
        first_at: clean(monthRows[0]?.sent_at) || clean(monthRows[0]?.created_at) || '',
        last_at:
          clean(monthRows[monthRows.length - 1]?.sent_at)
          || clean(monthRows[monthRows.length - 1]?.created_at)
          || '',
      });
    }
  }
  return written;
}

function groupByPhone(rows, key = 'sender_phone') {
  const map = new Map();
  for (const row of rows) {
    const phone = clean(row[key]) || 'unknown';
    if (!map.has(phone)) map.set(phone, []);
    map.get(phone).push(row);
  }
  return new Map([...map].sort((a, b) => a[0].localeCompare(b[0])));
}

// ---------------------------------------------------------------- 前置检查

if (!fs.existsSync(SQLITE)) {
  console.error(`找不到 sqlite3:${SQLITE}`);
  process.exit(1);
}
if (!fs.existsSync(databasePath)) {
  console.error(`找不到 SQLite:${databasePath}`);
  process.exit(1);
}

// ------------------------------------------------- 1. 先做一份一致性副本再读

// 运行库是 WAL 模式，直接读会读到写一半的状态；而且导出过程中 Mamba 可能还在写。
// .backup 拿到的是一个静止快照，之后所有查询都对着副本跑，运行库全程只读不碰。
// 快照名带上主机名:两台电脑的档案并在一起时,一眼看得出这份整库是谁的。
const sourceName = clean(os.hostname()).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown-host';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const snapshotDirectory = path.join(outputDirectory, '_snapshots');
const snapshotPath = path.join(snapshotDirectory, `${sourceName}-${stamp}.sqlite`);
const scratchPath = path.join(os.tmpdir(), `mamba-archive-${process.pid}.sqlite`);
const workingPath = dryRun ? scratchPath : snapshotPath;

if (!dryRun) ensureDir(snapshotDirectory);
try {
  execFileSync(SQLITE, ['-batch', databasePath, `.backup ${sqlText(workingPath)}`], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (error) {
  console.error(`建立快照失败:${String(error?.stderr || error?.message || error).trim()}`);
  process.exit(1);
}

try {
  const immutable = `file:${workingPath}?immutable=1`;
  const check = execFileSync(SQLITE, ['-batch', immutable, 'PRAGMA quick_check;'], {
    encoding: 'utf8',
  }).trim();
  if (check !== 'ok') throw new Error(check || '没有结果');
} catch (error) {
  console.error(`快照验证失败:${String(error?.stderr || error?.message || error).trim()}`);
  process.exit(1);
}

// -------------------------------------------------- 2. 建 instance → 号码 映射

const instanceMap = new Map();
for (const row of query(workingPath, 'SELECT instance_name, whatsapp_number FROM instance_identity;')) {
  const phone = digits(row.whatsapp_number);
  if (clean(row.instance_name) && phone) instanceMap.set(clean(row.instance_name), phone);
}
for (const row of query(workingPath, 'SELECT instance_name, whatsapp_number FROM whatsapp_connections;')) {
  const phone = digits(row.whatsapp_number);
  if (clean(row.instance_name) && phone && !instanceMap.has(clean(row.instance_name))) {
    instanceMap.set(clean(row.instance_name), phone);
  }
}
const resolveSender = makeSenderResolver(instanceMap);

// ------------------------------------------------------------ 3. Blast 记录

const blastRows = query(workingPath, `
SELECT j.sent_at, j.scheduled_at, j.created_at, j.status, j.flow_topic, j.part_no,
       j.template_key, j.connection_key, j.run_id, j.project_lead_key,
       pl.phone AS customer_phone, pl.name AS customer_name, pl.project_code,
       r.mode, r.flow_no, r.name AS run_name
FROM send_jobs j
LEFT JOIN project_leads pl ON pl.project_lead_key = j.project_lead_key
LEFT JOIN campaign_runs  r ON r.run_id = j.run_id;`).map((row) => ({
  sent_at: clean(row.sent_at),
  scheduled_at: clean(row.scheduled_at),
  created_at: clean(row.created_at),
  sender_phone: resolveSender(row.connection_key, ''),
  customer_phone: digits(row.customer_phone),
  customer_name: clean(row.customer_name),
  project_code: clean(row.project_code),
  flow_topic: clean(row.flow_topic),
  flow_no: row.flow_no ?? null,
  part_no: row.part_no ?? null,
  template_key: clean(row.template_key),
  status: clean(row.status),
  mode: clean(row.mode),
  run_id: clean(row.run_id),
  run_name: clean(row.run_name),
}));

// ------------------------------------------------------------- 4. 对话记录

const messageRows = query(workingPath, `
SELECT m.sent_at, m.created_at, m.direction, m.text, m.message_type, m.source,
       m.flow_topic, m.template_key, m.external_message_id, m.connection_key,
       json_extract(m.payload_json, '$.instanceName') AS instance_name,
       v.customer_phone
FROM messages m
JOIN conversations v ON v.id = m.conversation_id;`).map((row) => ({
  sent_at: clean(row.sent_at),
  created_at: clean(row.created_at),
  sender_phone: resolveSender(row.connection_key, row.instance_name),
  customer_phone: digits(row.customer_phone),
  direction: clean(row.direction),
  text: String(row.text ?? ''),
  message_type: clean(row.message_type),
  source: clean(row.source),
  flow_topic: clean(row.flow_topic),
  template_key: clean(row.template_key),
  external_message_id: clean(row.external_message_id),
}));

// --------------------------------------------------------------- 5. 客户资料

// 客户属于「人」，不属于某个发送号码,所以放顶层一份,不按号码切。
const leadsByContact = new Map();
for (const row of query(workingPath, `
SELECT contact_key, project_code, phone, name, status, sequence_status,
       last_flow_sent, next_flow, first_blast_at, last_blast_at, last_sender_phone
FROM project_leads;`)) {
  const key = clean(row.contact_key);
  if (!leadsByContact.has(key)) leadsByContact.set(key, []);
  leadsByContact.get(key).push({
    project_code: clean(row.project_code),
    name: clean(row.name),
    status: clean(row.status),
    sequence_status: clean(row.sequence_status),
    last_flow_sent: clean(row.last_flow_sent),
    next_flow: clean(row.next_flow),
    first_blast_at: clean(row.first_blast_at),
    last_blast_at: clean(row.last_blast_at),
    last_sender_phone: digits(row.last_sender_phone),
  });
}

const customerRows = query(workingPath, `
SELECT contact_key, phone, display_name, stop_flag, stop_reason, stop_at,
       reply_count, last_reply_at, created_at
FROM contacts;`).map((row) => ({
  customer_phone: digits(row.phone),
  display_name: clean(row.display_name),
  stopped: Number(row.stop_flag) === 1,
  stop_reason: clean(row.stop_reason),
  stop_at: clean(row.stop_at),
  reply_count: Number(row.reply_count) || 0,
  last_reply_at: clean(row.last_reply_at),
  first_seen_at: clean(row.created_at),
  projects: leadsByContact.get(clean(row.contact_key)) || [],
}));

// ---------------------------------------------------------------- 6. 号码表

// alias → 号码 的映射表必须单独存档:whatsapp_connections 在架构上是「本机、临时」的
// 运行时表,一旦被重建,库里的归属会静默变 NULL。档案要能自己解释自己。
const senderRows = query(workingPath, `
SELECT instance_name, whatsapp_number, source, first_seen_at, last_seen_at
FROM instance_identity;`).map((row) => ({
  instance_name: clean(row.instance_name),
  whatsapp_number: digits(row.whatsapp_number),
  source: clean(row.source),
  first_seen_at: clean(row.first_seen_at),
  last_seen_at: clean(row.last_seen_at),
}));

// ------------------------------------------------------------------ 7. 落盘

const blastsByPhone = groupByPhone(blastRows);
const messagesByPhone = groupByPhone(messageRows);

ensureDir(outputDirectory);
const shards = [
  ...writeShards(outputDirectory, 'blasts', blastsByPhone),
  ...writeShards(outputDirectory, 'conversations', messagesByPhone),
];

// 客户与号码对照是「整台机器一份」,不像对话那样能按号码切开。两台电脑导到同一个
// 目录树时,放顶层会互相覆盖 —— 所以按来源主机分开放,谁也不碰谁。
const sourceDirectory = path.join(outputDirectory, '_sources', sourceName);

function writeSource(name, rows) {
  const body = `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
  const relative = path.join('_sources', sourceName, name);
  if (!dryRun) {
    ensureDir(sourceDirectory);
    fs.writeFileSync(path.join(sourceDirectory, name), body);
  }
  return { file: relative, rows: rows.length, sha256: crypto.createHash('sha256').update(body).digest('hex') };
}

const topFiles = [writeSource('customers.jsonl', customerRows), writeSource('senders.jsonl', senderRows)];

// 每个号码一份 manifest:不用打开档案就知道「这个号我到底备到哪一个月」。
const phones = [...new Set([...blastsByPhone.keys(), ...messagesByPhone.keys()])].sort();
for (const phone of phones) {
  const own = shards.filter((item) => item.phone === phone);
  const manifest = {
    whatsapp_number: phone,
    source_host: sourceName,
    generated_at: new Date().toISOString(),
    blasts: own.filter((item) => item.kind === 'blasts').reduce((sum, item) => sum + item.rows, 0),
    messages: own.filter((item) => item.kind === 'conversations').reduce((sum, item) => sum + item.rows, 0),
    months: [...new Set(own.map((item) => item.month))].sort(),
    files: own.map(({ phone: _skip, ...rest }) => rest),
  };
  if (!dryRun) {
    ensureDir(path.join(outputDirectory, phone));
    fs.writeFileSync(
      path.join(outputDirectory, phone, `manifest.${sourceName}.json`),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  }
}

const report = {
  generated_at: new Date().toISOString(),
  source_host: sourceName,
  source_database: path.relative(ROOT, databasePath),
  snapshot: dryRun ? null : path.relative(ROOT, snapshotPath),
  dry_run: dryRun,
  totals: { blasts: blastRows.length, messages: messageRows.length, customers: customerRows.length },
  numbers: phones.map((phone) => ({
    whatsapp_number: phone,
    blasts: (blastsByPhone.get(phone) || []).length,
    messages: (messagesByPhone.get(phone) || []).length,
  })),
  top_level_files: topFiles,
};
if (!dryRun) {
  ensureDir(sourceDirectory);
  fs.writeFileSync(path.join(sourceDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
}
// 读快照会顺带生成 -wal / -shm。查询全是只读,内容都已经落在主文件里,
// 留着只会让「一个快照 = 一个文件」这件事变模糊,收尾时清掉。
fs.rmSync(dryRun ? scratchPath : `${snapshotPath}-wal`, { force: true });
fs.rmSync(dryRun ? `${scratchPath}-wal` : `${snapshotPath}-shm`, { force: true });
fs.rmSync(`${scratchPath}-shm`, { force: true });

// ------------------------------------------------------------------ 8. 报告

const pad = (value, width) => String(value).padStart(width);
console.log('');
console.log(dryRun ? '【试跑】不会写出任何档案' : `【已完成】档案位置:${path.relative(ROOT, outputDirectory)}`);
console.log('');
console.log('  号码              Blast 记录    对话记录   涵盖月份');
console.log('  ────────────────  ──────────  ──────────  ──────────────────');
for (const phone of phones) {
  const own = shards.filter((item) => item.phone === phone);
  const months = [...new Set(own.map((item) => item.month))].sort();
  const range = months.length ? `${months[0]} → ${months[months.length - 1]}(${months.length} 个月)` : '—';
  console.log(`  ${phone.padEnd(16)}  ${pad((blastsByPhone.get(phone) || []).length, 10)}  ${pad((messagesByPhone.get(phone) || []).length, 10)}  ${range}`);
}
console.log('  ────────────────  ──────────  ──────────');
console.log(`  合计              ${pad(blastRows.length, 10)}  ${pad(messageRows.length, 10)}`);
console.log('');
console.log(`  客户资料:${customerRows.length} 位(_sources/${sourceName}/customers.jsonl)`);
console.log(`  号码对照:${senderRows.length} 个(_sources/${sourceName}/senders.jsonl)`);
const unknown = messageRows.filter((row) => row.sender_phone === 'unknown').length;
if (unknown) console.log(`  ⚠️  ${unknown} 条对话认不出是哪个号发的,已放进 unknown/`);
console.log('');
