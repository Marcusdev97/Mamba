import { httpError, json, readJson } from "../lib/http.mjs";

function service(runtime) {
  if (!runtime.notionCrmSync) throw httpError(503, "SQLite ↔ Notion sync 尚未载入。", { code: "NOTION_CRM_SYNC_UNAVAILABLE" });
  return runtime.notionCrmSync;
}

function repository(runtime) {
  if (!runtime.notionCrmSyncRepository) throw httpError(503, "SQLite ↔ Notion sync repository 尚未载入。", { code: "NOTION_CRM_SYNC_UNAVAILABLE" });
  return runtime.notionCrmSyncRepository;
}

export function registerNotionCrmSyncRoutes(router) {
  router.get("/api/notion-crm-sync", async (_req, res, runtime) => {
    const coordinator = service(runtime);
    const health = await coordinator.health();
    const queue = health.ready ? await repository(runtime).queueSnapshot({ limit: 50 }) : { outbox: [], inbox: [], conflicts: [] };
    json(res, 200, { ok: true, health, scheduler: coordinator.status(), queue });
  });

  router.post("/api/notion-crm-sync/run", async (_req, res, runtime) => {
    const result = await service(runtime).run({ reason: "manual" });
    json(res, 200, { ok: true, result, health: await service(runtime).health() });
  });

  router.post("/api/notion-crm-sync/pause", async (req, res, runtime) => {
    const body = await readJson(req);
    const health = await repository(runtime).setWorkerPaused(true, body.reason || "Paused by operator");
    json(res, 200, { ok: true, health });
  });

  router.post("/api/notion-crm-sync/resume", async (_req, res, runtime) => {
    const health = await repository(runtime).setWorkerPaused(false);
    json(res, 200, { ok: true, health });
  });

  router.post("/api/notion-crm-sync/retry-failed", async (_req, res, runtime) => {
    if (!runtime.notionOutbox) throw httpError(503, "Notion outbox 尚未载入。", { code: "NOTION_OUTBOX_UNAVAILABLE" });
    const result = await runtime.notionOutbox.retryFailed();
    json(res, 200, { ok: true, result });
  });

  router.post("/api/notion-crm-sync/reconcile", async (_req, res, runtime) => {
    const result = await service(runtime).reconcile({ mode: "MANUAL" });
    json(res, 200, { ok: true, result });
  });

  router.post("/api/notion-crm-sync/conflicts/resolve", async (req, res, runtime) => {
    const body = await readJson(req);
    if (!body.conflictId) throw httpError(400, "缺少 conflictId。", { code: "SYNC_CONFLICT_ID_REQUIRED" });
    const result = await runtime.notionCrmSyncEngine.resolveConflict(body.conflictId, {
      resolution: body.resolution,
      value: body.value,
      resolvedBy: body.resolvedBy || "operator",
    });
    if (!result) throw httpError(404, "找不到冲突记录。", { code: "SYNC_CONFLICT_NOT_FOUND" });
    json(res, 200, { ok: true, result });
  });
}
