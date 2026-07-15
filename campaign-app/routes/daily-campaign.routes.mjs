import { httpError, json, readJson } from "../lib/http.mjs";

function requireDailyCampaign(runtime) {
  if (!runtime.dailyCampaign) {
    throw httpError(500, "Next Campaign 调度服务没有载入。请重启 Mamba server。");
  }
  return runtime.dailyCampaign;
}

export function registerDailyCampaignRoutes(router) {
  router.get("/api/daily-campaign", async (_req, res, runtime) => {
    json(res, 200, await requireDailyCampaign(runtime).snapshot());
  });

  router.post("/api/daily-campaign/config", async (req, res, runtime) => {
    const body = await readJson(req);
    if (body.mode && body.mode !== "TEST") {
      throw httpError(400, "安全限制：Next Campaign 目前只允许 TEST，不能开启 LIVE。");
    }
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
}
