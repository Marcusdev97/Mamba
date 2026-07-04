import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { FileBlob, SpreadsheetFile } from "./xlsx_compat.mjs";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(appDir, "..");
const campaignDir = path.join(rootDir, "campaign-assets");
const dataDir = path.join(rootDir, "campaign-data");
const runsDir = path.join(dataDir, "runs");

function normalizePhone(value) {
  let digits = String(value ?? "").replace(/\D/g, "");
  if (digits.startsWith("0")) digits = `60${digits.slice(1)}`;
  return /^\d{8,15}$/.test(digits) ? digits : null;
}

async function importLeads() {
  const cliArg = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
  const sourcePath = path.resolve(cliArg || path.join(rootDir, "Untitled spreadsheet.xlsx"));
  const input = await FileBlob.load(sourcePath);
  const workbook = await SpreadsheetFile.importXlsx(input);
  const sheet = workbook.worksheets.getItemAt(0);
  const values = sheet.getUsedRange(true)?.values ?? [];
  if (values.length < 2) throw new Error("The workbook does not contain any lead rows.");

  const headers = values[0].map((value) => String(value ?? "").trim().toLowerCase());
  const nameIndex = headers.indexOf("name");
  const phoneIndex = headers.indexOf("phone");
  if (nameIndex < 0 || phoneIndex < 0) throw new Error("The workbook needs Name and Phone columns.");

  const seen = new Set();
  const leads = [];
  const rejected = [];
  for (let index = 1; index < values.length; index += 1) {
    const row = values[index];
    const name = String(row[nameIndex] ?? "").trim() || "there";
    const phone = normalizePhone(row[phoneIndex]);
    if (!phone || seen.has(phone)) {
      rejected.push({ row: index + 1, reason: phone ? "duplicate" : "invalid phone" });
      continue;
    }
    seen.add(phone);
    leads.push({ id: `lead_${String(index).padStart(5, "0")}`, name, phone, sourceRow: index + 1 });
  }

  const result = { sourcePath, importedAt: new Date().toISOString(), leads, rejected };
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, "leads.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Imported ${leads.length} leads (${rejected.length} rejected) from ${path.basename(sourcePath)}`);
  return result;
}

const config = JSON.parse(await fs.readFile(path.join(campaignDir, "mid_valley_campaign.json"), "utf8"));
const leadsFile = await importLeads();
const envText = await fs.readFile(path.join(rootDir, "evolution-pilot", ".env"), "utf8");
const env = Object.fromEntries(
  envText.split(/\r?\n/).filter((line) => line && !line.startsWith("#") && line.includes("=")).map((line) => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), line.slice(separator + 1)];
  }),
);

const apiBase = "http://127.0.0.1:8080";
const apiHeaders = { "Content-Type": "application/json", apikey: env.AUTHENTICATION_API_KEY };
const automatedDryRun = process.argv.includes("--dry-run");
let rl;
let stopped = false;
let state;
let runPath;

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const pick = (items) => items[Math.floor(Math.random() * items.length)];

function maskPhone(phone) {
  return `${phone.slice(0, 2)}******${phone.slice(-4)}`;
}

function personalize(text, name) {
  return text.replaceAll("[Name]", name).replaceAll("[名字]", name);
}

