// Mamba | Advance Flow
//
// Run this AFTER you blast a next flow (Flow 2, 3, 4, ...). It walks the leads
// that were actually sent in a run and pushes their flow state forward in
// Notion, using the shared FLOW_SEQUENCE map.
//
// How it knows which flow was just sent: each lead's *current* "Next Flow" is
// the flow you just blasted. So Advance reads that, then sets:
//   Last Flow Sent = (the flow just sent)
//   Next Flow      = (the one after it, or "Completed")
//   Cohort Day     = the cohort day of the flow just sent
//   Follow Up Due  = today + that flow's delay days
//   Last Blast At  = this run's last send time
// When a lead reaches the end, Sequence Status -> Completed + Flow Completed At.
//
// Safety: a lead who replied / opted out between the pull and the blast (Stop
// Flag ticked, or Sequence Status no longer "Running") is SKIPPED — Advance
// never re-activates someone who left the automatic sequence.
//
// Usage: node campaign-app/advance_flow.mjs [runFile] [--latest]

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./campaign_core.mjs";
import { flowByLabel, flowStateAfter } from "./flow_sequence.mjs";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(appDir, "..");
const runsDir = path.join(rootDir, "campaign-data", "runs");
const VERSION = "2022-06-28";

const env = await loadEnv();
const token = env.NOTION_API_KEY || env.NOTION_TOKEN;
if (!token) {
  console.log("No NOTION_API_KEY in .env — open Mamba Settings and add the Notion token first.");
  process.exit(1);
}

