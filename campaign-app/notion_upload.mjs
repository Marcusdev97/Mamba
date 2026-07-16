// Upload blasted leads from a run into the Notion "Mamba | Blast Leads" database.
// One row per customer: skips anyone already in Notion (dedup by phone).
// Does NOT need Evolution — reads the run file + writes to Notion only.
// Usage: node campaign-app/notion_upload.mjs [runFile] [--latest]

import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./campaign_core.mjs";
import { buildSenderKey, createDeviceIdentity } from "./lib/device-identity.mjs";
import { getFlow, flowStateAfter } from "./flow_sequence.mjs";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(appDir, "..");
const runsDir = path.join(rootDir, "campaign-data", "runs");
const VERSION = "2022-06-28";

const env = await loadEnv();
const fallbackDevice = createDeviceIdentity(env);
const token = env.NOTION_API_KEY || env.NOTION_TOKEN;
if (!token) {
  console.log("No NOTION_API_KEY in .env — open Mamba Settings and add the Notion token first.");
  process.exit(1);
}

const config = JSON.parse(await fs.readFile(path.join(rootDir, "campaign-data", "notion_config.json"), "utf8"));
const dbId = String(config.databases.blastLeads).replace(/[^a-fA-F0-9]/g, "");
const runsDbId = String(config.databases.campaignRuns ?? "").replace(/[^a-fA-F0-9]/g, "");
const templates = config.templates ?? {};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanId = (v) => String(v ?? "").replace(/[^a-fA-F0-9]/g, "");
const klDateTime = (iso) => (iso ? new Date(iso).toLocaleString("sv-SE", { timeZone: "Asia/Kuala_Lumpur" }) : "?");

function normalizePhone(value) {
  let digits = String(value ?? "").replace(/\D/g, "");
  if (digits.startsWith("0")) digits = `60${digits.slice(1)}`;
  return digits || null;
}
const lastSentAt = (job) => {
  const extras = Array.isArray(job.extraParts) ? job.extraParts.map((e) => e?.sentInfo?.sentAt).filter(Boolean) : [];
  return extras[extras.length - 1] ?? job.part2?.sentAt ?? job.part1?.sentAt ?? job.scheduledAt;
};

