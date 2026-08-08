import { httpError, json, readJson } from "../lib/http.mjs";

function model(runtime) {
  if (!runtime.campaignModel) throw httpError(503, "Campaign Model service 尚未载入。", { code: "CAMPAIGN_MODEL_UNAVAILABLE" });
  return runtime.campaignModel;
}

export function registerCampaignModelRoutes(router) {
  router.get("/api/campaign-model/status", async (_req, res, runtime) => json(res, 200, { ok: true, schema: await model(runtime).schemaStatus() }));
  router.get("/api/campaign-model/campaigns", async (req, res, runtime, url) => json(res, 200, { ok: true, campaigns: await model(runtime).listCampaigns({ status: url.searchParams.get("status") || "" }) }));
  router.get("/api/campaign-model/detail", async (req, res, runtime, url) => {
    const campaignId = String(url.searchParams.get("campaignId") || "").trim();
    if (!campaignId) throw httpError(400, "缺少 campaignId。");
    json(res, 200, { ok: true, ...await model(runtime).campaignDetail(campaignId) });
  });
  router.post("/api/campaign-model/draft", async (req, res, runtime) => json(res, 200, { ok: true, campaign: await model(runtime).saveDraft(await readJson(req)) }));
  router.post("/api/campaign-model/members", async (req, res, runtime) => {
    const body = await readJson(req);
    json(res, 200, { ok: true, result: await model(runtime).enrollMembers({ campaignId: body.campaignId, projectLeadIds: Array.isArray(body.projectLeadIds) ? body.projectLeadIds : [] }) });
  });
  router.post("/api/campaign-model/runs", async (req, res, runtime) => json(res, 200, { ok: true, run: await model(runtime).createRun(await readJson(req)) }));
  router.post("/api/campaign-model/members/transition", async (req, res, runtime) => json(res, 200, { ok: true, member: await model(runtime).transitionMember(await readJson(req)) }));
  router.post("/api/campaign-model/outcomes", async (req, res, runtime) => json(res, 200, { ok: true, attribution: await model(runtime).recordOutcome(await readJson(req)) }));
}
