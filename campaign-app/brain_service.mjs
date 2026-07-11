// brain_service.mjs — the Sales Brain (Task B6). THE single responder (缺口 4).
//
// Data flow (Phase 1 — AI suggests, human approves, nothing complex auto-sends):
//
//   Evolution webhook (this service owns it)
//     -> forward raw payload to blaster_tracker (stats/dashboard only, 缺口 4)
//     -> global suppression check (STOP list -> log, never reply)
//     -> flow_sequence classifyReplyText (12 routes)
//        ├─ simple route  -> canned suggestedReply sent immediately
//        ├─ complaint     -> silent + Telegram alert (人工接管)
//        └─ complex route -> Claude drafts when ANTHROPIC_API_KEY exists;
//                            otherwise classifier suggestedReply is used as a
//                            rule-only draft
//                            -> Telegram draft + [✅照发 | ✏️改后发 | 🙋接管]
//                            -> your button decides -> Evolution sends
//                            -> Mamba | AI Reply Log records the loop
//
// Needs in evolution-pilot/.env:
//   AUTHENTICATION_API_KEY  (Evolution — already there)
//   NOTION_API_KEY          (already there)
//   TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID  (run Setup Telegram)
//   ANTHROPIC_API_KEY       optional; without it brain runs Rule-only mode
//
// Run:  node campaign-app/brain_service.mjs            # live service
//       node campaign-app/brain_service.mjs --simulate "这个多少钱?"
//                                                      # offline pipeline dry-run
//       node campaign-app/brain_service.mjs --no-webhook  # don't touch Evolution webhooks
//
// Ports: BRAIN_PORT (default 8799). Tracker keeps 8798 — run it with --no-webhook.

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { paths, loadEnv, makeApi, listInstances } from "./campaign_core.mjs";
import { classifyReplyText } from "./flow_sequence.mjs";
import { loadSuppressionSync, isSuppressed, normalizePhone, addLocalStop } from "./suppression.mjs";
import { loadBrainCacheSync } from "./brain_cache_sync.mjs";
import { loadProjectContext, resolveProjectLocal, listProjects } from "./knowledge_layer.mjs";
import { collectMessages, inboundEvent } from "./reply_intake.mjs";
import { makeTelegram, parseUpdate } from "./telegram.mjs";
import {
  decideAction, logRouteOf, detectLanguage, pickModel, buildPrompt,
  draftCard, draftButtons, parseCallbackData, logActionOf,
} from "./brain_core.mjs";

const HOST = process.env.BRAIN_HOST ?? "0.0.0.0";
const PORT = Number(process.env.BRAIN_PORT ?? 8799);
const PUBLIC_URL = process.env.BRAIN_WEBHOOK_URL ?? `http://host.docker.internal:${PORT}/webhook/evolution`;
const TRACKER_FORWARD_URL = process.env.BRAIN_FORWARD_URL ?? `http://127.0.0.1:${Number(process.env.TRACKER_PORT ?? 8798)}/webhook/evolution`;
const NOTION_VERSION = "2022-06-28";
const AI_REPLY_LOG_DB = "4272e2edbf644f44b670c71ae4276051"; // Mamba | AI Reply Log (override in notion_config.databases.aiReplyLog)

const simulateIdx = process.argv.indexOf("--simulate");
const SIMULATE = simulateIdx !== -1 ? String(process.argv[simulateIdx + 1] ?? "这个多少钱?") : null;
const skipWebhookSetup = process.argv.includes("--no-webhook");

const brainDir = path.join(paths.dataDir, "brain");
const pendingPath = path.join(brainDir, "pending.json");
const brainLogPath = path.join(brainDir, "reply_log.jsonl");
const stopRequestsPath = path.join(brainDir, "stop_requests.jsonl");

const env = await loadEnv();
const api = makeApi(env);
const tg = makeTelegram(env);

// ---------- tiny persistence ----------

