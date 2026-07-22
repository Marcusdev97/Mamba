// Notion outbox 的测试。
//
// 这层的存在理由：run 结束当下会直接回写 Notion，但那一下可能失败(timeout /
// token 过期 / 断网)。失败却没人记得重试的话，那批人在 Notion 里看起来没发过，
// 下一批就会重发 —— 就是 2026-07-21 那次事故。
//
// 所以这里要证的是：失败会留下来、会退避重试、重试成功会结案、
// 试到放弃不会每晚洗版、而且同一个 run 排两次不会变成两笔。

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { backoffMinutes, createNotionOutboxService } from "./lib/notion-outbox-service.mjs";
import { createNotionOutboxWorker, shouldRunNow, klMinutes } from "./lib/notion-outbox-worker.mjs";
import { createSqliteCli, findSqliteCli } from "./lib/sqlite-cli.mjs";

const binary = await findSqliteCli();
if (!binary) {
  console.log("⚠️ 这台机器没有 sqlite3，跳过 outbox 测试。");
  process.exit(0);
}

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-outbox-"));
const database = await createSqliteCli({ databasePath: path.join(dataDir, "mamba.sqlite") });
// 真 schema：idempotency_key UNIQUE 是幂等的关键，一定要照抄。
await database.exec(`
CREATE TABLE sync_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL UNIQUE,
  direction TEXT NOT NULL CHECK (direction IN ('NOTION_TO_LOCAL','LOCAL_TO_NOTION')),
  entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','RUNNING','RETRY','COMPLETED','FAILED')),
  attempt_count INTEGER NOT NULL DEFAULT 0, available_at TEXT NOT NULL,
  last_error_code TEXT NOT NULL DEFAULT '', last_error_message TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`);

let now = new Date("2026-07-22T10:00:00.000Z");
const outbox = createNotionOutboxService({ dataDir, clock: () => now, maxAttempts: 3 });

// --- 排队 + 幂等 ---
const first = await outbox.enqueue({
  entityType: "campaign_run", entityId: "run_A",
  idempotencyKey: "LOCAL_TO_NOTION:campaign_run:run_A:flow_advance",
  payload: { runId: "run_A", autoAdvance: true },
});
assert.equal(first.queued, true);
await outbox.enqueue({
  entityType: "campaign_run", entityId: "run_A",
  idempotencyKey: "LOCAL_TO_NOTION:campaign_run:run_A:flow_advance",
  payload: { runId: "run_A", autoAdvance: true },
});
assert.equal((await outbox.snapshot()).pending, 1, "同一个 run 排两次只能有一笔待办");
assert.deepEqual(await outbox.enqueue({ entityType: "", entityId: "x" }), { queued: false, reason: "invalid_entity" });

// --- 推成功 -> 结案 ---
const seen = [];
let report = await outbox.drain(async (job) => { seen.push(job.payload.runId); });
assert.equal(report.completed, 1);
assert.deepEqual(seen, ["run_A"]);
let snap = await outbox.snapshot();
assert.equal(snap.pending, 0);
assert.equal(snap.completed, 1);

// Local-first page patches are queued before the direct Notion attempt; a
// successful direct PATCH must be able to close that durable job by key.
await outbox.enqueue({ entityType: "project_lead_patch", entityId: "lead_1", idempotencyKey: "lead_patch_1", payload: { pageId: "abc", properties: {} } });
assert.equal((await outbox.snapshot()).pending, 1);
await outbox.markCompletedByKey("lead_patch_1");
assert.equal((await outbox.snapshot()).pending, 0);

// --- 推失败 -> 退避重试，不是丢掉 ---
await outbox.enqueue({ entityType: "campaign_run", entityId: "run_B", idempotencyKey: "k_B", payload: { runId: "run_B" } });
report = await outbox.drain(async () => { throw new Error("Notion timeout"); });
assert.equal(report.retried, 1);
assert.equal(report.failed, 0);
snap = await outbox.snapshot();
assert.equal(snap.retry, 1, "失败要留在队列里，不能消失");
assert.match(snap.nextAttemptAt, /2026-07-22T10:0/, "下次重试时间要往后排");

// --- 还没到时间就不重复捞 ---
assert.equal((await outbox.due()).length, 0, "退避时间没到不该再捞出来");
now = new Date("2026-07-22T10:30:00.000Z");
assert.equal((await outbox.due()).length, 1, "时间到了就该回到队列");

