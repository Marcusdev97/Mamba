// Mamba | Morning Follow-up Check
//
// Click it in the morning. It does two things:
//   1) Settlement: pull WhatsApp messages since the last run from every open
//      Evolution instance, match each customer by phone to the right Notion DB
//      (Blast -> Ads -> Recycle), and update their status / next follow-up.
//   2) Briefing: query Notion for everyone whose Follow Up Due is today or
//      earlier, split into "today" and "missed", and send the list to Telegram.
//
// Capture is manual on purpose: this script connects to Evolution only when you
// run it. Leave the Mac/Docker awake so WhatsApp stays linked between runs.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadEnv, makeApi, openInstances } from "./campaign_core.mjs";
import { createNotionSync } from "./notion_sync.mjs";
import { makeTelegram, escapeHtml } from "./telegram.mjs";
import { classifyReplyText } from "./flow_sequence.mjs";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(appDir, "..");
const statePath = path.join(rootDir, "campaign-data", "followup-state.json");

const TZ = "Asia/Kuala_Lumpur";

// ---- timing rules (edit here) -------------------------------------------------
const RULE = {
  replyFollowUpDays: 1,   // customer replied -> follow up tomorrow
  outboundPushDays: 2,    // you messaged them -> next follow up in 2 days
};
// Statuses we never put on the follow-up list.
const SKIP_STATUS = new Set([
  "Stop", "Not Interested", "Invalid", "Closed", "Do Not Call",
  "Invalid Number", "Already Bought", "Appointment",
]);

// ---- date helpers (all Kuala Lumpur / GMT+8) ---------------------------------
function klDate(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86400000).toLocaleDateString("en-CA", { timeZone: TZ });
}
function klDateTime(iso) {
  return iso ? new Date(iso).toLocaleString("sv-SE", { timeZone: TZ }) : "";
}
function startOfKLTodayMs() {
  return new Date(`${klDate(0)}T00:00:00+08:00`).getTime();
}

// ---- message helpers (same shapes as nightly_reply_checker) ------------------
export function normalizePhone(value) {
  let digits = String(value ?? "").replace(/\D/g, "");
  if (digits.startsWith("0")) digits = `60${digits.slice(1)}`;
  return /^\d{8,15}$/.test(digits) ? digits : null;
}
export function messageTime(message) {
  const t = Number(message.messageTimestamp ?? 0);
  if (!t) return 0;
  return t < 100000000000 ? t * 1000 : t;
}
export function extractText(message) {
  const body = message?.message ?? message;
  if (!body || typeof body !== "object") return "";
  return [
    body.conversation,
    body.extendedTextMessage?.text,
    body.imageMessage?.caption,
    body.videoMessage?.caption,
    body.documentMessage?.caption,
    body.buttonsResponseMessage?.selectedDisplayText,
    body.listResponseMessage?.title,
  ].find((v) => typeof v === "string" && v.trim())?.trim() ?? "";
}
export function collectMessageObjects(value, found = []) {
  if (!value || typeof value !== "object") return found;
  if (value.key && (value.messageTimestamp || value.message)) found.push(value);
  for (const child of Object.values(value)) collectMessageObjects(child, found);
  return found;
}
export function phoneFromJid(jid) {
  const raw = String(jid ?? "");
  if (!raw.includes("@s.whatsapp.net")) return null; // skip groups / status
  return normalizePhone(raw.split("@")[0].split(":")[0]);
}