const config = JSON.parse(await fs.readFile(path.join(rootDir, "campaign-data", "notion_config.json"), "utf8"));
const dbId = String(config.databases.blastLeads).replace(/[^a-fA-F0-9]/g, "");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const klToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" });
const klDate = (iso) => (iso ? new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" }) : null);

// today + days, returned as a Kuala Lumpur YYYY-MM-DD.
function addDaysKL(days) {
  const d = new Date(`${klToday()}T00:00:00+08:00`);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return klDate(d.toISOString());
}

function normalizePhone(value) {
  let digits = String(value ?? "").replace(/\D/g, "");
  if (digits.startsWith("0")) digits = `60${digits.slice(1)}`;
  return /^\d{8,15}$/.test(digits) ? digits : null;
}
const lastSentAt = (job) => job.part2?.sentAt ?? job.part1?.sentAt ?? job.scheduledAt;

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

async function pickRun() {
  const fileArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (fileArg) return path.resolve(fileArg);
  const files = (await fs.readdir(runsDir).catch(() => [])).filter((f) => f.endsWith(".json")).sort().reverse();
  if (!files.length) throw new Error("No campaign run files found.");
  return path.join(runsDir, files[0]); // newest
}

const pSelect = (page, name) => page?.properties?.[name]?.select?.name ?? page?.properties?.[name]?.status?.name ?? "";
const pCheckbox = (page, name) => page?.properties?.[name]?.checkbox === true;

async function findLead(phone) {
  const res = await notion("POST", `/databases/${dbId}/query`, {
    filter: { property: "Phone", phone_number: { equals: phone } },
    page_size: 1,
  });
  return res?.results?.[0] ?? null;
}

async function main() {
  const runFile = await pickRun();
  const run = await readJson(runFile);
  if (!run?.assignments?.length) throw new Error(`No assignments in ${path.basename(runFile)}.`);

  console.log("MAMBA | ADVANCE FLOW");
  console.log("====================");
  console.log(`Run: ${run.runId ?? path.basename(runFile)} · ${run.project ?? "?"}\n`);

  // --sent-flow="Flow 3 - Location" makes this safe to re-run: only advance leads
  // still sitting at that exact flow, so ones already moved on aren't double-advanced.
  // Which flow this run sent. From --sent-flow=, else stored on the run (picker sends
  // record it), so re-running is idempotent — already-advanced leads are skipped.
  const SENT_FLOW = (process.argv.find((a) => a.startsWith("--sent-flow=")) || "").split("=").slice(1).join("=").trim() || run.flowLabel || "";
  if (SENT_FLOW) console.log(`(only advancing leads still at "${SENT_FLOW}")\n`);
  let advanced = 0, completed = 0, optedOut = 0, notEnrolled = 0, notFound = 0, noFlow = 0, alreadyMoved = 0;
  const failed = [];

  for (const job of run.assignments) {
    const phone = normalizePhone(job.lead?.phone);
    if (!phone || !job.part1?.sentAt) continue; // only leads actually sent in this run
    try {
      const page = await findLead(phone);
      if (!page) { notFound += 1; console.log(`SKIP   ${phone} — not in Notion`); continue; }

      // Distinguish the real reason a lead isn't advanceable.
      const seq = pSelect(page, "Sequence Status");
      if (pCheckbox(page, "Stop Flag")) {
        optedOut += 1;
        console.log(`SKIP   ${job.lead?.name ?? phone} — Stop Flag ticked`);
        continue;
      }
      if (!seq) {
        notEnrolled += 1;
        console.log(`SKIP   ${job.lead?.name ?? phone} — not in flow system yet (run Backfill / re-upload first)`);
        continue;
      }
      if (seq !== "Running") {
        optedOut += 1;
        console.log(`SKIP   ${job.lead?.name ?? phone} — left auto sequence (${seq})`);
        continue;
      }

      // the flow we just sent = the lead's current Next Flow
      const sentLabel = pSelect(page, "Next Flow");
      // Re-run safety: skip anyone who already moved past the flow we're fixing.
      if (SENT_FLOW && sentLabel !== SENT_FLOW) {
        alreadyMoved += 1;
        console.log(`SKIP   ${job.lead?.name ?? phone} — 已在 ${sentLabel},不重复推进`);
        continue;
      }
      const sentFlow = flowByLabel(sentLabel);
      if (!sentFlow) { noFlow += 1; console.log(`SKIP   ${job.lead?.name ?? phone} — Next Flow "${sentLabel}" not in sequence`); continue; }

      const state = flowStateAfter(sentFlow.key); // last/next labels, cohortDay, dueDays
      const props = {
        "Last Flow Sent": { select: { name: state.lastFlowLabel } },
        "Next Flow": { select: { name: state.nextFlowLabel } },
        "Cohort Day": { select: { name: state.cohortDay } },
        "Last Blast At": { date: { start: lastSentAt(job) } },
      };
      if (state.nextFlowLabel === "Completed") {
        props["Sequence Status"] = { select: { name: "Completed" } };
        props["Flow Completed At"] = { date: { start: new Date().toISOString() } };
        props["Follow Up Due"] = { date: null };
        completed += 1;
      } else {
        props["Follow Up Due"] = { date: { start: addDaysKL(state.dueDays) } };
        advanced += 1;
      }

      await notion("PATCH", `/pages/${String(page.id).replace(/[^a-fA-F0-9]/g, "")}`, { properties: props });
      console.log(`OK     ${job.lead?.name ?? phone} — ${state.lastFlowLabel} → ${state.nextFlowLabel}`);
    } catch (error) {
      failed.push({ phone, error: error.message });
      console.log(`FAILED ${phone}: ${error.message}`);
    }
    await wait(350); // stay under Notion's rate limit
  }

  console.log("");
  console.log(`Done. Advanced ${advanced}, completed ${completed}, already-moved ${alreadyMoved}, opted-out ${optedOut}, not-enrolled ${notEnrolled}, not-found ${notFound}, no-flow ${noFlow}, failed ${failed.length}.`);
  if (notEnrolled) console.log(`Note: ${notEnrolled} lead(s) aren't in the flow system yet — run 🧬 Backfill Old Leads first, then Pull / blast / Advance.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
