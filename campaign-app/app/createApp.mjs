import { createRouter, json, notFound } from "../lib/http.mjs";
import { registerImportRoutes } from "../routes/import.routes.mjs";
import { registerInstancesRoutes } from "../routes/instances.routes.mjs";
import { registerProjectsRoutes } from "../routes/projects.routes.mjs";
import { registerSettingsRoutes } from "../routes/settings.routes.mjs";
import { registerStaticRoutes } from "../routes/static.routes.mjs";

function exportCsv(res, runtime) {
  const runner = runtime.getRunner?.();
  if (!runner || !runner.state) {
    json(res, 404, { ok: false, error: "没有可导出的 run。" });
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${runner.state.runId}.csv"`,
  });
  res.end("﻿" + runtime.buildCsv(runner.state));
}

export function createApp(runtime) {
  const router = createRouter(runtime);
  registerStaticRoutes(router);
  registerSettingsRoutes(router);
  registerProjectsRoutes(router);
  registerInstancesRoutes(router);
  registerImportRoutes(router);

  return async function app(req, res) {
    try {
      const url = new URL(req.url, `http://${runtime.host}:${runtime.port}`);
      const key = `${req.method} ${url.pathname}`;

      if (req.method === "GET" && url.pathname === "/api/export") {
        exportCsv(res, runtime);
        return;
      }

      if (await router.dispatch(req, res)) {
        return;
      }

      const handler = runtime.handlers?.[key];
      if (!handler) {
        notFound(res);
        return;
      }
      await handler(req, res);
    } catch (error) {
      json(res, 400, { ok: false, error: error.message });
    }
  };
}