// ---- Notion property getters/builders ---------------------------------------
function pText(page, name) {
  const p = page?.properties?.[name];
  if (!p) return "";
  if (p.type === "title") return (p.title ?? []).map((t) => t.plain_text).join("");
  if (p.type === "rich_text") return (p.rich_text ?? []).map((t) => t.plain_text).join("");
  if (p.type === "phone_number") return p.phone_number ?? "";
  return "";
}
function pSelect(page, name) {
  const p = page?.properties?.[name];
  return p?.select?.name ?? p?.status?.name ?? "";
}
function pDate(page, name) {
  return page?.properties?.[name]?.date?.start ?? "";
}
// True only when the page has a ticked "Stop Flag" checkbox. Once you tick it in
// Notion, we stop tracking/following up that customer.
function pCheckbox(page, name) {
  return page?.properties?.[name]?.checkbox === true;
}
const dateProp = (iso) => ({ date: iso ? { start: iso } : null });
const richProp = (v) => ({ rich_text: v ? [{ text: { content: String(v).slice(0, 1900) } }] : [] });
const selProp = (name) => (name ? { select: { name } } : { select: null });
const statusProp = (name) => (name ? { status: { name } } : undefined);
const numProp = (n) => ({ number: Number(n ?? 0) });
const cleanId = (v) => String(v ?? "").replace(/[^a-fA-F0-9]/g, "");
const pNumber = (page, name) => Number(page?.properties?.[name]?.number ?? 0);

// The Blast Leads "Status" column is written type-aware: some workspaces have it
// as a `select`, others as a `status`. We learn the real type once (see main)
// so we never send the wrong shape. Defaults to select until configured.
let blastChoice = (_name, optionName) => (optionName ? { select: { name: optionName } } : { select: null });

// ---- source resolver ---------------------------------------------------------
const DEAD_DBS = new Set(); // 查询失败(没分享给 integration / 已删除)的库,本次运行直接跳过
async function resolveByPhone(sync, dbIds, phone) {
  const filter = { property: "Phone", phone_number: { equals: phone } };
  for (const [db, id] of [["blast", dbIds.blast], ["ads", dbIds.ads], ["recycle", dbIds.recycle]]) {
    if (!id || DEAD_DBS.has(db)) continue;
    let res;
    try { res = await sync.queryDataSource(id, filter, 1); }
    catch (e) {
      DEAD_DBS.add(db);
      console.log(`⚠️ ${db} 库查询失败,本次跳过它(其余库照常):${String(e.message).slice(0, 120)}`);
      continue;
    }
    const page = res?.results?.[0];
    if (page) return { db, page };
  }
  return null;
}

// ---- apply updates on a settled message -------------------------------------
async function applyInbound(sync, hit, event) {
  const { db, page } = hit;
  const due = `${klDate(RULE.replyFollowUpDays)}`;
  if (db === "blast") {
    // Customer replied -> classify the text and STOP the automatic sequence.
    // Sequence Status moves off "Running", so the lead drops out of the
    // "Ready for Next Flow" queue until a human deliberately resumes it.
    const verdict = classifyReplyText(event.text);
    const props = {
      Status: blastChoice("Status", verdict.status),
      "Sequence Status": selProp(verdict.sequenceStatus),
      "Next Action": selProp(verdict.nextAction),
      "AI Category": selProp(verdict.aiCategory),   // colour: Stop=red, Warm=green, ...
      "AI Summary": richProp(`[${verdict.signal}] ${verdict.route} · 建议回复:${verdict.suggestedReply}`),
      "Last Reply At": dateProp(event.at),
      "Last Reply Text": richProp(event.text),
      "Reply Count": numProp(pNumber(page, "Reply Count") + 1),
      "Reply Checked At": dateProp(new Date().toISOString()),
      "Follow Up Due": dateProp(due),
    };
    if (verdict.stopFlag) {
      props["Stop Flag"] = { checkbox: true };
      props["Stop Reason"] = richProp(`Auto: ${verdict.route}`);
    }
    await sync.updatePage(page.id, props);
  } else if (db === "ads") {
    await sync.updatePage(page.id, {
      "Lead Status": selProp("Warm"),
      "Last Touch Type": selProp("Customer Replied"),
      "Last Message Text": richProp(event.text),
      "Last Touch At": dateProp(event.at),
      "Follow Up Due": dateProp(due),
      "Next Action": selProp("Send Details"),
    });
  } else {
    await sync.updatePage(page.id, {
      "Lead Status": selProp("Warm"),
      "Follow Up Due": dateProp(due),
      "Next Action": selProp("Follow Up"),
    });
  }
}
async function applyOutbound(sync, hit, event) {
  const { db, page } = hit;
  const due = `${klDate(RULE.outboundPushDays)}`;
  const props = { "Last Touch At": dateProp(event.at), "Follow Up Due": dateProp(due) };
  if (db === "ads") props["Last Touch Type"] = selProp("WhatsApp Sent");
  await sync.updatePage(page.id, props);
}

