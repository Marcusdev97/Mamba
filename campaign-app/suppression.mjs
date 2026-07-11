// suppression.mjs — GLOBAL STOP suppression list (Task A1).
//
// Principle: "STOP means stop the PERSON, not the project." One opt-out
// anywhere (any project, any lead database) blocks that phone everywhere,
// forever. Before this module, Stop Flag was only respected per-project:
// someone who said STOP under Gen Starz could be re-imported and re-blasted
// under Binastra. That is the #1 ban + reputation risk — fixed here.
//
// Two gates use this module:
//   Gate 1 (import): server.mjs POST /api/import — suppressed phones never
//                    enter a new cohort, regardless of includeBlasted.
//   Gate 2 (send):   campaign_core.mjs — snapshot refreshed at campaign start,
//                    checked again per lead right before Part 1 goes out.
//   Gate 3 (follow-up): pull_next_flow.mjs — due leads on the global list are
//                    excluded from next-flow cohorts (cross-project safety).
//
// Data flow: Notion (Stop Flag = true across blastLeads/adsLeads/recycleLeads)
//   -> syncSuppressionList() -> campaign-data/suppressed.json (local snapshot)
//   -> loadSuppressionSync() at runtime (no API calls on the hot path).
//
// CLI: `node suppression.mjs` — sync now and print a report.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const dataDir = path.join(rootDir, "campaign-data");
const SNAPSHOT_PATH = path.join(dataDir, "suppressed.json");
const NOTION_VERSION = "2022-06-28";

// Same normalization as the rest of the codebase (campaign_core/notion_upload):
// digits only, leading 0 -> 60 (MY), 8-15 digits or null.
export function normalizePhone(value) {
  let digits = String(value ?? "").replace(/\D/g, "");
  if (digits.startsWith("0")) digits = `60${digits.slice(1)}`;
  return /^\d{8,15}$/.test(digits) ? digits : null;
}

function loadEnv() {
  const env = {};
  try {
    const text = fs.readFileSync(path.join(rootDir, "evolution-pilot", ".env"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* .env optional; process.env may carry the token */ }
  return env;
}

function loadNotionConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, "notion_config.json"), "utf8"));
  } catch {
    return null;
  }
}

