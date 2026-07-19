import { json, readJson } from "../lib/http.mjs";

function requireDailyCampaign(runtime) {
  if (!runtime.dailyCampaign) {
    const error = new Error("Next Campaign 调度服务没有载入。请重启 Mamba server。");
    error.status = 500;
    throw error;
  }
  return runtime.dailyCampaign;
}

export function registerDailyCampaignRoutes(router) {
  router.get("/api/daily-campaign", async (_req, res, runtime) => {
    json(res, 200, await requireDailyCampaign(runtime).snapshot());
  });

  router.post("/api/daily-campaign/config", async (req, res, runtime) => {
    const body = await readJson(req);
    json(res, 200, await requireDailyCampaign(runtime).update(body));
  });

  router.post("/api/daily-campaign/check", async (req, res, runtime) => {
    const body = await readJson(req);
    json(res, 200, await requireDailyCampaign(runtime).check({ deep: body.deep === true }));
  });

  router.post("/api/daily-campaign/run-test", async (_req, res, runtime) => {
    const result = await requireDailyCampaign(runtime).runTest({ scheduled: false });
    json(res, result.ok ? 200 : 409, result);
  });

  router.post("/api/daily-campaign/stop-shift", async (_req, res, runtime) => {
    json(res, 200, await requireDailyCampaign(runtime).stopForToday());
  });
}
