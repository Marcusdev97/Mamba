// Mamba | Blaster Tracker
// Listens for Evolution API WhatsApp replies and writes a simple local CRM feed.
//
// SINGLE-RESPONDER RULE (缺口 4, 2026-07-05): the tracker RECORDS ONLY — stats,
// dashboard, Notion lead sync. It never sends a WhatsApp reply. The one and only
// module allowed to reply to a customer is brain_service.mjs. When the brain
// service owns the Evolution webhook, run this tracker with --no-webhook and the
// brain will forward every payload here so the dashboard keeps working.

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { paths, loadEnv, makeApi, listInstances } from "./campaign_core.mjs";
import { createNotionSync } from "./notion_sync.mjs";
import { normalizePhone, describeMessage, resolvePhone, collectMessages, senderFromPayload } from "./reply_intake.mjs";
import { makeTelegram, escapeHtml } from "./telegram.mjs";
import { classifyReplyText } from "./flow_sequence.mjs";
import { addLocalStop } from "./suppression.mjs";
import { makeHub } from "./telegram_hub.mjs";
import { resolveProjectLocal } from "./knowledge_layer.mjs";
import { resolveInboundProject } from "./lib/inbound-project-resolver.mjs";
import { createTelegramFilterService } from "./lib/telegram-filter-service.mjs";
import { createTrackerReliabilityService } from "./lib/tracker-reliability-service.mjs";
import { createNotionReplyQueueService } from "./lib/notion-reply-queue-service.mjs";
import { loadDeviceIdentity } from "./lib/device-identity.mjs";
import { filterInstancesForDevice, loadDeviceSenderPolicy } from "./lib/device-sender-policy.mjs";
import { createSystemLogService } from "./lib/system-log-service.mjs";
import { createConversationLogService } from "./lib/conversation-log-service.mjs";

const hub = makeHub();

const HOST = process.env.TRACKER_HOST ?? "0.0.0.0";
const PORT = Number(process.env.TRACKER_PORT ?? 8798);
const PUBLIC_URL = process.env.TRACKER_WEBHOOK_URL ?? `http://host.docker.internal:${PORT}/webhook/evolution`;
const LOCAL_URL = `http://127.0.0.1:${PORT}`;
const skipWebhookSetup = process.argv.includes("--no-webhook");
const openDashboard = process.argv.includes("--open");

const trackerDir = path.join(paths.dataDir, "tracker");
const eventsPath = path.join(trackerDir, "replies.jsonl");
const statusPath = path.join(trackerDir, "lead_status.json");
const csvPath = path.join(trackerDir, "replies.csv");

const env = await loadEnv();
const deviceIdentity = await loadDeviceIdentity(env, { dataDir: paths.dataDir });
const deviceSenderPolicy = await loadDeviceSenderPolicy({ dataDir: paths.dataDir, env });
const api = makeApi(env);
const telegramFilters = createTelegramFilterService({
  rootDir: paths.rootDir,
  getConnectedPhones: async () => filterInstancesForDevice(await listInstances(api), deviceSenderPolicy).map((item) => item.number),
});
const notion = await createNotionSync({
  env,
  onLog: (message) => console.log(message),
});
const tg = makeTelegram(env);

let startedAt = new Date().toISOString();
let leadIndex = new Map();
let lastEvents = [];
let allowedInstanceNames = new Set();
let lastWebhookRefreshAt = null;
let lastWebhookError = null;
const pushedPhones = new Set(); // unknown numbers manually pushed to Notion this session
const reliability = createTrackerReliabilityService({ trackerDir });
const trackerSystemLogs = createSystemLogService({ rootDir: paths.rootDir });
const conversationLog = createConversationLogService({ dataDir: paths.dataDir });
const notionReplyQueue = createNotionReplyQueueService({
  notion,
  reliability,
  onLog: (message) => console.log(message),
  onIssue: (issue) => trackerSystemLogs.write({
    level: issue.level,
    area: "notion",
    event: issue.code,
    message: [issue.message, `影响：${issue.impact}`, `处理：${issue.action}`].filter(Boolean).join(" "),
    context: issue,
  }),
});

// Click-to-WhatsApp ad leads: customers message in with a recognizable opening
// phrase (configured in campaign-assets/ad_triggers.json). When matched, we
// auto-create them in the Ads Leads Notion database.
let adPhrases = [];
async function loadAdTriggers() {
  try {
    const file = path.join(paths.dataDir, "..", "campaign-assets", "ad_triggers.json");
    const cfg = JSON.parse(await fs.readFile(file, "utf8"));
    adPhrases = (cfg.phrases ?? []).map((p) => String(p).toLowerCase().trim()).filter(Boolean);
  } catch {
    adPhrases = [];
  }
}
function isAdLead(text) {
  if (!text || !adPhrases.length) return false;
  const lower = String(text).toLowerCase();
  return adPhrases.some((phrase) => lower.includes(phrase));
}

