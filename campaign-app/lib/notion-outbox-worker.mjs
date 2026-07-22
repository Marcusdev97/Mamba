// Outbox 的排程器：每晚固定时间兜底一次，平常按按钮就立刻推。
//
// 为什么不是每 5 分钟一直推：run 一结束就已经直接回写过一次了(见
// campaign.routes.mjs 的收尾段)，outbox 只收「那次失败的」。所以定时的角色是兜底，
// 不是主力，一天一次够；急的时候人工按按钮。
//
// 时间用吉隆坡时区算，跟 daily-campaign 那支同一套逻辑 —— 不然换日光节约或
// 机器时区不同就会在错的时间跑。

const DEFAULT_TIME = "22:00";
const DEFAULT_INTERVAL_MS = 5 * 60_000;

export function klMinutes(date, timeZone = "Asia/Kuala_Lumpur") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(date).reduce((acc, part) => { acc[part.type] = part.value; return acc; }, {});
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

export function shouldRunNow({ time = DEFAULT_TIME, now, lastRunDate = null, windowMinutes = 20 } = {}) {
  const { date, minutes } = klMinutes(now);
  if (lastRunDate === date) return false;          // 今天已经跑过
  const target = Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  // 给一个窗口：机器睡着、server 刚重启，错过整点也还补得到。
  return minutes >= target && minutes <= target + windowMinutes;
}

export function createNotionOutboxWorker({
  outbox,
  handler,
  time = DEFAULT_TIME,
  clock = () => new Date(),
  onLog = () => {},
  batchLimit = 50,
} = {}) {
  if (!outbox) throw new Error("outbox is required");
  let timer = null;
  let running = false;
  let lastRunDate = null;
  let lastResult = null;
  let progress = null;

  // 一直推到没有到期的为止，但有上限 —— 免得一笔一直失败的把 worker 卡死在这轮。
  async function drainAll({ reason = "manual", maxBatches = 20 } = {}) {
    // 用 busy 而不是 skipped：drain 报告里的 skipped 是「无需处理的笔数」，
    // 两个同名的话 skipped=1 会被当成「正在跑」，画面就会骗人说还没做完。
    if (running) return { busy: true, reason: "already_running", processed: 0, completed: 0, retried: 0, failed: 0, skipped: 0, errors: [] };
    running = true;
    const total = { processed: 0, completed: 0, retried: 0, failed: 0, skipped: 0, errors: [] };
    try {
      await outbox.requeueStuckRunning().catch(() => {});
      const planned = await outbox.due({ limit: batchLimit * maxBatches }).catch(() => []);
      progress = {
        status: "RUNNING",
        reason,
        current: 0,
        total: planned.length,
        completed: 0,
        retried: 0,
        failed: 0,
        skipped: 0,
        currentItem: null,
        startedAt: clock().toISOString(),
        finishedAt: null,
      };
      for (let batch = 0; batch < maxBatches; batch += 1) {
        const before = total.processed;
        const report = await outbox.drain(handler, {
          limit: batchLimit,
          onProgress: ({ phase, current, job, outcome, report: batchReport }) => {
            progress = {
              ...progress,
              current: before + current,
              total: Math.max(progress?.total || 0, before + (batchReport?.processed || 0)),
              completed: total.completed + Number(batchReport?.completed || 0),
              retried: total.retried + Number(batchReport?.retried || 0),
              failed: total.failed + Number(batchReport?.failed || 0),
              skipped: total.skipped + Number(batchReport?.skipped || 0),
              currentItem: {
                entityType: job?.entityType || null,
                entityId: job?.entityId || null,
                flowLabel: job?.payload?.flowLabel || null,
                project: job?.payload?.project || job?.payload?.projectId || null,
                name: job?.payload?.name || null,
                phone: job?.payload?.phone || null,
                outcome: phase === "finished" ? outcome : "running",
              },
              updatedAt: clock().toISOString(),
            };
          },
        });
        total.processed += report.processed;
        total.completed += report.completed;
        total.retried += report.retried;
        total.failed += report.failed;
        total.skipped += report.skipped;
        total.errors.push(...report.errors);
        if (!report.processed) break;
      }
      lastResult = { at: clock().toISOString(), reason, ...total };
      progress = {
        ...progress,
        status: total.failed ? "FAILED" : total.retried ? "RETRY" : "SUCCEEDED",
        current: total.processed,
        total: Math.max(progress?.total || 0, total.processed),
        completed: total.completed,
        retried: total.retried,
        failed: total.failed,
        skipped: total.skipped,
        finishedAt: clock().toISOString(),
      };
      if (total.processed) {
        onLog(`[notion-outbox] ${reason}: 处理 ${total.processed} · 成功 ${total.completed} · 待重试 ${total.retried} · 放弃 ${total.failed}`);
      }
      return total;
    } finally {
      running = false;
    }
  }

  async function tick() {
    if (!shouldRunNow({ time, now: clock(), lastRunDate })) return;
    lastRunDate = klMinutes(clock()).date;
    await drainAll({ reason: "nightly" });
  }

  function start(intervalMs = DEFAULT_INTERVAL_MS) {
    if (timer) return timer;
    timer = setInterval(() => tick().catch((error) => onLog(`[notion-outbox] 排程出错: ${error.message}`)), intervalMs);
    timer.unref?.();
    return timer;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, tick, drainAll, status: () => ({ time, running, lastRunDate, lastResult, progress }) };
}
