export const CANCEL_MONITOR_RUNS_CONFIRMATION = "CANCEL_MONITOR_RUNS";

const TERMINAL_RUN_STATUSES = new Set(["COMPLETED", "STOPPED", "CANCELLED", "FAILED"]);

function normalizedRunIds(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))]
    .slice(0, 200);
}

export function createCampaignMonitorCleanupService({
  listRunners,
  forgetRunner,
  persistRunners,
  queue,
} = {}) {
  if (typeof listRunners !== "function" || typeof forgetRunner !== "function") {
    throw new Error("Campaign monitor cleanup requires runner registry access.");
  }

  async function cancelRuns({ runIds, confirmation } = {}) {
    if (confirmation !== CANCEL_MONITOR_RUNS_CONFIRMATION) {
      const error = new Error("取消全部 Campaign 需要明确确认。");
      error.code = "CAMPAIGN_CANCEL_CONFIRMATION_REQUIRED";
      throw error;
    }

    const requested = normalizedRunIds(runIds);
    if (!requested.length) return { requested: 0, cancelled: [], removed: [], queueRemoved: [] };
    const wanted = new Set(requested);
    const queueRemoved = [];

    // Remove queued launches first. Otherwise polling could start the next batch
    // while the operator is cancelling the monitor workspace.
    const queueItems = (await queue?.snapshot?.())?.items || [];
    for (const item of queueItems) {
      if (!wanted.has(String(item?.runId || ""))) continue;
      if (await queue.remove(item.runId)) queueRemoved.push(String(item.runId));
    }
    if (queueRemoved.length && typeof queue?.clearHold === "function") await queue.clearHold();

    const cancelled = [];
    const removed = [];
    for (const runner of listRunners()) {
      const runId = String(runner?.state?.runId || "").trim();
      if (!wanted.has(runId)) continue;
      const previousStatus = String(runner.state?.status || "").toUpperCase();
      if (!TERMINAL_RUN_STATUSES.has(previousStatus)) {
        if (typeof runner.cancel !== "function") {
          throw new Error(`Campaign ${runId} does not support safe cancellation.`);
        }
        await runner.cancel({ reason: "Operator cancelled all runs from Campaign Monitor" });
        cancelled.push({ runId, previousStatus });
      }
      if (forgetRunner(runId)) removed.push({ runId, previousStatus });
    }

    await persistRunners?.();
    return { requested: requested.length, cancelled, removed, queueRemoved };
  }

  return { cancelRuns };
}
