// Notion 回写的 outbox（先写本机，再非同步推出去）。
//
// 事故背景 (2026-07-21)：campaign 中途 STOP 就完全不回写 Notion，已经收到讯息的人
// 在名单上看起来从没发过，隔天重开整批重发。现在 run 一结束就立刻回写，但「立刻」
// 还是可能失败 —— Notion timeout、token 过期、网路断。失败了要有人记得重试，
// 不能靠人肉。
//
// 这就是 outbox：run 结束 -> 排一笔 job -> 马上试着推 -> 成功就结案，
// 失败就留在队列里，晚上 10 点或你按按钮的时候再推。
//
// sync_jobs / sync_worker_state 两张表在 schema v3 就设计好了(idempotency_key
// UNIQUE、attempt_count、available_at 退避)，只是一直没人实作。这里把它用起来。

import path from "node:path";
import { createSqliteCli, sqlValue } from "./sqlite-cli.mjs";

const MAX_ATTEMPTS = 6;
// 退避：1m → 5m → 15m → 1h → 4h，再来就等每晚那次兜底。
const BACKOFF_MINUTES = [1, 5, 15, 60, 240];

function clean(value) {
  return String(value ?? "").trim();
}

export function backoffMinutes(attempt) {
  return BACKOFF_MINUTES[Math.min(Math.max(attempt, 1) - 1, BACKOFF_MINUTES.length - 1)];
}

