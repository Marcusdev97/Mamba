import crypto from "node:crypto";

const CRM_ENTITY_TYPES = Object.freeze(["crm_customer", "crm_project_lead"]);

function errorSummary(error) {
  return { code: error?.code || "NOTION_CRM_SYNC_FAILED", message: String(error?.message || "Notion CRM sync failed").slice(0, 500) };
}

export function createNotionCrmSyncCoordinator({ repository, engine, outbox, notion, clock = () => new Date(), onLog = () => {} } = {}) {
  if (!repository || !engine || !outbox) throw new Error("Notion CRM sync coordinator dependencies are required.");
  let timer = null;
  let running = false;
  let lastNightlyDate = "";

  async function health() {
    const schema = await repository.schemaStatus();
    if (!schema.ready) return { schema, ready: false, enabled: false, status: "MIGRATION_REQUIRED" };
    return { schema, ready: true, ...(await repository.workerHealth()) };
  }

  async function drainPush({ limit = 100 } = {}) {
    return outbox.drain(async (job) => {
      const result = await engine.pushEntity(job);
      if (!result.handled) return false;
      return result;
    }, { limit, entityTypes: CRM_ENTITY_TYPES });
  }

  async function run({ reason = "manual" } = {}) {
    if (running) return { busy: true };
    const state = await health();
    if (!state.ready) return { skipped: true, reason: "migration_required", schema: state.schema };
    if (!Number(state.enabled)) return { skipped: true, reason: "paused" };
    running = true;
    await repository.markWorkerRun({ status: "RUNNING", started: true });
    try {
      const queued = await repository.enqueueDirtyEntities();
      const push = await drainPush();
      const pull = await engine.pullOnce();
      await repository.markWorkerRun({ status: "IDLE", finished: true });
      return { reason, queued, push, pull };
    } catch (error) {
      const summary = errorSummary(error);
      await repository.markWorkerRun({ status: "ERROR", errorCode: summary.code, errorMessage: summary.message, finished: true }).catch(() => {});
      throw error;
    } finally {
      running = false;
    }
  }

  async function reconcile({ mode = "MANUAL" } = {}) {
    const startedAt = clock().toISOString();
    const runId = `recon_${crypto.createHash("sha256").update(`${mode}:${startedAt}`).digest("hex").slice(0, 20)}`;
    const local = await repository.reconciliationLocalState();
    const mappings = await repository.listMappings({ limit: 5000 });
    const remote = { checked: 0, present: 0, archived: 0, missing: 0, errors: 0 };
    if (typeof notion === "function") {
      for (const mapping of mappings) {
        remote.checked += 1;
        try {
          const page = await notion("GET", `/pages/${mapping.notionPageId}`);
          if (page?.archived || page?.in_trash) remote.archived += 1;
          else remote.present += 1;
        } catch (error) {
          if (error?.status === 404 || error?.code === "object_not_found" || error?.code === "NOTION_NOT_FOUND") remote.missing += 1;
          else remote.errors += 1;
        }
      }
    }
    const mappedCustomers = mappings.filter((item) => item.entityType === "crm_customer").length;
    const mappedProjectLeads = mappings.filter((item) => item.entityType === "crm_project_lead").length;
    const report = {
      local,
      mapping: {
        total: mappings.length,
        missingCustomers: Math.max(0, Number(local.customers || 0) - mappedCustomers),
        missingProjectLeads: Math.max(0, Number(local.projectLeads || 0) - mappedProjectLeads),
      },
      remote,
    };
    const finishedAt = clock().toISOString();
    await repository.recordReconciliation({ runId, mode, status: remote.errors ? "FAILED" : "COMPLETED", report, startedAt, finishedAt });
    return { runId, mode, status: remote.errors ? "FAILED" : "COMPLETED", report, startedAt, finishedAt };
  }

  async function tick() {
    const state = await health();
    if (!state.ready || !Number(state.enabled)) return;
    await run({ reason: "scheduled" });
    const today = clock().toISOString().slice(0, 10);
    if (clock().getHours() >= 2 && lastNightlyDate !== today) {
      lastNightlyDate = today;
      await reconcile({ mode: "NIGHTLY" });
    }
  }

  function start(intervalMs = 20 * 60_000) {
    if (timer) return timer;
    timer = setInterval(() => tick().catch((error) => onLog(`[notion-crm-sync] ${errorSummary(error).message}`)), intervalMs);
    timer.unref?.();
    return timer;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    health,
    run,
    reconcile,
    start,
    stop,
    status: () => ({ running, intervalMinutes: 20, lastNightlyDate }),
  };
}
