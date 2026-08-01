import assert from "node:assert/strict";
import {
  evaluateRefreshLead,
  REFRESH_EXCLUSION,
  REFRESH_TEMPLATE_FLOW,
} from "./domain/refresh-campaign-eligibility.mjs";
import { createRefreshCampaignService } from "./lib/refresh-campaign-service.mjs";
import { createTemplateService } from "./lib/template-service.mjs";

const now = new Date("2026-07-30T04:00:00.000Z");
const oldLead = {
  id: "page-1",
  project: "Binastra",
  name: "Old Lead",
  phone: "60111111111",
  firstBlastAt: "2026-06-01T04:00:00.000Z",
  lastBlastAt: "2026-07-01T04:00:00.000Z",
  lastFlowSent: "Flow 1 - Project Template",
  nextFlow: "Flow 2 - Layout",
  sequenceStatus: "Running",
  status: "Blasted",
};

assert.equal(evaluateRefreshLead(oldLead, {
  phone: oldLead.phone,
  now,
  cooldownDays: 14,
}).eligible, true);

for (const [patch, context, reason] of [
  [{ stopFlag: true }, {}, REFRESH_EXCLUSION.STOPPED],
  [{ status: "Not Interested" }, {}, REFRESH_EXCLUSION.NOT_INTERESTED],
  [{ replyCount: 1 }, {}, REFRESH_EXCLUSION.REPLIED],
  [{ lastFlowSent: "Flow 3 - Location" }, {}, REFRESH_EXCLUSION.FOLLOWED_UP],
  [{ appointmentDate: "2026-08-01" }, {}, REFRESH_EXCLUSION.CLOSED_OR_APPOINTMENT],
  [{ lastBlastAt: "2026-07-25T04:00:00.000Z" }, {}, REFRESH_EXCLUSION.TOO_RECENT],
  [{}, { privatePhones: new Set([oldLead.phone]) }, REFRESH_EXCLUSION.PRIVATE_CONTACT],
  [{}, { activePhones: new Set([oldLead.phone]) }, REFRESH_EXCLUSION.ACTIVE_CAMPAIGN],
  [{}, { activity: { lastInboundAt: "2026-07-10T04:00:00.000Z" } }, REFRESH_EXCLUSION.REPLIED],
  [{}, { activity: { lastNonBlastOutboundAt: "2026-07-10T04:00:00.000Z" } }, REFRESH_EXCLUSION.FOLLOWED_UP],
]) {
  assert.equal(evaluateRefreshLead({ ...oldLead, ...patch }, {
    phone: oldLead.phone,
    now,
    cooldownDays: 14,
    ...context,
  }).reason, reason);
}

let createdGroup = null;
let cached = null;
let forceRefresh = false;
const service = createRefreshCampaignService({
  getProject: async () => ({ project: { id: "binastra", name: "Binastra" }, config: {} }),
  syncLeadStore: async ({ force }) => {
    forceRefresh = force;
    return {
      syncedAt: "2026-07-30T03:59:00.000Z",
      records: [
        oldLead,
        { ...oldLead, id: "page-stop", phone: "60122222222", stopFlag: true },
        { ...oldLead, id: "page-reply", phone: "60133333333", replyCount: 2 },
      ],
    };
  },
  normalizePhone: (value) => String(value || "").replace(/\D/g, ""),
  loadSuppressedPhones: async () => new Set(),
  workInboxIgnore: { snapshot: async () => ({ entries: [] }) },
  conversationLog: { refreshActivity: async () => new Map() },
  listRunners: () => [],
  createLeadGroup: async (options) => {
    createdGroup = options;
    return { id: "group-refresh", name: options.name, sourceName: options.sourceName, memberCount: options.leads.length, leads: options.leads };
  },
  setLeadsCache: (value) => { cached = value; },
  clock: () => now,
});

const report = await service.preview({ projectId: "binastra", cooldownDays: 14 });
assert.equal(forceRefresh, true, "Refresh preview must force a current Notion mirror");
assert.equal(report.eligible.length, 1);
assert.equal(report.exclusionCounts.STOPPED, 1);
assert.equal(report.exclusionCounts.REPLIED, 1);
assert.equal(report.templateFlow, REFRESH_TEMPLATE_FLOW);

const batch = await service.createBatch({
  projectId: "binastra",
  cooldownDays: 14,
  previewToken: report.previewToken,
});
assert.equal(batch.group.id, "group-refresh");
assert.equal(createdGroup.sourceType, "database");
assert.equal(createdGroup.sourceName, "notion-refresh:14d");
assert.equal(cached.campaignType, "RECYCLE");
assert.equal(cached.templateFlow, REFRESH_TEMPLATE_FLOW);
assert.equal(cached.refreshPreviewToken, report.previewToken);

const runner = {
  state: {
    runId: "run-refresh",
    projectId: "binastra",
    campaignType: "RECYCLE",
    refreshCooldownDays: 14,
    refreshPreviewToken: report.previewToken,
    assignments: [{ status: "QUEUED", lead: oldLead }],
  },
};
assert.equal((await service.assertPreparedRunner(runner)).checked, true);

await assert.rejects(
  service.createBatch({ projectId: "binastra", cooldownDays: 14, previewToken: "stale" }),
  (error) => error.code === "REFRESH_PREVIEW_CHANGED",
);

let templateQuery = null;
const templates = await createTemplateService({
  rootDir: "/tmp/mamba-refresh-template-test",
  notionConfig: { databases: { templates: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } },
  notion: async (_method, _path, body) => {
    templateQuery = body;
    return { results: [] };
  },
  nfTitle: () => "",
  nfText: () => "",
  nfSelect: () => "",
  personalize: (value) => value,
  firstFlowVariants: () => [],
  firstFlowPart2Variants: () => [],
});
await templates.fetchFlowTemplates("Binastra", REFRESH_TEMPLATE_FLOW);
assert.equal(
  templateQuery.filter.and[0].select.equals,
  REFRESH_TEMPLATE_FLOW,
  "Refresh template query must keep the full dedicated Flow Topic",
);
assert.match(
  templates.buildTemplateTitle({ project: "Binastra", flowTopic: REFRESH_TEMPLATE_FLOW, language: "EN", part: "Part 1" }),
  /Refresh - Reconnect/,
);

console.log("✅ refresh campaign eligibility/service tests passed");