async function notion(token, method, pathname, body, attempt = 0) {
  const r = await fetch(`https://api.notion.com/v1${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Notion-Version": NOTION_VERSION },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  if ((r.status === 429 || r.status === 502 || r.status === 503 || r.status === 504) && attempt < 5) {
    const retryAfter = Number(r.headers.get("retry-after")) || (attempt + 1);
    await new Promise((res) => setTimeout(res, Math.min(retryAfter + 0.5, 10) * 1000));
    return notion(token, method, pathname, body, attempt + 1);
  }
  const data = await r.json().catch(() => null);
  if (!r.ok) {
    const err = new Error(data?.message || `Notion ${r.status}`);
    err.status = r.status;
    err.code = data?.code;
    throw err;
  }
  return data;
}

// Pull the phone out of a page no matter what the column is called — find the
// first phone_number property. (Blast Leads calls it "Phone"; Ads/Recycle may
// differ, this stays schema-agnostic.)
function phoneOfPage(page) {
  for (const prop of Object.values(page?.properties ?? {})) {
    if (prop?.type === "phone_number" && prop.phone_number) return normalizePhone(prop.phone_number);
  }
  return null;
}

// Query ONE database for Stop Flag = true (no Project filter — that is the
// whole point). Returns { phones:Set, error:string|null }.
async function fetchStopsFromDb(token, dbId, label) {
  const phones = new Set();
  const clean = String(dbId ?? "").replace(/[^a-fA-F0-9]/g, "");
  if (!clean) return { phones, error: null, label };
  let cursor;
  try {
    do {
      const q = await notion(token, "POST", `/databases/${clean}/query`, {
        filter: { property: "Stop Flag", checkbox: { equals: true } },
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      });
      for (const page of q?.results ?? []) {
        const n = phoneOfPage(page);
        if (n) phones.add(n);
      }
      cursor = q?.has_more ? q?.next_cursor : null;
    } while (cursor);
    return { phones, error: null, label };
  } catch (err) {
    // A database without a "Stop Flag" property 400s — skip it, don't fail the
    // whole sync. Any other DB that DOES have the flag still contributes.
    return { phones, error: `${err.code || err.status || "error"}: ${err.message}`, label };
  }
}

// Fetch the global STOP list from Notion across all configured lead databases.
export async function fetchSuppressedPhones() {
  const env = loadEnv();
  const token = env.NOTION_API_KEY || env.NOTION_TOKEN || process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;
  if (!token) throw new Error("没有 Notion token。先运行 Set Notion Token。");
  const config = loadNotionConfig();
  const dbs = config?.databases ?? {};
  const targets = [
    ["blastLeads", dbs.blastLeads],
    ["adsLeads", dbs.adsLeads],
    ["recycleLeads", dbs.recycleLeads],
  ];
  const set = new Set();
  const report = [];
  for (const [label, id] of targets) {
    const { phones, error } = await fetchStopsFromDb(token, id, label);
    for (const p of phones) set.add(p);
    report.push({ db: label, stops: phones.size, error });
  }
  return { set, report };
}

// ---- local overlay (instant STOP, survives Notion re-sync) -------------------
// STOPs recorded the MOMENT a RED reply arrives — before Notion has the flag
// (stranger numbers, cross-PC blast lag, mid-run). The overlay is union'd into
// every read and every snapshot write, so a Notion re-sync can never wipe a
// stop that only exists locally yet.
const LOCAL_PATH = path.join(dataDir, "suppressed_local.json");

function loadLocalOverlaySync() {
  try {
    const data = JSON.parse(fs.readFileSync(LOCAL_PATH, "utf8"));
    return data?.entries && typeof data.entries === "object" ? data.entries : {};
  } catch {
    return {};
  }
}

// Block one phone RIGHT NOW, everywhere (all projects, all senders). Called by
// the live tracker + morning settlement whenever a verdict carries stopFlag.
export async function addLocalStop(phone, reason = "STOP") {
  const n = normalizePhone(phone);
  if (!n) return false;
  const entries = loadLocalOverlaySync();
  if (!entries[n]) {
    entries[n] = { reason: String(reason || "STOP"), at: new Date().toISOString() };
    await fsp.mkdir(dataDir, { recursive: true });
    const tmp = `${LOCAL_PATH}.tmp`;
    await fsp.writeFile(tmp, `${JSON.stringify({ updatedAt: new Date().toISOString(), entries }, null, 2)}\n`);
    await fsp.rename(tmp, LOCAL_PATH);
  }
  // Refresh the snapshot too so anything reading only suppressed.json sees it.
  try {
    const snap = JSON.parse(await fsp.readFile(SNAPSHOT_PATH, "utf8"));
    const phones = new Set(snap.phones ?? []);
    if (!phones.has(n)) {
      phones.add(n);
      const payload = { ...snap, updatedAt: new Date().toISOString(), count: phones.size, phones: [...phones].sort() };
      const tmp = `${SNAPSHOT_PATH}.tmp`;
      await fsp.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`);
      await fsp.rename(tmp, SNAPSHOT_PATH);
    }
  } catch { /* no snapshot yet — loadSuppressionSync unions the overlay anyway */ }
  return true;
}

// Fetch from Notion AND persist the local snapshot the hot paths read.
// Local overlay is union'd in so a fresh Notion sync never drops instant stops.
export async function syncSuppressionList() {
  const { set, report } = await fetchSuppressedPhones();
  for (const p of Object.keys(loadLocalOverlaySync())) set.add(p);
  await fsp.mkdir(dataDir, { recursive: true });
  const payload = { updatedAt: new Date().toISOString(), count: set.size, phones: [...set].sort() };
  const tmp = `${SNAPSHOT_PATH}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`);
  await fsp.rename(tmp, SNAPSHOT_PATH); // atomic, same pattern as campaign state
  return { set, report, updatedAt: payload.updatedAt };
}

// Runtime read — NO network. Missing snapshot = empty set (fail-open on data,
// but every import/campaign-start re-syncs, so the window is small).
export function loadSuppressionSync() {
  const overlay = Object.keys(loadLocalOverlaySync());
  try {
    const data = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8"));
    return { set: new Set([...(data.phones ?? []), ...overlay]), updatedAt: data.updatedAt ?? null };
  } catch {
    return { set: new Set(overlay), updatedAt: null };
  }
}

export function isSuppressed(phone, set) {
  const n = normalizePhone(phone);
  return Boolean(n && set && set.has(n));
}

// CLI: node suppression.mjs
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  syncSuppressionList()
    .then(({ set, report, updatedAt }) => {
      console.log("MAMBA | GLOBAL SUPPRESSION SYNC");
      console.log("================================");
      for (const r of report) {
        console.log(` ${r.db.padEnd(14)} ${r.error ? `⚠️  skipped (${r.error})` : `${r.stops} stop(s)`}`);
      }
      console.log(` TOTAL          ${set.size} phone(s) on the global STOP list`);
      console.log(` Snapshot       campaign-data/suppressed.json @ ${updatedAt}`);
    })
    .catch((err) => {
      console.error(`Sync failed: ${err.message}`);
      process.exitCode = 1;
    });
}