// ---- settlement --------------------------------------------------------------
export async function settle(api, sync, dbIds, sinceMs) {
  let instances = [];
  try {
    instances = await openInstances(api);
  } catch (error) {
    return { error: `连不上 Evolution(${error.message})。请确认 Docker 已启动。`, inbound: 0, outbound: 0, unknown: 0 };
  }
  if (!instances.length) return { error: "没有在线的 WhatsApp 号(instance)。请检查 Evolution 连接。", inbound: 0, outbound: 0, unknown: 0 };

  // newest message per phone per direction
  const events = new Map(); // phone -> { inbound?, outbound? }
  for (const inst of instances) {
    let response;
    try {
      response = await api(`/chat/findMessages/${encodeURIComponent(inst.name)}`, {
        method: "POST",
        body: JSON.stringify({ where: {} }),
      });
    } catch {
      continue;
    }
    for (const m of collectMessageObjects(response)) {
      const at = messageTime(m);
      if (at < sinceMs) continue;
      const phone = phoneFromJid(m?.key?.remoteJid);
      if (!phone) continue;
      const dir = m?.key?.fromMe ? "outbound" : "inbound";
      const text = extractText(m);
      const bucket = events.get(phone) ?? {};
      if (!bucket[dir] || at > bucket[dir].at) {
        bucket[dir] = { at: new Date(at).toISOString(), text, instance: inst.name };
      }
      events.set(phone, bucket);
    }
  }

  let inbound = 0, outbound = 0, unknown = 0;
  const inboundPhones = new Set(); // everyone who replied this window (used by no-reply pass)
  for (const [phone, bucket] of events) {
    if (bucket.inbound) inboundPhones.add(phone);
    const hit = await resolveByPhone(sync, dbIds, phone);
    if (!hit) { if (bucket.inbound) unknown += 1; continue; }
    // Stop Flag ticked -> leave the customer alone: don't re-schedule follow-up
    // even if they message again. Their reply still shows in WhatsApp; we just
    // don't put them back on the tracking list.
    if (pCheckbox(hit.page, "Stop Flag")) continue;
    // Outbound first (sets Last Touch + pushes due), then inbound can reset due to tomorrow.
    if (bucket.outbound) { await applyOutbound(sync, hit, bucket.outbound); outbound += 1; }
    if (bucket.inbound) { await applyInbound(sync, hit, bucket.inbound); inbound += 1; }
  }
  return { inbound, outbound, unknown, inboundPhones, instances: instances.map((i) => i.name) };
}

