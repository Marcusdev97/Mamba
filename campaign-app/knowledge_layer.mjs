// knowledge_layer.mjs — Layer 2: per-project knowledge (YAML sheets + Notion facts).
//
// 设计 (2026-07-11):
//   Layer 0 = bot rules / classifier   (安全反射, 不看内容语义)
//   Layer 1 = brain_service            (对话引擎: 分类 -> 起草 -> 人工批准)
//   Layer 2 = 这个文件                  (项目知识: 哪个盘 + 该盘能讲什么)
//
// 数据流:
//   campaign-assets/knowledge/<project>.yaml   (每盘一份, 丢进去就生效)
//     + campaign-data/brain/knowledge.json     (Notion verified facts, 按 project 过滤)
//     -> loadProjectContext(projectName)       (runtime, mtime 缓存, 无网络)
//     -> compile artifacts (debug 用):
//          campaign-data/brain/project_sheets.json
//          campaign-data/brain/index.json
//
// AUTO TRIGGER: 回复进来 -> resolveProjectLocal(phone) 认出是哪个盘 blast 的
//   (active-run -> tracker lead_status -> projects.json 映射), Notion 兜底那步
//   由 brain_service 做 (它有 token)。认不出 -> null, 调用方用默认盘。
//
// YAML 守则:
//   - promos[].valid_until 过期 -> 该 promo 自动消失 (跟 Notion Valid Until 同一个哲学)
//   - do_not_say 列表会进 prompt 的硬性规则
//   - 文件写错 YAML -> 该盘跳过 + 报错到 console, 不会拖垮其他盘

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const dataDir = path.join(rootDir, "campaign-data");
const brainDir = path.join(dataDir, "brain");
const knowledgeDir = path.join(rootDir, "campaign-assets", "knowledge");
// Obsidian vault 的盘资料 (Markdown + frontmatter)。后扫 -> 同名盘覆盖 YAML 版。
const vaultSheetsDir = path.join(rootDir, "brain-vault", "盘资料");

// ---------- name normalization (Gen Starz / gen_starz / GEN STARZ 都算同一个盘) ----------

export function normalizeProjectKey(name) {
  return String(name ?? "").toLowerCase().replace(/[^a-z0-9一-鿿]+/g, "_").replace(/^_+|_+$/g, "");
}

// ---------- YAML sheets (mtime-cached, auto-reload on change) ----------

let sheetCache = { files: new Map(), sheets: new Map(), compiledAt: null };

function todayKL() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" });
}

function activePromos(sheet, today = todayKL()) {
  return (sheet.promos ?? []).filter((p) => {
    const until = p?.valid_until ? String(p.valid_until).slice(0, 10) : null;
    return !until || until >= today;
  });
}

// .md = Obsidian 人话格式: frontmatter(---) 放结构字段, 正文原样给 AI。
// .yaml = 旧格式, 继续支持。同一个盘两种都有时, .md 赢 (扫描顺序保证)。
function readSheetFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  let doc;
  let body = "";
  if (/\.md$/i.test(filePath)) {
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
    if (!m) throw new Error("Markdown 缺 frontmatter (文件开头要有 --- 包住的字段区)");
    doc = yaml.load(m[1]) ?? {};
    // 正文 = 人话区。TODO 行是还没核对的占位, AI 不准看到。
    body = m[2].split(/\r?\n/).filter((line) => !/TODO/i.test(line)).join("\n").trim();
  } else {
    doc = yaml.load(raw) ?? {};
  }
  if (!doc.name && !doc.project) throw new Error("缺 name/project 字段");
  const name = String(doc.name ?? doc.project);
  if (body) doc.body = body;
  return { key: normalizeProjectKey(doc.project_id ?? name), name, sheet: doc };
}

function listSheetFiles() {
  const out = [];
  const scan = (dir, pattern) => {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (pattern.test(f) && !f.startsWith("_")) out.push(path.join(dir, f));
      }
    } catch { /* dir 不存在 = 还没建, 不是错误 */ }
  };
  scan(knowledgeDir, /\.ya?ml$/i);   // 旧 YAML 先扫
  scan(knowledgeDir, /\.md$/i);
  scan(vaultSheetsDir, /\.md$/i);    // vault 的 md 最后扫 -> 同名盘覆盖前面的
  return out;
}