// Keyword alerts: when a customer reply mentions something that needs YOU to step
// in (price / location / layout / viewing / loan — configurable), ping Telegram.
// The list lives in campaign-assets/alert_keywords.json and is re-read on every
// batch, so editing it takes effect without restarting the tracker.
const alertKeywordsPath = path.join(paths.dataDir, "..", "campaign-assets", "alert_keywords.json");
async function loadAlertConfig() {
  try {
    const cfg = JSON.parse(await fs.readFile(alertKeywordsPath, "utf8"));
    if (cfg?.enabled === false) return { enabled: false, groups: [] };
    const groups = (cfg?.groups ?? []).map((g) => ({
      label: String(g.label ?? "").trim() || "跟进",
      keywords: (g.keywords ?? []).map((k) => String(k).toLowerCase().trim()).filter(Boolean),
    })).filter((g) => g.keywords.length);
    return { enabled: true, groups };
  } catch {
    return { enabled: true, groups: [] };
  }
}
// Return the labels of every group the text matches (so one reply can flag e.g.
// both price AND viewing). Empty array = no alert.
function matchAlertGroups(text, cfg) {
  if (!cfg?.enabled || !text) return [];
  const lower = String(text).toLowerCase();
  return cfg.groups.filter((g) => g.keywords.some((k) => lower.includes(k))).map((g) => g.label);
}
async function sendKeywordAlert(event, labels) {
  // The Hub already forwards every inbound customer message to the Inbox.
  // Sending the same reply through the legacy chat would leak customer
  // content into the Ops/System channel and create a duplicate notification.
  if (hub.enabled) return;
  if (!tg.enabled || !tg.hasChatId || !labels.length) return;
  const filter = await telegramFilters.match(event.phone);
  if (filter.filtered) {
    console.log(`[telegram-filter] legacy alert skipped phone=${event.phone} reason=${filter.reason}`);
    return;
  }
  const who = event.name && event.name !== "Unknown" ? `${event.name} (${event.phone})` : event.phone;
  const message = [
    `🔔 <b>需要人工跟进</b> · ${escapeHtml(labels.join(" / "))}`,
    `👤 ${escapeHtml(who)}`,
    event.sender ? `📲 via ${escapeHtml(event.sender)}` : "",
    "",
    `💬 ${escapeHtml(event.text)}`,
  ].filter(Boolean).join("\n");
  await tg.send(message).catch((error) => console.log(`Telegram alert failed for ${event.phone}: ${error.message}`));
}
let stats = { totalReplies: 0, warm: 0, notInterested: 0, stop: 0, unknown: 0 };

async function ensureFiles() {
  await fs.mkdir(trackerDir, { recursive: true });
  try {
    await fs.access(eventsPath);
  } catch {
    await fs.writeFile(eventsPath, "");
  }
  try {
    await fs.access(csvPath);
  } catch {
    await fs.writeFile(csvPath, "\uFEFFtime,name,phone,status,category,instance,message\n");
  }
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function atomicWrite(filePath, value) {
  const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(tempPath, filePath);
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function classifyReply(text) {
  const verdict = classifyReplyText(text);
  return {
    status: verdict.status,
    category: verdict.aiCategory,
    aiCategory: verdict.aiCategory,
    nextAction: verdict.nextAction,
    sequenceStatus: verdict.sequenceStatus,
    route: verdict.route,
    signal: verdict.signal,
    stopFlag: verdict.stopFlag,
    suggestedReply: verdict.suggestedReply,
  };
}

async function refreshLeadIndex() {
  const next = new Map();
  const activeRun = await readJson(path.join(paths.dataDir, "active-run.json"), null);
  for (const job of activeRun?.assignments ?? []) {
    const phone = normalizePhone(job?.lead?.phone);
    if (phone) {
      next.set(phone, {
        name: job.lead.name,
        phone,
        leadId: job.lead.id,
        runId: activeRun.runId,
        campaignId: activeRun.campaignId,
        lastBlastStatus: job.status,
        sender: job.instanceName,
      });
    }
  }

  const leadsFile = await readJson(path.join(paths.dataDir, "leads.json"), null);
  for (const lead of leadsFile?.leads ?? []) {
    const phone = normalizePhone(lead.phone);
    if (phone && !next.has(phone)) {
      next.set(phone, { name: lead.name, phone, leadId: lead.id, runId: null, campaignId: null, lastBlastStatus: null, sender: null });
    }
  }

  leadIndex = next;
  return next;
}

async function loadStatus() {
  return readJson(statusPath, { updatedAt: null, leads: {} });
}

function countEvent(event) {
  stats.totalReplies += 1;
  if (event.signal === "GREEN" || event.status === "Warm" || event.status === "Appointment" || event.status === "Follow Up") stats.warm += 1;
  if (event.status === "Not Interested") stats.notInterested += 1;
  if (event.stopFlag || event.status === "Stop") stats.stop += 1;
  if (!event.leadId) stats.unknown += 1;
}

async function loadExistingEvents() {
  const lines = (await fs.readFile(eventsPath, "utf8")).split(/\r?\n/).filter(Boolean);
  const events = [];
  stats = { totalReplies: 0, warm: 0, notInterested: 0, stop: 0, unknown: 0 };
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      events.push(event);
      countEvent(event);
    } catch {
      // Ignore old/corrupt log lines; keep the tracker running.
    }
  }
  lastEvents = events.slice(-80).reverse();
}

