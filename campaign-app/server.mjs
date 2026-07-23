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
import { createConversationLogService } from "./lib/conversation-log-service.mjs";
import { createCampaignModeService } from "./lib/campaign-mode-service.mjs";
import { createNotionOutboxService } from "./lib/notion-outbox-service.mjs";
import { createNotionOutboxWorker } from "./lib/notion-outbox-worker.mjs";
import { createConversationHistoryService } from "./lib/conversation-history-service.mjs";
import { createDailyCampaignService } from "./lib/daily-campaign-service.mjs";
import { createLocalDatabaseService } from "./lib/local-database-service.mjs";
import { createGoldenConversationLedgerService } from "./lib/golden-conversation-ledger-service.mjs";
import { loadDeviceIdentity } from "./lib/device-identity.mjs";
import { filterRecordsForDevice } from "./lib/device-scope.mjs";
import { includeLocalInstancePhones, loadDeviceSenderPolicy, nextDeviceInstanceName } from "./lib/device-sender-policy.mjs";
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
  campaignRestartDecision,
} from "./campaign_core.mjs";
import { runCampaignInBackground, startNextQueued } from "./routes/campaign.routes.mjs";
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
const deviceSenderPolicy = await loadDeviceSenderPolicy({ dataDir: paths.dataDir, env });
deviceIdentity.senderPhones = deviceSenderPolicy.configured ? [deviceSenderPolicy.expectedSenderPhone] : [];
deviceIdentity.senderPolicyConfigured = deviceSenderPolicy.configured;
const deviceOpenInstances = async () => includeLocalInstancePhones(deviceIdentity, await openInstances(api));
const deviceListInstances = async () => includeLocalInstancePhones(deviceIdentity, await listInstances(api));
// 先做一次 best-effort discovery，让 Customer Desk 即使早于 Settings 打开，也已经
// 知道这台电脑所有本机 WhatsApp 号码。Evolution 离线时不阻塞 Mamba 启动。
listInstances(api)
  .then((items) => includeLocalInstancePhones(deviceIdentity, items))
  .catch(() => { /* 后续 Phone Health 刷新时会再发现。 */ });
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
const localDatabaseService = createLocalDatabaseService({
  dataDir: paths.dataDir,
  device: deviceIdentity,
  senderPolicy: deviceSenderPolicy,
});
const goldenLedgerService = createGoldenConversationLedgerService({
  localDatabase: localDatabaseService,
  dataDir: paths.dataDir,
});
const systemLogService = createSystemLogService({ rootDir: paths.rootDir });
const conversationLog = createConversationLogService({ dataDir: paths.dataDir });
const campaignModeService = createCampaignModeService({ dataDir: paths.dataDir });
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
const localProjectCodeByName = new Map((await loadProjects().catch(() => [])).flatMap((project) => [
  [String(project?.id || "").trim().toLowerCase(), String(project?.id || "").trim()],
  [String(project?.name || "").trim().toLowerCase(), String(project?.id || "").trim()],
]).filter(([name, code]) => name && code));
localDatabaseService.configureNotionImport({
  fetchRecords: () => blastCacheService.queryRows(undefined),
  scopeRecords: (records) => filterRecordsForDevice(records, {
    device: deviceIdentity,
    senderPhones: deviceIdentity.senderPhones,
  }),
  resolveProjectCode: (name) => localProjectCodeByName.get(String(name || "").trim().toLowerCase()) || "",
});
await localDatabaseService.initialize().catch(async (error) => {
  console.log(`[local-database] startup initialization held: ${error.code || "SQLITE_STARTUP_FAILED"} ${error.message}`);
  await systemLogService.write({
    level: "error",
    area: "local_database",
    event: "sqlite_startup_initialization_failed",
    message: "SQLite Shadow could not initialize or migrate at Mamba startup.",
    context: { code: error.code || "SQLITE_STARTUP_FAILED", error: error.message },
  }).catch(() => {});
});
await goldenLedgerService.initialize().catch(async (error) => {
  console.log(`[golden-ledger] startup initialization held: ${error.code || "GC_STARTUP_FAILED"} ${error.message}`);
  await systemLogService.write({
    level: "error",
    area: "golden_conversations",
    event: "golden_ledger_startup_failed",
    message: "Golden Conversation Ledger could not initialize safely.",
    context: { code: error.code || "GC_STARTUP_FAILED", error: error.message },
  }).catch(() => {});
});

