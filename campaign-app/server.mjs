// Local web console for the WhatsApp campaign blaster (multi-project).
// Start with: node campaign-app/server.mjs   (or open Mamba.app)

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { exec } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createApp } from "./app/createApp.mjs";
import { loadRuntime } from "./app/loadRuntime.mjs";
import { createBlastCacheService } from "./lib/blast-cache-service.mjs";
import { createCampaignRunService } from "./lib/campaign-run-service.mjs";
import { createCampaignQueueService } from "./lib/campaign-queue-service.mjs";
import { createCampaignRunnerRegistry } from "./lib/campaign-runner-registry.mjs";
import { createConversationHistoryService } from "./lib/conversation-history-service.mjs";
import { createDailyCampaignService } from "./lib/daily-campaign-service.mjs";
import { loadDeviceIdentity } from "./lib/device-identity.mjs";
import { filterRecordsForDevice } from "./lib/device-scope.mjs";
import { createTelegramFilterService } from "./lib/telegram-filter-service.mjs";
import { createNotionService } from "./lib/notion-service.mjs";
import { createOutboundFollowUpService } from "./lib/outbound-follow-up-service.mjs";
import { createProjectService } from "./lib/project-service.mjs";
import { createReplyServiceManager } from "./lib/reply-service-manager.mjs";
import { createRemoteMambaService } from "./lib/remote-mamba-service.mjs";
import { createSettingsService } from "./lib/settings-service.mjs";
import { createSystemLogService } from "./lib/system-log-service.mjs";
import { createTemplateService } from "./lib/template-service.mjs";
import { makeHub } from "./telegram_hub.mjs";
import {
  paths,
  loadEnv,
  makeApi,
  loadProjects,
  loadProjectConfig,
  importLeads,
  listInstances,
  openInstances,
  nextInstanceName,
  createInstance,
  instanceQr,
  deleteInstance,
  applyTemplateOverrides,
  firstFlowVariants,
  firstFlowPart2Variants,
  getTestLeads,
  resolveTime,
  formatTime,
  klDateTime,
  personalize,
  CampaignRunner,
} from "./campaign_core.mjs";
import { FLOW_SEQUENCE, flowByLabel, flowStateAfter, classifyReplyText } from "./flow_sequence.mjs";
import { collectMessageObjects, extractText, phoneFromJid, messageTime } from "./morning_followup.mjs";
import { describeMessage, resolvePhone } from "./reply_intake.mjs";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const HOST = "127.0.0.1";
const PORT = Number(process.env.CONSOLE_PORT ?? 8787);

const env = await loadEnv();
// Bridge .env into process.env so process.env consumers (e.g. getTestLeads -> TEST_LEADS)
// see the same values. Only fill blanks; never override real shell-exported env vars.
for (const [k, v] of Object.entries(env)) {
  if (v !== "" && process.env[k] === undefined) process.env[k] = v;
}
const api = makeApi(env);
const brainEnabled = String(env.MAMBA_BRAIN_ENABLED || process.env.MAMBA_BRAIN_ENABLED || "0").trim() === "1";
const deviceIdentity = await loadDeviceIdentity(env, { dataDir: paths.dataDir });
const notionService = createNotionService({ env });
const {
  notionTokenValue,
  notion,
  klTodayKL,
  nfTitle,
  nfText,
  nfPhone,
  nfSelect,
  nfNormalizePhone,
  nfAddDaysKL,
} = notionService;

let leadsCache = null; // { projectId, leads, rejected, sourcePath } | null
let runner = null;

// --- Notion access (for the "选人发下一轮" picker) --------------------------
const envPath = path.join(paths.rootDir, "evolution-pilot", ".env");
let notionConfig = {};
try {
  notionConfig = JSON.parse(await fs.readFile(path.join(paths.rootDir, "campaign-data", "notion_config.json"), "utf8"));
} catch { /* picker simply stays empty if config is missing */ }
const blastDsId = String(notionConfig?.databases?.blastLeads ?? "").replace(/[^a-fA-F0-9]/g, "");
const configuredBrainDb = (name, fallback) => String(notionConfig?.databases?.[name] || fallback).replace(/[^a-fA-F0-9]/g, "");

