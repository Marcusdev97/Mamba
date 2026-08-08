import { httpError, json, readJson, text } from "../lib/http.mjs";

function service(runtime) {
  if (!runtime.sendEligibility) {
    throw httpError(503, "Send Eligibility service 尚未载入。", { code: "SEND_ELIGIBILITY_UNAVAILABLE" });
  }
  return runtime.sendEligibility;
}
function csvCell(value) {
  const textValue = String(value ?? "");
  return /[",\n\r]/.test(textValue) ? `"${textValue.replaceAll('"', '""')}"` : textValue;
}

export function registerSendEligibilityRoutes(router) {
  router.get("/api/send-eligibility/status", async (_req, res, runtime) => {
    json(res, 200, { ok: true, schema: await service(runtime).schemaStatus() });
  });

  router.post("/api/send-eligibility/preview", async (req, res, runtime) => {
    const body = await readJson(req);
    let assignments = Array.isArray(body.assignments) ? body.assignments : [];
    let campaign = body.campaign || {};
    if (body.runId) {
      const runner = runtime.campaign?.getRunner?.(body.runId);
      if (!runner?.state) throw httpError(404, "找不到要预检的 Campaign run。", { code: "CAMPAIGN_RUN_NOT_FOUND" });
      assignments = runner.state.assignments || [];
      campaign = {
        campaignId: runner.state.campaignId,
        runId: runner.state.runId,
        projectId: runner.state.projectId,
        mode: runner.state.mode,
        flowTopic: runner.flowTopic?.() || runner.state.templateFlow || runner.state.flowLabel || "",
        resendCooldownDays: runner.resendCooldownDays?.() || 0,
        startAt: runner.state.startAt,
        endAt: runner.state.endAt,
      };
    }
    const preview = await service(runtime).previewAssignments(assignments, { campaign });
    json(res, 200, { ok: true, preview });
  });

  router.get("/api/send-eligibility/decisions", async (req, res, runtime) => {
    const url = new URL(req.url, `http://${runtime.host}:${runtime.port}`);
    const decisions = await service(runtime).listDecisions({
      runId: url.searchParams.get("runId") || "",
      limit: url.searchParams.get("limit") || 1000,
    });
    json(res, 200, { ok: true, decisions, count: decisions.length });
  });

  router.get("/api/send-eligibility/export", async (req, res, runtime) => {
    const url = new URL(req.url, `http://${runtime.host}:${runtime.port}`);
    const runId = url.searchParams.get("runId") || "";
    if (!runId) throw httpError(400, "缺少 runId。", { code: "CAMPAIGN_RUN_ID_REQUIRED" });
    const decisions = await service(runtime).listDecisions({ runId, limit: 5000 });
    const rows = [["decision_id", "customer_id", "campaign_id", "run_id", "requested_action", "allowed", "reason_code", "reason", "retry_at", "required_action", "evaluated_at"]];
    for (const item of decisions) {
      rows.push([
        item.decisionId, item.customerId, item.campaignId, item.runId, item.requestedAction,
        item.allowed ? "1" : "0", item.reasonCode, item.reason, item.retryAt, item.requiredAction, item.evaluatedAt,
      ]);
    }
    text(res, 200, `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`, "text/csv; charset=utf-8");
  });

  router.post("/api/send-eligibility/stop", async (req, res, runtime) => {
    const body = await readJson(req);
    const result = await service(runtime).propagateStop({
      phone: body.phone,
      customerId: body.customerId,
      source: body.source || "operator",
      reasonCode: body.reasonCode || "AGENT_MANUAL_STOP",
      reason: body.reason || "",
      idempotencyKey: body.idempotencyKey || "",
    });
    json(res, 200, { ok: true, result });
  });

  router.post("/api/send-eligibility/snooze", async (req, res, runtime) => {
    const body = await readJson(req);
    const result = await service(runtime).snooze({
      phone: body.phone,
      customerId: body.customerId,
      until: body.until,
      source: body.source || "operator",
    });
    json(res, 200, { ok: true, result });
  });
}