async function notion(method, pathname, body, attempt = 0) {
  const res = await fetch(`https://api.notion.com/v1${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Notion-Version": VERSION },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  if ((res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) && attempt < 5) {
    const ra = Number(res.headers.get("retry-after")) || (attempt + 1);
    await new Promise((r) => setTimeout(r, Math.min(ra + 0.5, 10) * 1000));
    return notion(method, pathname, body, attempt + 1);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function readJson(filePath, fallback = null) {
  try { return JSON.parse(await fs.readFile(filePath, "utf8")); } catch { return fallback; }
}

// Kuala Lumpur calendar date (YYYY-MM-DD) for an ISO timestamp.
const klDate = (iso) => (iso ? new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Asia/Kuala_Lumpur" }) : null);
const klToday = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Kuala_Lumpur" });
const klTime = (iso) => (iso ? new Date(iso).toLocaleTimeString("en-GB", { timeZone: "Asia/Kuala_Lumpur", hour: "2-digit", minute: "2-digit" }) : "");
const pad2 = (n) => String(n).padStart(2, "0");

// Add `days` calendar days to a Kuala Lumpur date and return YYYY-MM-DD.
function addDaysKL(iso, days) {
  const base = klDate(iso) || klToday();
  const d = new Date(`${base}T00:00:00+08:00`);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return klDate(d.toISOString());
}

// Accept: "" (today) | "27" (day, this month) | "06-27" / "6/27" (this year) | "2026-06-27".
function parseDateInput(input) {
  const value = String(input ?? "").trim();
  if (!value) return klToday();
  const [yyyy, mm] = klToday().split("-");
  let m;
  if ((m = value.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/))) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  if ((m = value.match(/^(\d{1,2})[-/](\d{1,2})$/))) return `${yyyy}-${pad2(m[1])}-${pad2(m[2])}`;
  if ((m = value.match(/^(\d{1,2})$/))) return `${yyyy}-${mm}-${pad2(m[1])}`;
  throw new Error(`看不懂日期 "${value}"。用:27 / 06-27 / 2026-06-27`);
}

async function listRuns() {
  const files = (await fs.readdir(runsDir).catch(() => [])).filter((f) => f.endsWith(".json")).sort().reverse();
  const runs = [];
  for (const file of files) {
    const run = await readJson(path.join(runsDir, file));
    if (!run?.assignments?.length) continue;
    const when = run.startAt || run.createdAt;
    const sent = run.assignments.filter((j) => j.status === "SENT" || j.part1?.sentAt).length;
    runs.push({
      file: path.join(runsDir, file),
      date: klDate(when),
      label: `${klDateTime(when)} · ${run.mode || "?"} · ${run.assignments.length} leads · ${sent} sent`,
    });
  }
  return runs;
}

// Returns the list of run files to upload, filtered by a chosen KL date.
async function pickRuns() {
  const fileArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (fileArg) return [path.resolve(fileArg)];

  const runs = await listRuns();
  if (!runs.length) throw new Error("No campaign run files found.");
  if (process.argv.includes("--latest")) return [runs[0].file];

  const dateFlag = (process.argv.find((a) => a.startsWith("--date=")) || "").split("=")[1];

  let dateStr;
  if (dateFlag !== undefined && dateFlag !== "") {
    dateStr = parseDateInput(dateFlag);
  } else if (!process.stdin.isTTY) {
    dateStr = klToday(); // scheduled / non-interactive: just today
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`Upload which date? [Enter = today ${klToday()}], or 27 / 06-27 / 2026-06-27: `)).trim();
    rl.close();
    dateStr = parseDateInput(answer);
  }

  const matches = runs.filter((r) => r.date === dateStr);
  if (!matches.length) {
    const recent = [...new Set(runs.map((r) => r.date))].slice(0, 10).join(", ");
    throw new Error(`${dateStr} 没有 blast 记录。最近有记录的日期:${recent}`);
  }
  if (matches.length === 1 || !process.stdin.isTTY) return matches.map((m) => m.file);

  console.log(`\n${dateStr} 有 ${matches.length} 个 blast:`);
  matches.forEach((r, i) => console.log(`  [${i + 1}] ${r.label}`));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`选一个 [数字],或按 Enter = 全部 ${matches.length} 个: `)).trim();
  rl.close();
  if (!answer) return matches.map((m) => m.file);
  const idx = Number(answer) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= matches.length) throw new Error(`Invalid choice: ${answer}`);
  return [matches[idx].file];
}

async function existsInNotion(phone) {
  const result = await notion("POST", `/databases/${dbId}/query`, {
    filter: { property: "Phone", phone_number: { equals: phone } },
    page_size: 1,
  });
  return Boolean(result?.results?.length);
}

// Read the database schema once so we write each property with the type Notion
// actually expects. This avoids 400 errors like sending a "select" to a column
// that is really a "status" (the original bug that blocked all uploads).
async function getSchema() {
  if (!dbId) throw new Error("notion_config.json 里没有 databases.blastLeads。");
  let db;
  try {
    db = await notion("GET", `/databases/${dbId}`);
  } catch (error) {
    if (/HTTP 401/.test(error.message)) {
      throw new Error("Notion 拒绝了你的 token (401)。请到 Mamba Settings 重新设置 NOTION_API_KEY。");
    }
    if (/HTTP 404/.test(error.message)) {
      throw new Error("找不到 Blast Leads 数据库 (404)。在 Notion 打开该数据库 → 右上角 ··· → Connections → 加上你的 integration,然后再试。");
    }
    throw error;
  }
  return db.properties || {};
}

// A single-choice value built to match the column's real type (status OR select).
function choiceValue(schema, name, optionName) {
  const type = schema?.[name]?.type;
  if (type === "status") return { status: { name: optionName } };
  if (type === "select") return { select: { name: optionName } };
  return null; // missing or unexpected type -> skip this property
}

function textValue(schema, name, value) {
  if (!value) return null;
  if (schema?.[name]?.type === "rich_text") return { rich_text: [{ text: { content: String(value).slice(0, 1900) } }] };
  if (schema?.[name]?.type === "select") return { select: { name: String(value).slice(0, 100) } };
  if (schema?.[name]?.type === "status") return { status: { name: String(value).slice(0, 100) } };
  return null;
}

function buildProperties(job, phone, projectName, schema, runPageId, run) {
  const language = String(job.language ?? "").toUpperCase() || "EN";
  const lang = ["EN", "ZH", "BM"].includes(language) ? language : "EN";
  const variants = [job.part1Variant, job.part2?.sentAt ? job.part2Variant : null].filter(Boolean);
  const templateRelations = [...new Set(variants.map((v) => templates[v]?.pageId).filter(Boolean))]
    .map((id) => ({ id: cleanId(id) }));

  // Initial flow state after Flow 1 (the upload always represents Flow 1 sends).
  const flow1 = getFlow("flow_1");
  const state = flowStateAfter("flow_1"); // { lastFlowLabel, nextFlowLabel, cohortDay, dueDays }
  const firstSentAt = job.part1?.sentAt ?? lastSentAt(job);
  const followUpDue = addDaysKL(firstSentAt, state.dueDays); // First blast + 2 days
  const deviceId = run?.deviceId || fallbackDevice.id;
  const senderKey = buildSenderKey(deviceId, job.instanceName);
  const instance = (run?.instances || []).find((item) => (item?.name || item) === job.instanceName);

  const titleProp = Object.keys(schema).find((k) => schema[k]?.type === "title") || "Name";
  const candidates = {
    [titleProp]: { title: [{ text: { content: job.lead.name || phone } }] },
    Phone:
      schema.Phone?.type === "phone_number" ? { phone_number: phone }
      : schema.Phone?.type === "rich_text" ? { rich_text: [{ text: { content: phone } }] }
      : null,
    Status: choiceValue(schema, "Status", "Blasted"),
    Project: choiceValue(schema, "Project", projectName),
    Language: choiceValue(schema, "Language", lang),
    "Sender Instance": choiceValue(schema, "Sender Instance", job.instanceName || "Unknown"),
    "Assigned Sender Key": textValue(schema, "Assigned Sender Key", senderKey),
    "Last Sender Key": textValue(schema, "Last Sender Key", senderKey),
    "Last Sender Phone": schema["Last Sender Phone"]?.type === "phone_number" && instance?.number
      ? { phone_number: normalizePhone(instance.number) }
      : textValue(schema, "Last Sender Phone", normalizePhone(instance?.number)),
    "Last Sent By Device": textValue(schema, "Last Sent By Device", deviceId),
    "Campaign Run ID": textValue(schema, "Campaign Run ID", run?.runId),
    "Last Blast At": schema["Last Blast At"]?.type === "date" ? { date: { start: lastSentAt(job) } } : null,
    "Template Sent": schema["Template Sent"]?.type === "relation" ? { relation: templateRelations } : null,
    "Reply Count": schema["Reply Count"]?.type === "number" ? { number: 0 } : null,
    "Stop Flag": schema["Stop Flag"]?.type === "checkbox" ? { checkbox: false } : null,

    // --- campaign / cohort / flow tracking (added by the flow upgrade) ---
    "Campaign Run":
      runPageId && schema["Campaign Run"]?.type === "relation"
        ? { relation: [{ id: cleanId(runPageId) }] }
        : null,
    "First Blast At": schema["First Blast At"]?.type === "date" ? { date: { start: firstSentAt } } : null,
    "Flow Started At": schema["Flow Started At"]?.type === "date" ? { date: { start: firstSentAt } } : null,
    "Last Flow Sent": choiceValue(schema, "Last Flow Sent", state.lastFlowLabel),
    "Next Flow": choiceValue(schema, "Next Flow", state.nextFlowLabel),
    "Sequence Status": choiceValue(schema, "Sequence Status", "Running"),
    "Cohort Day": choiceValue(schema, "Cohort Day", flow1.cohortDay),
    "Follow Up Due": schema["Follow Up Due"]?.type === "date" ? { date: { start: followUpDue } } : null,
    "No Reply Count": schema["No Reply Count"]?.type === "number" ? { number: 0 } : null,
  };

  const props = {};
  for (const [key, value] of Object.entries(candidates)) if (value) props[key] = value;
  return props;
}

// Create (or update) the single campaign-run row this blast belongs to, and
// return its page id so every lead can be linked to it. Deduped by the run's
// Name so re-uploading the same run updates the row instead of duplicating it.
// Per project decision, the project name is written into Message / Notes only
// (the runs DB "Project" select uses a different option set).
async function upsertCampaignRun(run, projectName) {
  if (!runsDbId) return null;
  const startIso = run.startAt || run.createdAt || new Date().toISOString();
  const sentCount = run.assignments.filter((j) => j.part1?.sentAt).length;
  const name = `${projectName} | ${klDate(startIso)} | Flow 1 (${klTime(startIso)})`;
  const notes = [
    `runId=${run.runId ?? "?"}`,
    `project=${projectName}`,
    `flow=Flow 1 - Project Template`,
    `sent=${sentCount}`,
    run.mode ? `mode=${run.mode}` : null,
  ].filter(Boolean).join(" · ");

  const properties = {
    Name: { title: [{ text: { content: name } }] },
    "Blast datetime": { date: { start: startIso } },
    "Target count": { number: sentCount },
    "Response count": { number: 0 },
    Status: { status: { name: "Sent" } },
    "Message / Notes": { rich_text: [{ text: { content: notes.slice(0, 1900) } }] },
  };

  try {
    const found = await notion("POST", `/databases/${runsDbId}/query`, {
      filter: { property: "Name", title: { equals: name } },
      page_size: 1,
    });
    const existing = found?.results?.[0];
    if (existing) {
      await notion("PATCH", `/pages/${cleanId(existing.id)}`, { properties });
      return existing.id;
    }
    const page = await notion("POST", "/pages", { parent: { database_id: runsDbId }, properties });
    return page.id;
  } catch (error) {
    console.log(`!  Campaign run row failed (${error.message}). Leads will upload without a run link.`);
    return null;
  }
}

async function main() {
  const runFiles = await pickRuns();

  console.log("\nUPLOAD BLAST LEADS -> NOTION");
  console.log("===========================");

  // Preflight: confirm the database is reachable and learn its real schema.
  const schema = await getSchema();
  const statusType = schema.Status?.type ?? "(no Status column)";
  console.log(`Notion OK · Status column type: ${statusType}`);
  console.log(`Uploading ${runFiles.length} blast run(s).`);

  let created = 0;
  let skipped = 0;
  const failed = [];

  for (const runFile of runFiles) {
    const run = await readJson(runFile);
    if (!run?.assignments?.length) {
      console.log(`\n(skip empty run ${path.basename(runFile)})`);
      continue;
    }
    const projectName = run.project || config.project || "Gen Starz";
    console.log(`\n— Run ${run.runId ?? path.basename(runFile)} · ${projectName} · ${klDateTime(run.startAt || run.createdAt)}`);

    const runPageId = await upsertCampaignRun(run, projectName);
    if (runPageId) console.log(`   Campaign run row ready (cohort linked).`);

    for (const job of run.assignments) {
      const phone = normalizePhone(job.lead?.phone);
      if (!phone || !job.part1?.sentAt) continue; // only actually-blasted leads
      try {
        if (await existsInNotion(phone)) {
          skipped += 1;
          console.log(`SKIP    ${job.lead.name} (${phone}) — already in Notion`);
        } else {
          await notion("POST", "/pages", { parent: { database_id: dbId }, properties: buildProperties(job, phone, projectName, schema, runPageId, run) });
          created += 1;
          console.log(`ADDED   ${job.lead.name} (${phone})`);
        }
      } catch (error) {
        failed.push({ name: job.lead?.name, phone, error: error.message });
        console.log(`FAILED  ${job.lead?.name ?? phone}: ${error.message}`);
      }
      await wait(350); // stay under Notion's rate limit
    }
  }

  console.log("");
  console.log(`Done. Added ${created}, skipped ${skipped}, failed ${failed.length}.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
