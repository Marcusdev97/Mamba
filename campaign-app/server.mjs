// Local web console for the WhatsApp campaign blaster (multi-project).
// Start with: node campaign-app/server.mjs   (or double-click "Campaign Console.command")

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { exec } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createApp } from "./app/createApp.mjs";
import { loadRuntime } from "./app/loadRuntime.mjs";
import { createBlastCacheService } from "./lib/blast-cache-service.mjs";
import { createCampaignRunService } from "./lib/campaign-run-service.mjs";
import { createConversationHistoryService } from "./lib/conversation-history-service.mjs";
import { createNotionService } from "./lib/notion-service.mjs";
import { createProjectService } from "./lib/project-service.mjs";
import { createSettingsService } from "./lib/settings-service.mjs";
import { createSystemLogService } from "./lib/system-log-service.mjs";
import { createTemplateService } from "./lib/template-service.mjs";
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

const settingsService = createSettingsService({ env, envPath, getNotionToken: notionTokenValue, notion });
const systemLogService = createSystemLogService({ rootDir: paths.rootDir });
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
});
const {
  autoAdvanceFlow,
  autoNotionUpload,
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

const handlers = {};

const runtime = await loadRuntime({
  host: HOST,
  port: PORT,
  env,
  api,
  appDir,
  paths,
  handlers,
  getRunner: () => runner,
  systemLogs: systemLogService,
  settings: settingsService,
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
    hasBlastDatabase: Boolean(blastDsId),
    blastDatabaseId: blastDsId,
    api,
    notion,
    openInstances: () => openInstances(api),
    normalizePhone: nfNormalizePhone,
    collectMessageObjects,
    extractText,
    phoneFromJid,
    messageTime,
    classifyReplyText,
    systemLogs: systemLogService,
    history: conversationHistoryService,
    readCache: blastCacheService.read,
    writeCache: blastCacheService.writeCache,
    queryNotionRows: blastCacheService.queryRows,
  },
  followUp: {
    hasBlastDatabase: Boolean(blastDsId),
    blastDatabaseId: blastDsId,
    notion,
    systemLogs: systemLogService,
    readCache: blastCacheService.read,
    writeCache: blastCacheService.writeCache,
    queryNotionRows: blastCacheService.queryRows,
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
    getRunner: () => runner,
    setRunner: (value) => { runner = value; },
    getLeadsCache: () => leadsCache,
    getProject,
    openInstances: () => openInstances(api),
    resolveTime,
    formatTime,
    getTestLeads,
    createRunner: (config) => new CampaignRunner({ config, env, systemLogs: systemLogService }),
    applyNotionFlowTemplatesToState,
    firstFlowLabel: FIRST_FLOW_LABEL,
    applyTemplateOverrides,
    assertFirstConsoleRunUsesFlow1Only,
    autoAdvanceFlow,
    creditSentCounts,
    autoNotionUpload,
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
    phoneFromJid,
    messageTime,
    classifyReplyText,
    incPageNumber,
    getRunner: () => runner,
    getProject,
    setLeadsCache: (value) => { leadsCache = value; },
    flowByLabel,
    flowSequence: FLOW_SEQUENCE,
    fetchFlowTemplates,
    applyNotionFlowTemplatesToState,
  },
});
const server = http.createServer(createApp(runtime));

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
  const openPath = process.env.MAMBA_OPEN_PATH || "/";
  const openUrl = new URL(openPath, address).toString();
  console.log("Campaign Console (multi-project)");
  console.log("================================");
  console.log(`Open in your browser: ${openUrl}`);
  console.log("Close this window to stop the console.");
  if (process.env.MAMBA_AUTO_OPEN !== "0") exec(`open "${openUrl}"`);
});