const settingsService = createSettingsService({ env, envPath, getNotionToken: notionTokenValue, notion });
const systemLogService = createSystemLogService({ rootDir: paths.rootDir });
const campaignQueueService = createCampaignQueueService({ rootDir: paths.rootDir });
const campaignRunnerRegistry = createCampaignRunnerRegistry({ rootDir: paths.rootDir });
const remoteMambaService = createRemoteMambaService({ rootDir: paths.rootDir, consolePort: PORT });

function setCurrentRunner(value, { latest = true } = {}) {
  if (!value) return;
  if (runner && runner !== value) runner.mirrorActiveState = false;
  runner = value;
  value.mirrorActiveState = latest;
  campaignRunnerRegistry.register(value, { latest });
}

function getCampaignRunner(runId = null) {
  return campaignRunnerRegistry.get(runId) || (!runId ? runner : null);
}
const replyServiceManager = createReplyServiceManager({
  rootDir: paths.rootDir,
  onLog: (message) => console.log(message),
  systemLogs: systemLogService,
  brainEnabled,
});
const conversationHistoryService = createConversationHistoryService({ rootDir: paths.rootDir });
const blastCacheService = createBlastCacheService({
  rootDir: paths.rootDir,
  blastDatabaseId: blastDsId,
  notion,
  nfSelect,
  nfTitle,
  nfText,
});
const templateService = await createTemplateService({
  rootDir: paths.rootDir,
  notionConfig,
  notion,
  nfTitle,
  nfText,
  nfSelect,
  personalize,
  firstFlowVariants,
  firstFlowPart2Variants,
});
const {
  firstFlowLabel: FIRST_FLOW_LABEL,
  flowMetaByTopic,
  buildTemplateTitle,
  resolveTemplateProject,
  resolveMedia,
  fetchFlowTemplates,
  getFirstFlowTemplateOptions,
  applyNotionFlowTemplatesToState,
  pickPreviewLanguage,
  shortPause,
  assertFirstConsoleRunUsesFlow1Only,
  addProjectOption,
  setImageAlias,
} = templateService;
const campaignRunService = createCampaignRunService({
  appDir,
  blastDatabaseId: blastDsId,
  notion,
  normalizePhone: nfNormalizePhone,
  nfSelect,
  nfAddDaysKL,
  klDateTime,
  flowByLabel,
  flowStateAfter,
  deviceIdentity,
});
const {
  autoAdvanceFlow,
  autoNotionUpload,
  recoverPendingUpdates,
  incPageNumber,
  creditSentCounts,
  emptySnapshot,
  buildCsv,
} = campaignRunService;
const projectService = createProjectService({
  blastDatabaseId: blastDsId,
  loadProjects,
  loadProjectConfig,
  notion,
  normalizePhone: nfNormalizePhone,
});
const { getProject, fetchBlastedPhones } = projectService;
const configuredFollowUpSyncMinutes = Number(process.env.MAMBA_FOLLOW_UP_SYNC_MINUTES || 30);
const followUpSyncMinutes = Number.isFinite(configuredFollowUpSyncMinutes)
  ? Math.max(5, configuredFollowUpSyncMinutes)
  : 30;
const outboundFollowUpService = createOutboundFollowUpService({
  blastDatabaseId: blastDsId,
  api,
  notion,
  openInstances: () => openInstances(api),
  normalizePhone: nfNormalizePhone,
  collectMessageObjects,
  describeMessage,
  resolvePhone,
  messageTime,
  queryNotionRows: blastCacheService.queryRows,
  filterRecords: (records) => filterRecordsForDevice(records, { device: deviceIdentity }).records,
  writeCache: blastCacheService.writeCache,
  history: conversationHistoryService,
  systemLogs: systemLogService,
  intervalMs: followUpSyncMinutes * 60 * 1000,
});

