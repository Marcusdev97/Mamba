// Local web console for the WhatsApp campaign blaster (multi-project).
// Start with: node campaign-app/server.mjs   (or double-click "Campaign Console.command")

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { exec, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
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

let leadsCache = null; // { projectId, leads, rejected, sourcePath } | null
let runner = null;

// --- Notion access (for the "选人发下一轮" picker) --------------------------
const NOTION_VERSION = "2022-06-28";
const notionToken = env.NOTION_API_KEY || env.NOTION_TOKEN || process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;
let notionConfig = {};
try {
  notionConfig = JSON.parse(await fs.readFile(path.join(paths.rootDir, "campaign-data", "notion_config.json"), "utf8"));
} catch { /* picker simply stays empty if config is missing */ }
const blastDsId = String(notionConfig?.databases?.blastLeads ?? "").replace(/[^a-fA-F0-9]/g, "");

// Map a template's "Image Name" to a local file the blaster can send.
// campaign-assets/image_aliases.json maps the Notion image name -> a filename in
// campaign-assets/images/. The blaster reads media as a path relative to campaign-assets.
let imageAliases = {};
try {
  imageAliases = JSON.parse(await fs.readFile(path.join(paths.rootDir, "campaign-assets", "image_aliases.json"), "utf8"));
} catch { /* no aliases -> images just won't attach */ }
function resolveMedia(imageName) {
  if (!imageName) return "";
  const alias = imageAliases[imageName];
  if (alias) return `images/${alias}`;
  if (/\.(png|jpe?g|webp|gif|mp4|mov|3gp|m4v)$/i.test(imageName)) return `images/${imageName}`;
  return "";
}

async function notion(method, pathname, body, attempt = 0) {
  if (!notionToken) throw new Error("没有 Notion token。先运行 Set Notion Token。");
  const r = await fetch(`https://api.notion.com/v1${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${notionToken}`, "Content-Type": "application/json", "Notion-Version": NOTION_VERSION },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  // Auto-retry on rate limit / transient errors so heavy blasts don't drop updates.
  if ((r.status === 429 || r.status === 502 || r.status === 503 || r.status === 504) && attempt < 5) {
    const retryAfter = Number(r.headers.get("retry-after")) || (attempt + 1);
    await new Promise((res) => setTimeout(res, Math.min(retryAfter + 0.5, 10) * 1000));
    return notion(method, pathname, body, attempt + 1);
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Notion HTTP ${r.status} ${JSON.stringify(data)}`);
  return data;
}

const klTodayKL = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" });
const nfTitle = (p, n) => (p?.properties?.[n]?.title ?? []).map((t) => t.plain_text).join("").trim();
const nfText = (p, n) => (p?.properties?.[n]?.rich_text ?? []).map((t) => t.plain_text).join("").trim();
const nfPhone = (p, n) => String(p?.properties?.[n]?.phone_number ?? "").trim();
const nfSelect = (p, n) => p?.properties?.[n]?.select?.name ?? p?.properties?.[n]?.status?.name ?? "";
function nfNormalizePhone(value) {
  let d = String(value ?? "").replace(/\D/g, "");
  if (d.startsWith("0")) d = `60${d.slice(1)}`;
  return /^\d{8,15}$/.test(d) ? d : null;
}
function nfAddDaysKL(days) {
  const d = new Date(`${klTodayKL()}T00:00:00+08:00`);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" });
}

// Fetch the Active templates for a Project + Cohort Day, grouped by language:
// { EN: { p1:{text,media}, p2:{text,media} }, ZH:{...} }. Shared by the preview
// (read-only) and the actual send (apply-templates).
// A project may be rebranded (e.g. leads still say "Gen Starz" but templates
// live under "Gen Starz"). notion_config.projectAlias maps lead-project -> template-project.
function resolveTemplateProject(name) {
  return notionConfig?.projectAlias?.[name] || name;
}
// "Flow 3 - Location" -> "Location" (matches the templates' Flow Topic).
function flowTopicOf(flowLabel) {
  const s = String(flowLabel || "");
  return s.includes(" - ") ? s.split(" - ").slice(1).join(" - ").trim() : s.trim();
}

const FLOW_META = [
  { no: 1, topic: "Project Template", day: "Day 0" },
  { no: 2, topic: "Layout", day: "Day 2" },
  { no: 3, topic: "Location", day: "Day 4" },
  { no: 4, topic: "Package", day: "Day 6" },
  { no: 5, topic: "Furnished List", day: "" },
  { no: 6, topic: "Price", day: "Day 9" },
  { no: 7, topic: "Facilities", day: "Day 12" },
  { no: 8, topic: "Invitation", day: "Day 15" },
  { no: 9, topic: "Rental", day: "" },
  { no: 10, topic: "Surrounding", day: "" },
];
const FIRST_FLOW_LABEL = "Flow 1 - Project Template";

function flowMetaByTopic(topic) {
  return FLOW_META.find((flow) => flow.topic === String(topic || "").trim()) || null;
}

function buildTemplateTitle({ project, flowTopic, language, part, version = "v1" }) {
  const meta = flowMetaByTopic(flowTopic);
  const flowLabel = meta ? `Flow ${String(meta.no).padStart(2, "0")} - ${meta.topic}` : (flowTopic || "Flow");
  return `[${project || "?"}][${flowLabel}][${String(language || "EN").toUpperCase()}][${part || "Part 1"}][${version}]`;
}

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

async function fetchFlowTemplates(projectName, flowLabel, { includeTesting = false } = {}) {
  // The 2022-06-28 API's /databases/{id}/query wants the DATABASE id, not the
  // data source (collection) id — using the collection id 404s.
  const tplDbId = String(notionConfig?.databases?.templates ?? "").replace(/[^a-fA-F0-9]/g, "");
  if (!tplDbId) throw new Error("notion_config 里没有 templates database。");
  const topic = flowTopicOf(flowLabel);
  const proj = resolveTemplateProject(projectName);
  // Normal sending only pulls Active. Mobile Preview can opt into Testing drafts
  // too (includeTesting) so half-built flows can still be previewed — Active is
  // always preferred over Testing when both exist for the same part.
  const statusFilter = includeTesting
    ? { or: [
        { property: "Status", select: { equals: "Active" } },
        { property: "Status", select: { equals: "Testing" } },
      ] }
    : { property: "Status", select: { equals: "Active" } };
  // Match by Flow Topic (which the templates are tagged with), not Cohort Day.
  const data = await notion("POST", `/databases/${tplDbId}/query`, { filter: { and: [
    { property: "Flow Topic", select: { equals: topic } },
    { property: "Project", select: { equals: proj } },
    statusFilter,
  ] }, page_size: 100 });
  const byLang = {};
  for (const row of data?.results ?? []) {
    const lang = (nfSelect(row, "Language") || "EN").toUpperCase();
    const part = nfSelect(row, "Part");
    const status = (nfSelect(row, "Status") || "").trim();
    const text = nfText(row, "Message Text");
    const imageName = nfText(row, "Image Name");
    const media = resolveMedia(imageName);
    if (!text && !media) continue;
    const pageId = row.id;
    const imagePageId = row.properties?.["Images"]?.relation?.[0]?.id || null;
    // Key by part NUMBER (Part 1/2/3/...), so templates can have any number of
    // parts. Each part holds all its active variants so the sender can rotate
    // between them (anti-spam). Ordering rules:
    //   "Part N"    -> N
    //   "Follow Up" -> 900, a sentinel that always sorts LAST, so the follow-up
    //                  re-prompt goes out after every numbered part in the flow.
    //                  (You can write the Follow Up content later; until then the
    //                  flow just sends its numbered parts.)
    //   blank/other -> 1  (the main message)
    const m = /(\d+)/.exec(part || "");
    const pn = m ? Number(m[1]) : (/follow\s*up/i.test(part || "") ? 900 : 1);
    byLang[lang] = byLang[lang] || { parts: {} };
    byLang[lang].parts[pn] = byLang[lang].parts[pn] || [];
    byLang[lang].parts[pn].push({
      name: nfTitle(row, "Template Name"),
      part,
      partNo: pn,
      text,
      media,
      pageId,
      imagePageId,
      status,
    });
  }
  // Prefer Active variants first within each part so preview picks a live
  // template over a Testing draft whenever one exists.
  for (const lang of Object.keys(byLang)) {
    for (const pn of Object.keys(byLang[lang].parts)) {
      byLang[lang].parts[pn].sort((a, b) =>
        (a.status === "Active" ? 0 : 1) - (b.status === "Active" ? 0 : 1));
    }
  }
  // Legacy accessors so older readers (credit fallbacks, twoPart) still work.
  for (const lang of Object.keys(byLang)) {
    byLang[lang].p1 = byLang[lang].parts[1] || [];
    byLang[lang].p2 = byLang[lang].parts[2] || [];
  }
  return byLang;
}

function pickTemplateVariant(variants) {
  return variants[Math.floor(Math.random() * variants.length)];
}

function sortedTemplatePartNumbers(languageTemplates) {
  return Object.keys(languageTemplates?.parts || {})
    .map(Number)
    .filter((n) => (languageTemplates.parts[n] || []).length)
    .sort((a, b) => a - b);
}

function findTemplateVariant(byLang, pageId) {
  const id = String(pageId || "");
  if (!id) return null;
  for (const [language, pack] of Object.entries(byLang || {})) {
    for (const [partNo, variants] of Object.entries(pack?.parts || {})) {
      const variant = (variants || []).find((item) => item.pageId === id);
      if (variant) return { language, partNo: Number(partNo), variant };
    }
  }
  return null;
}

async function getFirstFlowTemplateOptions(projectName) {
  const byLang = await fetchFlowTemplates(projectName, FIRST_FLOW_LABEL);
  const templates = [];
  for (const [language, pack] of Object.entries(byLang || {})) {
    for (const item of pack?.parts?.[1] || []) {
      templates.push({
        id: item.pageId,
        language: language.toLowerCase(),
        name: item.name || item.pageId,
        status: item.status,
      });
    }
  }
  return templates;
}

async function applyNotionFlowTemplatesToState(state, { projectName, flow, overrides = [], markFlowRun = true, credit = true } = {}) {
  const byLang = await fetchFlowTemplates(projectName, flow);
  if (!Object.keys(byLang).length) {
    throw new Error(`没有 Active 的「${flow}」模板(${projectName})。去 Templates 库确认 Flow Topic 对得上、Status=Active。`);
  }

  const overrideById = new Map((Array.isArray(overrides) ? overrides : []).map((item) => [String(item.id), item]));
  const slug = flow.replace(/[^A-Za-z0-9]+/g, "").toLowerCase();
  const tally = {};
  let overridden = 0;

  for (const job of state.assignments || []) {
    const override = overrideById.get(String(job.id));
    const requested = override?.part1Variant ? findTemplateVariant(byLang, override.part1Variant) : null;
    let language = requested?.language || String(job.language || "en").toUpperCase();
    if (!byLang[language]) language = byLang.EN ? "EN" : Object.keys(byLang)[0];
    const pack = byLang[language];
    const nums = sortedTemplatePartNumbers(pack);
    if (!nums.length) continue;

    const mainPartNo = nums.includes(1) ? 1 : nums[0];
    const main = (requested && requested.language === language && requested.partNo === mainPartNo)
      ? requested.variant
      : pickTemplateVariant(pack.parts[mainPartNo]);
    const chosen = [
      main,
      ...nums.filter((n) => n !== mainPartNo).map((n) => pickTemplateVariant(pack.parts[n])),
    ].filter(Boolean);
    const second = chosen[1] || null;
    const rest = chosen.slice(2);

    job.language = language.toLowerCase();
    job.part1Variant = main.pageId || `flow_${slug}_p1`;
    job.part1Text = personalize(main.text, job.lead.name);
    job.part1Media = main.media || "";
    if (second) {
      job.part2Variant = second.pageId || `flow_${slug}_p2`;
      job.part2Text = personalize(second.text, job.lead.name);
      job.part2Media = second.media || "";
    } else {
      job.part2Variant = null;
      job.part2Text = "";
      job.part2Media = "";
    }
    job.extraParts = rest.map((v, i) => ({
      variant: v.pageId || `flow_${slug}_p${i + 3}`,
      text: personalize(v.text, job.lead.name),
      media: v.media || "",
      sentInfo: null,
    }));
    job.tplCredit = chosen
      .filter((item) => item && item.pageId)
      .map((item) => ({ pageId: item.pageId, imagePageId: item.imagePageId }));
    for (const c of job.tplCredit) {
      tally[c.pageId] = tally[c.pageId] || { count: 0, imagePageId: c.imagePageId };
      tally[c.pageId].count += 1;
    }
    overridden += 1;
  }

  state.templateSource = "notion";
  state.templateFlow = flow;
  state.templateProject = resolveTemplateProject(projectName);
  state.templateLanguages = Object.keys(byLang);
  if (markFlowRun) {
    state.flowLabel = flow;
    state.advanceDone = false;
  }
  if (credit) {
    state.creditPlan = Object.entries(tally).map(([pageId, v]) => ({ pageId, imagePageId: v.imagePageId, count: v.count }));
    state.creditByLang = byLang;
    state.credited = false;
  }
  return { byLang, overridden, tally };
}

function pickPreviewLanguage(byLang, requestedLanguage) {
  const languages = Object.keys(byLang || {});
  if (!languages.length) return { language: "", parts: [] };
  const preferred = String(requestedLanguage || "EN").trim().toUpperCase();
  const language = byLang[preferred] ? preferred : (byLang.EN ? "EN" : languages[0]);
  const parts = Object.keys(byLang[language]?.parts || {})
    .map(Number)
    .filter((n) => (byLang[language].parts[n] || []).length)
    .sort((a, b) => a - b)
    .map((n) => byLang[language].parts[n][0])
    .filter(Boolean);
  const usedTesting = parts.some((p) => p && p.status === "Testing");
  return { language, parts, usedTesting };
}

async function shortPause(ms = 650) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function assertFirstConsoleRunUsesFlow1Only(config, state) {
  if (state?.flowLabel) return; // next-flow picker runs already carry a specific flow.
  if (state?.templateSource === "notion") {
    if (state.templateFlow !== FIRST_FLOW_LABEL) {
      throw new Error(`这个预览不是 Flow 1 模板(${state.templateFlow || "未知"})，请重新「生成预览」。`);
    }
    return;
  }
  const allowedP1 = new Set(firstFlowVariants(config).map((variant) => variant.id));
  const byP1 = new Map((config?.part1?.variants || []).map((variant) => [variant.id, variant]));
  const bad = [];
  for (const job of state?.assignments || []) {
    if (job.part1Variant && !allowedP1.has(job.part1Variant)) {
      bad.push(`${job.lead?.name || job.name || job.id}: ${job.part1Variant}`);
      continue;
    }
    if (job.part2Variant) {
      const part1 = byP1.get(job.part1Variant);
      const allowedP2 = new Set(firstFlowPart2Variants(config, part1).map((variant) => variant.id));
      if (!allowedP2.has(job.part2Variant)) bad.push(`${job.lead?.name || job.name || job.id}: ${job.part2Variant}`);
    }
  }
  if (bad.length) {
    throw new Error(`这个预览混到非 Flow 1 模板，请重新「生成预览」。例子: ${bad.slice(0, 3).join(" / ")}`);
  }
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

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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

const handlers = {
  "GET /api/projects": async (_req, res) => {
    const projects = await loadProjects();
    json(res, 200, {
      ok: true,
      projects: projects.map((p) => ({ id: p.id, name: p.name, senders: p.senders ?? [], excel: p.excel ?? "" })),
      alias: notionConfig?.projectAlias || {},
    });
  },

  "GET /api/instances": async (_req, res) => {
    try {
      const instances = await listInstances(api);
      json(res, 200, { ok: true, online: true, instances });
    } catch (error) {
      json(res, 200, { ok: true, online: false, error: error.message, instances: [] });
    }
  },

  "POST /api/instance/create": async (req, res) => {
    const body = await readBody(req);
    const items = await listInstances(api);
    let name = String(body.name ?? "").trim();
    if (name && !/^wa_\d{2}$/.test(name)) throw new Error("标签格式应为 wa_NN，例如 wa_03。");
    if (!name) name = nextInstanceName(items);
    if (items.some((item) => item.name === name)) throw new Error(`${name} 已存在，换一个标签。`);
    const result = await createInstance(api, name);
    if (!result.qr) throw new Error("Evolution 没有返回二维码。");
    json(res, 200, { ok: true, instanceName: name, qr: result.qr });
  },

  "GET /api/instance/qr": async (req, res) => {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const name = String(url.searchParams.get("name") ?? "").trim();
    if (!name) throw new Error("缺少 name。");
    const qr = await instanceQr(api, name);
    if (!qr) throw new Error("无法获取二维码（可能已连接）。");
    json(res, 200, { ok: true, qr });
  },

  "POST /api/instance/delete": async (req, res) => {
    if (runner && runner.running) throw new Error("campaign 正在运行，请先停止再删除号码。");
    const body = await readBody(req);
    const name = String(body.name ?? "").trim();
    if (!name) throw new Error("缺少 name。");
    await deleteInstance(api, name);
    json(res, 200, { ok: true });
  },

  "GET /api/config": async (req, res) => {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const { project, config } = await getProject(url.searchParams.get("project") ?? undefined);
    let templates = [];
    let templateSource = "notion";
    let templateError = "";
    try {
      templates = await getFirstFlowTemplateOptions(project.name);
    } catch (error) {
      templateSource = "local-fallback";
      templateError = error.message;
      templates = firstFlowVariants(config).map((variant) => ({
        id: variant.id,
        language: variant.language,
        name: variant.id,
        status: "Local",
      }));
    }
    json(res, 200, {
      ok: true,
      project: project.id,
      projectName: project.name,
      campaignName: config.campaignName,
      partGapSeconds: config.delivery.partGapSeconds,
      contactGapSeconds: config.delivery.contactGapSeconds,
      senders: project.senders ?? [],
      excel: project.excel ?? "",
      leadsLoaded: leadsCache && leadsCache.projectId === project.id ? leadsCache.leads.length : 0,
      templateSource,
      templateFlow: FIRST_FLOW_LABEL,
      templateError,
      templates,
    });
  },

  "POST /api/import": async (req, res) => {
    const body = await readBody(req);
    const { project } = await getProject(body.project);
    const source = String(body.sourcePath ?? "").trim() || path.join(paths.rootDir, project.excel);
    const result = await importLeads(source);
    // Skip anyone already in Notion's Blast Leads for THIS project (already blasted /
    // already in the sequence), so we never double-blast. Set includeBlasted:true to override.
    let skippedAlreadyBlasted = 0;
    let leads = result.leads;
    if (blastDsId && !body.includeBlasted) {
      try {
        const blasted = await fetchBlastedPhones(project.name);
        leads = result.leads.filter((lead) => {
          const n = nfNormalizePhone(lead.phone);
          if (n && blasted.has(n)) { skippedAlreadyBlasted += 1; return false; }
          return true;
        });
      } catch { /* if the lookup fails, fall back to importing everything */ }
    }
    // GLOBAL suppression gate (A1) — cross-project, cross-database. Anyone who
    // said STOP anywhere never enters a new cohort. NOT overridable by
    // includeBlasted (that flag is for re-blasting, not for ignoring opt-outs).
    let skippedSuppressed = 0;
    try {
      const { syncSuppressionList, loadSuppressionSync } = await import("./suppression.mjs");
      let suppressed;
      try {
        suppressed = (await syncSuppressionList()).set; // fresh from Notion
      } catch {
        suppressed = loadSuppressionSync().set; // Notion down -> last snapshot
      }
      leads = leads.filter((lead) => {
        const n = nfNormalizePhone(lead.phone);
        if (n && suppressed.has(n)) { skippedSuppressed += 1; return false; }
        return true;
      });
    } catch (err) {
      console.warn(`[suppression] gate unavailable: ${err?.message}`);
    }
    leadsCache = { projectId: project.id, ...result, leads };
    json(res, 200, {
      ok: true,
      project: project.id,
      imported: leads.length,
      skippedAlreadyBlasted,
      skippedSuppressed,
      rejected: result.rejected.length,
      sourcePath: result.sourcePath,
      sample: leads.slice(0, 8).map((lead) => ({ name: lead.name, phone: lead.phone })),
    });
  },

  // Full list of the currently imported leads, for in-console name editing.
  "GET /api/leads": async (req, res) => {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const { project } = await getProject(url.searchParams.get("project") ?? undefined);
    if (!leadsCache || leadsCache.projectId !== project.id) {
      json(res, 200, { ok: true, project: project.id, leads: [] });
      return;
    }
    json(res, 200, {
      ok: true,
      project: project.id,
      leads: leadsCache.leads.map((lead) => ({ id: lead.id, name: lead.name, phone: lead.phone })),
    });
  },

  // Edit lead display names after import. Updates the in-memory cache that
  // prepare() reads, so previews and the actual blast use the corrected names.
  // Blank names are ignored (we never overwrite a name with an empty value).
  "POST /api/leads/update": async (req, res) => {
    if (runner && runner.running) throw new Error("campaign 正在运行，请先停止再改名字。");
    const body = await readBody(req);
    const { project } = await getProject(body.project);
    if (!leadsCache || leadsCache.projectId !== project.id) {
      throw new Error("还没有导入这个 project 的 leads，请先导入。");
    }
    const edits = Array.isArray(body.edits) ? body.edits : [];
    const byId = new Map(leadsCache.leads.map((lead) => [lead.id, lead]));
    let updated = 0;
    for (const edit of edits) {
      const lead = byId.get(String(edit.id));
      if (!lead) continue;
      const name = String(edit.name ?? "").trim();
      if (name && name !== lead.name) { lead.name = name; updated += 1; }
    }
    json(res, 200, { ok: true, updated });
  },

  "POST /api/prepare": async (req, res) => {
    if (runner && runner.running) {
      json(res, 409, { ok: false, error: "已有 campaign 正在运行，请先停止。" });
      return;
    }
    const body = await readBody(req);
    const { project, config } = await getProject(body.project);
    const mode = body.mode === "LIVE" ? "LIVE" : "TEST";

    const open = await openInstances(api);
    if (open.length === 0) throw new Error("没有处于 OPEN 状态的 WhatsApp 号码，无法发送。");

    // All connected numbers blast the selected project together; body.instances can narrow it.
    let selectedInstances = open;
    if (Array.isArray(body.instances) && body.instances.length) {
      const wanted = new Set(body.instances);
      selectedInstances = open.filter((item) => wanted.has(item.name));
      if (selectedInstances.length === 0) throw new Error("所选号码都不在线。");
    }

    const now = new Date();
    const defaultEnd = new Date(now);
    defaultEnd.setHours(21, 0, 0, 0);
    if (defaultEnd <= now) defaultEnd.setTime(now.getTime() + 60 * 60 * 1000);

    const startAt = resolveTime(body.startTime, now);
    const endAt = resolveTime(body.endTime, defaultEnd);
    if (endAt <= startAt) throw new Error("结束时间必须晚于开始时间。");
    if (endAt.getTime() - startAt.getTime() <= config.delivery.partGapSeconds * 1000) {
      throw new Error(`发送时间窗必须长于 ${config.delivery.partGapSeconds} 秒。`);
    }

    let selectedLeads;
    if (mode === "TEST") {
      selectedLeads = getTestLeads();
    } else {
      if (!leadsCache || leadsCache.projectId !== project.id || !leadsCache.leads.length) {
        throw new Error(`还没有导入 ${project.name} 的 leads，请先导入它的 Excel。`);
      }
      selectedLeads = leadsCache.leads;
      const limit = Number(body.leadCount);
      if (Number.isInteger(limit) && limit >= 1 && limit < selectedLeads.length) {
        selectedLeads = selectedLeads.slice(0, limit);
      }
    }

    runner = new CampaignRunner({ config, env });
    await runner.prepare({ mode, startAt, endAt, instances: selectedInstances, leads: selectedLeads, project: project.name });
    await applyNotionFlowTemplatesToState(runner.state, {
      projectName: project.name,
      flow: FIRST_FLOW_LABEL,
      markFlowRun: false,
      credit: false,
    });
    await runner.saveState();
    json(res, 200, {
      ok: true,
      project: project.id,
      schedule: { start: formatTime(startAt), end: formatTime(endAt) },
      snapshot: runner.snapshot(),
    });
  },

  "POST /api/start": async (req, res) => {
    if (!runner || !runner.state) throw new Error("请先生成预览（prepare）。");
    if (runner.running) {
      json(res, 409, { ok: false, error: "campaign 已在运行。" });
      return;
    }
    const body = await readBody(req);
    if (runner.state.mode === "LIVE" && body.optIn !== true) {
      throw new Error("LIVE 模式需要先确认收件人已 opt-in。");
    }
    if (runner.state.templateSource === "notion") {
      await applyNotionFlowTemplatesToState(runner.state, {
        projectName: runner.state.project,
        flow: runner.state.templateFlow || FIRST_FLOW_LABEL,
        overrides: body.overrides,
        markFlowRun: false,
        credit: false,
      });
    } else {
      applyTemplateOverrides(runner.state, body.overrides, runner.config);
    }
    assertFirstConsoleRunUsesFlow1Only(runner.config, runner.state);
    await runner.saveState();
    const r = runner;
    const autoAdvance = body.autoAdvance === true && r.state.mode === "LIVE";
    r.run()
      .then(() => (autoAdvance ? autoAdvanceFlow(r) : null))
      .then(() => (autoAdvance ? creditSentCounts(r) : null))
      .then(() => autoNotionUpload(r))
      .catch((error) => r.pushLog(`运行出错：${error.message}`));
    json(res, 200, { ok: true, snapshot: runner.snapshot() });
  },

  "POST /api/resume": async (_req, res) => {
    if (!runner || !runner.state) throw new Error("没有可继续的 run。");
    if (runner.running) {
      json(res, 409, { ok: false, error: "campaign 已在运行。" });
      return;
    }
    const remaining = runner.state.assignments.filter((j) => j.status === "QUEUED").length;
    if (!remaining) throw new Error("没有待发送的客户了（都已处理）。");
    const r = runner;
    r.run()
      .then(() => autoNotionUpload(r))
      .catch((error) => r.pushLog(`运行出错：${error.message}`));
    json(res, 200, { ok: true, snapshot: runner.snapshot() });
  },

  "POST /api/stop": async (_req, res) => {
    if (runner) runner.stop();
    json(res, 200, { ok: true });
  },

  "GET /api/status": async (_req, res) => {
    json(res, 200, runner ? runner.snapshot() : emptySnapshot());
  },

  // Real-time reply routing during a blast: scan Evolution for replies from THIS
  // run's leads, classify each (Reply Routes), colour them (red/green) + write to
  // Notion. Called repeatedly by the picker while a run is active.
  "POST /api/next-flow/scan-replies": async (_req, res) => {
    if (!runner || !runner.state) { json(res, 200, { ok: true, replies: [] }); return; }
    const state = runner.state;
    state.repliesSeen = state.repliesSeen || {};
    const startMs = new Date(state.startAt || Date.now()).getTime();
    const runPhones = new Map(); // phone -> name
    for (const j of state.assignments) {
      const p = nfNormalizePhone(j.lead?.phone);
      if (p) runPhones.set(p, j.lead?.name || p);
    }
    let instances = [];
    try { instances = await openInstances(api); }
    catch { json(res, 200, { ok: true, replies: Object.values(state.repliesSeen), evoOffline: true }); return; }

    const inbound = new Map(); // phone -> { at, text }
    for (const inst of instances) {
      let resp;
      try { resp = await api(`/chat/findMessages/${encodeURIComponent(inst.name)}`, { method: "POST", body: JSON.stringify({ where: {} }) }); }
      catch { continue; }
      for (const m of collectMessageObjects(resp)) {
        const at = messageTime(m);
        if (at < startMs || m?.key?.fromMe) continue;
        const phone = phoneFromJid(m?.key?.remoteJid);
        if (!phone || !runPhones.has(phone)) continue;
        const prev = inbound.get(phone);
        if (!prev || at > prev.at) inbound.set(phone, { at, text: extractText(m) });
      }
    }

    for (const [phone, ev] of inbound) {
      if (state.repliesSeen[phone]) continue; // handled already
      const v = classifyReplyText(ev.text);
      const rec = { phone, name: runPhones.get(phone), signal: v.signal, route: v.route, status: v.status, text: (ev.text || "").slice(0, 80) };
      state.repliesSeen[phone] = rec;
      try {
        const q = await notion("POST", `/databases/${blastDsId}/query`, { filter: { property: "Phone", phone_number: { equals: phone } }, page_size: 1 });
        const page = q?.results?.[0];
        if (page) {
          const props = {
            Status: { select: { name: v.status } },
            "Sequence Status": { select: { name: v.sequenceStatus } },
            "Next Action": { select: { name: v.nextAction } },
            "AI Category": { select: { name: v.aiCategory } },
            "Last Reply At": { date: { start: new Date(ev.at).toISOString() } },
            "Last Reply Text": { rich_text: [{ text: { content: (ev.text || "").slice(0, 1900) } }] },
            "Reply Checked At": { date: { start: new Date().toISOString() } },
            "AI Summary": { rich_text: [{ text: { content: `[${v.signal}] ${v.route} · 建议:${v.suggestedReply}` } }] },
          };
          if (v.stopFlag) { props["Stop Flag"] = { checkbox: true }; props["Stop Reason"] = { rich_text: [{ text: { content: `Auto: ${v.route}` } }] }; }
          await notion("PATCH", `/pages/${String(page.id).replace(/[^a-fA-F0-9]/g, "")}`, { properties: props });
        }
      } catch { /* keep the in-memory record even if Notion write fails */ }

      // credit the template(s) this lead received: Response / Warm / Stop counts.
      try {
        const job = state.assignments.find((j) => nfNormalizePhone(j.lead?.phone) === phone);
        let credits = job?.tplCredit; // the exact variants this lead got (rotation-safe)
        if (!credits) {
          const L = String(job?.language || "en").toUpperCase();
          const t = (state.creditByLang || {})[L] || Object.values(state.creditByLang || {})[0] || {};
          credits = [(t.p1 || [])[0], (t.p2 || [])[0]].filter((x) => x && x.pageId)
            .map((x) => ({ pageId: x.pageId, imagePageId: x.imagePageId }));
        }
        for (const part of credits) {
          if (!part?.pageId) continue;
          await incPageNumber(part.pageId, "Response Count", 1);
          if (v.signal === "GREEN") await incPageNumber(part.pageId, "Warm Count", 1);
          else if (v.signal === "RED") await incPageNumber(part.pageId, "Stop Count", 1);
          if (part.imagePageId) {
            await incPageNumber(part.imagePageId, "Response Count", 1);
            if (v.signal === "GREEN") await incPageNumber(part.imagePageId, "Warm Count", 1);
            else if (v.signal === "RED") await incPageNumber(part.imagePageId, "Stop Count", 1);
          }
        }
      } catch { /* analytics best-effort */ }
    }
    json(res, 200, { ok: true, replies: Object.values(state.repliesSeen) });
  },

  // --- Next-flow picker: list everyone DUE for their next flow ---------------
  "GET /api/next-flow/list": async (_req, res) => {
    if (!blastDsId) { json(res, 200, { ok: true, leads: [] }); return; }
    const today = klTodayKL();
    const filter = { and: [
      { property: "Sequence Status", select: { equals: "Running" } },
      { property: "Follow Up Due", date: { on_or_before: today } },
      { property: "Stop Flag", checkbox: { equals: false } },
      { property: "Status", select: { does_not_equal: "Stop" } },
      { property: "Status", select: { does_not_equal: "Not Interested" } },
      { property: "Status", select: { does_not_equal: "Appointment" } },
      { property: "Status", select: { does_not_equal: "Invalid" } },
    ] };
    const leads = [];
    let cursor;
    do {
      const body = { filter, page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      const data = await notion("POST", `/databases/${blastDsId}/query`, body);
      for (const pg of data?.results ?? []) {
        const phone = nfNormalizePhone(nfPhone(pg, "Phone"));
        const nextFlow = nfSelect(pg, "Next Flow");
        if (!phone || !nextFlow || nextFlow === "Completed") continue;
        leads.push({
          pageId: pg.id,
          name: nfTitle(pg, "Name") || phone,
          phone,
          project: nfSelect(pg, "Project") || "Unknown",
          nextFlow,
          cohortDay: nfSelect(pg, "Cohort Day"),
          lastReply: nfText(pg, "Last Reply Text"),
          lastBlastAt: pg?.properties?.["Last Blast At"]?.date?.start || null,
        });
      }
      cursor = data?.has_more ? data?.next_cursor : null;
    } while (cursor);

    // 🛡 开单前回复检测:Notion 侧的 Stop/Warm 已经被上面的 filter 挡掉了,
    // 这里补最后一道闸门 —— 客户在 WhatsApp 回复了、但还没结算进 Notion 的人。
    // 发现回复 -> 分类 -> 写回 Notion(退出序列/红旗)-> 从本次名单剔除。
    const skipped = [];
    let evoOffline = false;
    if (leads.length) {
      let instances = [];
      try { instances = await openInstances(api); } catch { evoOffline = true; }
      if (!evoOffline && instances.length) {
        const byPhone = new Map(leads.map((l) => [l.phone, l]));
        const inbound = new Map(); // phone -> { at, text }
        for (const inst of instances) {
          let resp;
          try { resp = await api(`/chat/findMessages/${encodeURIComponent(inst.name)}`, { method: "POST", body: JSON.stringify({ where: {} }) }); }
          catch { continue; }
          for (const m of collectMessageObjects(resp)) {
            if (m?.key?.fromMe) continue;
            const phone = phoneFromJid(m?.key?.remoteJid);
            const lead = phone && byPhone.get(phone);
            if (!lead) continue;
            const at = messageTime(m);
            // 只认「上次 blast 之后」的回复;没有 Last Blast At 就看最近 7 天
            const sinceMs = lead.lastBlastAt ? new Date(lead.lastBlastAt).getTime() : Date.now() - 7 * 864e5;
            if (at < sinceMs) continue;
            const prev = inbound.get(phone);
            if (!prev || at > prev.at) inbound.set(phone, { at, text: extractText(m) });
          }
        }
        for (const [phone, ev] of inbound) {
          const lead = byPhone.get(phone);
          const v = classifyReplyText(ev.text);
          skipped.push({ name: lead.name, phone, signal: v.signal, route: v.route, text: (ev.text || "").slice(0, 80) });
          try {
            const props = {
              Status: { select: { name: v.status } },
              "Sequence Status": { select: { name: v.sequenceStatus } },
              "Next Action": { select: { name: v.nextAction } },
              "AI Category": { select: { name: v.aiCategory } },
              "Last Reply At": { date: { start: new Date(ev.at).toISOString() } },
              "Last Reply Text": { rich_text: [{ text: { content: (ev.text || "").slice(0, 1900) } }] },
              "Reply Checked At": { date: { start: new Date().toISOString() } },
              "AI Summary": { rich_text: [{ text: { content: `[${v.signal}] ${v.route} · 建议:${v.suggestedReply}` } }] },
            };
            if (v.stopFlag) { props["Stop Flag"] = { checkbox: true }; props["Stop Reason"] = { rich_text: [{ text: { content: `Auto: ${v.route}(picker 开单前检测)` } }] }; }
            await notion("PATCH", `/pages/${String(lead.pageId).replace(/[^a-fA-F0-9]/g, "")}`, { properties: props });
            await new Promise((r) => setTimeout(r, 200));
          } catch { /* Notion 写失败也照样剔除,宁可少发不错发 */ }
        }
        if (skipped.length) {
          const skipPhones = new Set(skipped.map((s) => s.phone));
          for (let i = leads.length - 1; i >= 0; i--) if (skipPhones.has(leads[i].phone)) leads.splice(i, 1);
        }
      } else {
        evoOffline = true;
      }
    }
    json(res, 200, { ok: true, today, leads, skipped, evoOffline });
  },

  // Red-flag people right from the picker: stop their automatic sequence.
  "POST /api/next-flow/redflag": async (req, res) => {
    const body = await readBody(req);
    const ids = Array.isArray(body.pageIds) ? body.pageIds : [];
    let done = 0;
    for (const id of ids) {
      try {
        await notion("PATCH", `/pages/${String(id).replace(/[^a-fA-F0-9]/g, "")}`, { properties: {
          "Stop Flag": { checkbox: true },
          "Sequence Status": { select: { name: "Stopped" } },
          "Stop Reason": { rich_text: [{ text: { content: "Manual: marked 不发 in picker" } }] },
        } });
        done += 1;
        await new Promise((r) => setTimeout(r, 200));
      } catch { /* skip failures, report count */ }
    }
    json(res, 200, { ok: true, flagged: done });
  },

  // Load the ticked leads into leadsCache so the normal prepare/start pipeline
  // blasts exactly them. projectId must be a real Console project id.
  "POST /api/next-flow/load": async (req, res) => {
    if (runner && runner.running) throw new Error("campaign 正在运行，请先停止。");
    const body = await readBody(req);
    const { project } = await getProject(body.project);
    const incoming = Array.isArray(body.leads) ? body.leads : [];
    const seen = new Set();
    const leads = [];
    for (const item of incoming) {
      const phone = nfNormalizePhone(item.phone);
      if (!phone || seen.has(phone)) continue;
      seen.add(phone);
      leads.push({ id: `pick_${String(leads.length + 1).padStart(5, "0")}`, name: String(item.name ?? "").trim() || "there", phone });
    }
    if (!leads.length) throw new Error("没有可发送的选中客户。");
    leadsCache = { projectId: project.id, leads, rejected: [], sourcePath: "(next-flow picker)" };
    json(res, 200, { ok: true, project: project.id, loaded: leads.length });
  },

  // Bulk-set which flow a list of phones should get next. Paste a compiled list
  // (e.g. everyone who already received Flow 2) and set them to "Flow 3 - ..."
  // so they move to that group and get the right template on the next blast.
  "POST /api/next-flow/set-flow": async (req, res) => {
    if (!blastDsId) throw new Error("没有 Notion 配置。");
    const body = await readBody(req);
    const nextFlow = String(body.nextFlow ?? "").trim();
    const target = flowByLabel(nextFlow);
    if (!target) throw new Error(`未知的 Next Flow:${nextFlow}`);
    const prev = FLOW_SEQUENCE.find((f) => f.next === target.key); // the flow they just received

    const raw = Array.isArray(body.phones) ? body.phones : String(body.phones ?? "").split(/[\s,;]+/);
    const phones = [...new Set(raw.map(nfNormalizePhone).filter(Boolean))];
    if (!phones.length) throw new Error("没有有效的电话号码。");

    const props = {
      "Next Flow": { select: { name: target.label } },
      "Sequence Status": { select: { name: "Running" } },
      "Cohort Day": { select: { name: prev ? prev.cohortDay : "Day 0" } },
      "Follow Up Due": { date: { start: klTodayKL() } }, // due now so it shows in the picker
    };
    if (prev) props["Last Flow Sent"] = { select: { name: prev.label } };

    let set = 0, skippedStop = 0;
    const notFound = [];
    for (const phone of phones) {
      const q = await notion("POST", `/databases/${blastDsId}/query`, {
        filter: { property: "Phone", phone_number: { equals: phone } }, page_size: 1,
      });
      const page = q?.results?.[0];
      if (!page) { notFound.push(phone); continue; }
      if (page.properties?.["Stop Flag"]?.checkbox === true) { skippedStop += 1; continue; } // never re-activate opted-out
      await notion("PATCH", `/pages/${String(page.id).replace(/[^a-fA-F0-9]/g, "")}`, { properties: props });
      set += 1;
      await new Promise((r) => setTimeout(r, 220));
    }
    json(res, 200, { ok: true, nextFlow: target.label, set, skippedStop, notFound: notFound.length, notFoundSample: notFound.slice(0, 15) });
  },

  // Shift an ENTIRE group to another flow: everyone in <project> whose Next Flow
  // is <fromFlow> (and still Running) becomes <toFlow>. One click for "this whole
  // batch already got that flow — bump them all forward." No phone list needed.
  "POST /api/next-flow/set-group": async (req, res) => {
    if (!blastDsId) throw new Error("没有 Notion 配置。");
    const body = await readBody(req);
    const projectName = String(body.projectName ?? "").trim();
    const fromFlow = String(body.fromFlow ?? "").trim();
    const toFlow = String(body.toFlow ?? "").trim();
    const target = flowByLabel(toFlow);
    if (!projectName || !fromFlow) throw new Error("缺少 projectName / fromFlow。");
    if (!target) throw new Error(`未知的目标 Flow:${toFlow}`);
    const prev = FLOW_SEQUENCE.find((f) => f.next === target.key);

    const props = {
      "Next Flow": { select: { name: target.label } },
      "Sequence Status": { select: { name: "Running" } },
      "Cohort Day": { select: { name: prev ? prev.cohortDay : "Day 0" } },
      "Follow Up Due": { date: { start: klTodayKL() } },
    };
    if (prev) props["Last Flow Sent"] = { select: { name: prev.label } };

    let cursor, set = 0, skippedStop = 0;
    do {
      const q = await notion("POST", `/databases/${blastDsId}/query`, {
        filter: { and: [
          { property: "Project", select: { equals: projectName } },
          { property: "Next Flow", select: { equals: fromFlow } },
          { property: "Sequence Status", select: { equals: "Running" } },
        ] },
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      });
      for (const page of q?.results ?? []) {
        if (page.properties?.["Stop Flag"]?.checkbox === true) { skippedStop += 1; continue; }
        await notion("PATCH", `/pages/${String(page.id).replace(/[^a-fA-F0-9]/g, "")}`, { properties: props });
        set += 1;
        await new Promise((r) => setTimeout(r, 200));
      }
      cursor = q?.has_more ? q?.next_cursor : null;
    } while (cursor);

    json(res, 200, { ok: true, from: fromFlow, to: target.label, set, skippedStop });
  },

  // Read-only preview:看这一轮实际会发的模板文案(不写任何东西、不发送)。
  "POST /api/next-flow/preview-template": async (req, res) => {
    if (!blastDsId) throw new Error("没有 Notion 配置。");
    const body = await readBody(req);
    const projectName = String(body.projectName ?? "").trim();
    const flow = String(body.flow ?? "").trim();
    if (!projectName || !flow) throw new Error("缺少 projectName / flow。");
    const languages = await fetchFlowTemplates(projectName, flow);
    json(res, 200, { ok: true, projectName, flow, languages });
  },

  // Override the prepared run's message text/media with the templates tagged for
  // this Cohort Day + Project in Notion (Status = Active). Call AFTER prepare,
  // BEFORE start, so the blast sends the right flow's copy automatically.
  "POST /api/next-flow/apply-templates": async (req, res) => {
    if (!runner || !runner.state) throw new Error("请先 prepare。");
    if (runner.running) throw new Error("campaign 正在运行。");
    if (!blastDsId) throw new Error("没有 Notion 配置。");
    const body = await readBody(req);
    const projectName = String(body.projectName ?? "").trim();
    const flow = String(body.flow ?? "").trim();
    if (!projectName || !flow) throw new Error("缺少 projectName 或 flow。");

    const { byLang, overridden } = await applyNotionFlowTemplatesToState(runner.state, {
      projectName,
      flow,
      markFlowRun: true,
      credit: true,
    });
    await runner.saveState();
    const sample = runner.state.assignments[0];
    json(res, 200, {
      ok: true, flow, project: projectName,
      languages: Object.keys(byLang),
      overridden,
      twoPart: Object.values(byLang).some((v) => v.parts && Object.keys(v.parts).filter((n) => (v.parts[n] || []).length).length >= 2),
      sample: sample ? String(sample.part1Text || "").slice(0, 120) : "",
    });
  },

  // Mobile Preview: send the automatic sequence to one test phone only.
  // It does not create leads, update Notion, advance flow state, or credit counts.
  "POST /api/templates/mobile-preview": async (req, res) => {
    const body = await readBody(req);
    const projectName = String(body.projectName ?? "").trim();
    const phone = nfNormalizePhone(body.phone);
    const name = String(body.name ?? "").trim() || "there";
    const requestedLanguage = String(body.language ?? "EN").trim().toUpperCase();
    const requestedInstance = String(body.instanceName ?? "").trim();
    const includeTesting = body.includeTesting === true;
    if (!projectName) throw new Error("请选择项目。");
    if (!phone) throw new Error("电话号码格式不对。例子: 60123456789。");

    const opened = await openInstances(api);
    const sender = requestedInstance
      ? opened.find((item) => item.name === requestedInstance)
      : opened[0];
    if (!sender) throw new Error("没有已连接的 WhatsApp sender。先去主控制台扫码连接一个 sender。");

    const previewRunner = new CampaignRunner({ env });
    const flowResults = [];
    let sentMessages = 0;

    await previewRunner.sendText(
      sender.name,
      phone,
      `Mamba Mobile Preview\nProject: ${projectName}\nLanguage: ${requestedLanguage}\nSender: ${sender.name}\n\n下面会发送自动序列的真实模板。这个测试不会更新 Notion。`,
    );
    sentMessages += 1;
    await shortPause();

    for (const flow of FLOW_SEQUENCE) {
      const byLang = await fetchFlowTemplates(projectName, flow.label, { includeTesting });
      const picked = pickPreviewLanguage(byLang, requestedLanguage);
      if (!picked.parts.length) {
        flowResults.push({ flow: flow.label, cohortDay: flow.cohortDay, language: picked.language, sent: 0, skipped: true, draft: false });
        continue;
      }

      const draftTag = picked.usedTesting ? " · Testing 草稿" : "";
      await previewRunner.sendText(sender.name, phone, `${flow.label} (${flow.cohortDay})${draftTag}`);
      sentMessages += 1;
      await shortPause();

      let flowSent = 0;
      for (const part of picked.parts) {
        await previewRunner.sendMediaWithRetry(
          sender.name,
          phone,
          personalize(part.text || "", name),
          part.media || "",
        );
        sentMessages += 1;
        flowSent += 1;
        await shortPause();
      }
      flowResults.push({ flow: flow.label, cohortDay: flow.cohortDay, language: picked.language, sent: flowSent, skipped: false, draft: picked.usedTesting });
    }

    json(res, 200, {
      ok: true,
      projectName,
      phone,
      instanceName: sender.name,
      requestedLanguage,
      sentMessages,
      flows: flowResults,
      skippedFlows: flowResults.filter((f) => f.skipped).length,
      draftFlows: flowResults.filter((f) => f.draft).length,
      includeTesting,
    });
  },

  // Template & Flow dashboard: pull all templates for a project from Notion so the
  // page can show the flow map + which flow is missing an Active template.
  "GET /api/templates/list": async (req, res) => {
    const tplDbId = String(notionConfig?.databases?.templates ?? "").replace(/[^a-fA-F0-9]/g, "");
    if (!tplDbId) { json(res, 200, { ok: true, project: "", projects: [], templates: [] }); return; }
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const projectQ = String(url.searchParams.get("project") ?? "").trim();

    const all = [];
    let cursor;
    do {
      const body = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      const data = await notion("POST", `/databases/${tplDbId}/query`, body);
      for (const pg of data?.results ?? []) all.push(pg);
      cursor = data?.has_more ? data?.next_cursor : null;
    } while (cursor);

    // Projects come from the Project property's options (so a brand-new project
    // shows up even before it has any templates), falling back to distinct values.
    let projects = [];
    try {
      const db = await notion("GET", `/databases/${tplDbId}`);
      const p = db?.properties?.Project;
      projects = (p?.select?.options || p?.multi_select?.options || []).map((o) => o.name);
    } catch { /* fall back below */ }
    if (!projects.length) projects = all.map((p) => nfSelect(p, "Project")).filter(Boolean);
    projects = [...new Set(projects)].sort();
    const project = projectQ || resolveTemplateProject(notionConfig?.project) || projects[0] || "";
    const templates = [];
    for (const pg of all.filter((p) => nfSelect(p, "Project") === project)) {
      const imageName = nfText(pg, "Image Name");
      const mediaPath = resolveMedia(imageName); // "images/xxx" or ""
      let mediaExists = false;
      if (mediaPath) {
        try { await fs.access(path.join(paths.rootDir, "campaign-assets", mediaPath)); mediaExists = true; } catch { /* not local */ }
      }
      templates.push({
        pageId: pg.id,
        name: nfTitle(pg, "Template Name"),
        flowTopic: nfSelect(pg, "Flow Topic"),
        flowNo: pg.properties?.["Flow No"]?.number ?? null,
        language: nfSelect(pg, "Language"),
        part: nfSelect(pg, "Part"),
        status: nfSelect(pg, "Status"),
        imageName,
        hasImageName: !!imageName,
        mediaUrl: mediaExists ? `/${mediaPath}` : "",
        mediaExists,
        text: nfText(pg, "Message Text").slice(0, 4000),
        url: `https://www.notion.so/${String(pg.id).replace(/-/g, "")}`,
      });
    }
    json(res, 200, { ok: true, project, projects, templates });
  },

  // Edit a template's Message Text / Status straight from the panel (saves to Notion).
  "POST /api/templates/update": async (req, res) => {
    const body = await readBody(req);
    const pageId = String(body.pageId ?? "").replace(/[^a-fA-F0-9]/g, "");
    if (!pageId) throw new Error("缺少 pageId。");
    const props = {};
    if (typeof body.messageText === "string") props["Message Text"] = { rich_text: [{ text: { content: body.messageText.slice(0, 1900) } }] };
    if (body.status) props["Status"] = { select: { name: String(body.status) } };
    if (typeof body.imageName === "string") props["Image Name"] = { rich_text: [{ text: { content: String(body.imageName).slice(0, 300) } }] };
    if (body.flowTopic) props["Flow Topic"] = { select: { name: String(body.flowTopic).slice(0, 100) } };
    if (body.flowNo !== undefined && body.flowNo !== null && body.flowNo !== "") props["Flow No"] = { number: Number(body.flowNo) };
    if (body.part) props["Part"] = { select: { name: String(body.part).slice(0, 100) } };
    if (body.language) props["Language"] = { select: { name: String(body.language).slice(0, 20).toUpperCase() } };
    if (body.flowTopic) {
      const meta = flowMetaByTopic(body.flowTopic);
      if (meta) {
        props["Flow No"] = { number: meta.no };
        if (meta.day) props["Cohort Day"] = { select: { name: meta.day } };
      }
      const page = await notion("GET", `/pages/${pageId}`);
      const project = String(body.project || nfSelect(page, "Project") || "").trim();
      const language = String(body.language || nfSelect(page, "Language") || "EN").trim();
      const part = String(body.part || nfSelect(page, "Part") || "Part 1").trim();
      props["Template Name"] = { title: [{ text: { content: buildTemplateTitle({ project, flowTopic: body.flowTopic, language, part }).slice(0, 200) } }] };
    }
    if (!Object.keys(props).length) throw new Error("没有要更新的内容。");
    await notion("PATCH", `/pages/${pageId}`, { properties: props });
    json(res, 200, { ok: true });
  },

  // Create a new template row in Notion.
  "POST /api/templates/create": async (req, res) => {
    const tplDbId = String(notionConfig?.databases?.templates ?? "").replace(/[^a-fA-F0-9]/g, "");
    if (!tplDbId) throw new Error("没有 templates database。");
    const b = await readBody(req);
    const name = String(b.templateName ?? "").trim()
      || buildTemplateTitle({ project: b.project, flowTopic: b.flowTopic, language: b.language, part: b.part });
    const props = { "Template Name": { title: [{ text: { content: name.slice(0, 200) } }] } };
    if (b.project) props["Project"] = { select: { name: String(b.project) } };
    if (b.flowTopic) props["Flow Topic"] = { select: { name: String(b.flowTopic) } };
    if (b.language) props["Language"] = { select: { name: String(b.language) } };
    if (b.part) props["Part"] = { select: { name: String(b.part) } };
    const meta = flowMetaByTopic(b.flowTopic);
    if (meta) {
      props["Flow No"] = { number: meta.no };
      if (meta.day) props["Cohort Day"] = { select: { name: meta.day } };
    }
    if (typeof b.messageText === "string") props["Message Text"] = { rich_text: [{ text: { content: b.messageText.slice(0, 1900) } }] };
    props["Status"] = { select: { name: String(b.status || "Testing") } };
    if (b.imageName) props["Image Name"] = { rich_text: [{ text: { content: String(b.imageName).slice(0, 300) } }] };
    const page = await notion("POST", "/pages", { parent: { database_id: tplDbId }, properties: props });
    json(res, 200, { ok: true, pageId: page.id });
  },

  // Upload an image for a template: save it into campaign-assets/images/, register
  // the alias (Image Name -> filename), and stamp the template's Image Name in Notion.
  "POST /api/templates/upload-image": async (req, res) => {
    const b = await readBody(req);
    const imageName = String(b.imageName ?? "").trim();
    const rawName = String(b.filename ?? "").trim();
    const base64 = String(b.base64 ?? "");
    if (!imageName) throw new Error("缺少图片名(别名 key)。");
    if (!rawName || !base64) throw new Error("缺少文件。");
    const comma = base64.indexOf(",");
    const b64 = base64.startsWith("data:") && comma >= 0 ? base64.slice(comma + 1) : base64;
    // Prefix with the template's FULL pageId so two templates uploading files with
    // the same name (e.g. "Image 01.jpg" across flows) can never overwrite each
    // other. An 8-char slice was colliding and making one follow-up's image stick
    // to another's. Fall back to a random id if there's no pageId, so a nameless
    // upload also can't clobber an existing file.
    const prefix = String(b.pageId ?? "").replace(/[^a-fA-F0-9]/g, "")
      || Math.random().toString(16).slice(2, 12);
    const safe = prefix + "_" + rawName.replace(/[^A-Za-z0-9._-]/g, "_");
    const imagesDir = path.join(paths.rootDir, "campaign-assets", "images");
    await fs.mkdir(imagesDir, { recursive: true });
    await fs.writeFile(path.join(imagesDir, safe), Buffer.from(b64, "base64"));

    // Force the alias key to be UNIQUE to this template: strip any trailing [hexid]
    // the name may already carry (e.g. an Image Name copied from a duplicated
    // template) and append THIS template's own full pageId. Without this, two
    // templates sharing a name (common with Follow Ups) point at one alias, so
    // uploading to one silently overwrites the other's image. A non-hex suffix
    // like [v1] or [Assets] is preserved; only a real id suffix is replaced.
    const fullPid = String(b.pageId ?? "").replace(/[^a-fA-F0-9]/g, "");
    const baseKey = imageName.replace(/\s*\[[0-9a-fA-F]{6,}\]\s*$/, "").trim();
    const key = fullPid ? `${baseKey}[${fullPid}]` : imageName;

    imageAliases[key] = safe; // update in-memory map + the file
    await fs.writeFile(path.join(paths.rootDir, "campaign-assets", "image_aliases.json"), JSON.stringify(imageAliases, null, 2) + "\n");
    if (b.pageId) {
      const pageId = String(b.pageId).replace(/[^a-fA-F0-9]/g, "");
      await notion("PATCH", `/pages/${pageId}`, { properties: { "Image Name": { rich_text: [{ text: { content: key.slice(0, 300) } }] } } });
    }
    json(res, 200, { ok: true, filename: safe, imageName: key });
  },

  // Delete (archive) a template — moves it to Notion trash, recoverable there.
  "POST /api/templates/delete": async (req, res) => {
    const b = await readBody(req);
    const pageId = String(b.pageId ?? "").replace(/[^a-fA-F0-9]/g, "");
    if (!pageId) throw new Error("缺少 pageId。");
    await notion("PATCH", `/pages/${pageId}`, { archived: true });
    json(res, 200, { ok: true });
  },

  // Add a new project — registers it as a Project option in the 3 Notion DBs
  // (Templates, Blast Leads, Campaign Runs) so you can tag templates/leads with it.
  "POST /api/templates/add-project": async (req, res) => {
    const b = await readBody(req);
    const name = String(b.name ?? "").trim();
    if (!name) throw new Error("缺少项目名。");
    const dbs = {
      templates: String(notionConfig?.databases?.templates ?? "").replace(/[^a-fA-F0-9]/g, ""),
      blastLeads: String(notionConfig?.databases?.blastLeads ?? "").replace(/[^a-fA-F0-9]/g, ""),
      campaignRuns: String(notionConfig?.databases?.campaignRuns ?? "").replace(/[^a-fA-F0-9]/g, ""),
    };
    const result = {};
    for (const [k, id] of Object.entries(dbs)) {
      if (!id) { result[k] = "no db"; continue; }
      try { result[k] = await addProjectOption(id, name); }
      catch (e) { result[k] = "err: " + e.message; }
    }
    json(res, 200, { ok: true, name, result });
  },

  // Lead lookup: search Blast Leads by phone or name across ALL projects. Uses the
  // local snapshot (instant, offline, no rate limits) if synced; else queries Notion.
  "GET /api/lookup": async (req, res) => {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const q = String(url.searchParams.get("q") ?? "").trim();
    if (!q) { json(res, 200, { ok: true, q: "", results: [] }); return; }
    const digits = q.replace(/[^0-9]/g, "");
    const isPhone = digits.length >= 5 && /^[0-9+\s()-]+$/.test(q);
    const cache = await readBlastLeadsCache();
    let rows;
    if (cache.records.length) {
      if (isPhone) {
        const sig = digits.replace(/^0+/, "");
        rows = cache.records.filter((r) => (r.phone || "").replace(/[^0-9]/g, "").includes(sig));
      } else {
        const ql = q.toLowerCase();
        rows = cache.records.filter((r) => (r.name || "").toLowerCase().includes(ql));
      }
    } else {
      if (!blastDsId) throw new Error("没有 Notion 配置。");
      const filter = isPhone
        ? { property: "Phone", phone_number: { contains: digits.replace(/^0+/, "") } }
        : { property: "Name", title: { contains: q } };
      rows = [];
      let cursor;
      do {
        const data = await notion("POST", `/databases/${blastDsId}/query`, { filter, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
        for (const p of data?.results ?? []) rows.push(blastRowToRecord(p));
        cursor = data?.has_more ? data?.next_cursor : null;
      } while (cursor);
    }
    rows = rows.slice().sort((a, b) => String(b.lastBlastAt || b.firstBlastAt || "").localeCompare(String(a.lastBlastAt || a.firstBlastAt || "")));
    json(res, 200, { ok: true, q, isPhone, count: rows.length, results: rows, cached: cache.records.length > 0, syncedAt: cache.syncedAt || null });
  },

  // How fresh is the local snapshot?
  "GET /api/lookup/cache-info": async (_req, res) => {
    const c = await readBlastLeadsCache();
    json(res, 200, { ok: true, syncedAt: c.syncedAt, count: c.records.length });
  },

  // Pull the WHOLE Blast Leads DB into a local snapshot for fast batch matching.
  "POST /api/lookup/sync": async (_req, res) => {
    const payload = await syncBlastLeadsCache();
    json(res, 200, { ok: true, syncedAt: payload.syncedAt, count: payload.count });
  },

  // Drag an Excel in → match every row against the local snapshot. Shows which of
  // your leads were already blasted (which project + when) vs which are new.
  "POST /api/lookup/match": async (req, res) => {
    const b = await readBody(req);
    const base64 = String(b.base64 ?? "");
    if (!base64) throw new Error("缺少 Excel 文件。");
    const comma = base64.indexOf(",");
    const b64 = base64.startsWith("data:") && comma >= 0 ? base64.slice(comma + 1) : base64;
    const tmp = path.join(paths.rootDir, "campaign-data", `._match_${Date.now()}.xlsx`);
    await fs.mkdir(path.dirname(tmp), { recursive: true });
    await fs.writeFile(tmp, Buffer.from(b64, "base64"));
    let parsed;
    try { parsed = await importLeads(tmp); } finally { fs.unlink(tmp).catch(() => {}); }
    const cache = await readBlastLeadsCache();
    const byPhone = new Map();
    for (const r of cache.records) {
      const n = nfNormalizePhone(r.phone);
      if (!n) continue;
      if (!byPhone.has(n)) byPhone.set(n, []);
      byPhone.get(n).push(r);
    }
    const rows = parsed.leads.map((lead) => {
      const n = nfNormalizePhone(lead.phone);
      const matches = (byPhone.get(n) || []).slice().sort((a, b) => String(b.lastBlastAt || "").localeCompare(String(a.lastBlastAt || "")));
      return { name: lead.name, phone: lead.phone, matched: matches.length > 0, records: matches };
    });
    const matched = rows.filter((r) => r.matched).length;
    json(res, 200, {
      ok: true, syncedAt: cache.syncedAt, cacheCount: cache.records.length,
      total: rows.length, matched, fresh: rows.length - matched, rejected: parsed.rejected.length, rows,
    });
  },
};

// ---- Local Blast Leads snapshot (a cached copy of Notion for fast batch matching) ----
const BLAST_CACHE_PATH = () => path.join(paths.rootDir, "campaign-data", "blast_leads_cache.json");

function blastRowToRecord(p) {
  const pr = p.properties || {};
  return {
    project: nfSelect(p, "Project") || "",
    name: nfTitle(p, "Name") || "",
    phone: pr["Phone"]?.phone_number || "",
    firstBlastAt: pr["First Blast At"]?.date?.start || null,
    lastBlastAt: pr["Last Blast At"]?.date?.start || null,
    lastFlowSent: nfSelect(p, "Last Flow Sent") || "",
    nextFlow: nfSelect(p, "Next Flow") || "",
    cohortDay: nfSelect(p, "Cohort Day") || "",
    sequenceStatus: nfSelect(p, "Sequence Status") || "",
    status: nfSelect(p, "Status") || "",
    stopFlag: pr["Stop Flag"]?.checkbox === true,
    stopReason: nfText(p, "Stop Reason") || "",
    replyCount: pr["Reply Count"]?.number ?? null,
    lastReplyAt: pr["Last Reply At"]?.date?.start || null,
    aiCategory: nfSelect(p, "AI Category") || "",
    lastReplyText: nfText(p, "Last Reply Text") || "",
    senderInstance: nfSelect(p, "Sender Instance") || "",
    url: `https://www.notion.so/${String(p.id).replace(/-/g, "")}`,
  };
}

async function syncBlastLeadsCache() {
  if (!blastDsId) throw new Error("没有 Notion 配置。");
  const records = [];
  let cursor;
  do {
    const data = await notion("POST", `/databases/${blastDsId}/query`, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
    for (const p of data?.results ?? []) records.push(blastRowToRecord(p));
    cursor = data?.has_more ? data?.next_cursor : null;
  } while (cursor);
  const payload = { syncedAt: new Date().toISOString(), count: records.length, records };
  await fs.mkdir(path.dirname(BLAST_CACHE_PATH()), { recursive: true });
  await fs.writeFile(BLAST_CACHE_PATH(), JSON.stringify(payload));
  return payload;
}

async function readBlastLeadsCache() {
  try {
    const c = JSON.parse(await fs.readFile(BLAST_CACHE_PATH(), "utf8"));
    return { syncedAt: c.syncedAt || null, records: Array.isArray(c.records) ? c.records : [] };
  } catch { return { syncedAt: null, records: [] }; }
}

// Add a "Project" select/multi_select option to a Notion database, if missing.
async function addProjectOption(dbId, name) {
  const db = await notion("GET", `/databases/${dbId}`);
  const prop = db?.properties?.Project;
  if (!prop) return "no Project prop";
  const kind = prop.type; // "select" | "multi_select"
  const cfg = prop[kind];
  if (!cfg) return "not select";
  const opts = (cfg.options || []).slice();
  if (opts.some((o) => o.name === name)) return "existed";
  opts.push({ name });
  await notion("PATCH", `/databases/${dbId}`, { properties: { Project: { [kind]: { options: opts } } } });
  return "added";
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const key = `${req.method} ${url.pathname}`;

    if (req.method === "GET" && url.pathname === "/") {
      const html = await fs.readFile(path.join(appDir, "console.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (req.method === "GET" && url.pathname === "/numbers") {
      const html = await fs.readFile(path.join(appDir, "numbers.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (req.method === "GET" && url.pathname === "/next-flow") {
      const html = await fs.readFile(path.join(appDir, "next-flow.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (req.method === "GET" && url.pathname === "/templates") {
      const html = await fs.readFile(path.join(appDir, "templates.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (req.method === "GET" && url.pathname === "/lookup") {
      const html = await fs.readFile(path.join(appDir, "lookup.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    // Serve the design system (mamba.css + fonts). See docs/MAMBA_UI_BIBLE.md.
    if (req.method === "GET" && url.pathname.startsWith("/assets/")) {
      const rel = decodeURIComponent(url.pathname.slice("/assets/".length));
      if (rel.includes("..")) { json(res, 400, { ok: false, error: "Bad path" }); return; }
      const fp = path.join(appDir, "assets", rel);
      const types = { ".css": "text/css; charset=utf-8", ".woff2": "font/woff2", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };
      try {
        const buf = await fs.readFile(fp);
        res.writeHead(200, { "Content-Type": types[path.extname(fp)] || "application/octet-stream", "Cache-Control": "no-cache" });
        res.end(buf);
      } catch {
        res.writeHead(404); res.end("Not found");
      }
      return;
    }

    // Serve local campaign images so the template panel can show thumbnails.
    if (req.method === "GET" && url.pathname.startsWith("/images/")) {
      const fname = decodeURIComponent(url.pathname.slice("/images/".length)).replace(/[^A-Za-z0-9._-]/g, "_");
      try {
        const buf = await fs.readFile(path.join(paths.rootDir, "campaign-assets", "images", fname));
        const ext = (fname.split(".").pop() || "").toLowerCase();
        const ct = ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp"
          : ext === "mp4" ? "video/mp4" : ext === "mov" ? "video/quicktime" : "image/jpeg";
        res.writeHead(200, { "Content-Type": ct, "Cache-Control": "no-cache" });
        res.end(buf);
      } catch { res.writeHead(404); res.end("not found"); }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/export") {
      if (!runner || !runner.state) {
        json(res, 404, { ok: false, error: "没有可导出的 run。" });
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${runner.state.runId}.csv"`,
      });
      res.end("﻿" + buildCsv(runner.state));
      return;
    }

    const handler = handlers[key];
    if (!handler) {
      json(res, 404, { ok: false, error: "Not found" });
      return;
    }
    await handler(req, res);
  } catch (error) {
    json(res, 400, { ok: false, error: error.message });
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.log("");
    console.log(`Console 已经在 ${PORT} 端口运行了 —— 不用再启动一个。`);
    console.log(`直接打开 http://${HOST}:${PORT}/ 即可;所有页面(首轮群发/号码连接/模板/查找)共用这一个 server。`);
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
