// 导出「回过话的客户 + 完整对话」,给 AI 抽画像用。
//
// 这是评估阶段的工具:先把资料摊出来给人看,确认值得做,再谈自动化。
// 它只读不写,不碰运行库,不改任何 schema。
//
// 排序按「意向强度 × 有没有晾着你」,所以 --limit 拿到的是最值得先看的那批,
// 不是随便前 N 个。
//
//   node tools/export-for-profiling.mjs --limit 40
//   node tools/export-for-profiling.mjs                  (全部)
//   node tools/export-for-profiling.mjs --include-flagged (连可疑的也导)
import fs from 'node:fs';
import path from 'node:path';
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

const databasePath = path.resolve(ROOT, flag('--db', 'campaign-data/mamba.sqlite'));
const outputPath = path.resolve(ROOT, flag('--out', 'campaign-data/profiling-input.jsonl'));
const limit = Number(flag('--limit', 0)) || 0;
const includeFlagged = has('--include-flagged');
const THREAD_CAP = Number(flag('--thread-cap', 150));

const die = (message) => { console.error(`✗ ${message}`); process.exit(1); };
const clean = (value) => String(value ?? '').trim();
if (!fs.existsSync(databasePath)) die(`找不到资料库:${databasePath}`);

function query(sql) {
  const out = execFileSync(SQLITE, ['-batch', '-json', databasePath, sql], {
    encoding: 'utf8', maxBuffer: 512 * 1024 * 1024,
  }).trim();
  return out ? JSON.parse(out) : [];
}

// ---------------------------------------------------------------- 本机的号码

// 自己的号码常常会以「客户」身分出现在对话里(测试、自己发给自己)。
// 先认出来,免得浪费一次抽取,也免得画像里混进假客户。
const ownNumbers = new Set(query(`
SELECT replace(replace(whatsapp_number,'+',''),' ','') AS n FROM whatsapp_connections
UNION SELECT replace(replace(whatsapp_number,'+',''),' ','') FROM instance_identity;`)
  .map((row) => clean(row.n)).filter(Boolean));

// ------------------------------------------------------------------ 候选客户

// 「有回过话」不等于「是客户」。你的号码同时是工作号和生活号,所以保险、牙医、
// 同行、自己公司发来的讯息一样会让 reply_count > 0,而且最后一句永远是他们说的。
// 真正的判准是「有没有在 blast 名单里」—— project_leads 有记录,代表这个人是你
// 主动导入、发过 campaign 的。牙医不会出现在里面。
const requireLead = !has('--include-non-leads');
const number = String(flag('--number', '')).replace(/[^0-9]/g, '');

const conditions = [
  'c.reply_count > 0',
  'c.stop_flag = 0',
  'EXISTS (SELECT 1 FROM conversations v WHERE v.contact_key = c.contact_key)',
];
if (requireLead) conditions.push('EXISTS (SELECT 1 FROM project_leads pl WHERE pl.contact_key = c.contact_key)');
if (number) {
  conditions.push(`EXISTS (SELECT 1 FROM conversations v2 WHERE v2.contact_key = c.contact_key
    AND v2.connection_key LIKE '%::${number}')`);
}

const contacts = query(`
SELECT c.contact_key AS phone, c.display_name AS name, c.reply_count AS replyCount,
       c.last_reply_at AS lastReplyAt, c.created_at AS firstSeenAt
FROM contacts c
WHERE ${conditions.join('\n  AND ')};`);
if (!contacts.length) die('没有符合条件的客户。放宽条件试试 --include-non-leads,或换 --number。');

// 一次把所有讯息捞回来,在 JS 里分组 —— 206 个客户逐一查会慢上百倍。
const keys = contacts.map((row) => `'${clean(row.phone).replaceAll("'", "''")}'`).join(',');
const messages = query(`
SELECT v.contact_key AS phone, m.direction, m.text, m.message_type AS type,
       m.source, m.flow_topic AS flowTopic, coalesce(m.sent_at, m.created_at) AS at
FROM messages m JOIN conversations v ON v.id = m.conversation_id
WHERE v.contact_key IN (${keys})
ORDER BY v.contact_key, coalesce(m.sent_at, m.created_at), m.row_id;`);

