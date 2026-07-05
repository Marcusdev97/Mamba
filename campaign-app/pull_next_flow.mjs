// Mamba | Pull Next Flow
//
// Pull the leads who are DUE for their next flow out of Notion and write them
// into spreadsheets the blaster can import directly (Name + Phone columns).
//
// This is the "smart" half of the multi-flow loop: you never hand-filter who to
// blast next. Notion is the brain — anyone who was red-flagged (said "stop" /
// "not interested", or has Stop Flag ticked) is already excluded by the same
// rules the "Ready for Next Flow" view uses. Whatever lands in these files is
// safe to blast.
//
// Output: one xlsx per (Project x Next Flow), plus a manifest.json that
// advance_flow.mjs / you can use to see exactly who was pulled.
//   campaign-data/cohorts/<YYYY-MM-DD>/<Project>__<Next-Flow>.xlsx
//   campaign-data/cohorts/<YYYY-MM-DD>/manifest.json
//
// Usage: node campaign-app/pull_next_flow.mjs [--date=YYYY-MM-DD]

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import { loadEnv } from "./campaign_core.mjs";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(appDir, "..");
const VERSION = "2022-06-28";

const env = await loadEnv();
const token = env.NOTION_API_KEY || env.NOTION_TOKEN;
if (!token) {
  console.log("No NOTION_API_KEY in .env — run 'Set Notion Token.command' first.");
  process.exit(1);
}

const config = JSON.parse(await fs.readFile(path.join(rootDir, "campaign-data", "notion_config.json"), "utf8"));
const dbId = String(config.databases.blastLeads).replace(/[^a-fA-F0-9]/g, "");

const klToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" });
const dateFlag = (process.argv.find((a) => a.startsWith("--date=")) || "").split("=")[1];
const today = dateFlag || klToday();

// Batching (opt-in). Default = one file per Project x Next Flow (no split).
//   --chunks=150,150,180,120  -> exact sizes per part; leftovers become a final part
//   --chunk=150               -> uniform parts of 150
const chunksArg = (process.argv.find((a) => a.startsWith("--chunks=")) || "").split("=")[1] || "";
const chunkArg = (process.argv.find((a) => a.startsWith("--chunk=")) || "").split("=")[1] || "";
const chunkSizes = chunksArg
  ? chunksArg.split(/[,\s]+/).map((n) => parseInt(n, 10)).filter((n) => n > 0)
  : null;
const chunkUniform = chunkArg ? Math.max(1, parseInt(chunkArg, 10) || 0) : 0;

// Split a group's leads into ordered parts based on the chosen mode.
function splitIntoParts(leads) {
  if (chunkSizes && chunkSizes.length) {
    const parts = [];
    let i = 0;
    for (const size of chunkSizes) {
      if (i >= leads.length) break;
      parts.push(leads.slice(i, i + size));
      i += size;
    }
    if (i < leads.length) parts.push(leads.slice(i)); // the rest
    return parts;
  }
  if (chunkUniform) {
    const parts = [];
    for (let i = 0; i < leads.length; i += chunkUniform) parts.push(leads.slice(i, i + chunkUniform));
    return parts;
  }
  return [leads]; // no chunking
}

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

const pTitle = (page, name) => (page?.properties?.[name]?.title ?? []).map((t) => t.plain_text).join("").trim();
const pPhone = (page, name) => String(page?.properties?.[name]?.phone_number ?? "").trim();
const pSelect = (page, name) => page?.properties?.[name]?.select?.name ?? page?.properties?.[name]?.status?.name ?? "";

function normalizePhone(value) {
  let digits = String(value ?? "").replace(/\D/g, "");
  if (digits.startsWith("0")) digits = `60${digits.slice(1)}`;
  return /^\d{8,15}$/.test(digits) ? digits : null;
}

const slug = (s) => String(s || "Unknown").trim().replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "Unknown";

// The same eligibility rules as the "Ready for Next Flow" view, plus Invalid.
function buildFilter() {
  return {
    and: [
      { property: "Sequence Status", select: { equals: "Running" } },
      { property: "Follow Up Due", date: { on_or_before: today } },
      { property: "Stop Flag", checkbox: { equals: false } },
      { property: "Status", select: { does_not_equal: "Stop" } },
      { property: "Status", select: { does_not_equal: "Not Interested" } },
      { property: "Status", select: { does_not_equal: "Appointment" } },
      { property: "Status", select: { does_not_equal: "Invalid" } },
    ],
  };
}