// --- 试到上限 -> FAILED，不再自动重跑 ---
report = await outbox.drain(async () => { throw new Error("still down"); });
assert.equal(report.retried, 1);
now = new Date("2026-07-22T18:00:00.000Z");
report = await outbox.drain(async () => { throw new Error("still down"); });
assert.equal(report.failed, 1, "第 3 次(maxAttempts=3)要放弃");
snap = await outbox.snapshot();
assert.equal(snap.failed, 1);
assert.equal(snap.retry, 0);
assert.equal((await outbox.due()).length, 0, "FAILED 不该每晚被捞出来洗版");
assert.equal(snap.failedSamples[0].entityId, "run_B");
assert.match(snap.failedSamples[0].lastErrorMessage, /still down/);

// --- 人工救回 ---
assert.deepEqual(await outbox.retryFailed(), { requeued: 1 });
assert.equal((await outbox.due()).length, 1, "救回来就该重新排队");
report = await outbox.drain(async () => {});
assert.equal(report.completed, 1, "Notion 修好后重试要能成功结案");

// --- handler 回 false = 结案不重试（run 档不见了那种）---
await outbox.enqueue({ entityType: "campaign_run", entityId: "run_gone", idempotencyKey: "k_gone" });
report = await outbox.drain(async () => false);
assert.equal(report.skipped, 1);
assert.equal((await outbox.snapshot()).pending, 0);

// --- 卡在 RUNNING 的要能救回来（跑到一半被关掉）---
await outbox.enqueue({ entityType: "campaign_run", entityId: "run_stuck", idempotencyKey: "k_stuck" });
await database.exec("UPDATE sync_jobs SET status='RUNNING', updated_at='2026-07-22T10:00:00.000Z' WHERE idempotency_key='k_stuck';");
assert.equal((await outbox.due()).length, 0, "RUNNING 不该被别人抢走");
assert.deepEqual(await outbox.requeueStuckRunning({ olderThanMinutes: 15 }), { requeued: 1 });
assert.equal((await outbox.due()).length, 1, "卡住的要回到队列");

// --- 退避曲线 ---
assert.equal(backoffMinutes(1), 1);
assert.equal(backoffMinutes(3), 15);
assert.equal(backoffMinutes(99), 240, "退避有上限，不会无限拉长");

// --- 排程：每晚一次，错过整点还补得到，同一天不重复 ---
const kl = (iso) => new Date(iso);
assert.equal(shouldRunNow({ time: "22:00", now: kl("2026-07-22T14:05:00.000Z") }), true, "KL 22:05 该跑");
assert.equal(shouldRunNow({ time: "22:00", now: kl("2026-07-22T13:30:00.000Z") }), false, "KL 21:30 还没到");
assert.equal(shouldRunNow({ time: "22:00", now: kl("2026-07-22T14:45:00.000Z") }), false, "超过 20 分钟窗口就不补跑");
assert.equal(
  shouldRunNow({ time: "22:00", now: kl("2026-07-22T14:05:00.000Z"), lastRunDate: klMinutes(kl("2026-07-22T14:05:00.000Z")).date }),
  false,
  "今天跑过就不再跑",
);

// --- worker：手动立即同步 ---
let workerNow = new Date("2026-07-22T10:00:00.000Z");
const workerOutbox = createNotionOutboxService({ dataDir, clock: () => workerNow });
await workerOutbox.enqueue({ entityType: "campaign_run", entityId: "run_M", idempotencyKey: "k_M" });
const handled = [];
const worker = createNotionOutboxWorker({
  outbox: workerOutbox,
  clock: () => workerNow,
  handler: async (job) => { handled.push(job.entityId); },
});
const manual = await worker.drainAll({ reason: "manual" });
assert.equal(manual.completed, 1);
assert.deepEqual(handled, ["run_M"]);
assert.equal(worker.status().lastResult.reason, "manual");
assert.notEqual(manual.busy, true, "跑完了就不该说自己还在忙");

