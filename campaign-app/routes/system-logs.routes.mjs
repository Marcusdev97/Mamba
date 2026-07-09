import { httpError, json, readJson } from "../lib/http.mjs";

function requireSystemLogs(runtime) {
  if (!runtime.systemLogs) {
    throw httpError(500, "System Logs service 没有载入。请重启 Mamba server。");
  }
  return runtime.systemLogs;
}

export function registerSystemLogsRoutes(router) {
  router.get("/api/system-logs", async (req, res, runtime) => {
    const logs = requireSystemLogs(runtime);
    const url = new URL(req.url, `http://${runtime.host}:${runtime.port}`);
    const entries = await logs.list({
      limit: url.searchParams.get("limit"),
      level: url.searchParams.get("level"),
      area: url.searchParams.get("area"),
      q: url.searchParams.get("q"),
      date: url.searchParams.get("date"),
    });
    json(res, 200, { ok: true, entries });
  });

  router.post("/api/system-logs", async (req, res, runtime) => {
    const logs = requireSystemLogs(runtime);
    const body = await readJson(req);
    const entry = await logs.write({
      level: body.level,
      area: body.area,
      event: body.event,
      message: body.message,
      context: body.context,
    });
    json(res, 200, { ok: true, entry });
  });
}
