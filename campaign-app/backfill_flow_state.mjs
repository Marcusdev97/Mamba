// Mamba | Backfill Old Leads into the Flow System
//
// One-time migration for leads that were blasted BEFORE the flow upgrade. Those
// rows only have Status = "Blasted" and no Sequence Status, so they are invisible
// to the "Ready for Next Flow" view and never continue to Flow 2.
//
// This script does two things, in the safe order:
//   1) SWEEP — reuse the tested Morning-Check settlement to read WhatsApp history
//      and stop/flag anyone who already replied. Repliers get a Sequence Status
//      that is NOT "Running", so step 2 will skip them.
//   2) ENROLL — every remaining still-"Blasted" lead with no Sequence Status is
//      put into the automatic sequence as if Flow 1 just finished:
//        Sequence Status = Running
//        Last Flow Sent  = Flow 1 - Project Template
//        Next Flow       = Flow 2 - Layout
//        Cohort Day      = Day 0
//        First/Flow Started At = their existing Last Blast At
//        Follow Up Due   = Last Blast At + 2 days   (so spacing is respected)
//        No Reply Count  = 0
//
// Safety: if Evolution can't be reached, we ABORT before enrolling — we never
// mark people "Running" when we couldn't verify whether they already replied.
//
// Usage:
//   node campaign-app/backfill_flow_state.mjs [--dry-run] [--days=45] [--since=YYYY-MM-DD] [--project=Name]

import { loadEnv, makeApi } from "./campaign_core.mjs";
import { createNotionSync } from "./notion_sync.mjs";
import { settle } from "./morning_followup.mjs";
import { flowStateAfter } from "./flow_sequence.mjs";

const TZ = "Asia/Kuala_Lumpur";
const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const daysArg = Number((args.find((a) => a.startsWith("--days=")) || "").split("=")[1] || 45);
const sinceArg = (args.find((a) => a.startsWith("--since=")) || "").split("=")[1] || "";
const projectArg = (args.find((a) => a.startsWith("--project=")) || "").split("=")[1] || "";

const cleanId = (v) => String(v ?? "").replace(/[^a-fA-F0-9]/g, "");
const klDate = (iso) => (iso ? new Date(iso).toLocaleDateString("en-CA", { timeZone: TZ }) : null);
const klToday = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function addDaysKL(ymd, days) {
  const base = ymd || klToday();
  const d = new Date(`${base}T00:00:00+08:00`);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return klDate(d.toISOString());
}

const pSelect = (page, name) => page?.properties?.[name]?.select?.name ?? page?.properties?.[name]?.status?.name ?? "";
const pDateStart = (page, name) => page?.properties?.[name]?.date?.start ?? "";
const pCheckbox = (page, name) => page?.properties?.[name]?.checkbox === true;

async function main() {
  const env = await loadEnv();
  const api = makeApi(env);
  const sync = await createNotionSync({ env, onLog: () => {} });

  console.log("MAMBA | BACKFILL OLD LEADS -> FLOW SYSTEM");
  console.log("========================================");
  if (!sync.enabled) { console.log("Notion token missing. Run 'Set Notion Token.command' first."); process.exit(1); }
  if (DRY) console.log("(dry run — no changes will be written)\n");

  const dbIds = {
    blast: sync.config.databases.blastLeads,
    ads: sync.config.databases.adsLeads,
    recycle: sync.config.databases.recycleLeads,
  };
  const blastDbId = cleanId(dbIds.blast);

  // ---- Step 1: historical reply sweep (reuses Morning-Check settlement) ----
  const sinceMs = sinceArg
    ? new Date(`${sinceArg}T00:00:00+08:00`).getTime()
    : Date.now() - daysArg * 86400000;
  console.log(`Step 1 — Sweeping WhatsApp replies since ${klDate(new Date(sinceMs).toISOString())} (KL)...`);
  const swept = await settle(api, sync, dbIds, sinceMs);
  if (swept.error) {
    console.log(`! ${swept.error}`);
    console.log("\nABORTED before enrolling: could not verify replies. Start Evolution (Docker) and re-run.");
    process.exit(1);
  }
  console.log(`  Instances: ${swept.instances.join(", ")}`);
  console.log(`  Replies found & settled: ${swept.inbound} (these will be skipped in step 2)`);

  // ---- Step 2: enroll the remaining legacy "Blasted" leads ----
  console.log(`\nStep 2 — Enrolling legacy "Blasted" leads (Sequence Status empty)${projectArg ? ` · project=${projectArg}` : ""}...`);
  const state = flowStateAfter("flow_1"); // Flow 1 -> Flow 2

  const filterAnd = [
    { property: "Sequence Status", select: { is_empty: true } },
    { property: "Status", select: { equals: "Blasted" } },
    { property: "Stop Flag", checkbox: { equals: false } },
  ];
  if (projectArg) filterAnd.push({ property: "Project", select: { equals: projectArg } });

  let cursor;
  let enrolled = 0, skipped = 0, scanned = 0;
  const failed = [];
  do {
    const body = { filter: { and: filterAnd }, page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const res = await sync.request("POST", `/databases/${blastDbId}/query`, body);
    for (const page of res?.results ?? []) {
      scanned += 1;
      // Defensive: a replier picked up in step 1 already has a Sequence Status /
      // Last Reply At, and the filter excludes them — but double-check.
      if (pSelect(page, "Sequence Status") || pDateStart(page, "Last Reply At") || pCheckbox(page, "Stop Flag")) {
        skipped += 1;
        continue;
      }
      const firstBlast = pDateStart(page, "Last Blast At") || new Date().toISOString();
      const followUpDue = addDaysKL(klDate(firstBlast), state.dueDays);
      const props = {
        "Sequence Status": { select: { name: "Running" } },
        "Last Flow Sent": { select: { name: state.lastFlowLabel } },
        "Next Flow": { select: { name: state.nextFlowLabel } },
        "Cohort Day": { select: { name: state.cohortDay } },
        "First Blast At": { date: { start: firstBlast } },
        "Flow Started At": { date: { start: firstBlast } },
        "No Reply Count": { number: 0 },
        "Follow Up Due": { date: { start: followUpDue } },
      };
      if (DRY) { enrolled += 1; continue; }
      try {
        await sync.updatePage(page.id, props);
        enrolled += 1;
        await wait(330); // stay under Notion's rate limit
      } catch (error) {
        failed.push({ id: page.id, error: error.message });
      }
    }
    cursor = res?.has_more ? res?.next_cursor : null;
  } while (cursor);

  console.log("");
  console.log(`Done. Swept replies ${swept.inbound}. Scanned ${scanned} legacy leads.`);
  console.log(`${DRY ? "Would enroll" : "Enrolled"} ${enrolled}, skipped ${skipped} (already replied/stopped), failed ${failed.length}.`);
  if (!DRY) console.log(`\n回填完成。去「选人发下一轮」页面点刷新,到期的人(Mid Valley 今天)就会列出来,即可发 Flow 2。`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