async function appendJsonl(filePath, entry) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`);
}

let pending = {};       // pendingId -> { event, classified, draft, tier, tgMessageId, createdAt }
let awaitingEdit = {};  // chatId -> pendingId (after ✏️ was pressed)
async function loadPending() {
  try { ({ pending = {}, awaitingEdit = {} } = JSON.parse(await fs.readFile(pendingPath, "utf8"))); }
  catch { pending = {}; awaitingEdit = {}; }
}
async function savePending() {
  await fs.mkdir(brainDir, { recursive: true });
  const tmp = `${pendingPath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ pending, awaitingEdit }, null, 2));
  await fs.rename(tmp, pendingPath);
}

// ---------- lead lookup (same files the tracker maintains) ----------

async function readJson(filePath, fallback) {
  try { return JSON.parse(await fs.readFile(filePath, "utf8")); } catch { return fallback; }
}

async function lookupLead(phone) {
  const status = await readJson(path.join(paths.dataDir, "tracker", "lead_status.json"), { leads: {} });
  const fromStatus = status.leads?.[phone];
  const activeRun = await readJson(path.join(paths.dataDir, "active-run.json"), null);
  const fromRun = (activeRun?.assignments ?? []).find((j) => normalizePhone(j?.lead?.phone) === phone)?.lead;
  const leadsFile = await readJson(path.join(paths.dataDir, "leads.json"), null);
  const fromLeads = (leadsFile?.leads ?? []).find((l) => normalizePhone(l.phone) === phone);
  return {
    name: fromStatus?.name ?? fromRun?.name ?? fromLeads?.name ?? null,
    status: fromStatus?.status ?? null,
    replyText: fromStatus?.replyText ?? null,
    lastBlastStatus: fromStatus?.status ?? null,
  };
}

// ---------- Evolution send (the ONLY WhatsApp reply path in the system) ----------

async function sendWhatsApp(instanceName, number, text) {
  if (SIMULATE) { console.log(`[simulate] Evolution sendText via ${instanceName} -> ${number}:\n${text}\n`); return { simulated: true }; }
  return api(`/message/sendText/${encodeURIComponent(instanceName)}`, {
    method: "POST",
    body: JSON.stringify({ number, text, delay: 1200 }),
  });
}

// ---------- Anthropic draft ----------

async function draftWithClaude({ system, user }, model) {
  const key = env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY 不在 .env — brain 无法起草。");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 400, system, messages: [{ role: "user", content: user }] }),
    signal: AbortSignal.timeout(45000),
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${data?.error?.message ?? "unknown"}`);
  return (data?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}

function anthropicKeyConfigured() {
  return Boolean(env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY);
}

function useAiDrafts() {
  const mode = String(env.BRAIN_DRAFT_MODE || process.env.BRAIN_DRAFT_MODE || "auto").trim().toLowerCase();
  if (["rules", "rule", "off", "none"].includes(mode)) return false;
  if (["ai", "anthropic", "claude"].includes(mode)) return anthropicKeyConfigured();
  return anthropicKeyConfigured();
}

// ---------- Notion: AI Reply Log + Stop Flag ----------

function notionToken() {
  return env.NOTION_API_KEY || env.NOTION_TOKEN || process.env.NOTION_API_KEY || process.env.NOTION_TOKEN || "";
}

async function notionCall(method, pathname, body) {
  const r = await fetch(`https://api.notion.com/v1${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${notionToken()}`, "Content-Type": "application/json", "Notion-Version": NOTION_VERSION },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(data?.message || `Notion ${r.status}`);
  return data;
}

function readJsonSyncSafe(p) { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } }

function configuredDb(name, fallback) {
  const cfg = readJsonSyncSafe(path.join(paths.dataDir, "notion_config.json"));
  const clean = String(cfg?.databases?.[name] ?? "").replace(/[^a-fA-F0-9]/g, "");
  return clean || fallback;
}

function brainProject() {
  return process.env.BRAIN_PROJECT || env.BRAIN_PROJECT || readJsonSyncSafe(path.join(paths.dataDir, "notion_config.json"))?.project || "Enlace";
}