export function createNotionOutboxService({
  dataDir,
  sqliteBinary = "",
  clock = () => new Date(),
  maxAttempts = MAX_ATTEMPTS,
} = {}) {
  const databasePath = path.join(dataDir, "mamba.sqlite");
  let cliPromise = null;

  function cli() {
    if (!cliPromise) {
      cliPromise = createSqliteCli({ databasePath, sqliteBinary }).catch((error) => {
        cliPromise = null;
        throw error;
      });
    }
    return cliPromise;
  }

  // idempotencyKey 撞到就当作已经排过 —— 同一个 run 结束两次(续跑、重启恢复)
  // 不该变成两笔待办。
  async function enqueue({
    entityType,
    entityId,
    payload = {},
    idempotencyKey = "",
    direction = "LOCAL_TO_NOTION",
  } = {}) {
    const type = clean(entityType);
    const id = clean(entityId);
    if (!type || !id) return { queued: false, reason: "invalid_entity" };
    const key = clean(idempotencyKey) || `${direction}:${type}:${id}`;
    const nowIso = clock().toISOString();
    const database = await cli();
    await database.exec(`
INSERT OR IGNORE INTO sync_jobs
  (idempotency_key, direction, entity_type, entity_id, status, attempt_count, available_at, payload_json, created_at, updated_at)
VALUES
  (${sqlValue(key)}, ${sqlValue(direction)}, ${sqlValue(type)}, ${sqlValue(id)}, 'PENDING', 0, ${sqlValue(nowIso)}, ${sqlValue(JSON.stringify(payload))}, ${sqlValue(nowIso)}, ${sqlValue(nowIso)});`);
    return { queued: true, idempotencyKey: key };
  }

  // 到期的待办。RUNNING 不捞 —— 那是别人正在处理的。
  async function due({ limit = 25 } = {}) {
    const database = await cli();
    const nowIso = clock().toISOString();
    return database.query(`
SELECT id, idempotency_key AS idempotencyKey, direction, entity_type AS entityType, entity_id AS entityId,
       status, attempt_count AS attemptCount, available_at AS availableAt, payload_json AS payloadJson,
       last_error_code AS lastErrorCode, last_error_message AS lastErrorMessage
FROM sync_jobs
WHERE status IN ('PENDING','RETRY') AND available_at <= ${sqlValue(nowIso)}
ORDER BY available_at, id
LIMIT ${Math.max(1, Math.min(Number(limit) || 25, 500))};`);
  }

  async function markRunning(id) {
    const database = await cli();
    const nowIso = clock().toISOString();
    await database.exec(`UPDATE sync_jobs SET status='RUNNING', updated_at=${sqlValue(nowIso)} WHERE id=${sqlValue(id)};`);
  }

  async function markCompleted(id) {
    const database = await cli();
    const nowIso = clock().toISOString();
    await database.exec(`
UPDATE sync_jobs SET status='COMPLETED', last_error_code='', last_error_message='', updated_at=${sqlValue(nowIso)}
WHERE id=${sqlValue(id)};`);
  }

  // 还有额度就退避重试；用完就标 FAILED 等人来看。FAILED 不会自己再跑，
  // 免得一笔坏资料每晚洗一次版。
  async function markFailure(job, error) {
    const database = await cli();
    const attempt = Number(job.attemptCount || 0) + 1;
    const nowMs = clock().getTime();
    const exhausted = attempt >= maxAttempts;
    const availableAt = new Date(nowMs + backoffMinutes(attempt) * 60_000).toISOString();
    const nowIso = new Date(nowMs).toISOString();
    await database.exec(`
UPDATE sync_jobs SET
  status=${sqlValue(exhausted ? "FAILED" : "RETRY")},
  attempt_count=${attempt},
  available_at=${sqlValue(availableAt)},
  last_error_code=${sqlValue(clean(error?.code) || "SYNC_FAILED")},
  last_error_message=${sqlValue(clean(error?.message).slice(0, 500))},
  updated_at=${sqlValue(nowIso)}
WHERE id=${sqlValue(job.id)};`);
    return { exhausted, attempt, availableAt };
  }

  // 把到期的推一轮。handler 回 false 代表「这笔现在处理不了但不算错」(例如 run
  // 档不见了)，直接结案不重试。
  async function drain(handler, { limit = 25 } = {}) {
    const report = { processed: 0, completed: 0, retried: 0, failed: 0, skipped: 0, errors: [] };
    if (typeof handler !== "function") return report;
    const jobs = await due({ limit });
    for (const job of jobs) {
      report.processed += 1;
      await markRunning(job.id);
      try {
        let payload = {};
        try { payload = JSON.parse(job.payloadJson || "{}"); } catch { payload = {}; }
        const result = await handler({ ...job, payload });
        if (result === false) {
          await markCompleted(job.id);
          report.skipped += 1;
        } else {
          await markCompleted(job.id);
          report.completed += 1;
        }
      } catch (error) {
        const outcome = await markFailure(job, error);
        if (outcome.exhausted) report.failed += 1; else report.retried += 1;
        report.errors.push({ entityId: job.entityId, attempt: outcome.attempt, error: error.message });
      }
    }
    return report;
  }

  async function snapshot() {
    const database = await cli();
    const rows = await database.query(`
SELECT status, COUNT(*) AS count, MIN(available_at) AS nextAt
FROM sync_jobs GROUP BY status;`);
    const byStatus = {};
    for (const row of rows) byStatus[row.status] = { count: row.count, nextAt: row.nextAt };
    // 等着同步的是哪些 flow —— 弹窗要讲得出「Flow 2 - Layout 正在同步」，
    // 光说「同步中」使用者不知道是哪一批。
    const waiting = await database.query(`
SELECT payload_json AS payloadJson, entity_id AS entityId, status
FROM sync_jobs WHERE status IN ('PENDING','RETRY','RUNNING')
ORDER BY available_at LIMIT 20;`);
    const flows = [];
    for (const row of waiting) {
      let payload = {};
      try { payload = JSON.parse(row.payloadJson || "{}"); } catch { /* 坏 payload 不该让整个状态查询失败 */ }
      flows.push({
        runId: row.entityId,
        status: row.status,
        flowLabel: clean(payload.flowLabel) || "Flow 1 - Project Template",
        project: clean(payload.project) || clean(payload.projectId),
      });
    }
    const failed = await database.query(`
SELECT entity_type AS entityType, entity_id AS entityId, attempt_count AS attemptCount,
       last_error_code AS lastErrorCode, last_error_message AS lastErrorMessage
FROM sync_jobs WHERE status='FAILED' ORDER BY updated_at DESC LIMIT 10;`);
    return {
      pending: byStatus.PENDING?.count ?? 0,
      retry: byStatus.RETRY?.count ?? 0,
      running: byStatus.RUNNING?.count ?? 0,
      completed: byStatus.COMPLETED?.count ?? 0,
      failed: byStatus.FAILED?.count ?? 0,
      nextAttemptAt: byStatus.RETRY?.nextAt ?? byStatus.PENDING?.nextAt ?? null,
      waitingFlows: flows,
      failedSamples: failed,
    };
  }

  // 卡在 RUNNING 的通常是上次跑到一半被关掉。开机时喊一次，让它们回到队列。
  async function requeueStuckRunning({ olderThanMinutes = 15 } = {}) {
    const database = await cli();
    const nowMs = clock().getTime();
    const cutoff = new Date(nowMs - olderThanMinutes * 60_000).toISOString();
    const nowIso = new Date(nowMs).toISOString();
    const stuck = await database.query(`SELECT COUNT(*) AS count FROM sync_jobs WHERE status='RUNNING' AND updated_at < ${sqlValue(cutoff)};`);
    const count = stuck?.[0]?.count ?? 0;
    if (count) {
      await database.exec(`
UPDATE sync_jobs SET status='RETRY', available_at=${sqlValue(nowIso)}, updated_at=${sqlValue(nowIso)}
WHERE status='RUNNING' AND updated_at < ${sqlValue(cutoff)};`);
    }
    return { requeued: count };
  }

  // 人工把 FAILED 的救回队列（改完 Notion 设定之后按一下就好）。
  async function retryFailed() {
    const database = await cli();
    const nowIso = clock().toISOString();
    const rows = await database.query("SELECT COUNT(*) AS count FROM sync_jobs WHERE status='FAILED';");
    const count = rows?.[0]?.count ?? 0;
    if (count) {
      await database.exec(`
UPDATE sync_jobs SET status='RETRY', attempt_count=0, available_at=${sqlValue(nowIso)}, updated_at=${sqlValue(nowIso)}
WHERE status='FAILED';`);
    }
    return { requeued: count };
  }

  return { enqueue, due, drain, snapshot, requeueStuckRunning, retryFailed, markFailure, markCompleted };
}
