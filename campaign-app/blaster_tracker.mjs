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
const api = makeApi(env);
const notion = await createNotionSync({
  env,
  onLog: (message) => console.log(message),
});

let startedAt = new Date().toISOString();
let leadIndex = new Map();
let lastEvents = [];
const pushedPhones = new Set(); // unknown numbers manually pushed to Notion this session

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

function classifyReply() {
  // Stage 1 rule: any customer reply after blasting is treated as Warm.
  // This keeps the system deterministic and avoids over-classifying early data.
  return { status: "WARM", category: "Warm" };
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
  if (event.status === "WARM") stats.warm += 1;
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

  lastEvents.unshift(event);
  lastEvents = lastEvents.slice(0, 80);
  countEvent(event);

  // Routing:
  //  - Ad leads (matched the ad opening phrase) -> auto-create in Ads Leads DB.
  //  - Known blast leads -> auto-sync/amend in Blast Leads DB.
  //  - Other unknown numbers -> NOT auto-pushed; they wait for a manual
  //    "Add to Notion" click so random / wrong-number messages don't create rows.
  if (event.adLead) {
    await notion.upsertAdLead(event).catch((error) => {
      console.log(`Ad-lead Notion failed for ${event.phone}: ${error.message}`);
    });
  } else if (event.leadId) {
    await notion.upsertLeadReply(event).catch((error) => {
      console.log(`Notion sync failed for reply ${event.phone}: ${error.message}`);
    });
  }
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
    instanceName: senderFromPayload(payload),
    name: lead.name ?? message.pushName ?? "Unknown",
    phone,
    leadId: lead.leadId ?? null,
    runId: lead.runId ?? null,
    campaignId: lead.campaignId ?? null,
    sender: lead.sender ?? null,
    status: category.status,
    category: category.category,
    text,
    adLead: isAdLead(text),
  };
}

async function processWebhook(payload) {
  await refreshLeadIndex();
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
  const open = instances.filter((item) => item.status === "OPEN");
  for (const item of open) {
    await setInstanceWebhook(item.name);
  }
  return open;
}

function htmlPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mamba | Blaster Tracker</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 28px; color: #111827; background: #f8fafc; }
    h1 { margin: 0 0 8px; }
    .muted { color: #64748b; }
    .cards { display: grid; grid-template-columns: repeat(3, minmax(120px, 1fr)); gap: 12px; margin: 20px 0; }
    .card { background: white; border: 1px solid #e2e8f0; border-radius: 14px; padding: 16px; box-shadow: 0 1px 2px #0000000d; }
    .num { font-size: 28px; font-weight: 700; }
    table { width: 100%; border-collapse: collapse; background: white; border-radius: 14px; overflow: hidden; }
    th, td { text-align: left; padding: 12px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
    th { background: #f1f5f9; font-size: 13px; color: #475569; }
    .pill { display: inline-block; padding: 4px 9px; border-radius: 999px; font-size: 12px; font-weight: 700; background: #e2e8f0; }
    .WARM { background: #dcfce7; color: #166534; }
    .added { background: #dbeafe; color: #1e40af; }
    .btn { padding: 6px 12px; border-radius: 8px; border: 1px solid #16a34a; background: #16a34a; color: white; font-size: 12px; font-weight: 700; cursor: pointer; }
    .btn:disabled { opacity: .55; cursor: default; }
    .btn.sec { background: #0ea5e9; border-color: #0ea5e9; }
    .btn.danger { background: #dc2626; border-color: #dc2626; }
    .toolbar { display: flex; gap: 10px; align-items: center; margin: 6px 0 12px; }
  </style>
</head>
<body>
  <h1>Mamba | Blaster Tracker</h1>
  <div class="muted">Listening for WhatsApp replies. Keep the tracker window open.</div>
  <div class="cards">
    <div class="card"><div class="muted">Total Replies</div><div id="total" class="num">0</div></div>
    <div class="card"><div class="muted">Warm</div><div id="warm" class="num">0</div></div>
    <div class="card"><div class="muted">Mode</div><div class="num" style="font-size:18px">Reply = Warm</div></div>
  </div>
  <div class="muted" id="meta"></div>
  <h2>Recent Replies</h2>
  <div class="toolbar">
    <button class="btn sec" onclick="pushSelected(this)">➕ 选中加进 Notion</button>
    <button class="btn danger" onclick="deleteSelected(this)">🗑 删除选中</button>
    <span class="muted" id="selinfo">未选</span>
  </div>
  <table>
    <thead><tr><th><input type="checkbox" id="chkall" onclick="toggleAll(this)"></th><th>Time</th><th>Name</th><th>Phone</th><th>Status</th><th>Message</th><th>Notion</th></tr></thead>
    <tbody id="rows"></tbody>
  </table>
  <script>
    const fmt = (iso) => new Date(iso).toLocaleString("en-MY", { hour12: false });
    const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[char]);
    async function refresh() {
      const res = await fetch("/api/status");
      const data = await res.json();
      total.textContent = data.stats.totalReplies;
      warm.textContent = data.stats.warm;
      meta.textContent = "Leads indexed: " + data.leadsIndexed + " | Notion sync: " + (data.notionSync ? "ON" : "OFF") + " | Started: " + fmt(data.startedAt);
      const checked = new Set([...document.querySelectorAll(".rowchk:checked")].map((c) => c.value));
      rows.innerHTML = data.events.map((event) => {
        const action = event.adLead
          ? '<span class="pill added">✓ Ad → Notion</span>'
          : event.known
            ? '<span class="muted">auto</span>'
            : event.pushed
              ? '<span class="pill added">✓ Added</span>'
              : '<button class="btn" onclick="push(\\'' + esc(event.phone) + '\\', this)">Add to Notion</button>';
        const id = esc(event.id);
        const chk = checked.has(String(event.id)) ? " checked" : "";
        return \`
        <tr>
          <td><input type="checkbox" class="rowchk" value="\${id}" onchange="updateSel()"\${chk}></td>
          <td>\${fmt(event.receivedAt)}</td>
          <td>\${esc(event.name)}</td>
          <td>\${esc(event.phone)}</td>
          <td><span class="pill \${event.status}">\${event.status}</span></td>
          <td>\${esc(event.text)}</td>
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
      json(res, 200, { ok: true, startedAt, stats, leadsIndexed: leadIndex.size, notionSync: notion.enabled, events });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/push") {
      const body = await readBody(req);
      const phone = String(body.phone ?? "");
      const event = lastEvents.find((item) => item.phone === phone);
      if (!event) { json(res, 404, { ok: false, error: "找不到这个号码的回复。" }); return; }
      if (!notion.enabled) { json(res, 400, { ok: false, error: "Notion sync 没开(缺 NOTION_API_KEY)。" }); return; }
      try {
        await notion.upsertLeadReply({ ...event });
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
          else await notion.upsertLeadReply({ ...event });
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
        if (event.status === "WARM") stats.warm = Math.max(0, stats.warm - 1);
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
      console.log("Webhook auto-setup skipped for this run.");
      console.log("\nWaiting for customer replies. Press Control+C to stop.");
      return;
    }

    const open = await configureWebhookForOpenInstances();
    if (open.length === 0) {
      console.log("No OPEN WhatsApp numbers found. Start/scan a number, then restart this tracker.");
    } else {
      console.log(`Listening on: ${open.map((item) => `${item.name} (${item.number})`).join(", ")}`);
    }
  } catch (error) {
    console.log(`Could not auto-connect webhook: ${error.message}`);
    console.log("Keep this window open, then restart once Evolution API is online.");
  }

  console.log("\nWaiting for customer replies. Press Control+C to stop.");
});