// ---------- project resolution (Layer 2 auto trigger) ----------
//
// 哪个盘? 本地先 (active-run / tracker / projects.json), 认不出再问 Notion
// (Blast Leads 按 phone 查, 同号多盘时优先 Sender Instance 一样的那行, 再看
// 最新 blast 日期), 最后 fallback 配置的默认盘。结果按 phone 缓存 30 分钟。
const projectCache = new Map(); // phone -> { project, at }
const PROJECT_CACHE_MS = 30 * 60 * 1000;

async function resolveProjectFromNotion(event) {
  try {
    const dbId = configuredDb("blastLeads", null);
    if (!dbId) return null;
    const q = await notionCall("POST", `/databases/${dbId}/query`, {
      filter: { property: "Phone", phone_number: { contains: event.phone.slice(-9) } },
      page_size: 10,
    });
    const rows = q?.results ?? [];
    if (!rows.length) return null;
    const sel = (page, name) => page?.properties?.[name]?.select?.name ?? null;
    const date = (page, name) => page?.properties?.[name]?.date?.start ?? "";
    const byInstance = event.instanceName ? rows.filter((p) => sel(p, "Sender Instance") === event.instanceName) : [];
    const pool = byInstance.length ? byInstance : rows;
    const blastAt = (p) => new Date(date(p, "Last Blast At") || date(p, "First Blast At") || 0).getTime();
    const best = pool.slice().sort((a, b) => blastAt(b) - blastAt(a))[0];
    return sel(best, "Project");
  } catch (error) {
    console.log(`[project] Notion lookup failed for ${event.phone}: ${error.message}`);
    return null;
  }
}

async function resolveProject(event) {
  const cached = projectCache.get(event.phone);
  if (cached && Date.now() - cached.at < PROJECT_CACHE_MS) return cached.project;
  const project = resolveProjectLocal(event.phone)
    || (SIMULATE ? null : await resolveProjectFromNotion(event))
    || brainProject();
  projectCache.set(event.phone, { project, at: Date.now() });
  return project;
}

// Every decision lands locally FIRST (survives Notion being down), Notion best-effort after.
async function logReply({ event, classified, aiDraft, finalSent, action, project = null }) {
  const entry = {
    at: new Date().toISOString(),
    phone: event.phone,
    route: classified.route,
    language: detectLanguage(event.text),
    replyText: event.text,
    aiDraft: aiDraft ?? null,
    finalSent: finalSent ?? null,
    action,
  };
  await appendJsonl(brainLogPath, entry);
  if (SIMULATE) { console.log(`[simulate] AI Reply Log: ${action} (${logRouteOf(classified.route)})`); return; }
  try {
    await notionCall("POST", "/pages", {
      parent: { database_id: configuredDb("aiReplyLog", AI_REPLY_LOG_DB) },
      properties: {
        "Reply Summary": { title: [{ text: { content: String(event.text).slice(0, 200) } }] },
        "AI Draft": { rich_text: aiDraft ? [{ text: { content: String(aiDraft).slice(0, 1800) } }] : [] },
        "Final Sent": { rich_text: finalSent ? [{ text: { content: String(finalSent).slice(0, 1800) } }] : [] },
        "Lead Phone": { phone_number: `+${event.phone}` },
        "Route": { select: { name: logRouteOf(classified.route) } },
        "Language": { select: { name: entry.language } },
        "Action": { select: { name: action } },
        "Project": { select: { name: project || brainProject() } },
        "Timestamp": { date: { start: entry.at } },
      },
    });
  } catch (error) {
    console.log(`[notion] AI Reply Log failed (local jsonl has it): ${error.message}`);
  }
}