async function queryAll() {
  const pages = [];
  let cursor;
  do {
    const body = { filter: buildFilter(), page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const res = await notion("POST", `/databases/${dbId}/query`, body);
    pages.push(...(res?.results ?? []));
    cursor = res?.has_more ? res?.next_cursor : null;
  } while (cursor);
  return pages;
}

function writeXlsx(filePath, rows) {
  const aoa = [["Name", "Phone"], ...rows.map((r) => [r.name || "there", r.phone])];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Leads");
  XLSX.writeFile(wb, filePath);
}

async function main() {
  console.log("MAMBA | PULL NEXT FLOW");
  console.log("======================");
  console.log(`Pulling leads due on/before ${today} (Sequence Status = Running, red-flags excluded)...\n`);

  const pages = await queryAll();

  // GLOBAL suppression gate (A1): a lead's own Stop Flag is already excluded by
  // the query, but a STOP recorded under ANOTHER project would not be — this
  // snapshot check covers the cross-project case.
  const { loadSuppressionSync } = await import("./suppression.mjs");
  const { set: suppressed, updatedAt: supAt } = loadSuppressionSync();
  if (supAt) console.log(`Global STOP list: ${suppressed.size} phone(s) (snapshot ${supAt}).\n`);
  else console.log("Global STOP list: no snapshot yet — run `node campaign-app/suppression.mjs` once.\n");

  // group by Project + Next Flow
  const groups = new Map(); // key -> { project, nextFlow, leads:[] }
  let noNextFlow = 0;
  let noPhone = 0;
  let suppressedCount = 0;
  for (const page of pages) {
    const phone = normalizePhone(pPhone(page, "Phone"));
    if (!phone) { noPhone += 1; continue; }
    if (suppressed.has(phone)) { suppressedCount += 1; continue; }
    const nextFlow = pSelect(page, "Next Flow");
    if (!nextFlow || nextFlow === "Completed") { noNextFlow += 1; continue; } // nothing to send
    const project = pSelect(page, "Project") || "Unknown";
    const key = `${project}__${nextFlow}`;
    if (!groups.has(key)) groups.set(key, { project, nextFlow, leads: [] });
    groups.get(key).leads.push({ pageId: page.id, name: pTitle(page, "Name"), phone });
  }

  if (!groups.size) {
    console.log("No leads are due for a next flow right now.");
    if (noNextFlow) console.log(`(${noNextFlow} due lead(s) have no next flow / already Completed — nothing to send.)`);
    if (noPhone) console.log(`(${noPhone} due lead(s) skipped: missing/invalid phone.)`);
    if (suppressedCount) console.log(`(${suppressedCount} due lead(s) skipped: on the GLOBAL STOP list.)`);
    return;
  }

  const outDir = path.join(rootDir, "campaign-data", "cohorts", today);
  await fs.mkdir(outDir, { recursive: true });

  const manifest = { generatedAt: new Date().toISOString(), today, chunkMode: chunkSizes ? chunkSizes.join(",") : (chunkUniform || "none"), groups: [] };
  console.log("Wrote these cohort files:\n");
  for (const { project, nextFlow, leads } of [...groups.values()].sort((a, b) =>
    (a.project + a.nextFlow).localeCompare(b.project + b.nextFlow))) {
    const parts = splitIntoParts(leads);
    const multi = parts.length > 1;
    console.log(`  • ${project} · ${nextFlow} · ${leads.length} leads${multi ? ` · split into ${parts.length} batches` : ""}`);
    parts.forEach((part, idx) => {
      const suffix = multi ? `__part${idx + 1}` : "";
      const fileName = `${slug(project)}__${slug(nextFlow)}${suffix}.xlsx`;
      const filePath = path.join(outDir, fileName);
      writeXlsx(filePath, part);
      manifest.groups.push({ project, nextFlow, part: idx + 1, ofParts: parts.length, file: filePath, count: part.length, leads: part });
      console.log(`      ${multi ? `[${idx + 1}/${parts.length}] ` : ""}${part.length} → ${filePath}`);
    });
  }

  await fs.writeFile(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const total = manifest.groups.reduce((n, g) => n + g.count, 0);
  console.log(`\nDone. ${total} lead(s) across ${manifest.groups.length} cohort file(s).`);
  if (noNextFlow) console.log(`Skipped ${noNextFlow} due lead(s) with no next flow / Completed.`);
  if (noPhone) console.log(`Skipped ${noPhone} due lead(s) with missing/invalid phone.`);
  if (suppressedCount) console.log(`Skipped ${suppressedCount} due lead(s) on the GLOBAL STOP list.`);
  console.log(`\nNext: in the Campaign Console, import one of these files as your lead list,`);
  console.log(`blast that flow, then run 'Advance Flow.command' on the new run.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