async function localJson(pathname, options = {}) {
  const response = await fetch(`http://${HOST}:${PORT}${pathname}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    signal: AbortSignal.timeout(15 * 60 * 1000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || `Mamba API HTTP ${response.status}`);
  return data;
}

const telegramHub = makeHub(env);
const telegramFilterService = createTelegramFilterService({
  rootDir: paths.rootDir,
  getConnectedPhones: async () => (await listInstances(api)).map((item) => item.number),
});
const dailyCampaignService = createDailyCampaignService({
  rootDir: paths.rootDir,
  flowSequence: FLOW_SEQUENCE,
  replyServices: replyServiceManager,
  openInstances: () => openInstances(api),
  getRunner: () => campaignRunnerRegistry.list().find((item) => item?.running) || runner,
  queue: campaignQueueService,
  systemLogs: systemLogService,
  postOps: telegramHub.hasOps ? (text) => telegramHub.postOps(text) : null,
  fetchDuePlan: ({ deep = false } = {}) => localJson(`/api/next-flow/list${deep ? "?deep=1" : ""}`),
  executeTest: async ({ batch, instances, maxLeads }) => {
    const projects = await loadProjects();
    const project = projects.find((item) => item.name === batch.project);
    if (!project) throw new Error(`找不到 Project 配置: ${batch.project}`);
    const testRecipients = getTestLeads().slice(0, maxLeads)
      .map((lead) => `${lead.name},${lead.phone},${lead.language || "en"}`)
      .join("\n");
    if (!testRecipients) throw new Error("Settings 没有 TEST 收件人，无法安全测试自动任务。");
    const selectedInstances = instances.slice(0, 1).map((item) => item.name).filter(Boolean);
    const prepared = await localJson("/api/prepare", {
      method: "POST",
      body: JSON.stringify({ project: project.id, mode: "TEST", instances: selectedInstances, testRecipients }),
    });
    await localJson("/api/next-flow/apply-templates", {
      method: "POST",
      body: JSON.stringify({ projectName: batch.project, flow: batch.flow, runId: prepared?.snapshot?.state?.runId }),
    });
    const started = await localJson("/api/start", {
      method: "POST",
      body: JSON.stringify({ optIn: true, overrides: [], project: project.id, runId: prepared?.snapshot?.state?.runId }),
    });
    return { runId: prepared?.snapshot?.state?.runId || prepared?.snapshot?.runId || null, queued: started.queued === true };
  },
});

const handlers = {};

const runtime = await loadRuntime({
  host: HOST,
  port: PORT,
  env,
  api,
  appDir,
  paths,
  handlers,
  getRunner: () => campaignRunnerRegistry.list().find((item) => item?.running) || runner,
  systemLogs: systemLogService,
  settings: settingsService,
  device: deviceIdentity,
  telegramHub,
  telegramFilters: telegramFilterService,
  replyServices: replyServiceManager,
  dailyCampaign: dailyCampaignService,
  remoteMamba: remoteMambaService,
  projects: {
    alias: notionConfig?.projectAlias || {},
    firstFlowLabel: FIRST_FLOW_LABEL,
    loadProjects,
    getProject,
    getFirstFlowTemplateOptions,
    firstFlowVariants,
    getLeadsCache: () => leadsCache,
  },
  whatsapp: {
    listInstances: () => listInstances(api),
    createInstance: (name) => createInstance(api, name),
    instanceQr: (name) => instanceQr(api, name),
    deleteInstance: (name) => deleteInstance(api, name),
    nextInstanceName,
  },
  imports: {
    rootDir: paths.rootDir,
    hasBlastDatabase: Boolean(blastDsId),
    getProject,
    importLeads,
    fetchBlastedPhones,
    normalizePhone: nfNormalizePhone,
    getLeadsCache: () => leadsCache,
    setLeadsCache: (value) => { leadsCache = value; },
  },
  lookup: {
    rootDir: paths.rootDir,
    hasBlastDatabase: Boolean(blastDsId),
    importLeads,
    normalizePhone: nfNormalizePhone,
    readCache: blastCacheService.read,
    syncCache: blastCacheService.sync,
    queryNotionRows: blastCacheService.queryRows,
  },
  conversations: {
    device: deviceIdentity,
    hasBlastDatabase: Boolean(blastDsId),
    blastDatabaseId: blastDsId,
    api,
    notion,
    openInstances: () => openInstances(api),
    normalizePhone: nfNormalizePhone,
    collectMessageObjects,
    extractText,
    describeMessage,
    phoneFromJid,
    resolvePhone,
    messageTime,
    classifyReplyText,
    systemLogs: systemLogService,
    history: conversationHistoryService,
    readCache: blastCacheService.read,
    syncCache: blastCacheService.sync,
    writeCache: blastCacheService.writeCache,
    queryNotionRows: blastCacheService.queryRows,
  },
  followUp: {
    device: deviceIdentity,
    hasBlastDatabase: Boolean(blastDsId),
    blastDatabaseId: blastDsId,
    api,
    notion,
    openInstances: () => openInstances(api),
    collectMessageObjects,
    describeMessage,
    resolvePhone,
    messageTime,
    normalizePhone: nfNormalizePhone,
    history: conversationHistoryService,
    outboundSync: outboundFollowUpService,
    systemLogs: systemLogService,
    readCache: blastCacheService.read,
    writeCache: blastCacheService.writeCache,
    queryNotionRows: blastCacheService.queryRows,
  },
  brainLearning: {
    notion,
    api,
    openInstances: () => openInstances(api),
    collectMessageObjects,
    describeMessage,
    resolvePhone,
    messageTime,
    normalizePhone: nfNormalizePhone,
    history: conversationHistoryService,
    readCache: blastCacheService.read,
    systemLogs: systemLogService,
    aiReplyLogDbId: configuredBrainDb("aiReplyLog", "4272e2edbf644f44b670c71ae4276051"),
    goldenDbId: configuredBrainDb("goldenConversations", "dc5c303e463145abb9d635c007120157"),
    objectionDbId: configuredBrainDb("objectionBank", "f73c35315d604aa682ecf84826cde123"),
  },
  templates: {
    rootDir: paths.rootDir,
    env,
    notionConfig,
    notion,
    nfTitle,
    nfText,
    nfSelect,
    normalizePhone: nfNormalizePhone,
    resolveMedia,
    resolveTemplateProject,
    flowMetaByTopic,
    buildTemplateTitle,
    fetchFlowTemplates,
    pickPreviewLanguage,
    flowSequence: FLOW_SEQUENCE,
    personalize,
    shortPause,
    openInstances: () => openInstances(api),
    createPreviewRunner: () => new CampaignRunner({ env, systemLogs: systemLogService }),
    addProjectOption,
    setImageAlias,
  },
  campaign: {
    env,
    device: deviceIdentity,
    getRunner: (runId = null) => getCampaignRunner(runId),
    listRunners: () => campaignRunnerRegistry.list(),
    setRunner: (value, options) => setCurrentRunner(value, options),
    persistRunners: () => campaignRunnerRegistry.persist(),
    getLeadsCache: () => leadsCache,
    getProject,
    openInstances: () => openInstances(api),
    resolveTime,
    formatTime,
    getTestLeads,
    createRunner: (config) => new CampaignRunner({ config, env, systemLogs: systemLogService }),
    restoreRunner: async ({ runId, projectId }) => {
      if (!/^run_[A-Za-z0-9_.-]+$/.test(String(runId || ""))) throw new Error("Queue runId 不合法。");
      const { config } = await getProject(projectId);
      const restored = new CampaignRunner({ config, env, systemLogs: systemLogService });
      const expectedPath = path.join(paths.runsDir, `${runId}.json`);
      await restored.restore(expectedPath);
      return restored;
    },
    queue: campaignQueueService,
    applyNotionFlowTemplatesToState,
    firstFlowLabel: FIRST_FLOW_LABEL,
    applyTemplateOverrides,
    assertFirstConsoleRunUsesFlow1Only,
    autoAdvanceFlow,
    creditSentCounts,
    autoNotionUpload,
    recoverPendingUpdates,
    emptySnapshot,
    buildCsv,
  },
  nextFlow: {
    blastDatabaseId: blastDsId,
    api,
    notion,
    normalizePhone: nfNormalizePhone,
    nfPhone,
    nfSelect,
    nfTitle,
    nfText,
    klTodayKL,
    openInstances: () => openInstances(api),
    collectMessageObjects,
    extractText,
    describeMessage,
    phoneFromJid,
    resolvePhone,
    messageTime,
    classifyReplyText,
    systemLogs: systemLogService,
    incPageNumber,
    getRunner: (runId = null) => getCampaignRunner(runId),
    listRunners: () => campaignRunnerRegistry.list(),
    getProject,
    setLeadsCache: (value) => { leadsCache = value; },
    flowByLabel,
    flowSequence: FLOW_SEQUENCE,
    fetchFlowTemplates,
    applyNotionFlowTemplatesToState,
  },
});
const server = http.createServer(createApp(runtime));

async function restoreActiveCampaign() {
  let index;
  try {
    index = await campaignRunnerRegistry.loadIndex();
  } catch (error) {
    console.log(`Active campaign registry recovery read failed: ${error.message}`);
    index = { latestRunId: null, runs: [] };
  }

  if (!index.runs.length) {
    try {
      const saved = JSON.parse(await fs.readFile(path.join(paths.dataDir, "active-run.json"), "utf8"));
      if (saved?.runId) index.runs = [{
        runId: saved.runId,
        projectId: saved.projectId || saved.campaignId,
        mode: saved.mode,
        status: saved.status,
      }];
    } catch (error) {
      if (error?.code !== "ENOENT") console.log(`Legacy active campaign recovery read failed: ${error.message}`);
    }
  }

  const results = [];
  for (const saved of index.runs) {
    if (!saved?.runId) continue;
    const projectId = saved.projectId || saved.campaignId;
    if (!projectId) {
      console.log(`Active campaign ${saved.runId} cannot recover: missing projectId/campaignId.`);
      continue;
    }
    try {
      const restored = await runtime.campaign.restoreRunner({ runId: saved.runId, projectId });
      const latest = saved.runId === index.latestRunId || !runner;
      setCurrentRunner(restored, { latest });
      if (saved.status === "RUNNING" || restored.state.status === "RUNNING") {
        restored.state.status = "INTERRUPTED";
        restored.pushLog("检测到上次运行期间服务中断。已停止自动发送；请人工检查后再按 Resume。已发送记录不会重发。");
        await restored.saveState();
        await systemLogService.write({
          level: "warn",
          area: "campaign",
          event: "campaign_interrupted_recovered",
          message: "Recovered an interrupted campaign without resuming sends.",
          context: { runId: saved.runId, project: saved.project || null },
        }).catch(() => {});
        results.push({ runId: saved.runId, restored: true, interrupted: true });
        continue;
      }
      const recovery = await runtime.campaign.recoverPendingUpdates(restored);
      if (recovery?.recovered) {
        console.log(`Recovered pending Notion update for ${saved.runId}: ${recovery.kind} ${recovery.status || ""}`);
      }
      results.push({ runId: saved.runId, restored: true, recovery });
    } catch (error) {
      console.log(`Active campaign recovery failed (${saved.runId}): ${error.message}`);
      await systemLogService.write({
        level: "error",
        area: "campaign",
        event: "campaign_recovery_failed",
        message: "Could not restore pending campaign/Notion state after restart.",
        context: { runId: saved.runId, error: error.message },
      }).catch(() => {});
    }
  }
  if (index.latestRunId) {
    const latest = campaignRunnerRegistry.get(index.latestRunId);
    if (latest) setCurrentRunner(latest, { latest: true });
  }
  await campaignRunnerRegistry.persist().catch(() => {});
  return results;
}

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.log("");
    console.log(`Console 已经在 ${PORT} 端口运行了 —— 不用再启动一个。`);
    console.log(`直接打开 http://${HOST}:${PORT}/ 即可;所有页面(首轮群发/Settings/模板/查找)共用这一个 server。`);
    console.log(`想强制重启:先跑  lsof -ti tcp:${PORT} | xargs kill  再启动。`);
    process.exit(0);
  }
  throw error;
});

