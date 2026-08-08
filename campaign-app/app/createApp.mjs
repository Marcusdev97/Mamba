import { createRouter, json, notFound } from "../lib/http.mjs";
import { registerBotRulesRoutes } from "../routes/bot-rules.routes.mjs";
import { registerBrainLearningRoutes } from "../routes/brain-learning.routes.mjs";
import { registerCampaignRoutes } from "../routes/campaign.routes.mjs";
import { registerCampaignModelRoutes } from "../routes/campaign-model.routes.mjs";
import { registerCampaignSafetyRoutes } from "../routes/campaign-safety.routes.mjs";
import { registerConversationsRoutes } from "../routes/conversations.routes.mjs";
import { registerInboxRoutes } from "../routes/inbox.routes.mjs";
import { registerControlCenterRoutes } from "../routes/control-center.routes.mjs";
import { registerCustomerIdentityRoutes } from "../routes/customer-identity.routes.mjs";
import { registerDailyCampaignRoutes } from "../routes/daily-campaign.routes.mjs";
import { registerFollowUpRoutes } from "../routes/follow-up.routes.mjs";
import { registerGoldenConversationRoutes } from "../routes/golden-conversations.routes.mjs";
import { registerImportRoutes } from "../routes/import.routes.mjs";
import { registerInstancesRoutes } from "../routes/instances.routes.mjs";
import { registerKnowledgeRoutes } from "../routes/knowledge.routes.mjs";
import { registerLookupRoutes } from "../routes/lookup.routes.mjs";
import { registerNextFlowRoutes } from "../routes/next-flow.routes.mjs";
import { registerNotionCrmSyncRoutes } from "../routes/notion-crm-sync.routes.mjs";
import { registerProjectsRoutes } from "../routes/projects.routes.mjs";
import { registerProjectBrainRoutes } from "../routes/project-brain.routes.mjs";
import { registerRemoteMambaRoutes } from "../routes/remote-mamba.routes.mjs";
import { registerRefreshCampaignRoutes } from "../routes/refresh-campaign.routes.mjs";
import { registerSettingsRoutes } from "../routes/settings.routes.mjs";
import { registerSendEligibilityRoutes } from "../routes/send-eligibility.routes.mjs";
import { registerSalesPipelineRoutes } from "../routes/sales-pipeline.routes.mjs";
import { registerStaticRoutes } from "../routes/static.routes.mjs";
import { registerSystemLogsRoutes } from "../routes/system-logs.routes.mjs";
import { registerTemplatesRoutes } from "../routes/templates.routes.mjs";
import { registerTeamViewRoutes } from "../routes/team-view.routes.mjs";
import { registerDashboardAiAuditorRoutes } from "../routes/dashboard-ai-auditor.routes.mjs";
import { registerAiChangeTrackingRoutes } from "../routes/ai-change-tracking.routes.mjs";

export function createApp(runtime) {
  const router = createRouter(runtime);
  registerStaticRoutes(router, runtime);
  registerSettingsRoutes(router);
  registerProjectsRoutes(router);
  registerProjectBrainRoutes(router);
  registerRemoteMambaRoutes(router);
  registerTeamViewRoutes(router);
  registerControlCenterRoutes(router);
  registerCustomerIdentityRoutes(router);
  registerSendEligibilityRoutes(router);
  registerSalesPipelineRoutes(router);
  registerDashboardAiAuditorRoutes(router);
  registerAiChangeTrackingRoutes(router);
  registerDailyCampaignRoutes(router);
  registerInstancesRoutes(router);
  registerImportRoutes(router);
  registerLookupRoutes(router);
  registerTemplatesRoutes(router);
  registerBotRulesRoutes(router);
  registerBrainLearningRoutes(router);
  registerKnowledgeRoutes(router);
  registerCampaignRoutes(router);
  registerCampaignModelRoutes(router);
  registerCampaignSafetyRoutes(router);
  registerRefreshCampaignRoutes(router);
  registerNextFlowRoutes(router);
  registerNotionCrmSyncRoutes(router);
  registerConversationsRoutes(router);
  registerInboxRoutes(router);
  registerFollowUpRoutes(router);
  registerGoldenConversationRoutes(router);
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
