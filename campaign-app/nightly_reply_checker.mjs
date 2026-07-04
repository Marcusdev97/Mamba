import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { loadEnv, makeApi } from "./campaign_core.mjs";
import { createNotionSync } from "./notion_sync.mjs";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(appDir, "..");
const dataDir = path.join(rootDir, "campaign-data");
const runsDir = path.join(dataDir, "runs");
const trackerDir = path.join(dataDir, "tracker");
const resultsDir = path.join(dataDir, "reply-checks");
const checkerStatePath = path.join(dataDir, "reply-checker-state.json");

function normalizePhone(value) {
  let digits = String(value ?? "").replace(/\D/g, "");
  if (digits.startsWith("0")) digits = `60${digits.slice(1)}`;
  return digits || null;
}

function extractText(message) {
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
    body.templateButtonReplyMessage?.selectedDisplayText,
  ].find((value) => typeof value === "string" && value.trim())?.trim() ?? "";
}

// Like extractText, but never returns empty for a real inbound message: media
// replies (voice notes, images, stickers, reactions, etc.) get a readable label
// instead of being dropped. This is why some replies used to show as "Blasted".
function describeMessage(message) {
  const text = extractText(message);
  if (text) return text;
  const body = message?.message ?? message;
  if (!body || typeof body !== "object") return "[reply]";
  if (body.audioMessage) return body.audioMessage.ptt ? "[voice note]" : "[audio]";
  if (body.imageMessage) return "[image]";
  if (body.videoMessage) return "[video]";
  if (body.stickerMessage) return "[sticker]";
  if (body.documentMessage) return "[document]";
  if (body.locationMessage || body.liveLocationMessage) return "[location]";
  if (body.contactMessage || body.contactsArrayMessage) return "[contact]";
  if (body.reactionMessage) return `[reaction ${body.reactionMessage.text ?? ""}]`.trim();
  if (body.pollCreationMessage || body.pollUpdateMessage) return "[poll]";
  return "[reply]";
}

function collectMessageObjects(value, found = []) {
  if (!value || typeof value !== "object") return found;
  if (value.key && (value.messageTimestamp || value.createdAt || value.message)) found.push(value);
  for (const child of Object.values(value)) collectMessageObjects(child, found);
  return found;
}

function messageTime(message) {
  const timestamp = Number(message.messageTimestamp ?? 0);
  if (!timestamp) return 0;
  return timestamp < 100000000000 ? timestamp * 1000 : timestamp;
}

function firstSentAt(job) {
  return job.part1?.sentAt ?? job.part2?.sentAt ?? job.scheduledAt;
}

function lastSentAt(job) {
  return job.part2?.sentAt ?? job.part1?.sentAt ?? job.scheduledAt;
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function klDateTime(iso) {
  return iso ? new Date(iso).toLocaleString("sv-SE", { timeZone: "Asia/Kuala_Lumpur" }) : "?";
}

// All runs, newest first, with a human-readable label so the user can pick by
// time/size instead of matching filenames.
async function listRuns() {
  const files = (await fs.readdir(runsDir).catch(() => []))
    .filter((file) => file.endsWith(".json"))
    .sort()
    .reverse();
  const runs = [];
  for (const file of files) {
    const run = await readJson(path.join(runsDir, file));
    if (!run?.assignments?.length) continue;
    const sent = run.assignments.filter((job) => job.status === "SENT" || job.part1?.sentAt).length;
    runs.push({
      file: path.join(runsDir, file),
      label: `${klDateTime(run.startAt || run.createdAt)} · ${run.mode || "?"} · ${run.assignments.length} leads · ${sent} sent`,
    });
  }
  return runs;
}

async function pickRun() {
  const runs = await listRuns();
  if (!runs.length) throw new Error("No campaign run files found.");
  // Non-interactive (scheduled task) or --latest: just use the newest.
  if (process.argv.includes("--latest") || !process.stdin.isTTY) return runs[0].file;

  const shown = runs.slice(0, 15);
  console.log("Select a run to check (newest first):\n");
  shown.forEach((run, index) => console.log(`  [${index + 1}] ${run.label}`));
  console.log("");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("Which run? [Enter = 1, the newest]: ")).trim();
  rl.close();
  const index = answer ? Number(answer) - 1 : 0;
  if (!Number.isInteger(index) || index < 0 || index >= shown.length) {
    throw new Error(`Invalid choice: ${answer}`);
  }
  return shown[index].file;
}

// Read-only: is this phone already in the Notion Lead CRM?
// Returns true / false, or null when we can't tell (no token / query error).
async function existsInNotion(sync, phone) {
  if (!sync?.enabled) return null;
  try {
    const result = await sync.queryDataSource(
      sync.config.dataSources.leadCrm,
      { property: "Phone", phone_number: { equals: phone } },
      1,
    );
    return Boolean(result?.results?.length);
  } catch {
    return null;
  }
}