async function saveEvent(event) {
  const status = await loadStatus();
  status.updatedAt = new Date().toISOString();
  status.leads[event.phone] = {
    name: event.name,
    phone: event.phone,
    status: event.status,
    category: event.category,
    replyText: event.text,
    replyAt: event.receivedAt,
    instanceName: event.instanceName,
    runId: event.runId,
    campaignId: event.campaignId,
    sender: event.sender,
  };
  await atomicWrite(statusPath, status);
  await fs.appendFile(eventsPath, `${JSON.stringify(event)}\n`);
  await fs.appendFile(csvPath, `${[
    event.receivedAt,
    event.name,
    event.phone,
    event.status,
    event.category,
    event.instanceName,
    event.text,
  ].map(csvCell).join(",")}\n`);

  // 写进本机数据库，jsonl 之外多一份查得动的纪录。写库失败不影响回复处理 ——
  // jsonl 已经落地了，之后跑 backfill_reply_conversations.mjs 可以补回来。
  await conversationLog.recordReply(event).catch((error) => {
    console.log(`[reply-tracker] 回复写入本机数据库失败 phone=${event.phone}: ${error.message}`);
    trackerSystemLogs.write({
      level: "warn",
      area: "local_database",
      event: "CONVERSATION_LOG_WRITE_FAILED",
      message: `客户回复已保存在 replies.jsonl，但写入本机数据库失败。影响：这条回复暂时查不到、也进不了 reply brain。处理：跑 node campaign-app/backfill_reply_conversations.mjs 补写。原始错误：${error.message}`,
      context: { phone: event.phone, messageId: event.id, code: error.code || "" },
    }).catch(() => {});
  });

  lastEvents.unshift(event);
  lastEvents = lastEvents.slice(0, 80);
  countEvent(event);
  await reliability.heartbeat({
    startedAt,
    lastReplyAt: event.receivedAt,
    webhookMode: skipWebhookSetup ? "forwarded" : "direct",
  }).catch((error) => console.log(`Tracker heartbeat write failed: ${error.message}`));

  // RED verdict -> block this phone locally RIGHT NOW (all projects, all
  // senders), even if the number isn't in Notion yet (stranger / cross-PC lag).
  // Notion flags follow via upsertLeadReply -> stopAllRowsForPhone.
  if (event.stopFlag) {
    try {
      await addLocalStop(event.phone, event.route);
      console.log(`🔴 ${event.phone} added to global STOP list (${event.route}).`);
    } catch (error) {
      console.log(`Local STOP add failed for ${event.phone}: ${error.message}`);
    }
  }

  // Telegram Hub 统一收件箱: 全量转发 (SPAM 除外), 按盘进 topic。失败只记 log,
  // 绝不拖垮 saveEvent — 本地 jsonl 才是 source of truth。
  const telegramFilter = await telegramFilters.match(event.phone);
  if (telegramFilter.filtered) {
    console.log(`[telegram-filter] inbox skipped phone=${event.phone} reason=${telegramFilter.reason}`);
  } else if (hub.enabled) {
    resolveInboundProject(event, {
      resolveLocal: (phone) => resolveProjectLocal(phone, event.instanceName),
      notion,
      onLog: (message) => console.log(message),
    }).then(({ project, source }) => {
      console.log(`[hub] route phone=${event.phone} project=${project || "Unknown"} source=${source}`);
      return hub.postInbound(event, project);
    }).catch((error) => {
      console.log(`[hub] inbox card failed for ${event.phone}: ${error.message}`);
    });
  }

  // Routing:
  //  - Ad leads (matched the ad opening phrase) -> auto-create in Ads Leads DB.
  //  - Known blast leads -> auto-sync/amend in Blast Leads DB.
  //  - Numbers missing from this PC's local files are checked against Notion.
  //    This matters when another PC performed the blast. Existing Blast Leads
  //    are updated, while truly unknown numbers are still never auto-created.
  if (event.adLead) {
    await notion.upsertAdLead(event).catch((error) => {
      console.log(`Ad-lead Notion failed for ${event.phone}: ${error.message}`);
    });
  } else {
    await syncBlastReplyToNotion(event);
  }
}

async function syncBlastReplyToNotion(event) {
  const result = await notionReplyQueue.submit(event);
  if (result?.matched) {
    pushedPhones.add(event.phone);
    if (!event.leadId) console.log(`Notion matched cross-PC lead ${event.phone}; reply updated.`);
  }
  return result;
}