const threads = new Map();
for (const row of messages) {
  const phone = clean(row.phone);
  if (!threads.has(phone)) threads.set(phone, []);
  threads.get(phone).push(row);
}

// Flow 状态:抽画像时要知道这个人现在跑到哪,不然给不出「下一步该做什么」。
const leads = new Map();
for (const row of query(`
SELECT contact_key AS phone, project_code AS project, name, status, sequence_status AS sequenceStatus,
       last_flow_sent AS lastFlowSent, next_flow AS nextFlow, cohort_day AS cohortDay,
       follow_up_due AS followUpDue, first_blast_at AS firstBlastAt, last_blast_at AS lastBlastAt
FROM project_leads WHERE contact_key IN (${keys});`)) {
  const phone = clean(row.phone);
  if (!leads.has(phone)) leads.set(phone, []);
  leads.get(phone).push(row);
}

// ------------------------------------------------------------ 意向强度(粗排用)

// 只用来决定「先看谁」,不是用来下结论 —— 真正的判断交给 AI 读完整段对话。
// 关键字沿用 flow_sequence.mjs 的家族,但这里只取最强的那一个当分数。
const INTENT = [
  { name: 'viewing', score: 5, re: /(view|visit|appointment|show ?unit|showroom|看房|参观|约时间|现场|boleh tengok)/i },
  { name: 'price', score: 4, re: /(price|how ?much|package|rebate|discount|budget|afford|多少钱|几钱|价格|配套|预算|berapa|harga)/i },
  { name: 'loan', score: 3, re: /(loan|bank|salary|payslip|monthly|installment|月供|供多少|贷款|银行|薪水|gaji|ansuran)/i },
  { name: 'layout', score: 2, re: /(layout|floor ?plan|sqft|bedroom|\d ?room|2房|3房|户型|面积|平方尺|bilik)/i },
  { name: 'location', score: 2, re: /(location|where|address|nearby|\blrt\b|\bmrt\b|station|地点|位置|在哪里|靠近|车站|lokasi|stesen)/i },
];

const OTP_OR_LINK = /^\s*(\d{4,8}|https?:\/\/\S+)\s*$/;
const NOISE = /(verification code|confirmation code|验证码|kod pengesahan|one-?time password|\bOTP\b)/i;

