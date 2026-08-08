export function createSalesFollowUpJob({ salesPipeline, systemLogs = null, intervalMs = 5 * 60_000 } = {}) {
  if (!salesPipeline) throw new Error("Sales Follow-up job requires salesPipeline.");
  let timer = null;
  let running = false;

  async function run(reason = "scheduled") {
    if (running) return { skipped: true, reason: "already_running" };
    running = true;
    try {
      const schema = await salesPipeline.schemaStatus();
      if (!schema.ready) return { skipped: true, reason: "migration_307_required", schema };
      const result = await salesPipeline.refreshTasks();
      if (result.triggered) {
        await systemLogs?.write({
          level: "info",
          area: "sales_pipeline",
          event: "follow_up_tasks_refreshed",
          message: "Sales follow-up tasks refreshed from SQLite evidence.",
          context: { reason, scanned: result.scanned, triggered: result.triggered },
        }).catch(() => {});
      }
      return result;
    } catch (error) {
      await systemLogs?.write({
        level: "error",
        area: "sales_pipeline",
        event: "follow_up_task_refresh_failed",
        message: error.message,
        context: { reason, code: error.code || "SALES_FOLLOW_UP_REFRESH_FAILED" },
      }).catch(() => {});
      return { error: error.message, code: error.code || "SALES_FOLLOW_UP_REFRESH_FAILED" };
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    run("startup");
    timer = setInterval(() => run("scheduled"), Math.max(60_000, Number(intervalMs) || 5 * 60_000));
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, run };
}