server.listen(PORT, HOST, () => {
  const address = `http://${HOST}:${PORT}`;
  const openPath = process.env.MAMBA_OPEN_PATH || "/control-center";
  const openUrl = new URL(openPath, address).toString();
  console.log("Campaign Console (multi-project)");
  console.log("================================");
  console.log(`Open in your browser: ${openUrl}`);
  console.log("Close this window to stop the console.");
  replyServiceManager.startMonitoring();
  outboundFollowUpService.start();
  dailyCampaignService.start();
  restoreActiveCampaign().catch((error) => console.log(`Campaign recovery failed: ${error.message}`));
  replyServiceManager.ensureStarted()
    .then((status) => console.log(
      status.brainEnabled
        ? `Reply services: tracker ${status.tracker ? "ONLINE" : "OFFLINE"} · brain ${status.brain ? "ONLINE" : "OFFLINE"}`
        : `Reply services: tracker ${status.tracker ? "ONLINE" : "OFFLINE"} · Sales Brain DISABLED (tracker-only, no automatic customer replies)`,
    ))
    .catch((error) => console.log(`Reply services could not start: ${error.message}`));
  if (process.env.MAMBA_AUTO_OPEN !== "0") exec(`open "${openUrl}"`);
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    replyServiceManager.stopManaged();
    outboundFollowUpService.stop();
    dailyCampaignService.stop();
    remoteMambaService.stop();
    server.close(() => process.exit(0));
  });
}