// STOP handling: flag the lead in Notion (feeds the global suppression sync)
// AND remember locally so we stop immediately even before the next sync.
async function recordStop(event) {
  await appendJsonl(stopRequestsPath, { at: new Date().toISOString(), phone: event.phone, text: event.text });
  // 本地全局 STOP 名单马上生效 (跨盘跨号), 不等 Notion。
  try { await addLocalStop(event.phone, "BRAIN_STOP"); } catch { /* jsonl + sessionStops still hold */ }
  if (SIMULATE) { console.log("[simulate] Stop Flag -> Notion"); return; }
  try {
    const dbId = configuredDb("blastLeads", null);
    if (!dbId) return;
    const q = await notionCall("POST", `/databases/${dbId}/query`, {
      filter: { property: "Phone", phone_number: { contains: event.phone.slice(-9) } },
      page_size: 5,
    });
    for (const page of q?.results ?? []) {
      await notionCall("PATCH", `/pages/${page.id}`, { properties: { "Stop Flag": { checkbox: true } } });
    }
    if (!q?.results?.length) console.log(`[stop] ${event.phone} 不在 Blast Leads — 已记 stop_requests.jsonl,等人工归档。`);
  } catch (error) {
    console.log(`[stop] Notion Stop Flag failed for ${event.phone}: ${error.message}`);
  }
}

// In-memory session STOP list layered over the synced snapshot.
const sessionStops = new Set();

// ---------- Telegram ----------

async function notifyTelegram(text) {
  if (SIMULATE) { console.log(`[simulate] Telegram:\n${text}\n`); return { message_id: 0 }; }
  return tg.send(text);
}

async function pushDraft(card, pendingId) {
  if (SIMULATE) { console.log(`[simulate] Telegram draft + buttons (pending ${pendingId}):\n${card}\n`); return { message_id: 0 }; }
  return tg.sendWithButtons(card, draftButtons(pendingId));
}

// ---------- the pipeline ----------

async function handleEvent(event) {
  // 1) global suppression — STOP means stop, everywhere, forever.
  const { set } = loadSuppressionSync();
  if (isSuppressed(event.phone, set) || sessionStops.has(event.phone)) {
    console.log(`[suppressed] ${event.phone} — logged, no reply.`);
    await appendJsonl(brainLogPath, { at: new Date().toISOString(), phone: event.phone, replyText: event.text, action: "Suppressed" });
    return;
  }

  // 2) classify + Layer 2: 认出这个 lead 是哪个盘的, 拿它的知识包。
  const classified = classifyReplyText(event.text);
  const policy = decideAction(classified.route);
  const lead = await lookupLead(event.phone);
  const project = await resolveProject(event);
  const projectCtx = loadProjectContext(project);
  console.log(`[${classified.route}] ${lead.name ?? event.pushName ?? "?"} (${event.phone}) 🏢${project}${projectCtx.matched ? "" : " (无 YAML sheet)"} "${event.text}" -> ${policy.mode}`);

  // 3a) simple route: canned reply, out it goes.
  if (policy.mode === "auto") {
    await sendWhatsApp(event.instanceName, event.phone, classified.suggestedReply);
    await logReply({ event, classified, aiDraft: null, finalSent: classified.suggestedReply, action: "Sent As-Is", project });
    if (classified.route === "STOP_DNC") {
      sessionStops.add(event.phone);
      await recordStop(event);
    }
    return;
  }

  // 3b) complaint / forced handoff: stay silent, wake the human.
  if (policy.mode === "handoff") {
    await notifyTelegram(`🚨 <b>投诉/负面情绪 — 已静默,请人工接管</b>\n${lead.name ?? event.pushName ?? "?"} (${event.phone}) · 🏢 ${project}\n💬 ${event.text}`);
    await logReply({ event, classified, aiDraft: null, finalSent: null, action: "Takeover", project });
    return;
  }

  // 3c) complex route: AI draft when configured; otherwise Rule-only suggestedReply.
  const aiEnabled = useAiDrafts();
  const model = aiEnabled ? pickModel(policy.tier, env) : "rule-only";
  let draft;
  let draftTier = aiEnabled ? policy.tier : "rules";
  try {
    if (aiEnabled) {
      const cache = loadBrainCacheSync();
      const prompt = buildPrompt({ event, classified, cache, lead, projectCtx });
      draft = SIMULATE ? `[simulate:${model}] ${classified.suggestedReply}` : await draftWithClaude(prompt, model);
    } else {
      draft = classified.suggestedReply;
    }
    if (!draft) throw new Error("empty draft");
  } catch (error) {
    console.log(`[ai] draft failed: ${error.message} — falling back to handoff alert.`);
    await notifyTelegram(`⚠️ <b>AI 起草失败 — 请人工回复</b>\n${lead.name ?? "?"} (${event.phone}) · 🏢 ${project}\n💬 ${event.text}\n(${error.message})`);
    await logReply({ event, classified, aiDraft: null, finalSent: null, action: "Takeover", project });
    return;
  }

  const pendingId = crypto.randomBytes(6).toString("base64url");
  const message = await pushDraft(draftCard({ event, classified, draft, lead, tier: draftTier, project }), pendingId);
  pending[pendingId] = { event, classified, draft, tier: draftTier, project, tgMessageId: message.message_id, createdAt: new Date().toISOString() };
  await savePending();
}

