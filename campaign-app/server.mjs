// Local web console for the WhatsApp campaign blaster (multi-project).
// Start with: node campaign-app/server.mjs   (or double-click "Campaign Console.command")

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { exec, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createApp } from "./app/createApp.mjs";
import { loadRuntime } from "./app/loadRuntime.mjs";
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
const envPath = path.join(paths.rootDir, "evolution-pilot", ".env");
function notionTokenValue() {
  return env.NOTION_API_KEY || env.NOTION_TOKEN || process.env.NOTION_API_KEY || process.env.NOTION_TOKEN || "";
}
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
  const token = notionTokenValue();
  if (!token) throw new Error("没有 Notion token。先运行 Set Notion Token。");
  const r = await fetch(`https://api.notion.com/v1${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Notion-Version": NOTION_VERSION },
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

function maskSecret(value) {
  const s = String(value || "");
  if (!s) return "";
  if (s.length <= 10) return `${s.slice(0, 2)}***${s.slice(-2)}`;
  return `${s.slice(0, 6)}...${s.slice(-4)}`;
}

async function writeEnvValues(values) {
  let text = "";
  try {
    text = await fs.readFile(envPath, "utf8");
  } catch {
    await fs.mkdir(path.dirname(envPath), { recursive: true });
  }
  const lines = text.split(/\r?\n/);
  for (const [key, value] of Object.entries(values)) {
    const clean = value === null ? null : String(value ?? "").trim();
    if (clean !== null && !clean) continue;
    const line = `${key}=${clean}`;
    let replaced = false;
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index].startsWith(`${key}=`)) {
        if (clean === null) {
          lines.splice(index, 1);
          index -= 1;
          replaced = true;
          continue;
        }
        lines[index] = line;
        replaced = true;
      }
    }
    if (clean !== null && !replaced) {
      if (lines.length && lines.at(-1) !== "") lines.push("");
      lines.push(line);
    }
    if (clean === null) {
      delete env[key];
      delete process.env[key];
    } else {
      env[key] = clean;
      process.env[key] = clean;
    }
  }
  await fs.writeFile(envPath, `${lines.join("\n").replace(/\n+$/, "")}\n`);
}

function isTelegramBotToken(value) {
  return /^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(String(value || "").trim());
}

function isTelegramChatId(value) {
  const s = String(value || "").trim();
  return /^-?\d{5,}$/.test(s) || /^@[A-Za-z0-9_]{5,}$/.test(s);
}

function assertTelegramBotToken(value) {
  if (!isTelegramBotToken(value)) {
    throw new Error("Telegram Bot Token 格式不对。Bot token 长这样: 123456789:ABC...，请放在 Bot Token 栏位。");
  }
}

function assertTelegramChatId(value) {
  const s = String(value || "").trim();
  if (!s) return;
  if (isTelegramBotToken(s)) {
    throw new Error("你把 Bot Token 放进 Chat ID 了。Chat ID 是数字；先对 bot 发 hi，再点「自动找 Chat ID」。");
  }
  if (/^[A-Za-z0-9_]+_bot$/i.test(s) || /^@[A-Za-z0-9_]+_bot$/i.test(s)) {
    throw new Error("Chat ID 不是 bot username。先在 Telegram 对这个 bot 发一句 hi，然后点「自动找 Chat ID」。");
  }
  if (!isTelegramChatId(s)) {
    throw new Error("Chat ID 格式不对。私人聊天通常是数字；group/channel 可以是 @username。");
  }
}

function settingsSnapshot() {
  const botToken = env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || "";
  const chatId = env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID || "";
  const botValid = isTelegramBotToken(botToken);
  const chatValid = isTelegramChatId(chatId);
  return {
    notion: {
      configured: Boolean(notionTokenValue()),
      masked: maskSecret(notionTokenValue()),
    },
    telegram: {
      botConfigured: botValid,
      botInvalid: Boolean(botToken && !botValid),
      botMasked: maskSecret(botToken),
      chatConfigured: chatValid,
      chatInvalid: Boolean(chatId && !chatValid),
      chatId: chatValid ? chatId : "",
    },
  };
}

async function telegramApi(method, token, body = {}) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const data = await response.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Telegram ${method}: ${JSON.stringify(data)}`);
  return data.result;
}

function telegramName(value) {
  if (!value) return "";
  const handle = value.username ? `@${value.username}` : "";
  const full = [value.first_name, value.last_name].filter(Boolean).join(" ").trim();
  return value.title || full || handle || String(value.id || "");
}

async function settingsIdentity() {
  const identity = {
    notion: { ok: false, label: "", error: "" },
    telegram: { botOk: false, botLabel: "", chatOk: false, chatLabel: "", error: "" },
  };

  const token = notionTokenValue();
  if (token) {
    try {
      const me = await notion("GET", "/users/me");
      identity.notion.ok = true;
      identity.notion.label = me?.name || me?.bot?.owner?.workspace_name || me?.id || "Notion integration";
    } catch (error) {
      identity.notion.error = error.message;
    }
  }

  const botToken = env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || "";
  const chatId = env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID || "";
  if (isTelegramBotToken(botToken)) {
    try {
      const bot = await telegramApi("getMe", botToken, {});
      identity.telegram.botOk = true;
      identity.telegram.botLabel = `${telegramName(bot)}${bot.username ? "" : ""}`;
    } catch (error) {
      identity.telegram.error = error.message;
    }
    if (isTelegramChatId(chatId)) {
      try {
        const chat = await telegramApi("getChat", botToken, { chat_id: chatId });
        identity.telegram.chatOk = true;
        const name = telegramName(chat);
        const username = chat.username ? `@${chat.username}` : "";
        identity.telegram.chatLabel = [name, username && username !== name ? username : "", chat.type ? `(${chat.type})` : ""]
          .filter(Boolean)
          .join(" ");
      } catch (error) {
        identity.telegram.error = error.message;
      }
    }
  }

  return identity;
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

const runtime = await loadRuntime({
  host: HOST,
  port: PORT,
  env,
  api,
  appDir,
  paths,
  handlers,
  settings: {
    env,
    snapshot: settingsSnapshot,
    identity: settingsIdentity,
    writeEnvValues,
    telegramApi,
    isTelegramChatId,
    assertTelegramBotToken,
    assertTelegramChatId,
  },
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
    readCache: readBlastLeadsCache,
    syncCache: syncBlastLeadsCache,
    queryNotionRows: async (filter) => {
      if (!blastDsId) throw new Error("没有 Notion 配置。");
      const rows = [];
      let cursor;
      do {
        const data = await notion("POST", `/databases/${blastDsId}/query`, { filter, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
        for (const page of data?.results ?? []) rows.push(blastRowToRecord(page));
        cursor = data?.has_more ? data?.next_cursor : null;
      } while (cursor);
      return rows;
    },
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
    setImageAlias: async (key, filename) => {
      imageAliases[key] = filename;
      await fs.writeFile(path.join(paths.rootDir, "campaign-assets", "image_aliases.json"), JSON.stringify(imageAliases, null, 2) + "\n");
    },
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