// No-reply pass: for blast leads still in the automatic sequence whose follow-up
// is due, bump "No Reply Count" and stamp "Reply Checked At" so the operator can
// see how many consecutive flow-checks passed with silence. Idempotent per KL
// day (a lead already checked today is skipped), so running the check twice in a
// day won't double-count. Leads that replied this window are skipped (already
// handled by settlement).
async function markNoReplies(sync, blastDbId, inboundPhones) {
  if (!blastDbId) return { bumped: 0, scanned: 0 };
  const today = klDate(0);
  let cursor;
  let bumped = 0, scanned = 0;
  do {
    const body = {
      filter: {
        and: [
          { property: "Sequence Status", select: { equals: "Running" } },
          { property: "Follow Up Due", date: { on_or_before: today } },
          { property: "Stop Flag", checkbox: { equals: false } },
        ],
      },
      page_size: 100,
    };
    if (cursor) body.start_cursor = cursor;
    let res;
    try {
      res = await sync.request("POST", `/databases/${cleanId(blastDbId)}/query`, body);
    } catch {
      break; // older DBs without these columns: skip the pass quietly
    }
    for (const page of res?.results ?? []) {
      scanned += 1;
      const phone = normalizePhone(pText(page, "Phone"));
      if (phone && inboundPhones.has(phone)) continue; // they replied -> handled by settle
      const checkedAt = pDate(page, "Reply Checked At");
      if (checkedAt && new Date(checkedAt).toLocaleDateString("en-CA", { timeZone: TZ }) === today) continue;
      await sync.updatePage(page.id, {
        "No Reply Count": numProp(pNumber(page, "No Reply Count") + 1),
        "Reply Checked At": dateProp(new Date().toISOString()),
      });
      bumped += 1;
    }
    cursor = res?.has_more ? res?.next_cursor : null;
  } while (cursor);
  return { bumped, scanned };
}

// ---- due list ----------------------------------------------------------------
function angleFor(db, page) {
  const next = pSelect(page, "Next Action");
  if (next && next !== "No Action") return next;
  return db === "recycle" ? "Follow Up" : "Send info";
}
async function collectDue(sync, dbIds) {
  const today = klDate(0);
  const out = [];
  for (const [db, id] of [["blast", dbIds.blast], ["ads", dbIds.ads], ["recycle", dbIds.recycle]]) {
    if (!id || DEAD_DBS.has(db)) continue;
    let res;
    try {
      res = await sync.queryDataSource(id, {
        property: "Follow Up Due", date: { on_or_before: today },
      }, 100);
    } catch (e) {
      DEAD_DBS.add(db);
      console.log(`⚠️ ${db} 库查询失败,今日跟进清单里跳过它:${String(e.message).slice(0, 120)}`);
      continue;
    }
    for (const page of res?.results ?? []) {
      // Stop Flag ticked -> never list this customer for follow-up.
      if (pCheckbox(page, "Stop Flag")) continue;
      // Blast leads that already replied (Sequence Status off "Running") are in
      // human hands now -> keep them off the automatic follow-up briefing.
      if (db === "blast") {
        const seq = pSelect(page, "Sequence Status");
        if (seq && seq !== "Running") continue;
      }
      const statusName = db === "blast" ? pSelect(page, "Status") : pSelect(page, "Lead Status");
      if (SKIP_STATUS.has(statusName)) continue;
      const due = pDate(page, "Follow Up Due");
      if (!due) continue;
      out.push({
        db,
        name: pText(page, "Name") || pText(page, "Phone") || "(no name)",
        phone: pText(page, "Phone"),
        instance: pSelect(page, "Sender Instance"),
        lastReply: pText(page, "Last Reply Text") || pText(page, "Last Message Text"),
        angle: angleFor(db, page),
        due,
        missed: due < today,
      });
    }
  }
  out.sort((a, b) => a.due.localeCompare(b.due));
  return out;
}

const SRC = { blast: "Blast", ads: "Ads", recycle: "Recycle" };
function line(item, index) {
  const head = `${index}. <b>${escapeHtml(item.name)}</b> · ${SRC[item.db]}${item.instance ? ` · ${escapeHtml(item.instance)}` : ""}`;
  const bits = [];
  if (item.lastReply) bits.push(`上次:「${escapeHtml(item.lastReply.slice(0, 60))}」`);
  bits.push(`建议:${escapeHtml(item.angle)}`);
  return `${head}\n   ${bits.join(" · ")}`;
}