const rows = [];
for (const contact of contacts) {
  const phone = clean(contact.phone);
  const thread = threads.get(phone) || [];
  if (!thread.length) continue;

  const inbound = thread.filter((m) => m.direction === 'inbound');
  const inboundText = inbound.map((m) => clean(m.text)).filter(Boolean);

  let intent = { name: 'none', score: 0 };
  for (const candidate of INTENT) {
    if (inboundText.some((text) => candidate.re.test(text)) && candidate.score > intent.score) intent = candidate;
  }

  const last = thread[thread.length - 1];
  const waiting = last?.direction === 'inbound';
  const lastAt = clean(last?.at);
  const daysSince = lastAt ? Math.floor((Date.now() - Date.parse(lastAt)) / 86400000) : null;

  // 「这可能不是客户」的嫌疑。不自动删,只标记 —— 判断权留给人。
  const flags = [];
  if (ownNumbers.has(phone)) flags.push('本机号码');
  if (Number(contact.replyCount) > 200) flags.push(`回复 ${contact.replyCount} 次,不像房产客户`);
  if (inboundText.length && inboundText.every((text) => OTP_OR_LINK.test(text))) flags.push('全是验证码或链接');
  else if (inboundText.some((text) => NOISE.test(text)) && inboundText.length <= 3) flags.push('疑似验证码通知');

  // 长对话只留最近的:抽画像看的是「他现在要什么」,半年前的寒暄没有帮助。
  const kept = thread.length > THREAD_CAP ? thread.slice(-THREAD_CAP) : thread;

  rows.push({
    sortScore: intent.score * 10 + (waiting ? 5 : 0),
    lastAt,
    flags,
    record: {
      customer_phone: phone,
      name: clean(contact.name) === phone ? '' : clean(contact.name),
      reply_count: Number(contact.replyCount) || 0,
      last_message_at: lastAt,
      days_since_last: daysSince,
      waiting_for_you: waiting,
      intent_signal: intent.name,
      review_flags: flags,
      lead_state: (leads.get(phone) || []).map((lead) => ({
        project: clean(lead.project),
        status: clean(lead.status),
        sequence_status: clean(lead.sequenceStatus),
        last_flow_sent: clean(lead.lastFlowSent),
        next_flow: clean(lead.nextFlow),
        cohort_day: lead.cohortDay ?? null,
        follow_up_due: clean(lead.followUpDue),
        first_blast_at: clean(lead.firstBlastAt),
        last_blast_at: clean(lead.lastBlastAt),
      })),
      thread_truncated: thread.length > THREAD_CAP ? thread.length - THREAD_CAP : 0,
      thread: kept.map((m) => ({
        at: clean(m.at),
        from: m.direction === 'inbound' ? 'customer' : 'me',
        text: String(m.text ?? ''),
        ...(clean(m.type) && clean(m.type) !== 'text' ? { media: clean(m.type) } : {}),
        ...(clean(m.flowTopic) ? { flow: clean(m.flowTopic) } : {}),
      })),
    },
  });
}

// 先看最值得看的:意向强 > 晾着你 > 最近讲过话。
rows.sort((a, b) => b.sortScore - a.sortScore || String(b.lastAt).localeCompare(String(a.lastAt)));

const usable = includeFlagged ? rows : rows.filter((row) => !row.flags.length);
const flagged = rows.filter((row) => row.flags.length);
const selected = limit > 0 ? usable.slice(0, limit) : usable;

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${selected.map((row) => JSON.stringify(row.record)).join('\n')}\n`);

// ------------------------------------------------------------------ 报告

const chars = selected.reduce((sum, row) => sum + row.record.thread.reduce((n, m) => n + m.text.length, 0), 0);
const byIntent = {};
for (const row of selected) byIntent[row.record.intent_signal] = (byIntent[row.record.intent_signal] || 0) + 1;

console.log('');
console.log(`  筛选:有回过话 · 没 STOP${requireLead ? ' · 在 blast 名单里' : ' · 含非 lead'}${number ? ` · 号码 ${number}` : ''}`);
console.log(`  候选客户:${rows.length} 位`);
console.log(`  标记为可疑、已排除:        ${flagged.length} 位${includeFlagged ? '(--include-flagged 已包含)' : ''}`);
console.log(`  本次导出:                  ${selected.length} 位`);
console.log('');
console.log('  意向讯号   人数');
console.log('  ────────  ────');
for (const [name, count] of Object.entries(byIntent).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${name.padEnd(8)}  ${String(count).padStart(4)}`);
}
console.log('');
console.log(`  其中晾着你没回的:${selected.filter((row) => row.record.waiting_for_you).length} 位`);
console.log(`  对话总字元:      ${chars.toLocaleString()}`);
console.log('');
if (flagged.length) {
  console.log('  被排除的(自己看一眼对不对):');
  for (const row of flagged.slice(0, 8)) {
    console.log(`    ${row.record.customer_phone.slice(0, 7)}****  ${row.flags.join(' · ')}`);
  }
  if (flagged.length > 8) console.log(`    …还有 ${flagged.length - 8} 位`);
  console.log('');
}
console.log(`  已写出:${path.relative(ROOT, outputPath)}`);
console.log('');
