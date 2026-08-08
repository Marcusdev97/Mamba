// 把抽好的客户画像写进本机档案,并校验格式。
//
// 评估阶段刻意不碰 SQLite schema —— 画像存成一个 JSON 档,没用就删掉,
// Mamba 一行都不用改。等验证够多、格式稳定了,再走正规 migration 搬进资料库。
//
// 以 customer_phone 为键做 merge:重跑同一个客户会更新,不会长出重复。
//
//   node tools/import-profiles.mjs --file new-profiles.json          (试跑)
//   node tools/import-profiles.mjs --file new-profiles.json --apply
//   node tools/import-profiles.mjs --list
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

const storePath = path.resolve(ROOT, flag('--store', 'campaign-data/contact_profiles.json'));
const databasePath = path.resolve(ROOT, flag('--db', 'campaign-data/mamba.sqlite'));
const apply = has('--apply');

const die = (message) => { console.error(`✗ ${message}`); process.exit(1); };
const clean = (value) => String(value ?? '').trim();
const digits = (value) => clean(value).replace(/[^0-9]/g, '');

const ENUMS = {
  contact_type: ['buyer', 'owner', 'tenant', 'agent_partner', 'not_relevant'],
  intent_level: ['hot', 'warm', 'cold', 'not_a_lead'],
  relationship: ['waiting_on_you', 'waiting_on_them', 'dormant'],
  confidence: ['high', 'medium', 'low'],
};
// 有值就必须有原话。这是整套画像可不可信的关键 —— 见 docs/LEAD_PROFILING_PROMPT.md。
const NEEDS_QUOTE = ['budget', 'purpose', 'blocker', 'location_wants', 'location_avoids'];

function readStore() {
  if (!fs.existsSync(storePath)) return { generated_at: '', prompt_version: 'docs/LEAD_PROFILING_PROMPT.md', profiles: [] };
  const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  return { ...parsed, profiles: Array.isArray(parsed.profiles) ? parsed.profiles : [] };
}

// ------------------------------------------------------------------ --list

if (has('--list')) {
  const store = readStore();
  if (!store.profiles.length) die(`${path.relative(ROOT, storePath)} 里还没有画像。`);
  const pad = (value, width) => String(value ?? '').padEnd(width);
  console.log('');
  console.log('  客户              类型        意向      谁在等          等  预算        可配对');
  console.log('  ────────────────  ─────────  ───────  ─────────────  ──  ─────────  ────');
  const waitLabel = { waiting_on_you: '你欠他', waiting_on_them: '等他回', dormant: '沉睡' };
  for (const p of [...store.profiles].sort((a, b) => (b.days_waiting || 0) - (a.days_waiting || 0))) {
    const budget = p.budget?.max ? `${Math.round(p.budget.max / 1000)}k` : (p.budget?.raw || '—');
    console.log(`  ${pad(`${clean(p.customer_phone).slice(0, 7)}**** ${clean(p.name).slice(0, 6)}`, 16)}  ${pad(p.contact_type, 9)}  ${pad(p.intent_level, 7)}  ${pad(waitLabel[p.relationship] || p.relationship, 13)}  ${String(p.days_waiting ?? '').padStart(2)}  ${pad(budget, 9)}  ${p.reusable_for_other_projects ? '✓' : ''}`);
  }
  console.log('');
  console.log(`  共 ${store.profiles.length} 位 · ${path.relative(ROOT, storePath)}`);
  console.log('');
  process.exit(0);
}

// ------------------------------------------------------------------ 读入新画像

const filePath = flag('--file', '');
if (!filePath) die('缺少 --file(新画像档案),或用 --list 看现有的。');
const inputPath = path.resolve(ROOT, filePath);
if (!fs.existsSync(inputPath)) die(`找不到:${inputPath}`);

const raw = fs.readFileSync(inputPath, 'utf8').trim();
let incoming;
try {
  // 同时吃 JSON 阵列、{profiles:[...]} 与 JSONL —— 三种我都可能产出。
  incoming = raw.startsWith('{') || raw.startsWith('[')
    ? (() => { const parsed = JSON.parse(raw); return Array.isArray(parsed) ? parsed : (parsed.profiles || []); })()
    : raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
} catch (error) {
  die(`档案解析失败:${error.message}`);
}
if (!incoming.length) die('档案里没有画像。');

// ------------------------------------------------------------------ 校验