async function readLeadStore() {
  if (await localDatabaseService.isPrimary().catch(() => false)) {
    return localDatabaseService.readLeadCache();
  }
  return blastCacheService.read();
}

const LEAD_STORE_AUTO_REFRESH_MS = Math.max(
  0,
  Number(process.env.MAMBA_LEAD_AUTO_REFRESH_MINUTES ?? 15) * 60_000,
);

async function pullNotionIntoLocal(reason) {
  const payload = await blastCacheService.sync({ force: true });
  await localDatabaseService.syncNotionRecords(payload.records, { reason });
  return localDatabaseService.readLeadCache();
}

async function syncLeadStore(options = {}) {
  const primary = await localDatabaseService.isPrimary().catch(() => false);
  if (primary && options.force !== true) {
    const current = await localDatabaseService.readLeadCache();
    // Auto-refresh: if the local snapshot is stale, pull the latest from Notion so
    // the dashboard reflects today's blasts without a manual "重新同步". Never let a
    // Notion hiccup break the read — fall back to the snapshot we already have.
    const ageMs = current?.syncedAt ? Date.now() - new Date(current.syncedAt).getTime() : Infinity;
    if (LEAD_STORE_AUTO_REFRESH_MS > 0 && (!Number.isFinite(ageMs) || ageMs >= LEAD_STORE_AUTO_REFRESH_MS)) {
      try {
        return await pullNotionIntoLocal("auto_dashboard_refresh");
      } catch (error) {
        console.warn(`[lead-store] auto refresh failed, serving cached snapshot: ${error?.message}`);
        return current;
      }
    }
    return current;
  }
  const payload = await blastCacheService.sync(options);
  if (!primary) return payload;
  await localDatabaseService.syncNotionRecords(payload.records, { reason: "manual_notion_refresh" });
  return localDatabaseService.readLeadCache();
}