async function api(pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, {
    ...options,
    headers: { ...apiHeaders, ...(options.headers ?? {}) },
    signal: AbortSignal.timeout(15000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${pathname}: HTTP ${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function atomicWrite(filePath, value) {
  const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(tempPath, filePath);
}

async function saveState() {
  state.updatedAt = new Date().toISOString();
  await atomicWrite(runPath, state);
  await atomicWrite(path.join(dataDir, "active-run.json"), state);
}

function parseTime(value, fallbackDate) {
  const cleaned = value.trim().toLowerCase();
  if (!cleaned || cleaned === "ok" || cleaned === "yes" || cleaned === "y") return new Date(fallbackDate);
  if (cleaned === "now") return new Date();
  const match = cleaned.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) throw new Error("Use HH:MM, for example 09:00 or 21:00.");
  const date = new Date();
  date.setHours(Number(match[1]), Number(match[2]), 0, 0);
  return date;
}

async function askTime(question, fallbackDate) {
  while (true) {
    const answer = await rl.question(question);
    try {
      return parseTime(answer, fallbackDate);
    } catch (error) {
      console.log(`${error.message} Press Enter to use the default.`);
    }
  }
}

function formatTime(date) {
  return date.toLocaleTimeString("en-MY", { hour: "2-digit", minute: "2-digit", hour12: false });
}

async function openInstances() {
  const items = await api("/instance/fetchInstances");
  return items
    .filter((item) => (item.connectionStatus ?? item?.instance?.state ?? item?.instance?.status) === "open")
    .map((item) => ({
      name: item.name ?? item?.instance?.instanceName,
      owner: String(item.ownerJid ?? item?.instance?.owner ?? "").split("@")[0].split(":")[0],
    }))
    .filter((item) => item.name);
}

function chooseLanguage() {
  const threshold = config.languageSelection.weights.en;
  return Math.random() * 100 < threshold ? "en" : "zh";
}

function buildAssignments(leads, instances, startAt, endAt) {
  const assignments = leads.map((lead, index) => {
    const instance = instances[index % instances.length];
    const language = lead.language ?? chooseLanguage();
    const eligiblePart1 = config.part1.variants.filter((variant) => variant.language === language);
    const part1 = lead.templateId
      ? eligiblePart1.find((variant) => variant.id === lead.templateId)
      : pick(eligiblePart1);
    const part2 = pick(config.part2.variants.filter((variant) => variant.language === language));
    if (!part1 || !part2) throw new Error(`No matching template for ${lead.name}.`);
    const assignment = {
      id: `job_${String(index + 1).padStart(5, "0")}`,
      lead,
      instanceName: instance.name,
      senderLast4: instance.owner.slice(-4),
      language,
      part1Variant: part1.id,
      part2Variant: part2.id,
      part1Text: personalize(part1.text, lead.name),
      part2Text: personalize(part2.text, lead.name),
      status: "QUEUED",
      scheduledAt: null,
      part1: null,
      part2: null,
      error: null,
    };
    return assignment;
  });

  const latestPart1 = endAt.getTime() - config.delivery.partGapSeconds * 1000;
  const interval = assignments.length > 1 ? (latestPart1 - startAt.getTime()) / (assignments.length - 1) : 0;
  assignments.forEach((job, index) => {
    job.scheduledAt = new Date(startAt.getTime() + interval * index).toISOString();
  });
  return assignments;
}

async function sendMedia(instanceName, number, text, relativeMediaPath) {
  const mediaPath = path.join(campaignDir, relativeMediaPath);
  const media = (await fs.readFile(mediaPath)).toString("base64");
  const result = await api(`/message/sendMedia/${encodeURIComponent(instanceName)}`, {
    method: "POST",
    body: JSON.stringify({
      number,
      mediatype: "image",
      mimetype: "image/jpeg",
      caption: text,
      media,
      fileName: path.basename(mediaPath),
      delay: 1000,
    }),
  });
  return { messageId: result?.key?.id ?? null, apiStatus: result?.status ?? null, sentAt: new Date().toISOString() };
}

function collectMessageObjects(value, found = []) {
  if (!value || typeof value !== "object") return found;
  if (value.key && (value.messageTimestamp || value.createdAt)) found.push(value);
  for (const child of Object.values(value)) collectMessageObjects(child, found);
  return found;
}

async function repliedSince(instanceName, phone, sinceIso) {
  try {
    const response = await api(`/chat/findMessages/${encodeURIComponent(instanceName)}`, {
      method: "POST",
      body: JSON.stringify({ where: { key: { remoteJid: `${phone}@s.whatsapp.net` } } }),
    });
    const since = new Date(sinceIso).getTime();
    return collectMessageObjects(response).some((message) => {
      const timestamp = Number(message.messageTimestamp ?? 0);
      const milliseconds = timestamp < 100000000000 ? timestamp * 1000 : timestamp;
      return message?.key?.fromMe === false && milliseconds >= since;
    });
  } catch {
    return false;
  }
}

function summary() {
  const counts = {};
  for (const assignment of state.assignments) counts[assignment.status] = (counts[assignment.status] ?? 0) + 1;
  return counts;
}

function showProgress(current) {
  const counts = summary();
  console.log(`\n[${new Date().toLocaleTimeString("en-MY")}] ${current}`);
  console.log(`Progress: ${JSON.stringify(counts)}`);
}

async function waitUntil(isoTime) {
  while (!stopped) {
    const remaining = new Date(isoTime).getTime() - Date.now();
    if (remaining <= 0) return;
    await wait(Math.min(remaining, 1000));
  }
}

async function processJob(job) {
  if (stopped) return;
  await waitUntil(job.scheduledAt);
  if (stopped) return;
  if (Date.now() > new Date(state.endAt).getTime()) {
    job.status = "SKIPPED_END_TIME";
    await saveState();
    return;
  }

  try {
    job.status = "SENDING_PART1";
    await saveState();
    showProgress(`Part 1 -> ${job.lead.name} (${maskPhone(job.lead.phone)}) via ${job.instanceName}`);
    job.part1 = await sendMedia(job.instanceName, job.lead.phone, job.part1Text, config.part1.media);
    job.status = "WAITING_PART2";
    await saveState();

    await wait(config.delivery.partGapSeconds * 1000);
    if (stopped) return;

    if (config.delivery.cancelPart2WhenCustomerReplies && await repliedSince(job.instanceName, job.lead.phone, job.part1.sentAt)) {
      job.status = "REPLIED_WARM";
      await saveState();
      showProgress(`Reply detected -> ${job.lead.name}; Part 2 cancelled`);
      return;
    }

    if (Date.now() > new Date(state.endAt).getTime()) {
      job.status = "PART1_ONLY_END_TIME";
      await saveState();
      return;
    }

    job.status = "SENDING_PART2";
    await saveState();
    showProgress(`Part 2 -> ${job.lead.name} (${maskPhone(job.lead.phone)}) via ${job.instanceName}`);
    job.part2 = await sendMedia(job.instanceName, job.lead.phone, job.part2Text, config.part2.media);
    job.status = "SENT";
    await saveState();
  } catch (error) {
    job.status = "FAILED";
    job.error = error.message;
    await saveState();
    showProgress(`FAILED -> ${job.lead.name}: ${error.message}`);
    stopped = true;
  }
}

async function runQueue() {
  for (let index = 0; index < state.assignments.length; index += 1) {
    if (stopped) return;
    await processJob(state.assignments[index]);
    if (stopped || index === state.assignments.length - 1) return;
    const minimum = config.delivery.contactGapSeconds.min;
    const maximum = config.delivery.contactGapSeconds.max;
    const gapSeconds = Math.floor(Math.random() * (maximum - minimum + 1)) + minimum;
    showProgress(`Waiting ${gapSeconds}s before the next customer (global serial queue)`);
    await wait(gapSeconds * 1000);
  }
}

process.on("SIGINT", async () => {
  stopped = true;
  if (state) {
    state.status = "STOPPED";
    await saveState().catch(() => {});
  }
  console.log("\nCampaign stopped safely. Progress has been saved.");
  process.exit(0);
});

console.log("MID VALLEY CAMPAIGN LAUNCHER");
console.log("============================");
console.log(`Imported leads: ${leadsFile.leads.length}`);
const instances = await openInstances();
if (instances.length === 0) throw new Error("No OPEN WhatsApp instances are available.");
console.log(`Connected senders (live from Evolution): ${instances.map((item) => `${item.name} (...${item.owner.slice(-4)})`).join(", ")}`);
if (!automatedDryRun) rl = readline.createInterface({ input: process.stdin, output: process.stdout });

let startAt;
let endAt;
let selectedInstances = instances;
let selectedLeads = leadsFile.leads;
let mode = "DRY_RUN";

if (automatedDryRun) {
  startAt = new Date();
  endAt = new Date(Date.now() + 60 * 60 * 1000);
} else {
  const now = new Date();
  const defaultEnd = new Date(now);
  defaultEnd.setHours(21, 0, 0, 0);
  if (defaultEnd <= now) defaultEnd.setTime(now.getTime() + 60 * 60 * 1000);

  startAt = await askTime("Start time [now, press Enter]: ", now);
  while (true) {
    endAt = await askTime(`End time [${formatTime(defaultEnd)}, press Enter]: `, defaultEnd);
    if (endAt <= startAt) {
      console.log("End time must be later than start time. Please try again.");
      continue;
    }
    if (endAt.getTime() - startAt.getTime() <= config.delivery.partGapSeconds * 1000) {
      console.log(`The campaign window must be longer than ${config.delivery.partGapSeconds} seconds. Please try again.`);
      continue;
    }
    break;
  }

  const instanceAnswer = (await rl.question(`Instances [all: ${instances.map((item) => item.name).join(",")}]: `)).trim();
  if (instanceAnswer) {
    const names = new Set(instanceAnswer.split(",").map((value) => value.trim()));
    selectedInstances = instances.filter((item) => names.has(item.name));
    if (selectedInstances.length === 0) throw new Error("None of the selected instances are OPEN.");
  }

  const modeAnswer = (await rl.question("Mode [TEST/LIVE, default TEST]: ")).trim().toUpperCase();
  mode = modeAnswer === "LIVE" ? "LIVE" : "TEST";

  if (mode === "TEST") {
    selectedLeads = [
      { id: "test_mark", name: "Mark", phone: "60168568756", language: "en", templateId: "en_part1_quick_update" },
      { id: "test_ccliu", name: "CC Liu", phone: "60179978682", language: "en", templateId: "en_part1_still_looking" }
    ];
  } else {
    const limitAnswer = (await rl.question(`Number of leads [${selectedLeads.length}]: `)).trim();
    if (limitAnswer) {
      const limit = Number(limitAnswer);
      if (!Number.isInteger(limit) || limit < 1 || limit > selectedLeads.length) throw new Error("Invalid lead count.");
      selectedLeads = selectedLeads.slice(0, limit);
    }
  }
}

const runId = `run_${new Date().toISOString().replace(/[:.]/g, "-")}`;
runPath = path.join(runsDir, `${runId}.json`);
await fs.mkdir(runsDir, { recursive: true });
state = {
  runId,
  campaignId: config.campaignId,
  mode,
  status: mode === "LIVE" ? "READY" : mode === "TEST" ? "READY_TEST" : "DRY_RUN_COMPLETE",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  startAt: startAt.toISOString(),
  endAt: endAt.toISOString(),
  instances: selectedInstances,
  assignments: buildAssignments(selectedLeads, selectedInstances, startAt, endAt),
};
if (mode === "TEST") {
  for (const assignment of state.assignments) assignment.scheduledAt = startAt.toISOString();
}
await saveState();

console.log(`\nSchedule: ${formatTime(startAt)} - ${formatTime(endAt)}`);
console.log(`Leads: ${selectedLeads.length}`);
console.log(`Instances: ${selectedInstances.map((item) => item.name).join(", ")}`);
console.log("Preview:");
for (const job of state.assignments.slice(0, 5)) {
  console.log(`- ${formatTime(new Date(job.scheduledAt))} ${job.lead.name} -> ${job.instanceName}, ${job.language}, ${job.part1Variant}`);
}

if (mode === "DRY_RUN") {
  console.log("\nDRY RUN only. No WhatsApp messages were sent.");
  if (rl) await rl.close();
  process.exit(0);
}

let confirmed = false;
if (mode === "TEST") {
  console.log("\nTEST sends only to Mark (...8756) and CC Liu (...8682). Both receive Part 1 and Part 2.");
  confirmed = (await rl.question("Type SEND to run this two-contact test: ")).trim() === "SEND";
} else {
  const consent = (await rl.question("Confirm recipients opted in. Type YES: ")).trim();
  const confirmation = (await rl.question("Type SEND to start this campaign: ")).trim();
  confirmed = consent === "YES" && confirmation === "SEND";
}
if (!confirmed) {
  state.status = "CANCELLED";
  await saveState();
  console.log("Campaign cancelled. No messages were sent.");
  await rl.close();
  process.exit(0);
}

await rl.close();
state.status = "RUNNING";
await saveState();
await runQueue();
state.status = stopped ? "STOPPED" : "COMPLETED";
await saveState();
console.log(`\nCampaign ${state.status}. Final progress: ${JSON.stringify(summary())}`);