function buildCsv(rows) {
  const header = ["Name", "Phone", "Status", "Language", "Sender Instance", "Template Sent", "Last Blast At", "Reply Count", "Last Reply At", "Last Reply Text"];
  const lines = [header, ...rows.map((r) => [
    r.name, r.phone, r.status, r.language, r.instance, r.template, r.lastBlastAt, r.replyCount, r.lastReplyAt, r.lastReplyText,
  ])];
  return "﻿" + lines.map((line) => line.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

async function apiFindMessages(api, instanceName, phone) {
  return api(`/chat/findMessages/${encodeURIComponent(instanceName)}`, {
    method: "POST",
    body: JSON.stringify({ where: { key: { remoteJid: `${phone}@s.whatsapp.net` } } }),
  });
}

function replyEventFrom(job, message) {
  const phone = normalizePhone(job.lead.phone);
  const text = describeMessage(message);
  const receivedAt = new Date(messageTime(message)).toISOString();
  return {
    id: message?.key?.id ?? `${phone}_${messageTime(message)}`,
    receivedAt,
    instanceName: job.instanceName,
    name: job.lead.name,
    phone,
    leadId: job.lead.id ?? null,
    runId: null,
    campaignId: null,
    sender: job.instanceName,
    status: "WARM",
    category: "Warm",
    text,
  };
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function appendTrackerEvent(event) {
  await fs.mkdir(trackerDir, { recursive: true });
  await fs.appendFile(path.join(trackerDir, "replies.jsonl"), `${JSON.stringify(event)}\n`);
  try {
    await fs.access(path.join(trackerDir, "replies.csv"));
  } catch {
    await fs.writeFile(path.join(trackerDir, "replies.csv"), "\uFEFFtime,name,phone,status,category,instance,message\n");
  }
  await fs.appendFile(path.join(trackerDir, "replies.csv"), `${[
    event.receivedAt,
    event.name,
    event.phone,
    event.status,
    event.category,
    event.instanceName,
    event.text,
  ].map(csvCell).join(",")}\n`);
}

async function loadCheckerState() {
  return readJson(checkerStatePath, { syncedReplyIds: {} });
}

async function saveCheckerState(state) {
  await fs.writeFile(checkerStatePath, `${JSON.stringify(state, null, 2)}\n`);
}

async function main() {
  const env = await loadEnv();
  const api = makeApi(env);
  const sync = await createNotionSync({ env, onLog: () => {} });

  const fileArg = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
  const runFile = fileArg ? path.resolve(fileArg) : await pickRun();
  const run = await readJson(runFile);
  if (!run?.assignments?.length) throw new Error("Run file has no assignments.");

  console.log("MAMBA NIGHTLY REPLY CHECKER");
  console.log("===========================");
  console.log(`Run: ${run.runId ?? path.basename(runFile)}`);
  console.log(`Leads: ${run.assignments.length}`);
  console.log(`Notion lookup: ${sync.enabled ? "ON (split new vs existing)" : "OFF (everyone treated as new)"}`);
  console.log("");

  const checked = [];
  const replied = [];
  const noReply = [];
  const failed = [];
  const newRows = [];
  const existingRows = [];

  for (const job of run.assignments) {
    const phone = normalizePhone(job.lead?.phone);
    // Only leads that were actually blasted belong in the Notion report.
    if (!phone || !job.part1?.sentAt) continue;
    const since = new Date(firstSentAt(job)).getTime();

    try {
      const response = await apiFindMessages(api, job.instanceName, phone);
      const seenIds = new Set();
      const messages = collectMessageObjects(response)
        // Any inbound message counts as a reply now — text OR media (voice note,
        // image, sticker, reaction, etc.). Only fromMe and time are required.
        .filter((message) => message?.key?.fromMe === false)
        .filter((message) => messageTime(message) >= since)
        .filter((message) => {
          const id = message?.key?.id;
          if (!id) return true;
          if (seenIds.has(id)) return false; // dedupe the recursive collector
          seenIds.add(id);
          return true;
        })
        .sort((a, b) => messageTime(a) - messageTime(b));

      checked.push(phone);
      const templates = [job.part1Variant, job.part2?.sentAt ? job.part2Variant : null].filter(Boolean).join("; ");
      const row = {
        name: job.lead.name,
        phone,
        status: messages.length ? "Warm" : "Blasted",
        language: String(job.language ?? "").toUpperCase(),
        instance: job.instanceName,
        template: templates,
        lastBlastAt: klDateTime(lastSentAt(job)),
        replyCount: messages.length,
        lastReplyAt: "",
        lastReplyText: "",
      };

      if (messages.length) {
        const latest = messages[messages.length - 1];
        const event = replyEventFrom(job, latest);
        replied.push(event);
        job.status = "REPLIED_WARM";
        job.reply = { messageId: event.id, text: event.text, receivedAt: event.receivedAt, count: messages.length };
        row.lastReplyAt = klDateTime(event.receivedAt);
        row.lastReplyText = event.text;
        console.log(`WARM      ${job.lead.name} (${phone}) x${messages.length} -> ${event.text}`);
      } else {
        noReply.push(job);
        console.log(`NO REPLY  ${job.lead.name} (${phone})`);
      }

      // Already in Notion? (read-only; null = can't tell -> treat as new)
      const exists = await existsInNotion(sync, phone);
      if (exists === true) existingRows.push(row);
      else newRows.push(row);
    } catch (error) {
      failed.push({ name: job.lead?.name, phone, error: error.message });
      console.log(`FAILED    ${job.lead?.name ?? phone}: ${error.message}`);
    }
  }

  const stamp = (run.runId ?? "run").replace(/[:.]/g, "-");
  const newPath = path.join(rootDir, `notion_NEW_${stamp}.csv`);
  await fs.writeFile(newPath, buildCsv(newRows));
  let existingPath = null;
  if (existingRows.length) {
    existingPath = path.join(rootDir, `notion_EXISTING_${stamp}.csv`);
    await fs.writeFile(existingPath, buildCsv(existingRows));
  }
  await fs.writeFile(runFile, `${JSON.stringify(run, null, 2)}\n`);

  console.log("");
  console.log(`Summary: blasted ${newRows.length + existingRows.length}, NEW ${newRows.length}, already in Notion ${existingRows.length}, warm ${replied.length}, no reply ${noReply.length}, failed ${failed.length}`);
  console.log(`NEW customers CSV (paste into Notion): ${newPath}`);
  if (existingPath) console.log(`Already-in-Notion CSV (for manual update): ${existingPath}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