// ---------- Telegram button loop (long-poll getUpdates, 缺口 2) ----------

async function resolvePending(pendingId, action, finalText) {
  const p = pending[pendingId];
  if (!p) return null;
  if (action !== "take") {
    await sendWhatsApp(p.event.instanceName, p.event.phone, finalText);
  }
  await logReply({
    event: p.event, classified: p.classified, aiDraft: p.draft,
    finalSent: action === "take" ? null : finalText,
    action: logActionOf(action),
    project: p.project ?? null,
  });
  delete pending[pendingId];
  await savePending();
  return p;
}

async function telegramLoop() {
  if (!tg.enabled || !tg.hasChatId) {
    console.log("⚠️  Telegram 未配置 (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID) — 复杂 route 只会记录,不会弹按钮。");
    return;
  }
  let offset;
  for (;;) {
    let updates = [];
    try { updates = await tg.getUpdates({ offset, timeoutSec: 25 }); }
    catch (error) {
      console.log(`[telegram] getUpdates: ${error.message} — retry in 5s`);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    for (const raw of updates) {
      offset = raw.update_id + 1;
      const u = parseUpdate(raw);
      if (!u) continue;
      try {
        if (u.type === "callback") {
          const cb = parseCallbackData(u.data);
          if (!cb) { await tg.answerCallback(u.callbackQueryId); continue; }
          const p = pending[cb.pendingId];
          if (!p) { await tg.answerCallback(u.callbackQueryId, "这条草稿已处理过了。"); continue; }
          if (cb.action === "ok") {
            await resolvePending(cb.pendingId, "ok", p.draft);
            await tg.answerCallback(u.callbackQueryId, "已照发 ✅");
            await tg.editMessageText(u.chatId, u.messageId, `✅ <b>已照发</b> -> ${p.event.phone}\n${p.draft}`);
          } else if (cb.action === "take") {
            await resolvePending(cb.pendingId, "take", null);
            await tg.answerCallback(u.callbackQueryId, "已静默,你来接管 🙋");
            await tg.editMessageText(u.chatId, u.messageId, `🙋 <b>人工接管</b> ${p.event.phone} — brain 不回复这条。\n💬 ${p.event.text}`);
          } else if (cb.action === "edit") {
            awaitingEdit[String(u.chatId)] = cb.pendingId;
            await savePending();
            await tg.answerCallback(u.callbackQueryId, "回复你的新文本 ✏️");
            await tg.send("✏️ 直接发我改好的文本,我会原样发给客户。(发 /cancel 放弃)");
          }
        }
        if (u.type === "message") {
          const pendingId = awaitingEdit[String(u.chatId)];
          if (!pendingId) continue;
          delete awaitingEdit[String(u.chatId)];
          await savePending();
          if (u.text.trim() === "/cancel") { await tg.send("已取消,草稿还挂着,可以再按按钮。"); continue; }
          const p = await resolvePending(pendingId, "edit", u.text.trim());
          if (p) await tg.send(`✏️ <b>已按你改的发出</b> -> ${p.event.phone}\n${u.text.trim()}`);
        }
      } catch (error) {
        console.log(`[telegram] handling update failed: ${error.message}`);
      }
    }
  }
}

// ---------- webhook plumbing (brain owns it; tracker gets a forwarded copy) ----------

function forwardToTracker(payload) {
  fetch(TRACKER_FORWARD_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  }).catch(() => { /* tracker offline is fine — stats only */ });
}

