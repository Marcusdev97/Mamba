import { httpError, json, readJson } from "../lib/http.mjs";

function requireRefresh(runtime) {
  if (!runtime.refreshCampaign) {
    throw httpError(503, "Refresh Campaign service 尚未载入。请重启 Mamba server。");
  }
  return runtime.refreshCampaign;
}

export function registerRefreshCampaignRoutes(router) {
  router.get("/api/refresh/preview", async (req, res, runtime) => {
    const url = new URL(req.url, `http://${runtime.host}:${runtime.port}`);
    const projectId = String(url.searchParams.get("project") || "").trim();
    if (!projectId) throw httpError(400, "请选择 Project。");
    try {
      const report = await requireRefresh(runtime).preview({
        projectId,
        cooldownDays: url.searchParams.get("cooldownDays"),
      });
      json(res, 200, { ok: true, report });
    } catch (error) {
      throw httpError(502, `Refresh 名单检查失败: ${error.message}`, error.code ? { code: error.code } : {});
    }
  });

  router.post("/api/refresh/create", async (req, res, runtime) => {
    const body = await readJson(req);
    if (!body.project) throw httpError(400, "请选择 Project。");
    try {
      const result = await requireRefresh(runtime).createBatch({
        projectId: body.project,
        cooldownDays: body.cooldownDays,
        previewToken: body.previewToken,
        name: body.name,
      });
      json(res, 200, { ok: true, ...result });
    } catch (error) {
      const status = error.code === "REFRESH_PREVIEW_CHANGED" ? 409 : 400;
      throw httpError(status, error.message, error.code ? { code: error.code } : {});
    }
  });
}