async function main() {
  const env = await loadEnv();
  const api = makeApi(env);
  const sync = await createNotionSync({ env, onLog: () => {} });
  const tg = makeTelegram(env);

  console.log("MAMBA | MORNING FOLLOW-UP CHECK");
  console.log("===============================");
  if (!sync.enabled) { console.log("Notion token missing. Run Set Notion Token first."); process.exit(1); }

  const dbIds = {
    blast: sync.config.databases.blastLeads,
    ads: sync.config.databases.adsLeads,
    recycle: sync.config.databases.recycleLeads,
  };

  // Learn the real type of the Blast Leads "Status" column once, so we write it
  // as select-or-status correctly (workspaces differ).
  try {
    const blastDb = await sync.request("GET", `/databases/${cleanId(dbIds.blast)}`);
    const statusType = blastDb?.properties?.Status?.type;
    if (statusType === "status") blastChoice = (_n, opt) => (opt ? { status: { name: opt } } : undefined);
  } catch { /* keep select default */ }

  // settlement window
  let state = {};
  try { state = JSON.parse(await fs.readFile(statePath, "utf8")); } catch {}
  const sinceMs = state.lastSettledAt ? new Date(state.lastSettledAt).getTime() : startOfKLTodayMs();

  console.log(`Settling messages since ${klDateTime(new Date(sinceMs).toISOString())} (KL)...`);
  const settled = await settle(api, sync, dbIds, sinceMs);
  if (settled.error) console.log(`! ${settled.error}`);
  else {
    console.log(`Instances: ${settled.instances.join(", ")}`);
    console.log(`Inbound updated: ${settled.inbound}, outbound updated: ${settled.outbound}, unknown inbound: ${settled.unknown}`);
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, JSON.stringify({ lastSettledAt: new Date().toISOString() }, null, 2));
  }

  // No-reply pass: bump No Reply Count for still-Running blast leads that were
  // due and stayed silent this window. Skipped if Evolution settlement failed,
  // so we never mark "no reply" when we actually couldn't read replies.
  let noReply = { bumped: 0, scanned: 0 };
  if (!settled.error) {
    noReply = await markNoReplies(sync, dbIds.blast, settled.inboundPhones ?? new Set());
    console.log(`No-reply pass: bumped ${noReply.bumped} of ${noReply.scanned} due running leads.`);
  }

  console.log("Collecting today's follow-up list from Notion...");
  const due = await collectDue(sync, dbIds);
  const todayStr = klDate(0);
  const todayItems = due.filter((d) => !d.missed);
  const missedItems = due.filter((d) => d.missed);

  // ---- build Telegram message ----
  const dow = new Date(`${todayStr}T08:00:00+08:00`).toLocaleDateString("en-US", { weekday: "short", timeZone: TZ });
  const parts = [`☀️ <b>Mamba 今日跟进</b> — ${todayStr} (${dow})`, ""];

  if (todayItems.length) {
    parts.push(`📋 <b>今天要跟进 (${todayItems.length})</b>`);
    todayItems.forEach((item, i) => parts.push(line(item, i + 1)));
  } else {
    parts.push("📋 今天没有到期要跟进的客户。");
  }
  if (missedItems.length) {
    parts.push("", `⚠️ <b>漏掉没发 (${missedItems.length})</b> — 更早就该跟进`);
    missedItems.forEach((item, i) => parts.push(line(item, i + 1)));
  }
  parts.push("");
  if (settled.error) parts.push(`<i>⚠️ 结算未完成:${escapeHtml(settled.error)}</i>`);
  else parts.push(`<i>刚结算:收到 ${settled.inbound} 条回复,你发出 ${settled.outbound} 条${settled.unknown ? `,${settled.unknown} 条陌生来信待查` : ""}。</i>`);

  const message = parts.join("\n");
  console.log("");
  console.log(message.replace(/<[^>]+>/g, ""));

  if (tg.enabled && tg.hasChatId) {
    await tg.send(message);
    console.log("\nSent to Telegram.");
  } else {
    console.log("\n(Telegram not configured — run Setup Telegram to push this to your phone.)");
  }
}

// Only auto-run when this file is launched directly (e.g. the .command), not
// when another script imports settle() to reuse the Evolution sweep.
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