async function setInstanceWebhook(instanceName) {
  const events = ["MESSAGES_UPSERT"];
  const v2 = { webhook: { enabled: true, url: PUBLIC_URL, byEvents: false, base64: false, events } };
  const v1 = { enabled: true, url: PUBLIC_URL, webhookByEvents: false, webhookBase64: false, events };
  const endpoint = `/webhook/set/${encodeURIComponent(instanceName)}`;
  try { return await api(endpoint, { method: "POST", body: JSON.stringify(v2) }); }
  catch (error) {
    if (!/HTTP 400/.test(error.message)) throw error;
    return api(endpoint, { method: "POST", body: JSON.stringify(v1) });
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

// ---------- simulate mode: whole pipeline, no network sends ----------

if (SIMULATE) {
  console.log(`MAMBA | BRAIN SERVICE — simulate: "${SIMULATE}"\n`);
  await loadPending();
  await handleEvent({
    id: `sim_${Date.now()}`,
    receivedAt: new Date().toISOString(),
    instanceName: "simulate",
    pushName: "Test Lead",
    phone: "60123456789",
    text: SIMULATE,
  });
  console.log("\nsimulate 完成 (没有真的发任何东西)。");
  process.exit(0);
}

// ---------- live service ----------

await loadPending();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        ok: true, service: "mamba-brain", pending: Object.keys(pending).length,
        telegram: tg.enabled && tg.hasChatId, anthropic: anthropicKeyConfigured(), draftMode: useAiDrafts() ? "ai" : "rules",
      }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/webhook/evolution") {
      const payload = await readBody(req);
      forwardToTracker(payload); // 缺口 4: tracker keeps its stats, brain keeps the mic
      const seen = new Set();
      for (const message of collectMessages(payload)) {
        const event = inboundEvent(payload, message);
        if (!event || seen.has(event.id)) continue;
        seen.add(event.id);
        handleEvent(event).catch((error) => console.log(`[pipeline] ${event.phone}: ${error.message}`));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false }));
  } catch (error) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: error.message }));
  }
});

server.listen(PORT, HOST, async () => {
  console.log("MAMBA | BRAIN SERVICE (B6) — Phase 1: 关键词检测 + 人工按钮批准");
  console.log("==========================================================");
  console.log(`Status:    http://127.0.0.1:${PORT}/`);
  console.log(`Webhook:   ${PUBLIC_URL}`);
  console.log(`Forward:   ${TRACKER_FORWARD_URL} (tracker, stats only)`);
  console.log(`Telegram:  ${tg.enabled && tg.hasChatId ? "ON" : "OFF — 跑 Setup Telegram"}`);
  console.log(`Drafting:  ${useAiDrafts() ? "AI" : "Rule-only (no AI API needed)"}`);
  console.log(`Anthropic: ${anthropicKeyConfigured() ? "ON" : "OFF"}`);
  const cache = loadBrainCacheSync();
  console.log(`Brain:     ${cache.knowledge.count} facts / ${cache.golden.count} golden / ${cache.objections.count} objections${cache.knowledge.count === 0 ? "  ⚠️ 库是空的 — 先做缺口 1" : ""}`);
  const projects = listProjects();
  console.log(`Layer 2:   ${projects.length ? projects.map((p) => p.name).join(", ") : "⚠️ 没有 YAML sheet — 放进 campaign-assets/knowledge/"} (丢 YAML 进去自动生效)`);

  if (!skipWebhookSetup) {
    try {
      const instances = await listInstances(api);
      const open = instances.filter((i) => i.status === "OPEN");
      for (const item of open) await setInstanceWebhook(item.name);
      console.log(open.length ? `Listening:  ${open.map((i) => i.name).join(", ")}` : "No OPEN WhatsApp instances — start one, then restart.");
    } catch (error) {
      console.log(`Webhook setup failed: ${error.message} — restart once Evolution is online.`);
    }
  } else {
    console.log("Webhook auto-setup skipped (--no-webhook).");
  }
  console.log("\n提醒: tracker 请用 --no-webhook 跑 (brain 是唯一回复出口,会转发数据给它)。");

  telegramLoop();
});