// Scan sheet dirs; reload only files whose mtime changed. Never throws —
// a broken file is skipped (with a console warning) so other 盘 keep working.
export function loadSheetsSync() {
  const entries = listSheetFiles();
  if (!entries.length && !sheetCache.files.size) return sheetCache;
  const seen = new Set();
  let changed = false;
  for (const filePath of entries) {
    const file = path.basename(filePath);
    let mtime = 0;
    try { mtime = fs.statSync(filePath).mtimeMs; } catch { continue; }
    seen.add(filePath);
    const cached = sheetCache.files.get(filePath);
    if (cached?.mtime === mtime) continue;
    changed = true;
    try {
      const { key, name, sheet } = readSheetFile(filePath);
      sheetCache.files.set(filePath, { mtime, key });
      sheetCache.sheets.set(key, { name, sheet, file });
      console.log(`[knowledge] loaded ${file} -> project "${name}"`);
    } catch (error) {
      sheetCache.files.set(filePath, { mtime, key: null });
      console.log(`[knowledge] ⚠️ ${file} 解析失败, 这个盘先跳过: ${error.message}`);
    }
  }
  // dropped files
  for (const filePath of [...sheetCache.files.keys()]) {
    if (!seen.has(filePath)) {
      const { key } = sheetCache.files.get(filePath) ?? {};
      sheetCache.files.delete(filePath);
      if (key) sheetCache.sheets.delete(key);
      changed = true;
    }
  }
  if (changed) {
    sheetCache.compiledAt = new Date().toISOString();
    writeCompiledArtifacts().catch(() => {});
  }
  return sheetCache;
}