// 「已经在跑」用 busy 表示，不能跟 skipped(无需处理的笔数)同名 ——
// 撞名的话 skipped=1 会被画面当成「还在同步中」，明明做完了却骗人。
await workerOutbox.enqueue({ entityType: "campaign_run", entityId: "run_N", idempotencyKey: "k_N" });
let release;
const gate = new Promise((resolve) => { release = resolve; });
let markStarted;
const started = new Promise((resolve) => { markStarted = resolve; });
const slowWorker = createNotionOutboxWorker({ outbox: workerOutbox, clock: () => workerNow, handler: () => { markStarted(); return gate; } });
const inflight = slowWorker.drainAll({ reason: "manual" });
await started;
assert.equal(slowWorker.status().progress.status, "RUNNING");
assert.equal(slowWorker.status().progress.current, 0);
assert.equal(slowWorker.status().progress.total, 1, "画面要知道这轮总共有几笔");
assert.equal(slowWorker.status().progress.currentItem.entityId, "run_N", "画面要知道当前正在处理哪一笔");
const rejected = await slowWorker.drainAll({ reason: "manual" });
assert.equal(rejected.busy, true, "第二次呼叫要回 busy");
assert.equal(rejected.skipped, 0, "busy 的回应不可以让 skipped 变成真值");
release();
const finished = await inflight;
assert.equal(finished.completed, 1);
assert.notEqual(finished.busy, true);
assert.equal(slowWorker.status().progress.status, "SUCCEEDED");
assert.equal(slowWorker.status().progress.current, 1);

// --- 画面要讲得出「在同步哪一批」，不能只说「同步中」 ---
const flowDir = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-outbox-flow-"));
const flowDb = await createSqliteCli({ databasePath: path.join(flowDir, "mamba.sqlite") });
await flowDb.exec(`
CREATE TABLE sync_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, idempotency_key TEXT NOT NULL UNIQUE,
  direction TEXT NOT NULL CHECK (direction IN ('NOTION_TO_LOCAL','LOCAL_TO_NOTION')),
  entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','RUNNING','RETRY','COMPLETED','FAILED')),
  attempt_count INTEGER NOT NULL DEFAULT 0, available_at TEXT NOT NULL,
  last_error_code TEXT NOT NULL DEFAULT '', last_error_message TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`);
const flowOutbox = createNotionOutboxService({ dataDir: flowDir, clock: () => new Date("2026-07-22T10:00:00.000Z") });

// Flow 1 没有 flowLabel，Flow 2-10 有。两种都要在画面上叫得出名字。
await flowOutbox.enqueue({ entityType: "campaign_run", entityId: "run_f1", idempotencyKey: "f1", payload: { runId: "run_f1", flowLabel: "", project: "Binastra" } });
await flowOutbox.enqueue({ entityType: "campaign_run", entityId: "run_f2", idempotencyKey: "f2", payload: { runId: "run_f2", flowLabel: "Flow 2 - Layout", project: "Binastra" } });
await flowOutbox.enqueue({ entityType: "campaign_run", entityId: "run_f10", idempotencyKey: "f10", payload: { runId: "run_f10", flowLabel: "Flow 10 - Surrounding", project: "Enlace" } });

const flowSnap = await flowOutbox.snapshot();
assert.equal(flowSnap.waitingFlows.length, 3);
const labels = flowSnap.waitingFlows.map((item) => item.flowLabel);
assert.ok(labels.includes("Flow 2 - Layout"), "Flow 2 要认得出来");
assert.ok(labels.includes("Flow 10 - Surrounding"), "Flow 10 也要认得出来");
assert.ok(labels.includes("Flow 1 - Project Template"), "Flow 1 没有 label，要补成看得懂的名字");
assert.equal(flowSnap.waitingFlows.find((item) => item.runId === "run_f10").project, "Enlace");

// payload 坏掉不该让整个状态查询爆掉 —— 那会连「队列有没有积压」都看不到。
await flowDb.exec("INSERT INTO sync_jobs (idempotency_key,direction,entity_type,entity_id,status,attempt_count,available_at,payload_json,created_at,updated_at) VALUES ('bad','LOCAL_TO_NOTION','campaign_run','run_bad','PENDING',0,'2026-07-22T10:00:00.000Z','{not json','2026-07-22T10:00:00.000Z','2026-07-22T10:00:00.000Z');");
const afterBad = await flowOutbox.snapshot();
assert.equal(afterBad.pending, 4, "坏 payload 也要算进积压数");
assert.equal(afterBad.waitingFlows.length, 4);

await fs.rm(flowDir, { recursive: true, force: true });
await fs.rm(dataDir, { recursive: true, force: true });
console.log("✅ all notion outbox tests passed");
