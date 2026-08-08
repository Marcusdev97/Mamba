import { httpError, json, readJson } from "../lib/http.mjs";

function service(runtime) {
  if (!runtime.dashboardAiAuditor) {
    throw httpError(503, "Dashboard AI Auditor service 尚未载入。", { code: "DASHBOARD_AI_UNAVAILABLE" });
  }
  return runtime.dashboardAiAuditor;
}

function filters(req, runtime) {
  const url = new URL(req.url, `http://${runtime.host}:${runtime.port}`);
  return {
    dateFrom: url.searchParams.get("dateFrom") || "",
    dateTo: url.searchParams.get("dateTo") || "",
    project: url.searchParams.get("project") || "",
    campaign: url.searchParams.get("campaign") || "",
    agent: url.searchParams.get("agent") || "",
    source: url.searchParams.get("source") || "",
  };
}

export function registerDashboardAiAuditorRoutes(router) {
  router.get("/api/dashboard/status", async (_req, res, runtime) => {
    const auditor = service(runtime);
    json(res, 200, {
      ok: true,
      schema: await auditor.schemaStatus(),
      provider: auditor.providerStatus(),
    });
  });

  router.get("/api/dashboard", async (req, res, runtime) => {
    const auditor = service(runtime);
    const schema = await auditor.schemaStatus();
    if (!schema.ready) {
      json(res, 503, {
        ok: false,
        code: "DASHBOARD_SETUP_REQUIRED",
        message: "Dashboard setup required.",
        schema,
      });
      return;
    }
    json(res, 200, { ok: true, ...await auditor.dashboard(filters(req, runtime)) });
  });

  router.get("/api/dashboard/audit-candidates", async (req, res, runtime) => {
    const url = new URL(req.url, `http://${runtime.host}:${runtime.port}`);
    const candidates = await service(runtime).candidates({ limit: url.searchParams.get("limit") || 100 });
    json(res, 200, { ok: true, count: candidates.length, candidates });
  });

  router.get("/api/dashboard/quality", async (_req, res, runtime) => {
    json(res, 200, { ok: true, quality: await service(runtime).quality() });
  });

  router.post("/api/dashboard/audit", async (req, res, runtime) => {
    const body = await readJson(req);
    if (!body.projectLeadKey) throw httpError(400, "缺少 projectLeadKey。");
    const result = await service(runtime).analyze({ projectLeadKey: body.projectLeadKey });
    json(res, result.ok ? 200 : 503, { ...result });
  });

  router.post("/api/dashboard/audit-feedback", async (req, res, runtime) => {
    const body = await readJson(req);
    if (!body.analysisId) throw httpError(400, "缺少 analysisId。");
    json(res, 200, { ok: true, feedback: await service(runtime).feedback(body) });
  });
}