function eventFromMessage(payload, message) {
  const key = message?.key ?? {};
  if (key.fromMe) return null;

  // Ignore group chats; accept 1:1 chats including privacy-id (@lid) replies.
  const remoteJid = String(key.remoteJid ?? message?.remoteJid ?? "");
  if (remoteJid.includes("@g.us")) return null;

  const phone = resolvePhone(message);
  if (!phone) return null;

  // Count any inbound message (text OR media) as a reply.
  const text = describeMessage(message);

  const lead = leadIndex.get(phone) ?? { name: message.pushName ?? "Unknown", phone };
  const category = classifyReply(text);
  const timestamp = Number(message.messageTimestamp ?? Date.now());
  const receivedAt = new Date(timestamp < 100000000000 ? timestamp * 1000 : timestamp).toISOString();

  return {
    id: key.id ?? `${phone}_${Date.now()}`,
    receivedAt,
    deviceId: deviceIdentity.id,
    deviceName: deviceIdentity.name,
    instanceName: senderFromPayload(payload),
    name: lead.name ?? message.pushName ?? "Unknown",
    phone,
    leadId: lead.leadId ?? null,
    runId: lead.runId ?? null,
    campaignId: lead.campaignId ?? null,
    sender: lead.sender ?? null,
    status: category.status,
    category: category.category,
    aiCategory: category.aiCategory,
    nextAction: category.nextAction,
    sequenceStatus: category.sequenceStatus,
    route: category.route,
    signal: category.signal,
    stopFlag: category.stopFlag,
    suggestedReply: category.suggestedReply,
    text,
    adLead: isAdLead(text),
  };
}

async function processWebhook(payload) {
  const payloadInstance = senderFromPayload(payload);
  if (deviceSenderPolicy.configured && (!payloadInstance || !allowedInstanceNames.has(payloadInstance))) {
    console.log(`[DEVICE_SENDER_BLOCKED] ignored webhook from ${payloadInstance || "unknown instance"}; expected phone ${deviceSenderPolicy.expectedSenderPhone}.`);
    return [];
  }
  await refreshLeadIndex();
  const alertCfg = await loadAlertConfig(); // re-read each batch so edits apply live
  const messages = collectMessages(payload);
  const seen = new Set();
  const saved = [];

  for (const message of messages) {
    const event = eventFromMessage(payload, message);
    if (!event || seen.has(event.id)) continue;
    seen.add(event.id);
    await saveEvent(event);
    saved.push(event);
    console.log(`[${event.category}] ${event.name} (${event.phone}) -> ${event.text}`);

    // Keyword filter: high-intent reply -> Telegram ping so you can take over.
    const labels = matchAlertGroups(event.text, alertCfg);
    if (labels.length) {
      console.log(`  🔔 alert (${labels.join(", ")}) -> Telegram`);
      await sendKeywordAlert(event, labels);
    }
  }

  return saved;
}

// Evolution API v2 wants the settings wrapped in a "webhook" object with
// renamed fields (byEvents/base64); v1 used a flat body. Try v2 first, fall
// back to v1 so it works across Evolution versions.
async function setInstanceWebhook(instanceName) {
  const events = ["MESSAGES_UPSERT"];
  const v2 = { webhook: { enabled: true, url: PUBLIC_URL, byEvents: false, base64: false, events } };
  const v1 = { enabled: true, url: PUBLIC_URL, webhookByEvents: false, webhookBase64: false, events };
  const endpoint = `/webhook/set/${encodeURIComponent(instanceName)}`;
  try {
    return await api(endpoint, { method: "POST", body: JSON.stringify(v2) });
  } catch (error) {
    if (!/HTTP 400/.test(error.message)) throw error;
    return await api(endpoint, { method: "POST", body: JSON.stringify(v1) });
  }
}

async function configureWebhookForOpenInstances() {
  const instances = await listInstances(api);
  const open = filterInstancesForDevice(instances.filter((item) => item.status === "OPEN"), deviceSenderPolicy);
  allowedInstanceNames = new Set(open.map((item) => item.name));
  for (const item of open) {
    await setInstanceWebhook(item.name);
  }
  return open;
}

async function refreshWebhookConnection() {
  if (skipWebhookSetup) {
    const instances = await listInstances(api);
    const open = filterInstancesForDevice(instances.filter((item) => item.status === "OPEN"), deviceSenderPolicy);
    allowedInstanceNames = new Set(open.map((item) => item.name));
    lastWebhookRefreshAt = new Date().toISOString();
    lastWebhookError = null;
    return { mode: "forwarded", connected: open.length, instances: open.map((item) => item.name) };
  }
  try {
    const open = await configureWebhookForOpenInstances();
    lastWebhookRefreshAt = new Date().toISOString();
    lastWebhookError = null;
    return { mode: "direct", connected: open.length, instances: open.map((item) => item.name) };
  } catch (error) {
    lastWebhookRefreshAt = new Date().toISOString();
    lastWebhookError = error.message;
    throw error;
  }
}

function htmlPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mamba | Blaster Tracker</title>
  <style>
    :root {
      --bg:#0f1115; --panel:#181b21; --panel-2:#1f232b; --panel-3:#262b35;
      --line:#2a2f39; --line-2:#3a414e; --text:#e8eaed; --muted:#9aa3b2;
      --green:#25d366; --green-d:#1da851; --on-green:#04220f; --blue:#4a9eff;
      --amber:#f5b342; --red:#ff5d5d; --green-bg:rgba(37,211,102,.16);
      --blue-bg:rgba(74,158,255,.16); --amber-bg:rgba(245,179,66,.18); --red-bg:rgba(255,93,93,.16);
      --radius:9px; --radius-l:12px; --radius-full:999px;
      --font:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
      --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--text); font-family:var(--font); font-size:14px; line-height:1.5; }
    .wrap { max-width:1320px; margin:0 auto; padding:24px 20px 64px; }
    header.top { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:20px; }
    h1 { margin:0; font-size:22px; line-height:1.25; font-weight:700; }
    h2 { margin:0 0 12px; font-size:13px; text-transform:uppercase; letter-spacing:.8px; color:var(--muted); }
    .muted { color:var(--muted); }
    .nav { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
    .cards { display:grid; grid-template-columns: repeat(4, minmax(120px, 1fr)); gap:12px; margin-bottom:16px; }
    .card { background:var(--panel); border:1px solid var(--line); border-radius:var(--radius-l); padding:16px; margin-bottom:16px; }
    .stat { background:var(--panel-2); border:1px solid var(--line); border-radius:var(--radius); padding:12px; }
    .stat span { display:block; color:var(--muted); font-size:12px; }
    .num { font-size:24px; font-weight:800; }
    .tablebox { overflow:auto; border:1px solid var(--line); border-radius:var(--radius-l); }
    table { width:100%; min-width:1080px; border-collapse:collapse; font-size:13px; }
    th, td { text-align:left; padding:10px 12px; border-bottom:1px solid var(--line); vertical-align:top; }
    th { color:var(--muted); font-size:11.5px; text-transform:uppercase; letter-spacing:.5px; font-weight:700; background:rgba(255,255,255,.02); }
    tbody tr:hover { background:rgba(255,255,255,.025); }
    .pill { display:inline-flex; align-items:center; gap:4px; padding:2px 8px; border-radius:var(--radius-full); font-size:12px; font-weight:750; border:1px solid var(--line); background:var(--panel-2); color:var(--muted); white-space:nowrap; }
    .pill.green { background:var(--green-bg); color:var(--green); border-color:rgba(37,211,102,.35); }
    .pill.red { background:var(--red-bg); color:var(--red); border-color:rgba(255,93,93,.35); }
    .pill.amber { background:var(--amber-bg); color:var(--amber); border-color:rgba(245,179,66,.35); }
    .pill.blue { background:var(--blue-bg); color:var(--blue); border-color:rgba(74,158,255,.35); }
    .btn { appearance:none; padding:10px 16px; border-radius:var(--radius); border:1px solid var(--line); background:var(--panel-2); color:var(--text); font:inherit; font-weight:650; cursor:pointer; }
    .btn:hover { border-color:var(--line-2); background:var(--panel-3); }
    .btn:disabled { opacity:.5; cursor:not-allowed; }
    .btn.primary { background:var(--green); border-color:var(--green); color:var(--on-green); }
    .btn.primary:hover { background:var(--green-d); border-color:var(--green-d); }
    .btn.danger { background:transparent; border-color:var(--red); color:var(--red); }
    .btn.danger:hover { background:var(--red-bg); }
    .btn.sm { padding:5px 10px; font-size:12px; }
    .toolbar { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:12px; }
    .message { max-width:420px; white-space:pre-wrap; word-break:break-word; color:#cbd5e1; }
    .phone { color:var(--muted); font-family:var(--mono); font-size:12px; }
    input[type=checkbox] { width:16px; height:16px; accent-color:var(--green); }
    @media (max-width: 820px) { .cards { grid-template-columns:repeat(2, 1fr); } header.top { align-items:flex-start; flex-direction:column; } }
  </style>
</head>
<body>
  <div class="wrap">
    <header class="top">
      <div>
        <h1>Mamba | Blaster Tracker</h1>
        <div class="muted">Listening for WhatsApp replies · tracker records only, no auto-reply</div>
      </div>
      <div class="nav">
        <a class="btn" href="http://127.0.0.1:8787/" style="text-decoration:none">Campaign Console</a>
        <a class="btn" href="http://127.0.0.1:8787/conversations" style="text-decoration:none">Conversations</a>
      </div>
    </header>
    <section class="cards">
      <div class="stat"><span>Total Replies</span><div id="total" class="num">0</div></div>
      <div class="stat"><span>Warm / Intent</span><div id="warm" class="num">0</div></div>
      <div class="stat"><span>Stop / Reject</span><div id="stop" class="num">0</div></div>
      <div class="stat"><span>Unknown</span><div id="unknown" class="num">0</div></div>
    </section>
    <section class="card">
      <h2>Tracker Status</h2>
      <div class="muted" id="meta"></div>
    </section>
    <section class="card">
      <h2>Recent Replies</h2>
      <div class="toolbar">
        <button class="btn primary" onclick="pushSelected(this)">选中加进 Notion</button>
        <button class="btn danger" onclick="deleteSelected(this)">删除选中</button>
        <span class="muted" id="selinfo">未选</span>
      </div>
      <div class="tablebox">
        <table>
          <thead><tr><th><input type="checkbox" id="chkall" onclick="toggleAll(this)"></th><th>Time</th><th>Name</th><th>Phone</th><th>Status</th><th>Route</th><th>Next Action</th><th>Message</th><th>Notion</th></tr></thead>
          <tbody id="rows"></tbody>
        </table>
      </div>
    </section>
  </div>
  <script>
    const fmt = (iso) => new Date(iso).toLocaleString("en-MY", { hour12: false });
    const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[char]);
    async function refresh() {
      const res = await fetch("/api/status");
      const data = await res.json();
      document.getElementById("total").textContent = data.stats.totalReplies;
      document.getElementById("warm").textContent = data.stats.warm;
      document.getElementById("stop").textContent = (data.stats.stop || 0) + (data.stats.notInterested ? " / " + data.stats.notInterested : "");
      document.getElementById("unknown").textContent = data.stats.unknown || 0;
      document.getElementById("meta").textContent = "Leads indexed: " + data.leadsIndexed + " · Notion sync: " + (data.notionSync ? "ON" : "OFF") + " · Started: " + fmt(data.startedAt);
      const checked = new Set([...document.querySelectorAll(".rowchk:checked")].map((c) => c.value));
      document.getElementById("rows").innerHTML = data.events.map((event) => {
        const action = event.adLead
          ? '<span class="pill blue">Ad → Notion</span>'
          : event.known
            ? '<span class="muted">auto</span>'
            : event.pushed
              ? '<span class="pill blue">Added</span>'
              : '<button class="btn sm primary" onclick="push(\\'' + esc(event.phone) + '\\', this)">Add to Notion</button>';
        const id = esc(event.id);
        const chk = checked.has(String(event.id)) ? " checked" : "";
        const tone = event.signal === "RED" || event.status === "Stop" || event.status === "Not Interested"
          ? "red"
          : event.signal === "GREEN" || event.status === "Warm" || event.status === "Appointment" || event.status === "Follow Up"
            ? "green"
            : "amber";
        return \`
        <tr>
          <td><input type="checkbox" class="rowchk" value="\${id}" onchange="updateSel()"\${chk}></td>
          <td>\${fmt(event.receivedAt)}</td>
          <td>\${esc(event.name)}</td>
          <td><div class="phone">\${esc(event.phone)}</div><div class="muted">\${esc(event.instanceName || "-")}</div></td>
          <td><span class="pill \${tone}">\${esc(event.status || "-")}</span></td>
          <td>\${esc(event.route || "-")}</td>
          <td>\${esc(event.nextAction || "-")}</td>
          <td><div class="message">\${esc(event.text)}</div></td>
          <td>\${action}</td>
        </tr>\`;
      }).join("");
      updateSel();
    }
    function selectedIds() {
      return [...document.querySelectorAll(".rowchk:checked")].map((c) => c.value);
    }
    function updateSel() {
      const n = selectedIds().length;
      document.getElementById("selinfo").textContent = n ? ("已选 " + n) : "未选";
    }
    function toggleAll(box) {
      document.querySelectorAll(".rowchk").forEach((c) => (c.checked = box.checked));
      updateSel();
    }
    async function pushSelected(btn) {
      const ids = selectedIds();
      if (!ids.length) { alert("先勾选要加进 Notion 的行。"); return; }
      btn.disabled = true;
      try {
        const res = await fetch("/api/push-bulk", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) });
        const data = await res.json().catch(() => ({}));
        if (!data.ok) throw new Error(data.error || ("HTTP " + res.status));
        let msg = "已加进 Notion: " + data.pushed + " 个";
        if (data.failed && data.failed.length) msg += "\\n失败 " + data.failed.length + " 个:\\n" + data.failed.slice(0, 3).join("\\n");
        alert(msg);
        refresh();
      } catch (e) { alert("批量加 Notion 失败: " + e.message); }
      finally { btn.disabled = false; }
    }
    async function deleteSelected(btn) {
      const ids = selectedIds();
      if (!ids.length) { alert("先勾选要删除的行。"); return; }
      if (!confirm("从面板删除选中的 " + ids.length + " 行?(只删面板记录,不动 Notion / WhatsApp)")) return;
      btn.disabled = true;
      try {
        const res = await fetch("/api/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) });
        const data = await res.json().catch(() => ({}));
        if (!data.ok) throw new Error(data.error || ("HTTP " + res.status));
        refresh();
      } catch (e) { alert("删除失败: " + e.message); }
      finally { btn.disabled = false; }
    }
    async function push(phone, btn) {
      if (btn) { btn.disabled = true; btn.textContent = "Adding…"; }
      try {
        const res = await fetch("/api/push", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone }),
        });
        const data = await res.json().catch(() => ({}));
        if (!data.ok) throw new Error(data.error || ("HTTP " + res.status));
        refresh();
      } catch (error) {
        alert("Notion push 失败: " + error.message);
        if (btn) { btn.disabled = false; btn.textContent = "Add to Notion"; }
      }
    }
    refresh();
    setInterval(refresh, 3000);
  </script>
</body>
</html>`;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

// Rewrite replies.jsonl, dropping any event whose id is in idSet, so deleted
// rows don't come back when the tracker restarts. (replies.csv is left as a
// full audit log.)
async function rewriteEventsFile(idSet) {
  let lines = [];
  try {
    lines = (await fs.readFile(eventsPath, "utf8")).split(/\r?\n/).filter(Boolean);
  } catch {
    return;
  }
  const kept = lines.filter((line) => {
    try { return !idSet.has(String(JSON.parse(line).id)); } catch { return true; }
  });
  await fs.writeFile(eventsPath, kept.length ? `${kept.join("\n")}\n` : "");
}

await ensureFiles();
await loadExistingEvents();
await refreshLeadIndex();
await loadAdTriggers();
await reliability.init();

// Recover a reply that arrived just before the tracker/server was restarted.
// Older unmatched messages remain available through Conversations > Refresh Replies.
const retryCutoff = Date.now() - 15 * 60 * 1000;
for (const event of lastEvents) {
  if (!event.adLead && new Date(event.receivedAt || 0).getTime() >= retryCutoff) {
    const alreadyQueued = reliability.values().some((item) => String(item.event?.id) === String(event.id));
    if (!alreadyQueued) await reliability.enqueue(event, { attempts: 0 });
  }
}
await reliability.heartbeat({
  startedAt,
  lastReplyAt: lastEvents[0]?.receivedAt || null,
  webhookMode: skipWebhookSetup ? "forwarded" : "direct",
});
const heartbeatTimer = setInterval(() => {
  reliability.heartbeat({
    startedAt,
    lastReplyAt: lastEvents[0]?.receivedAt || null,
    webhookMode: skipWebhookSetup ? "forwarded" : "direct",
  }).catch((error) => console.log(`Tracker heartbeat write failed: ${error.message}`));
}, 15_000);
heartbeatTimer.unref();
const notionRetryTimer = setInterval(() => {
  notionReplyQueue.retryPending().catch((error) => {
    const message = `Notion 重试协调器发生内部错误。影响：等待中的回复暂时不会同步，但仍保存在本机。处理：重启 Mamba；如果再次出现，请在 System Logs 搜索 NOTION_RETRY_COORDINATOR_FAILED。原始错误：${error.message}`;
    console.log(`[reply-tracker:error] ${message}`);
    trackerSystemLogs.write({
      level: "error",
      area: "notion",
      event: "NOTION_RETRY_COORDINATOR_FAILED",
      message,
      context: { details: error.message, pending: notionReplyQueue.snapshot() },
    }).catch(() => {});
  });
}, 15_000);
notionRetryTimer.unref();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, LOCAL_URL);
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(htmlPage());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/status") {
      const events = lastEvents.map((event) => ({
        ...event,
        known: Boolean(event.leadId),
        pushed: pushedPhones.has(event.phone),
      }));
      const reliabilityState = reliability.snapshot();
      const notionQueue = notionReplyQueue.snapshot();
      json(res, 200, {
        ok: true,
        service: "reply-tracker",
        port: PORT,
        webhookUrl: PUBLIC_URL,
        webhookMode: skipWebhookSetup ? "forwarded" : "direct",
        webhookRefreshAt: lastWebhookRefreshAt,
        webhookError: lastWebhookError,
        connectedInstances: [...allowedInstanceNames],
        startedAt,
        stats,
        leadsIndexed: leadIndex.size,
        notionSync: notion.enabled,
        notionPending: reliabilityState.pendingCount,
        notionQueue,
        notionIssues: reliabilityState.pending.slice(0, 20).map((item) => ({
          id: item.event?.id,
          phone: item.event?.phone,
          status: item.status,
          errorCode: item.errorCode,
          message: item.lastError,
          help: item.help,
          attempts: item.attempts,
          nextRetryAt: item.nextRetryAt,
          queuedAt: item.queuedAt,
        })),
        heartbeat: reliabilityState.heartbeat,
        events,
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/refresh") {
      try {
        const webhook = await refreshWebhookConnection();
        await reliability.heartbeat({
          startedAt,
          webhookMode: skipWebhookSetup ? "forwarded" : "direct",
        });
        json(res, 200, { ok: true, service: "reply-tracker", port: PORT, webhook });
      } catch (error) {
        json(res, 503, {
          ok: false,
          service: "reply-tracker",
          port: PORT,
          error: `WhatsApp webhook 刷新失败：${error.message}`,
        });
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/push") {
      const body = await readBody(req);
      const phone = String(body.phone ?? "");
      const event = lastEvents.find((item) => item.phone === phone);
      if (!event) { json(res, 404, { ok: false, error: "找不到这个号码的回复。" }); return; }
      if (!notion.enabled) { json(res, 400, { ok: false, error: "Notion sync 没开(缺 NOTION_API_KEY)。" }); return; }
      try {
        await notion.upsertLeadReply({ ...event, force: true });
        await reliability.remove(event.id);
        await notionReplyQueue.syncPhone(event.phone, { force: true, reason: "manual_push" });
        pushedPhones.add(phone);
        json(res, 200, { ok: true });
      } catch (error) {
        json(res, 400, { ok: false, error: error.message });
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/push-bulk") {
      const body = await readBody(req);
      const idSet = new Set((body.ids ?? []).map(String));
      if (!notion.enabled) { json(res, 400, { ok: false, error: "Notion sync 没开(缺 NOTION_API_KEY)。" }); return; }
      let pushed = 0;
      const failed = [];
      // Push whatever was selected — known OR unknown. Ad leads go to the Ads DB,
      // everyone else to Blast Leads (upsertLeadReply amends known / creates new).
      // This also doubles as a "retry" if an earlier auto-sync failed.
      for (const event of lastEvents) {
        if (!idSet.has(String(event.id))) continue;
        try {
          if (event.adLead) await notion.upsertAdLead({ ...event });
          else await notion.upsertLeadReply({ ...event, force: true });
          await reliability.remove(event.id);
          if (!event.adLead) await notionReplyQueue.syncPhone(event.phone, { force: true, reason: "manual_bulk_push" });
          pushedPhones.add(event.phone);
          pushed += 1;
        } catch (error) {
          failed.push(`${event.phone}: ${error.message}`);
        }
      }
      json(res, 200, { ok: true, pushed, failed });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/delete") {
      const body = await readBody(req);
      const idSet = new Set((body.ids ?? []).map(String));
      const removed = lastEvents.filter((event) => idSet.has(String(event.id)));
      lastEvents = lastEvents.filter((event) => !idSet.has(String(event.id)));
      for (const event of removed) {
        stats.totalReplies = Math.max(0, stats.totalReplies - 1);
        if (event.signal === "GREEN" || event.status === "Warm" || event.status === "Appointment" || event.status === "Follow Up") stats.warm = Math.max(0, stats.warm - 1);
        if (event.status === "Not Interested") stats.notInterested = Math.max(0, stats.notInterested - 1);
        if (event.stopFlag || event.status === "Stop") stats.stop = Math.max(0, stats.stop - 1);
        if (!event.leadId) stats.unknown = Math.max(0, stats.unknown - 1);
      }
      await rewriteEventsFile(idSet); // drop from replies.jsonl so it stays gone after restart
      json(res, 200, { ok: true, removed: removed.length });
      return;
    }
    if (req.method === "POST" && url.pathname === "/webhook/evolution") {
      const payload = await readBody(req);
      const saved = await processWebhook(payload);
      json(res, 200, { ok: true, saved: saved.length });
      return;
    }
    json(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    console.log(`Tracker error: ${error.message}`);
    json(res, 400, { ok: false, error: error.message });
  }
});

server.listen(PORT, HOST, async () => {
  console.log("Mamba | Blaster Tracker");
  console.log("=======================");
  console.log(`Dashboard: ${LOCAL_URL}`);
  console.log(`Webhook URL: ${PUBLIC_URL}`);
  console.log(`Data folder: ${trackerDir}`);
  console.log(`Notion sync: ${notion.enabled ? "ON" : "OFF (set NOTION_API_KEY to enable)"}`);
  console.log("");
  if (openDashboard) execFile("/usr/bin/open", [LOCAL_URL], () => {});

  try {
    if (skipWebhookSetup) {
      const instances = await listInstances(api);
      const open = filterInstancesForDevice(instances.filter((item) => item.status === "OPEN"), deviceSenderPolicy);
      allowedInstanceNames = new Set(open.map((item) => item.name));
      console.log("Webhook auto-setup skipped for this run.");
      if (deviceSenderPolicy.configured) console.log(`Device sender lock: ${deviceSenderPolicy.expectedSenderPhone} (${open.map((item) => item.name).join(", ") || "not OPEN"})`);
      console.log("\nWaiting for customer replies. Press Control+C to stop.");
      return;
    }

    const webhook = await refreshWebhookConnection();
    if (webhook.connected === 0) {
      console.log("No OPEN WhatsApp numbers found. Start/scan a number, then restart this tracker.");
    } else {
      console.log(`Listening on: ${webhook.instances.join(", ")} · dynamic port ${PORT}`);
    }
  } catch (error) {
    console.log(`Could not auto-connect webhook: ${error.message}`);
    console.log("Keep this window open, then restart once Evolution API is online.");
  }

  console.log("\nWaiting for customer replies. Press Control+C to stop.");
});
