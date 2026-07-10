import { createRouter, json, notFound } from "../lib/http.mjs";
import { registerBotRulesRoutes } from "../routes/bot-rules.routes.mjs";
import { registerCampaignRoutes } from "../routes/campaign.routes.mjs";
import { registerConversationsRoutes } from "../routes/conversations.routes.mjs";
import { registerFollowUpRoutes } from "../routes/follow-up.routes.mjs";
import { registerImportRoutes } from "../routes/import.routes.mjs";
import { registerInstancesRoutes } from "../routes/instances.routes.mjs";
import { registerLookupRoutes } from "../routes/lookup.routes.mjs";
import { registerNextFlowRoutes } from "../routes/next-flow.routes.mjs";
import { registerProjectsRoutes } from "../routes/projects.routes.mjs";
import { registerSettingsRoutes } from "../routes/settings.routes.mjs";
import { registerStaticRoutes } from "../routes/static.routes.mjs";
import { registerSystemLogsRoutes } from "../routes/system-logs.routes.mjs";
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
  registerBotRulesRoutes(router);
  registerCampaignRoutes(router);
  registerNextFlowRoutes(router);
  registerConversationsRoutes(router);
  registerFollowUpRoutes(router);
  registerSystemLogsRoutes(router);

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
      await runtime.systemLogs?.write({
        level: "error",
        area: "api",
        event: "app_unhandled_error",
        message: error.message || "Unhandled app error",
        context: { method: req.method, url: req.url },
      }).catch(() => {});
      json(res, 400, { ok: false, error: error.message });
    }
  };
}
