import { httpError, json, readJson } from "../lib/http.mjs";

function requireSafety(runtime) {
  if (!runtime.campaignSafety) {
    throw httpError(503, "WhatsApp P0 安全服务尚未载入。", "CAMPAIGN_SAFETY_UNAVAILABLE");
  }
  return runtime.campaignSafety;
}

export function registerCampaignSafetyRoutes(router) {
  router.get("/api/campaign-safety", async (_req, res, runtime) => {
    json(res, 200, { ok: true, safety: await requireSafety(runtime).snapshot() });
  });

  router.post("/api/campaign-safety/policy", async (req, res, runtime) => {
    const body = await readJson(req);
    const safety = requireSafety(runtime);
    const policy = await safety.savePolicy(body?.policy || body || {});
    json(res, 200, {
      ok: true,
      policy,
      message: "WhatsApp 安全策略已保存。只影响之后进行的 LIVE preflight，不会改写正在运行或已经完成的 Campaign。",
    });
  });

  router.get("/api/campaign-safety/permission", async (req, res, runtime) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const phone = url.searchParams.get("phone") || "";
    if (!phone) throw httpError(400, "请输入要查询的客户号码。", "CONSENT_PHONE_REQUIRED");
    json(res, 200, { ok: true, permission: await requireSafety(runtime).permissionSnapshot(phone) });
  });

  router.post("/api/campaign-safety/permission", async (req, res, runtime) => {
    const body = await readJson(req);
    if (!body?.sourceType) {
      throw httpError(400, "必须记录同意来源，例如 FACEBOOK_AD、WEB_FORM 或 PHONE_CALL。", "CONSENT_SOURCE_REQUIRED");
    }
    const event = await requireSafety(runtime).recordPermission(body);
    json(res, 200, {
      ok: true,
      event,
      message: "客户同意证据已追加到 SQLite Ledger。历史记录没有被覆盖。",
    });
  });

  router.post("/api/campaign-safety/permission/revoke", async (req, res, runtime) => {
    const body = await readJson(req);
    const event = await requireSafety(runtime).revokePermission({
      ...body,
      sourceType: body?.sourceType || "CUSTOMER_REQUEST",
    });
    json(res, 200, {
      ok: true,
      event,
      message: "客户已撤回同意。之后的 LIVE preflight 会直接阻止这个号码。",
    });
  });

  router.post("/api/campaign-safety/sender-state", async (req, res, runtime) => {
    const body = await readJson(req);
    const state = String(body?.state || "").trim().toUpperCase();
    if (state === "HEALTHY" && body?.confirmation !== "RESUME_SENDER") {
      throw httpError(400, "人工恢复 Sender 需要明确确认。", "SENDER_RESUME_CONFIRMATION_REQUIRED");
    }
    const sender = await requireSafety(runtime).setSenderState({
      instanceName: body?.instanceName,
      state,
      reasonCode: body?.reasonCode || (state === "PAUSED" ? "SENDER_MANUALLY_PAUSED" : "SENDER_MANUALLY_RESUMED"),
      reason: body?.reason || (state === "PAUSED" ? "操作员人工暂停。" : "操作员检查后人工恢复。"),
      metrics: body?.metrics || {},
    });
    json(res, 200, {
      ok: true,
      sender,
      message: state === "PAUSED" ? "Sender 已安全暂停。" : "Sender 已人工恢复；下一批仍会重新检查健康指标。",
    });
  });
}
