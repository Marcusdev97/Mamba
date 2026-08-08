import { httpError, json, readJson } from "../lib/http.mjs";

function sales(runtime) {
  if (!runtime.salesPipeline) throw httpError(503, "Sales Pipeline service 尚未载入。", { code: "SALES_PIPELINE_UNAVAILABLE" });
  return runtime.salesPipeline;
}

function leadSelector(body = {}) {
  return {
    projectLeadKey: String(body.projectLeadKey || "").trim(),
    customerId: String(body.customerId || "").trim(),
    phone: String(body.phone || "").trim(),
    projectCode: String(body.projectCode || "").trim(),
  };
}

export function registerSalesPipelineRoutes(router) {
  router.get("/api/sales/status", async (_req, res, runtime) => {
    json(res, 200, { ok: true, schema: await sales(runtime).schemaStatus() });
  });

  router.get("/api/sales/leads", async (req, res, runtime) => {
    const url = new URL(req.url, `http://${runtime.host}:${runtime.port}`);
    const leads = await sales(runtime).listLeads({
      q: url.searchParams.get("q") || "",
      stage: url.searchParams.get("stage") || "",
      temperature: url.searchParams.get("temperature") || "",
      limit: url.searchParams.get("limit") || 500,
    });
    json(res, 200, { ok: true, count: leads.length, leads });
  });

  router.get("/api/sales/customer", async (req, res, runtime) => {
    const url = new URL(req.url, `http://${runtime.host}:${runtime.port}`);
    const detail = await sales(runtime).customerDetail({
      projectLeadKey: url.searchParams.get("projectLeadKey") || "",
      customerId: url.searchParams.get("customerId") || "",
      phone: url.searchParams.get("phone") || "",
      projectCode: url.searchParams.get("projectCode") || "",
    });
    json(res, 200, { ok: true, ...detail });
  });

  router.get("/api/sales/today", async (_req, res, runtime) => {
    json(res, 200, { ok: true, ...(await sales(runtime).today()) });
  });

  router.post("/api/sales/tasks/refresh", async (_req, res, runtime) => {
    json(res, 200, { ok: true, ...(await sales(runtime).refreshTasks()) });
  });

  router.post("/api/sales/tasks/complete", async (req, res, runtime) => {
    const body = await readJson(req);
    if (!body.taskId) throw httpError(400, "缺少 taskId。");
    const task = await sales(runtime).completeTask({ taskId: body.taskId, outcome: body.outcome, completedBy: body.completedBy || "operator" });
    json(res, 200, { ok: true, task });
  });

  router.post("/api/sales/stage", async (req, res, runtime) => {
    const body = await readJson(req);
    if (!body.toStage) throw httpError(400, "缺少目标 Sales Stage。");
    const lead = await sales(runtime).transitionStage({
      ...leadSelector(body),
      toStage: body.toStage,
      source: "human",
      actorId: body.actorId || "operator",
      reason: body.reason || "",
      lostReason: body.lostReason || "",
      allowBackward: body.allowBackward === true,
      sourceEvent: body.sourceEvent || "",
    });
    json(res, 200, { ok: true, lead });
  });

  router.post("/api/sales/lead", async (req, res, runtime) => {
    const body = await readJson(req);
    if (String(body.fields?.temperature || "").trim().toUpperCase() === "STOP") {
      if (!String(body.reason || "").trim()) throw httpError(400, "设置 STOP 必须填写停止联系原因。");
      if (!runtime.sendEligibility) throw httpError(503, "Global STOP service 尚未载入。");
      await runtime.sendEligibility.propagateStop({
        ...leadSelector(body),
        source: "sales_pipeline",
        reasonCode: "AGENT_MANUAL_STOP",
        reason: body.reason,
        idempotencyKey: body.sourceEvent || "",
      });
    }
    const lead = await sales(runtime).updateLead({
      ...leadSelector(body),
      fields: body.fields || {},
      actorId: body.actorId || "operator",
      reason: body.reason || "",
      sourceEvent: body.sourceEvent || "",
    });
    json(res, 200, { ok: true, lead });
  });

  router.post("/api/sales/opportunity", async (req, res, runtime) => {
    const body = await readJson(req);
    const lead = await sales(runtime).promoteOpportunity({
      ...leadSelector(body),
      trigger: body.trigger || "MANUAL_PROMOTION",
      sourceEvent: body.sourceEvent || "",
      actorId: body.actorId || "operator",
    });
    json(res, 200, { ok: true, lead });
  });

  router.post("/api/sales/commission", async (req, res, runtime) => {
    const body = await readJson(req);
    const lead = await sales(runtime).updateCommission({
      ...leadSelector(body),
      propertyValue: body.propertyValue,
      commissionRatePercent: body.commissionRatePercent,
      teamSplitPercent: body.teamSplitPercent,
      probabilityPercent: body.probabilityPercent,
      actualCommission: body.actualCommission,
      commissionStatus: body.commissionStatus,
      expectedPaymentDate: body.expectedPaymentDate,
      paidAt: body.paidAt,
      actorId: body.actorId || "operator",
      reason: body.reason || "",
    });
    json(res, 200, { ok: true, lead });
  });
}