const problems = [];
const warnings = [];
for (const [index, profile] of incoming.entries()) {
  const where = `第 ${index + 1} 笔${clean(profile.name) ? ` (${clean(profile.name)})` : ''}`;
  if (!digits(profile.customer_phone)) problems.push(`${where}:缺 customer_phone`);
  for (const [field, allowed] of Object.entries(ENUMS)) {
    const value = clean(profile[field]);
    if (!value) problems.push(`${where}:缺 ${field}`);
    else if (!allowed.includes(value)) problems.push(`${where}:${field}="${value}" 不是合法值(${allowed.join('/')})`);
  }
  for (const field of NEEDS_QUOTE) {
    const value = profile[field];
    const filled = Array.isArray(value) ? value.length : (value && typeof value === 'object' ? value.max ?? value.min ?? value.raw : clean(value));
    if (!filled) continue;
    const quote = clean(profile[`${field}_quote`]) || clean(value?.quote);
    if (!quote) warnings.push(`${where}:${field} 有值但没有客户原话`);
  }
  if (clean(profile.next_step).length < 15) warnings.push(`${where}:next_step 太短,可能不够具体`);
}

// 号码对不对得上本机资料库 —— 对不上通常是打错或抽错人。
const known = new Map();
if (fs.existsSync(databasePath)) {
  const keys = incoming.map((p) => `'${digits(p.customer_phone)}'`).filter((k) => k !== "''").join(',');
  if (keys) {
    const out = execFileSync(SQLITE, ['-batch', '-json', databasePath, `
SELECT c.contact_key AS phone, c.display_name AS name, c.reply_count AS replyCount,
       (SELECT group_concat(DISTINCT pl.project_code) FROM project_leads pl WHERE pl.contact_key=c.contact_key) AS projects
FROM contacts c WHERE c.contact_key IN (${keys});`], { encoding: 'utf8' }).trim();
    for (const row of out ? JSON.parse(out) : []) known.set(clean(row.phone), row);
  }
}
for (const profile of incoming) {
  const phone = digits(profile.customer_phone);
  if (phone && !known.has(phone)) warnings.push(`${phone}:资料库里找不到这个客户`);
}

// ------------------------------------------------------------------ 合并

const store = readStore();
const byPhone = new Map(store.profiles.map((p) => [digits(p.customer_phone), p]));
const now = new Date().toISOString().slice(0, 10);
let added = 0;
let updated = 0;

for (const profile of incoming) {
  const phone = digits(profile.customer_phone);
  if (!phone) continue;
  const existing = byPhone.get(phone);
  const info = known.get(phone);
  const merged = {
    ...profile,
    customer_phone: phone,
    name: clean(profile.name) || clean(info?.name) || '',
    // 存下来时补上资料库现况,画像才自成一份可读的东西,不用另外去查。
    db_reply_count: info ? Number(info.replyCount) || 0 : null,
    db_projects: clean(info?.projects) ? clean(info.projects).split(',') : [],
    first_profiled_at: existing?.first_profiled_at || now,
    updated_at: now,
  };
  if (existing) { updated += 1; byPhone.set(phone, merged); } else { added += 1; byPhone.set(phone, merged); }
}

// ------------------------------------------------------------------ 报告

console.log('');
console.log(`  来源:${path.relative(ROOT, inputPath)} · ${incoming.length} 笔`);
console.log(`  现有:${store.profiles.length} 笔 → 新增 ${added} · 更新 ${updated}`);
console.log('');
if (problems.length) {
  console.log(`  ✗ 格式错误 ${problems.length} 项(必须修掉才能写入):`);
  for (const message of problems.slice(0, 12)) console.log(`      ${message}`);
  if (problems.length > 12) console.log(`      …还有 ${problems.length - 12} 项`);
  console.log('');
}
if (warnings.length) {
  console.log(`  ⚠ 提醒 ${warnings.length} 项(不挡写入,但值得看):`);
  for (const message of warnings.slice(0, 12)) console.log(`      ${message}`);
  if (warnings.length > 12) console.log(`      …还有 ${warnings.length - 12} 项`);
  console.log('');
}

if (problems.length) die('有格式错误,没有写入任何东西。');
if (!apply) {
  console.log('  【试跑】没有写入。确认后加上 --apply');
  console.log('');
  process.exit(0);
}

const output = {
  generated_at: now,
  prompt_version: store.prompt_version || 'docs/LEAD_PROFILING_PROMPT.md',
  profiles: [...byPhone.values()].sort((a, b) => (b.days_waiting || 0) - (a.days_waiting || 0)),
};
fs.mkdirSync(path.dirname(storePath), { recursive: true });
fs.writeFileSync(storePath, `${JSON.stringify(output, null, 2)}\n`);
console.log(`  ✓ 已写入:${path.relative(ROOT, storePath)} · 共 ${output.profiles.length} 位`);
console.log('  用 node tools/import-profiles.mjs --list 查看');
console.log('');