async function writeLeadStore(records) {
  const payload = await blastCacheService.writeCache(records);
  if (!await localDatabaseService.isPrimary().catch(() => false)) return payload;
  await localDatabaseService.syncNotionRecords(payload.records, { reason: "notion_write_through" });
  return localDatabaseService.readLeadCache();
}
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
  localDatabase: localDatabaseService,
  normalizePhone: nfNormalizePhone,
  nfSelect,
  nfAddDaysKL,
  klDateTime,
  flowByLabel,
  flowStateAfter,
  deviceIdentity,
});
const {
  recordLocalFlowProgress,
  checkpointCompletedCustomer,
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
  openInstances: deviceOpenInstances,
  normalizePhone: nfNormalizePhone,
  collectMessageObjects,
  describeMessage,
  resolvePhone,
  messageTime,
  queryNotionRows: blastCacheService.queryRows,
  filterRecords: (records) => filterRecordsForDevice(records, { device: deviceIdentity }).records,
  writeCache: writeLeadStore,
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
  getConnectedPhones: async () => (await deviceListInstances()).map((item) => item.number),
});
const dailyCampaignService = createDailyCampaignService({
  rootDir: paths.rootDir,
  flowSequence: FLOW_SEQUENCE,
  replyServices: replyServiceManager,
  openInstances: deviceOpenInstances,
  getRunner: () => campaignRunnerRegistry.list().find((item) => item?.running) || runner,
  queue: campaignQueueService,
  systemLogs: systemLogService,
  postOps: telegramHub.hasOps ? (text) => telegramHub.postOps(text) : null,
  getTestLeads,
  fetchDuePlan: ({ deep = false } = {}) => localJson(`/api/next-flow/list${deep ? "?deep=1" : ""}`),
  executeTest: async ({ batch, instances, maxLeads }) => {
    const projects = await loadProjects();
    const project = projects.find((item) => item.name === batch.project);
    if (!project) throw new Error(`找不到 Project 配置: ${batch.project}`);
    const selectedTestLeads = Array.isArray(batch.leads) && batch.leads.length
      ? batch.leads
      : getTestLeads().slice(0, maxLeads);
    const testRecipients = selectedTestLeads
      .map((lead) => `${lead.name},${lead.phone},${lead.language || "en"}`)
      .join("\n");
    if (!testRecipients) throw new Error("Settings 没有 TEST 收件人，无法安全测试自动任务。");
    const selectedInstances = instances.slice(0, 1).map((item) => item.name).filter(Boolean);
    const prepared = await localJson("/api/prepare", {
      method: "POST",
      body: JSON.stringify({ project: project.id, mode: "TEST", instances: selectedInstances, testRecipients }),
    });
    if (batch.flow !== "Flow 1 - Project Template") {
      await localJson("/api/next-flow/apply-templates", {
        method: "POST",
        body: JSON.stringify({ projectName: batch.project, flow: batch.flow, runId: prepared?.snapshot?.state?.runId }),
      });
    }
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
  localDatabase: localDatabaseService,
  goldenLedger: goldenLedgerService,
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
    listInstances: deviceListInstances,
    createInstance: (name) => createInstance(api, name),
    instanceQr: (name) => instanceQr(api, name),
    deleteInstance: (name) => deleteInstance(api, name),
    nextInstanceName: (items) => nextDeviceInstanceName(items, deviceIdentity),
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
    listLeadGroups: (options) => localDatabaseService.listLeadGroups(options),
    readLeadGroup: (options) => localDatabaseService.readLeadGroup(options),
    createLeadGroup: (options) => localDatabaseService.createLeadGroup(options),
    renameLeadGroup: (options) => localDatabaseService.renameLeadGroup(options),
    updateLeadGroupMembers: (options) => localDatabaseService.updateLeadGroupMembers(options),
  },
  lookup: {
    rootDir: paths.rootDir,
    hasBlastDatabase: Boolean(blastDsId),
    importLeads,
    normalizePhone: nfNormalizePhone,
    readCache: readLeadStore,
    syncCache: syncLeadStore,
    queryNotionRows: blastCacheService.queryRows,
  },
  conversations: {
    device: deviceIdentity,
    hasBlastDatabase: Boolean(blastDsId),
    blastDatabaseId: blastDsId,
    api,
    notion,
    openInstances: deviceOpenInstances,
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
    readCache: readLeadStore,
    syncCache: syncLeadStore,
    writeCache: writeLeadStore,
    queryNotionRows: blastCacheService.queryRows,
  },
  followUp: {
    device: deviceIdentity,
    hasBlastDatabase: Boolean(blastDsId),
    blastDatabaseId: blastDsId,
    api,
    notion,
    openInstances: deviceOpenInstances,
    collectMessageObjects,
    describeMessage,
    resolvePhone,
    messageTime,
    normalizePhone: nfNormalizePhone,
    history: conversationHistoryService,
    outboundSync: outboundFollowUpService,
    systemLogs: systemLogService,
    readCache: readLeadStore,
    syncCache: syncLeadStore,
    writeCache: writeLeadStore,
    queryNotionRows: blastCacheService.queryRows,
  },
  brainLearning: {
    notion,
    api,
    openInstances: deviceOpenInstances,
    collectMessageObjects,
    describeMessage,
    resolvePhone,
    messageTime,
    normalizePhone: nfNormalizePhone,
    history: conversationHistoryService,
    readCache: readLeadStore,
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
    openInstances: deviceOpenInstances,
    createPreviewRunner: () => new CampaignRunner({ env, systemLogs: systemLogService, conversationLog }),
    addProjectOption,
    setImageAlias,
  },
  campaign: {
    env,
    device: deviceIdentity,
    getRunner: (runId = null) => getCampaignRunner(runId),
    listRunners: () => campaignRunnerRegistry.list(),
    setRunner: (value, options) => setCurrentRunner(value, options),
    // 只从监控清单拿掉，campaign-data/runs/ 的发送回执不动。
    // 也要把「当前 runner」这个指标放掉 —— 不然 registry 空了，/api/status 还是
    // 会从这个指标回一张卡，画面上清不掉。
    forgetRunner: (runId) => {
      const removed = campaignRunnerRegistry.remove(runId);
      if (removed && runner?.state?.runId === runId) runner = null;
      return removed;
    },
    persistRunners: () => campaignRunnerRegistry.persist(),
    getLeadsCache: () => leadsCache,
    getProject,
    openInstances: deviceOpenInstances,
    resolveTime,
    formatTime,
    getTestLeads,
    createRunner: (config) => new CampaignRunner({
      config, env, systemLogs: systemLogService, conversationLog,
      customerCheckpoint: checkpointCompletedCustomer,
    }),
    restoreRunner: async ({ runId, projectId }) => {
      if (!/^run_[A-Za-z0-9_.-]+$/.test(String(runId || ""))) throw new Error("Queue runId 不合法。");
      const { config } = await getProject(projectId);
      const restored = new CampaignRunner({
        config, env, systemLogs: systemLogService, conversationLog,
        customerCheckpoint: checkpointCompletedCustomer,
      });
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
    checkpointCompletedCustomer,
    recordLocalFlowProgress,
    creditSentCounts,
    autoNotionUpload,
    recoverPendingUpdates,
    emptySnapshot,
    buildCsv,
  },
  nextFlow: {
    blastDatabaseId: blastDsId,
    device: deviceIdentity,
    senderPolicy: deviceSenderPolicy,
    api,
    notion,
    normalizePhone: nfNormalizePhone,
    nfPhone,
    nfSelect,
    nfTitle,
    nfText,
    klTodayKL,
    openInstances: deviceOpenInstances,
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
    recordLocalFlowProgress,
    readLocalLeadCache: () => localDatabaseService.readLeadCache(),
    setLocalLeadFlowState: (options) => localDatabaseService.setLeadFlowState(options),
    recordLocalLeadReply: (options) => localDatabaseService.recordLeadReply(options),
    getProject,
    setLeadsCache: (value) => { leadsCache = value; },
    createLeadGroup: (options) => localDatabaseService.createLeadGroup(options),
    flowByLabel,
    flowSequence: FLOW_SEQUENCE,
    fetchFlowTemplates,
    applyNotionFlowTemplatesToState,
  },
});

// ---------- Notion 回写队列（outbox）----------
//
// 每位客户完成时先把 Flow + 这笔待办一起 commit 到 SQLite。Notion 不阻塞
// WhatsApp 发送，只在晚上 22:00 或人工按「立即同步」时处理。
runtime.campaignMode = campaignModeService;
runtime.notionOutbox = createNotionOutboxService({ dataDir: paths.dataDir });
runtime.notionOutboxWorker = createNotionOutboxWorker({
  outbox: runtime.notionOutbox,
  time: env.NOTION_OUTBOX_TIME || "22:00",
  onLog: (message) => console.log(message),
  // 重跑一次那个 run 的收尾。两个函式本身都会跳过没发出去的客户，
  // 所以重复执行是安全的。
  handler: async (job) => {
    if (job.entityType === "project_lead_patch") {
      const pageId = String(job.payload?.pageId || "").replace(/[^a-fA-F0-9]/g, "");
      const properties = job.payload?.properties;
      if (!pageId || !properties || typeof properties !== "object") return false;
      await notion("PATCH", `/pages/${pageId}`, { properties });
      await systemLogService.write({
        level: "info",
        area: "notion",
        event: "outbox_project_lead_patch_retried",
        message: `Notion 客户状态重试成功：${job.entityId}`,
        context: { pageId, entityId: job.entityId },
      }).catch(() => {});
      return true;
    }
    const { runId, projectId } = job.payload ?? {};
    if (!runId) return false;
    const activeRunner = runtime.campaign.getRunner(runId);
    if (activeRunner?.running) {
      return { defer: true, delayMs: 5 * 60_000, reason: "campaign_still_running" };
    }
    const runner = activeRunner?.state
      ? activeRunner
      : await runtime.campaign.restoreRunner({ runId, projectId }).catch(() => null);
    if (!runner?.state) return false;   // run 档不见了：结案，不重试
    // 走哪条路по run 自己的状态判断，不看排队当下存的旗标 —— 旗标可能是旧的，
    // 而 flowLabel 是这个 run 的事实。Flow 1 没有 flowLabel 走上传，
    // Flow 2-10 有 flowLabel 走推进。
    const flowLabel = runner.state.flowLabel || "";
    if (flowLabel) {
      await autoAdvanceFlow(runner);
      if (runner.state.advanceStatus !== "SUCCEEDED") {
        throw new Error(runner.state.advanceError || `Notion Flow 推进状态是 ${runner.state.advanceStatus || "UNKNOWN"}`);
      }
      await creditSentCounts(runner);
    }
    else {
      const result = await autoNotionUpload(runner, { allowPartial: true });
      if (result?.status === "FAILED") throw new Error(result.error || "Flow 1 Notion upload failed");
    }
    await systemLogService.write({
      level: "info",
      area: "notion",
      event: "outbox_finalise_retried",
      message: `Notion 回写重试成功：${flowLabel || "Flow 1"} · ${runId}`,
      context: { runId, flowLabel: flowLabel || "Flow 1 - Project Template" },
    }).catch(() => {});
    return true;
  },
});
runtime.notionOutboxWorker.start();

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
        const decision = campaignRestartDecision(restored.state);
        if (decision.action === "COMPLETE") {
          restored.state.status = "COMPLETED";
          restored.state.interruption = null;
          restored.pushLog("重启检查：所有客户都已有完成证据，已自动结案并释放号码，不需要人工确认。");
          await restored.saveState();
          await systemLogService.write({
            level: "info",
            area: "campaign",
            event: "campaign_restart_auto_completed",
            message: "Restart recovery found no unfinished customers and completed the campaign automatically.",
            context: { runId: saved.runId, project: saved.project || null },
          }).catch(() => {});
        } else if (decision.action === "RESUME") {
          restored.state.resumeSession = {
            startedAt: new Date().toISOString(),
            total: decision.safe,
            jobIds: decision.safeJobIds,
            source: "restart-auto-resume",
          };
          restored.state.interruption = null;
          restored.pushLog(`重启检查：${decision.safe} 位都有明确安全状态，已自动继续；已完成的客户不会重发。`);
          await restored.saveState();
          await systemLogService.write({
            level: "info",
            area: "campaign",
            event: "campaign_restart_auto_resumed",
            message: "Restart recovery automatically resumed only customers with unambiguous local state.",
            context: { runId: saved.runId, project: saved.project || null, resumed: decision.safe, jobIds: decision.safeJobIds },
          }).catch(() => {});
          runCampaignInBackground(runtime, restored, Boolean(restored.state.flowLabel), "campaign_restart_auto_resume_failed");
          results.push({ runId: saved.runId, restored: true, autoResumed: true, decision });
          continue;
        } else {
          restored.state.status = "INTERRUPTED";
          restored.state.interruption = {
            code: "UNCONFIRMED_SEND_AFTER_RESTART",
            message: `${decision.ambiguous} 位客户停在发送确认窗口，WhatsApp 可能已经收到。请人工核对后再决定，系统不会自动重发。`,
            jobIds: decision.ambiguousJobIds,
            interruptedAt: new Date().toISOString(),
          };
          restored.pushLog(`重启检查：${decision.ambiguous} 位客户的发送结果无法确认，已安全暂停；其余明确状态不会重发。`);
          await restored.saveState();
          await systemLogService.write({
            level: "warn",
            area: "campaign",
            event: "campaign_interrupted_recovered",
            message: "Restart recovery paused because one or more WhatsApp sends have no local confirmation evidence.",
            context: {
              runId: saved.runId,
              project: saved.project || null,
              ambiguous: decision.ambiguous,
              jobIds: decision.ambiguousJobIds,
            },
          }).catch(() => {});
          results.push({ runId: saved.runId, restored: true, interrupted: true, decision });
          continue;
        }
      }
      const recovery = await runtime.campaign.recoverPendingUpdates(restored);
      if (recovery?.recovered) {
        console.log(`Recovered local campaign checkpoint for ${saved.runId}; Notion remains queued: ${recovery.kind} ${recovery.status || ""}`);
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
  // Queue 已经由使用者确认过。程序重启后重新检查号码车道：安全就自动接着跑；
  // 若旧 run 有 SENDING 未确认状态，campaignQueueBlockReason 仍会维持暂停。
  await startNextQueued(runtime).catch(async (error) => {
    await campaignQueueService.setHold(`重启后启动下一批失败: ${error.message}`).catch(() => {});
    await systemLogService.write({
      level: "error",
      area: "campaign",
      event: "campaign_queue_restart_failed",
      message: "Could not restart the saved Campaign Queue after Mamba launched.",
      context: { error: error.message },
    }).catch(() => {});
  });
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
  goldenLedgerService.start();
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
    goldenLedgerService.stop();
    remoteMambaService.stop();
    server.close(() => process.exit(0));
  });
}
