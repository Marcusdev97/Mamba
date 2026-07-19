import { httpError, json, readJson } from "../lib/http.mjs";

function ledger(runtime) {
  if (!runtime.goldenLedger) throw httpError(503, "Golden Conversation Ledger 尚未启动，请重启 Mamba。");
  return runtime.goldenLedger;
}

export function registerGoldenConversationRoutes(router) {
  router.get("/api/golden-conversations/status", async (_req, res, runtime) => {
    json(res, 200, { ok: true, ...(await ledger(runtime).status()) });
  });

  router.get("/api/golden-conversations", async (req, res, runtime) => {
    const url = new URL(req.url, `http://${runtime.host}:${runtime.port}`);
    const records = await ledger(runtime).list({
      outcome: url.searchParams.get("outcome") || "",
      projectCode: url.searchParams.get("project") || "",
      limit: url.searchParams.get("limit") || 100,
    });
    json(res, 200, { ok: true, records, count: records.length });
  });

  router.get("/api/golden-conversations/reports", async (_req, res, runtime) => {
    json(res, 200, { ok: true, ...(await ledger(runtime).reports()) });
  });

  router.post("/api/golden-conversations/preview", async (req, res, runtime) => {
    const body = await readJson(req);
    json(res, 200, { ok: true, ...ledger(runtime).preview(body) });
  });

  router.post("/api/golden-conversations/import", async (req, res, runtime) => {
    const body = await readJson(req);
    const result = await ledger(runtime).importConversation(body);
    json(res, 201, { ok: true, ...result });
  });

  router.post("/api/golden-conversations/followups", async (req, res, runtime) => {
    const result = await ledger(runtime).addFollowup(await readJson(req));
    json(res, 201, { ok: true, ...result });
  });

  router.post("/api/golden-conversations/mark-dormant", async (req, res, runtime) => {
    const body = await readJson(req);
    const result = await ledger(runtime).markDormant({ now: body.now || new Date() });
    json(res, 200, { ok: true, ...result });
  });
}
