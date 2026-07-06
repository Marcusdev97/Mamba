// brain_cache_sync.mjs — Notion AI-brain databases -> local JSON cache (Task B5).
//
// Why this exists: the future brain service must answer WhatsApp replies in
// seconds, and Notion's API is rate-limited (~3 req/s) and occasionally down.
// So Notion stays the EDITING surface, this cache is the RUNTIME surface:
//
//   Mamba | Project Knowledge   -> campaign-data/brain/knowledge.json
//   Mamba | Golden Conversations-> campaign-data/brain/golden.json
//   Mamba | Objection Bank      -> campaign-data/brain/objections.json
//
// GUARDRAIL ENFORCED AT CACHE LEVEL: knowledge.json only ever contains facts
// with Verified = true AND not past their Valid Until date. The brain service
// literally cannot see an unverified or expired fact — "AI 不乱讲" is enforced
// by data shape, not by prompt discipline alone. Unverified/expired counts are
// reported in meta so you know what's waiting for PE confirmation.
//
// Usage:
//   node brain_cache_sync.mjs           # sync once, print report
//   node brain_cache_sync.mjs --watch   # sync now + every 30 minutes (Mac Mini mode)
//
// Config: database ids default to the four DBs created 2026-07-04 under
// "Mamba | Content & Templates Hub"; override in campaign-data/notion_config.json:
//   "databases": { ..., "projectKnowledge": "...", "goldenConversations": "...",
//                  "objectionBank": "...", "aiReplyLog": "..." }

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const dataDir = path.join(rootDir, "campaign-data");
const brainDir = path.join(dataDir, "brain");
const NOTION_VERSION = "2022-06-28";
const WATCH_INTERVAL_MS = 30 * 60 * 1000; // 30 min — the "knowledge clock"

const DEFAULT_DBS = {
  projectKnowledge: "339481852caa427ebe6cf4f756d82e47",
  goldenConversations: "dc5c303e463145abb9d635c007120157",
  objectionBank: "f73c35315d604aa682ecf84826cde123",
  aiReplyLog: "4272e2edbf644f44b670c71ae4276051",
};

// ---------- config / auth (same conventions as the rest of the repo) ----------

function loadEnv() {
  const env = {};
  try {
    const text = fs.readFileSync(path.join(rootDir, "evolution-pilot", ".env"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* optional */ }
  return env;
}

function loadNotionConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, "notion_config.json"), "utf8"));
  } catch {
    return null;
  }
}

function resolveDbIds() {
  const cfg = loadNotionConfig()?.databases ?? {};
  const clean = (v) => String(v ?? "").replace(/[^a-fA-F0-9]/g, "");
  return {
    projectKnowledge: clean(cfg.projectKnowledge) || DEFAULT_DBS.projectKnowledge,
    goldenConversations: clean(cfg.goldenConversations) || DEFAULT_DBS.goldenConversations,
    objectionBank: clean(cfg.objectionBank) || DEFAULT_DBS.objectionBank,
  };
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
  if (!r.ok) throw new Error(data?.message || `Notion ${r.status}`);
  return data;
}

