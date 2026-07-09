import { createRouter, json, notFound } from "../lib/http.mjs";
import { registerCampaignRoutes } from "../routes/campaign.routes.mjs";
import { registerImportRoutes } from "../routes/import.routes.mjs";
import { registerInstancesRoutes } from "../routes/instances.routes.mjs";
import { registerLookupRoutes } from "../routes/lookup.routes.mjs";
import { registerNextFlowRoutes } from "../routes/next-flow.routes.mjs";
import { registerProjectsRoutes } from "../routes/projects.routes.mjs";
import { registerSettingsRoutes } from "../routes/settings.routes.mjs";
import { registerStaticRoutes } from "../routes/static.routes.mjs";
import { registerTemplatesRoutes } from "../routes/templates.routes.mjs";

export function createApp(runtime) {
  const router = createRouter(runtime);
  registerStaticRoutes(router);
  registerSettingsRoutes(router);
  registerProjectsRoutes(router);
  registerInstancesRoutes(router);
  registerImportRoutes(router);
  registerLookupRoutes(router);
  registerTemplatesRoutes(router);
  registerCampaignRoutes(router);
  registerNextFlowRoutes(router);

  return async function app(req, res) {
    try {
      const url = new URL(req.url, `http://${runtime.host}:${runtime.port}`);
      const key = `${req.method} ${url.pathname}`;

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
