// Local web console for the WhatsApp campaign blaster (multi-project).
// Start with: node campaign-app/server.mjs   (or double-click "Campaign Console.command")

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { exec, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createApp } from "./app/createApp.mjs";
import { loadRuntime } from "./app/loadRuntime.mjs";
import { createBlastCacheService } from "./lib/blast-cache-service.mjs";
import { createNotionService } from "./lib/notion-service.mjs";
import { createSettingsService } from "./lib/settings-service.mjs";
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

// All normalized phone numbers already in Blast Leads for a project — used to skip
// re-importing (and re-blasting) people who are already in the sequence.
async function fetchBlastedPhones(projectName) {
  const phones = new Set();
  if (!blastDsId || !projectName) return phones;
  let cursor;
  do {
    const q = await notion("POST", `/databases/${blastDsId}/query`, {
      filter: { property: "Project", select: { equals: projectName } },
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    for (const page of q?.results ?? []) {
      const n = nfNormalizePhone(page.properties?.["Phone"]?.phone_number);
      if (n) phones.add(n);
    }
    cursor = q?.has_more ? q?.next_cursor : null;
  } while (cursor);
  return phones;
}

// After a picker LIVE run finishes, push each sent lead's flow state forward in
// Notion (same logic as advance_flow.mjs), so the operator never runs a separate
// "advance" step. Only touches leads that actually sent and are still Running.
async function autoAdvanceFlow(r) {
  if (!blastDsId || !r?.state?.assignments) return;
  let advanced = 0;
  try {
    for (const job of r.state.assignments) {
      if (!job.part1?.sentAt) continue; // only actually-sent leads
      const phone = nfNormalizePhone(job.lead?.phone);
      if (!phone) continue;
      const q = await notion("POST", `/databases/${blastDsId}/query`, {
        filter: { property: "Phone", phone_number: { equals: phone } }, page_size: 1,
      });
      const page = q?.results?.[0];
      if (!page) continue;
      if (page.properties?.["Stop Flag"]?.checkbox === true) continue;
      if (nfSelect(page, "Sequence Status") !== "Running") continue;
      const curNext = nfSelect(page, "Next Flow");
      if (r.state.flowLabel && curNext !== r.state.flowLabel) continue; // already advanced -> don't double-advance
      const sentFlow = flowByLabel(curNext);
      if (!sentFlow) continue;
      const st = flowStateAfter(sentFlow.key);
      const props = {
        "Last Flow Sent": { select: { name: st.lastFlowLabel } },
        "Next Flow": { select: { name: st.nextFlowLabel } },
        "Cohort Day": { select: { name: st.cohortDay } },
        "Last Blast At": { date: { start: job.part2?.sentAt ?? job.part1?.sentAt } },
      };
      if (st.nextFlowLabel === "Completed") {
        props["Sequence Status"] = { select: { name: "Completed" } };
        props["Flow Completed At"] = { date: { start: new Date().toISOString() } };
        props["Follow Up Due"] = { date: null };
      } else {
        props["Follow Up Due"] = { date: { start: nfAddDaysKL(st.dueDays) } };
      }
      await notion("PATCH", `/pages/${String(page.id).replace(/[^a-fA-F0-9]/g, "")}`, { properties: props });
      advanced += 1;
      await new Promise((res) => setTimeout(res, 250));
    }
    r.state.advanceDone = true;
    await r.saveState();
    r.pushLog?.(`Flow 状态已自动推进:${advanced} 人进入下一轮。`);
  } catch (e) {
    r.state.advanceDone = true; // don't leave the UI stuck on "更新中" if it errors
    await r.saveState().catch(() => {});
    r.pushLog?.(`自动推进 Flow 出错:${e.message}`);
  }
}

// After a LIVE Flow-1 blast finishes, upload the run's leads to Notion
// automatically — same as clicking「上传 Blast 名单到 Notion」by hand.
// Self-guarding: picker (next-flow) runs carry state.flowLabel and are skipped;
// notion_upload.mjs dedups by phone, so a re-run / resume can never double-write.
function autoNotionUpload(r) {
  try {
    if (!r?.runPath || r?.state?.mode !== "LIVE") return;
    if (r.state.flowLabel) return; // picker run: leads already exist in Notion
    r.pushLog?.("正在自动上传 blast 名单到 Notion…");
    execFile(process.execPath, [path.join(appDir, "notion_upload.mjs"), r.runPath], { cwd: appDir }, (error, stdout, stderr) => {
      if (error) {
        r.pushLog?.(`自动上传 Notion 失败:${(stderr || error.message).trim().slice(0, 200)} —— 可在控制台点「上传 Blast 名单到 Notion(手动补跑)」`);
      } else {
        r.pushLog?.("Blast 名单已自动上传到 Notion ✅");
      }
    });
  } catch (e) {
    r?.pushLog?.(`自动上传 Notion 出错:${e.message}`);
  }
}

// Increment a number property on a Notion page (read-then-write).
async function incPageNumber(pageId, prop, delta) {
  if (!pageId || !delta) return;
  const id = String(pageId).replace(/[^a-fA-F0-9]/g, "");
  try {
    const p = await notion("GET", `/pages/${id}`);
    const cur = Number(p?.properties?.[prop]?.number ?? 0);
    await notion("PATCH", `/pages/${id}`, { properties: { [prop]: { number: cur + delta } } });
  } catch { /* best-effort analytics */ }
}

// After a run, bump each used template's (and its image's) Sent Count by how many
// leads actually received it. Idempotent per run via state.credited.
async function creditSentCounts(r) {
  if (!r?.state || r.state.credited) return;
  r.state.credited = true;
  const byLang = r.state.creditByLang || {};
  const tally = {}; // pageId -> { c, img }
  for (const job of r.state.assignments) {
    if (!job.part1?.sentAt) continue; // only actually-sent leads
    let credits = job.tplCredit; // the exact variants this lead got (rotation-safe)
    if (!credits) { // fallback for older runs without per-job credit
      const L = String(job.language || "en").toUpperCase();
      const t = byLang[L] || byLang[Object.keys(byLang)[0]] || {};
      credits = [(t.p1 || [])[0], (t.p2 || [])[0]].filter((x) => x && x.pageId)
        .map((x) => ({ pageId: x.pageId, imagePageId: x.imagePageId }));
    }
    for (const c of credits) {
      if (c?.pageId) { tally[c.pageId] = tally[c.pageId] || { c: 0, img: c.imagePageId }; tally[c.pageId].c += 1; }
    }
  }
  for (const [pageId, v] of Object.entries(tally)) {
    await incPageNumber(pageId, "Sent Count", v.c);
    if (v.img) await incPageNumber(v.img, "Sent Count", v.c);
  }
  try { await r.saveState(); } catch { /* ignore */ }
  r.pushLog?.(`已更新 Sent Count(${Object.keys(tally).length} 个模板)。`);
}

// Read fresh each time so "Sync Templates" changes show up without restarting.
async function getProject(id) {
  const projects = await loadProjects();
  const project = projects.find((p) => p.id === id) || projects[0];
  if (!project) throw new Error("campaign-assets/projects.json 里没有配置任何 project。");
  return { project, config: await loadProjectConfig(project) };
}

function emptySnapshot() {
  return { running: false, stopped: false, state: null, log: [] };
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function buildCsv(state) {
  const headers = ["name", "phone", "instance", "language", "status", "scheduled_time", "part1_sent_at", "part2_sent_at", "error"];
  const rows = state.assignments.map((job) => [
    job.lead.name, job.lead.phone, job.instanceName, job.language, job.status,
    klDateTime(job.scheduledAt), klDateTime(job.part1?.sentAt), klDateTime(job.part2?.sentAt), job.error ?? "",
  ]);
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

const handlers = {};

const runtime = await loadRuntime({
  host: HOST,
  port: PORT,
  env,
  api,
  appDir,
  paths,
  handlers,
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
    createPreviewRunner: () => new CampaignRunner({ env }),
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
    createRunner: (config) => new CampaignRunner({ config, env }),
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