async function queryAllPages(token, dbId) {
  const pages = [];
  let cursor;
  do {
    const q = await notion(token, "POST", `/databases/${dbId}/query`, {
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    pages.push(...(q?.results ?? []));
    cursor = q?.has_more ? q?.next_cursor : null;
  } while (cursor);
  return pages;
}

// ---------- property extraction (pure, unit-tested) ----------

export function pText(prop) {
  const parts = prop?.title ?? prop?.rich_text ?? [];
  return parts.map((t) => t?.plain_text ?? "").join("").trim();
}
export function pSelect(prop) {
  return prop?.select?.name ?? null;
}
export function pCheckbox(prop) {
  return prop?.checkbox === true;
}
export function pDate(prop) {
  return prop?.date?.start ?? null;
}

export function mapKnowledgePage(page) {
  const p = page?.properties ?? {};
  return {
    fact: pText(p["Fact"]),
    project: pSelect(p["Project"]),
    category: pSelect(p["Category"]),
    verified: pCheckbox(p["Verified"]),
    source: pText(p["Source"]),
    validUntil: pDate(p["Valid Until"]),
  };
}

export function mapGoldenPage(page) {
  const p = page?.properties ?? {};
  return {
    title: pText(p["Conversation"]),
    scenario: pSelect(p["Scenario"]),
    project: pSelect(p["Project"]),
    customerType: pSelect(p["Customer Type"]),
    outcome: pSelect(p["Outcome"]),
    text: pText(p["Conversation Text"]),
    why: pText(p["Why It Worked"]),
    language: pSelect(p["Language"]),
  };
}

export function mapObjectionPage(page) {
  const p = page?.properties ?? {};
  return {
    says: pText(p["Customer Says"]),
    intent: pText(p["Real Intent"]),
    direction: pText(p["Response Direction"]),
    handoff: pCheckbox(p["Handoff Required"]),
    scenario: pSelect(p["Scenario"]),
    language: pSelect(p["Language"]),
  };
}

// The guardrail: verified AND (no expiry OR expiry >= today). Pure function.
export function splitUsableFacts(facts, today = new Date().toISOString().slice(0, 10)) {
  const usable = [];
  let unverified = 0;
  let expired = 0;
  for (const f of facts) {
    if (!f.fact) continue;
    if (!f.verified) { unverified += 1; continue; }
    if (f.validUntil && String(f.validUntil).slice(0, 10) < today) { expired += 1; continue; }
    usable.push(f);
  }
  return { usable, unverified, expired };
}

// ---------- sync ----------

async function writeJson(filePath, payload) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`);
  await fsp.rename(tmp, filePath); // atomic
}

export async function syncBrainCache() {
  const env = loadEnv();
  const token = env.NOTION_API_KEY || env.NOTION_TOKEN || process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;
  if (!token) throw new Error("没有 Notion token。先运行 Set Notion Token。");
  const dbs = resolveDbIds();
  const updatedAt = new Date().toISOString();

  // Each library syncs independently: one unshared/broken DB must not kill the
  // other two (same per-DB tolerance as suppression.mjs). A failed library keeps
  // its LAST snapshot on disk and the error is reported instead.
  const settled = await Promise.allSettled([
    queryAllPages(token, dbs.projectKnowledge),
    queryAllPages(token, dbs.goldenConversations),
    queryAllPages(token, dbs.objectionBank),
  ]);
  const [k, g, o] = settled.map((r) => (r.status === "fulfilled" ? { pages: r.value, error: null } : { pages: null, error: r.reason?.message ?? "unknown" }));
  const errors = {
    ...(k.error ? { knowledge: k.error } : {}),
    ...(g.error ? { golden: g.error } : {}),
    ...(o.error ? { objections: o.error } : {}),
  };
  if (k.error && g.error && o.error) throw new Error(`所有库都同步失败 — ${k.error}`);

  let usable = null, unverified = 0, expired = 0, totalFacts = 0;
  if (k.pages) {
    const allFacts = k.pages.map(mapKnowledgePage);
    ({ usable, unverified, expired } = splitUsableFacts(allFacts));
    totalFacts = allFacts.length;
    await writeJson(path.join(brainDir, "knowledge.json"), { updatedAt, count: usable.length, facts: usable });
  }
  let golden = null;
  if (g.pages) {
    golden = g.pages.map(mapGoldenPage).filter((row) => row.text);
    await writeJson(path.join(brainDir, "golden.json"), { updatedAt, count: golden.length, conversations: golden });
  }
  let objections = null;
  if (o.pages) {
    objections = o.pages.map(mapObjectionPage).filter((row) => row.says);
    await writeJson(path.join(brainDir, "objections.json"), { updatedAt, count: objections.length, objections });
  }
  await writeJson(path.join(brainDir, "meta.json"), {
    updatedAt,
    knowledge: usable ? { usable: usable.length, unverified, expired, total: totalFacts } : { error: k.error },
    golden: golden ? golden.length : { error: g.error },
    objections: objections ? objections.length : { error: o.error },
    errors,
  });

  return {
    updatedAt,
    usable: usable?.length ?? null, unverified, expired,
    golden: golden?.length ?? null,
    objections: objections?.length ?? null,
    errors,
  };
}

// Runtime read for the brain service — no network on the hot path.
export function loadBrainCacheSync() {
  const read = (name) => {
    try { return JSON.parse(fs.readFileSync(path.join(brainDir, name), "utf8")); }
    catch { return null; }
  };
  return {
    knowledge: read("knowledge.json") ?? { updatedAt: null, count: 0, facts: [] },
    golden: read("golden.json") ?? { updatedAt: null, count: 0, conversations: [] },
    objections: read("objections.json") ?? { updatedAt: null, count: 0, objections: [] },
  };
}

// ---------- CLI ----------

async function runOnce() {
  const r = await syncBrainCache();
  const show = (v, unit) => (v == null ? "⚠️  skipped" : `${v} ${unit}`);
  console.log("MAMBA | BRAIN CACHE SYNC");
  console.log("========================");
  console.log(` knowledge   ${show(r.usable, "usable fact(s)")}${r.usable != null ? `  (skipped: ${r.unverified} unverified, ${r.expired} expired)` : ""}`);
  console.log(` golden      ${show(r.golden, "conversation(s)")}`);
  console.log(` objections  ${show(r.objections, "entrie(s)")}`);
  console.log(` Snapshot    campaign-data/brain/*.json @ ${r.updatedAt}`);
  if (r.unverified > 0) console.log(` ⚠️  ${r.unverified} fact(s) waiting for Verified ✓ — AI cannot see them until you tick the box.`);
  for (const [lib, err] of Object.entries(r.errors ?? {})) {
    console.log(` ⚠️  ${lib} 同步失败: ${err}`);
    if (/Could not find database/i.test(err)) {
      console.log(`     -> 去 Notion 打开「Mamba | Content & Templates Hub」页面 → 右上 ⋯ → Connections → 加上你的 integration,再跑一次。`);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const watch = process.argv.includes("--watch");
  runOnce()
    .then(() => {
      if (!watch) return;
      console.log(`\n--watch: re-syncing every ${WATCH_INTERVAL_MS / 60000} min. Ctrl+C to stop.`);
      setInterval(() => {
        runOnce().catch((err) => console.error(`[brain sync] failed: ${err.message} — keeping last snapshot.`));
      }, WATCH_INTERVAL_MS);
    })
    .catch((err) => {
      console.error(`Sync failed: ${err.message}`);
      process.exitCode = 1;
    });
}