// Debug artifacts so 你可以直接打开看 AI 眼里的知识长什么样.
async function writeCompiledArtifacts() {
  const sheets = {};
  const index = [];
  for (const [key, { name, sheet, file }] of sheetCache.sheets) {
    sheets[key] = { name, file, sheet };
    index.push(indexLineOf(name, sheet));
  }
  await fsp.mkdir(brainDir, { recursive: true });
  const write = async (p, payload) => {
    const tmp = `${p}.tmp`;
    await fsp.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`);
    await fsp.rename(tmp, p);
  };
  await write(path.join(brainDir, "project_sheets.json"), { updatedAt: sheetCache.compiledAt, count: Object.keys(sheets).length, sheets });
  await write(path.join(brainDir, "index.json"), { updatedAt: sheetCache.compiledAt, count: index.length, index });
}

// ---------- index line (每盘一行, 给 AI 做转推判断用) ----------

export function indexLineOf(name, sheet) {
  const bits = [name];
  if (sheet.location?.area) bits.push(sheet.location.area);
  if (sheet.price_range?.length === 2) bits.push(`RM${Math.round(sheet.price_range[0] / 1000)}k-${Math.round(sheet.price_range[1] / 1000)}k`);
  if (sheet.monthly_from) bits.push(`月供约 RM${sheet.monthly_from} 起`);
  if (sheet.target_buyer?.length) bits.push(`适合: ${sheet.target_buyer.join("/")}`);
  if (sheet.one_liner) bits.push(sheet.one_liner);
  return bits.join(" · ");
}

// ---------- Notion facts (already Verified-only via brain_cache_sync) ----------

function loadFactsSync() {
  try { return JSON.parse(fs.readFileSync(path.join(brainDir, "knowledge.json"), "utf8"))?.facts ?? []; }
  catch { return []; }
}

// ---------- the main runtime call ----------
//
// Returns everything Layer 1 needs for ONE conversation:
//   { projectName, sheet, promos, facts, indexLines, matched }
// matched=false -> caller asked for a project we don't have a sheet for
// (Notion facts still filter by名字, so partial knowledge still flows).
export function loadProjectContext(projectName) {
  loadSheetsSync();
  const key = normalizeProjectKey(projectName);
  const hit = sheetCache.sheets.get(key) ?? null;
  const allFacts = loadFactsSync();
  const facts = allFacts.filter((f) => {
    const p = normalizeProjectKey(f.project);
    return !p || p === key; // 无 project 的通用 facts + 当前盘的 facts
  });
  const indexLines = [...sheetCache.sheets.values()].map(({ name, sheet }) => indexLineOf(name, sheet));
  return {
    projectName: hit?.name ?? (projectName || null),
    sheet: hit?.sheet ?? null,
    promos: hit ? activePromos(hit.sheet) : [],
    facts,
    indexLines,
    matched: Boolean(hit),
  };
}

export function listProjects() {
  loadSheetsSync();
  return [...sheetCache.sheets.values()].map(({ name, file }) => ({ name, file }));
}

// ---------- project resolution (AUTO TRIGGER, local sources only) ----------
//
// 回复进来是哪个盘的? 按可信度排:
//   1. active-run.json — 正在跑的 blast, assignment 里有这个 phone -> run 的 project
//   2. tracker/lead_status.json — 上次记录的 campaignId -> campaign 配置里的 project
//   3. blast_leads_cache.json — 另一台电脑 blast 后同步回来的 Notion 客户资料
//   4. campaign-assets/projects.json — campaignId 前缀猜 project id
// 认不出 -> null (brain_service 再去 Notion 查, 最后 fallback 默认盘)。

function readJsonSyncSafe(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }

function normalizePhoneLocal(value) {
  let digits = String(value ?? "").replace(/\D/g, "");
  if (digits.startsWith("0")) digits = `60${digits.slice(1)}`;
  return /^\d{8,15}$/.test(digits) ? digits : null;
}

function projectFromCampaignId(campaignId) {
  if (!campaignId) return null;
  const projects = readJsonSyncSafe(path.join(rootDir, "campaign-assets", "projects.json"))?.projects ?? [];
  const cid = normalizeProjectKey(campaignId);
  for (const p of projects) {
    const pid = normalizeProjectKey(p.id);
    if (pid && (cid === pid || cid.startsWith(`${pid}_`))) return p.name ?? p.id;
  }
  return null;
}

export function resolveProjectLocal(phone, senderInstance = "") {
  const n = normalizePhoneLocal(phone);
  if (!n) return null;

  // 1) active run
  const run = readJsonSyncSafe(path.join(dataDir, "active-run.json"));
  if (run?.assignments?.some((j) => normalizePhoneLocal(j?.lead?.phone) === n)) {
    if (run.project) return run.project;
    const fromCid = projectFromCampaignId(run.campaignId);
    if (fromCid) return fromCid;
  }

  // 2) tracker lead_status (last known campaign for this phone)
  const status = readJsonSyncSafe(path.join(dataDir, "tracker", "lead_status.json"));
  const entry = status?.leads?.[n];
  if (entry?.campaignId) {
    const fromCid = projectFromCampaignId(entry.campaignId);
    if (fromCid) return fromCid;
  }

  // 3) Notion Blast Leads local cache. This is the cross-PC fast path: one
  // computer may blast while another receives the webhook. Prefer the row
  // owned by the same sender, then the most recently blasted row.
  const cache = readJsonSyncSafe(path.join(dataDir, "blast_leads_cache.json"));
  const rows = (cache?.records ?? []).filter((record) => normalizePhoneLocal(record?.phone) === n);
  if (rows.length) {
    const sender = String(senderInstance ?? "").trim().toLowerCase();
    const matchingSender = sender
      ? rows.filter((record) => String(record?.senderInstance ?? "").trim().toLowerCase() === sender)
      : [];
    const pool = matchingSender.length ? matchingSender : rows;
    const latest = pool.slice().sort((a, b) => {
      const aAt = new Date(a?.lastBlastAt || a?.firstBlastAt || 0).getTime() || 0;
      const bAt = new Date(b?.lastBlastAt || b?.firstBlastAt || 0).getTime() || 0;
      return bAt - aAt;
    })[0];
    if (latest?.project) return latest.project;
  }

  return null;
}
