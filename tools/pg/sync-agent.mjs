// Sync Agent —— 把这台电脑的 SQLite 同步进 Global PostgreSQL。
//
//   node tools/pg/sync-agent.mjs              # 同步本机 + 吸收 incoming/ 里别台传来的
//   node tools/pg/sync-agent.mjs --dry-run    # 只说会做什么,不碰资料库
//   node tools/pg/sync-agent.mjs --self-only  # 只同步本机,不处理 incoming/
//   node tools/pg/sync-agent.mjs --skip-schema
//
// 连线字串取用顺序:环境变数 DATABASE_URL → 仓库根目录的 .env.pg。
// .env.pg 一行就好:postgresql://user@host:5432/dbname
//
// 设计要点:
//   · 全程只读本机 SQLite,写入只发生在 Postgres。
//   · 有锁档,launchd 排程和你手动跑撞在一起也不会同时跑两份。
//   · 每次先跑一次建表脚本(幂等),所以 schema 有新栏位会自动补上。
//   · 每张表带 source_device_key,Postgres 里永远分得清哪台电脑传的。
//   · incoming/ 里别台电脑上传的 .sqlite 同步成功后移到 incoming/done/。
//   · 任何一步失败就以非 0 结束,launchd 的 err log 里看得到。
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const SELF_ONLY = argv.includes('--self-only');
const SKIP_SCHEMA = argv.includes('--skip-schema');

const INCOMING = path.join(ROOT, 'campaign-data/incoming');
const DONE = path.join(INCOMING, 'done');
const LOCK = path.join(ROOT, 'campaign-data/.sync-agent.lock');
const TMP = path.join(ROOT, 'campaign-data/.sync-tmp.sql');
const SCHEMA = path.join(ROOT, 'docs/mamba-schema.postgres.sql');
const LOCK_STALE_MS = 30 * 60 * 1000;

const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (...a) => console.log(`[${ts()}]`, ...a);
const fail = (...a) => { console.error(`[${ts()}] ✗`, ...a); release(); process.exit(1); };

// --- 连线字串 -------------------------------------------------------------
function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL.trim();
  const envFile = path.join(ROOT, '.env.pg');
  if (existsSync(envFile)) {
    const raw = readFileSync(envFile, 'utf8').trim();
    // 支援裸字串,也支援 DATABASE_URL=... 的写法
    const m = raw.match(/^(?:DATABASE_URL\s*=\s*)?["']?(postgres(?:ql)?:\/\/[^"'\s]+)/m);
    if (m) return m[1];
  }
  return '';
}

// --- 锁:不让两份同时跑 ----------------------------------------------------
let locked = false;
function acquire() {
  if (existsSync(LOCK)) {
    const age = Date.now() - statSync(LOCK).mtimeMs;
    const pid = readFileSync(LOCK, 'utf8').trim();
    if (age < LOCK_STALE_MS) {
      log(`另一个同步还在跑(pid ${pid},${Math.round(age / 1000)}s 前),这次跳过。`);
      process.exit(0);
    }
    log(`发现过期锁档(${Math.round(age / 60000)} 分钟前),接手。`);
  }
  mkdirSync(path.dirname(LOCK), { recursive: true });
  writeFileSync(LOCK, String(process.pid));
  locked = true;
}
function release() { if (locked) rmSync(LOCK, { force: true }); }
process.on('exit', release);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { release(); process.exit(130); });

// --- 小工具 ---------------------------------------------------------------
function run(cmd, args, label) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) fail(`${label} 起不来:${r.error.message}`);
  if (r.status !== 0) {
    const detail = (r.stderr || r.stdout || '').trim().split('\n').slice(-6).join('\n   ');
    fail(`${label} 失败(exit ${r.status}):\n   ${detail}`);
  }
  return (r.stdout || '').trim();
}
const psql = (url, file) => run('psql', [url, '-v', 'ON_ERROR_STOP=1', '-q', '-f', file], `psql ${path.basename(file)}`);
const dump = (out, extra = []) =>
  run(process.execPath, [path.join(ROOT, 'tools/pg/dump-data.mjs'), '--if-newer', '--out', out, ...extra], 'dump-data');

// --- 开工 -----------------------------------------------------------------
const url = databaseUrl();
if (!url) {
  console.error(`[${ts()}] ✗ 找不到连线字串。设 DATABASE_URL,或在 ${path.join(ROOT, '.env.pg')} 写一行:`);
  console.error('   postgresql://user@localhost:5432/mamba_global');
  process.exit(1);
}
const safeUrl = url.replace(/\/\/([^:@/]+):[^@]*@/, '//$1:***@');   // 日志里不露密码

acquire();
log(`Sync Agent 开始${DRY ? '(dry-run)' : ''} → ${safeUrl}`);

// 连得上吗
if (!DRY) {
  const ver = run('psql', [url, '-tAc', 'select version()'], '连线测试');
  log(`已连上:${ver.split(',')[0]}`);
}

// 1) schema(幂等,顺便把新栏位补上)
if (!SKIP_SCHEMA) {
  if (!existsSync(SCHEMA)) fail(`找不到建表脚本:${SCHEMA}`);
  if (DRY) log('会跑一次建表脚本(幂等)');
  else { psql(url, SCHEMA); log('schema 已是最新'); }
}

// 2) 本机
const jobs = [{ label: '本机', db: null }];

// 3) 别台电脑上传上来的
if (!SELF_ONLY && existsSync(INCOMING)) {
  for (const f of readdirSync(INCOMING).filter((f) => f.endsWith('.sqlite')).sort()) {
    jobs.push({ label: `上传档 ${f}`, db: path.join(INCOMING, f) });
  }
}

let rowsTotal = 0;
for (const job of jobs) {
  const extra = job.db ? ['--db', job.db] : [];
  if (DRY) { log(`会同步:${job.label}`); continue; }

  const outText = dump(TMP, extra);
  const rows = Number(outText.match(/^\s+(\d+) 行/m)?.[1] || 0);
  const who = outText.match(/盖章为:(.+)$/m)?.[1] || '?';
  psql(url, TMP);
  rmSync(TMP, { force: true });
  rowsTotal += rows;
  log(`✓ ${job.label}:${rows} 行 · ${who}`);

  // 上传档同步完就归档,下次不再重复处理
  if (job.db) {
    mkdirSync(DONE, { recursive: true });
    const dest = path.join(DONE, path.basename(job.db));
    renameSync(job.db, dest);
    log(`  已归档 → ${path.relative(ROOT, dest)}`);
  }
}

if (!DRY) {
  const summary = run('psql', [url, '-tAc',
    `select string_agg(x, ' · ') from (
       select device_name || ' ' || rows_total || ' 行 (' || left(started_at, 16) || ')' as x
       from sync_runs s
       where started_at = (select max(started_at) from sync_runs where source_device_key = s.source_device_key)
       order by device_name) t`], 'sync_runs 汇总');
  log(`Postgres 现况:${summary || '(空)'}`);
}

log(`完成,共 ${rowsTotal} 行。`);
release();
