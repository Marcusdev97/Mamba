// knowledge.routes.mjs — 脑编辑器 (Layer 2 盘资料 + 原料箱) 的 API。
//
// 设计: 你在网页用人话写, 这里负责"convert 去电脑懂的语言" —
// 表单字段 -> YAML frontmatter, 人话正文原样保留, 合成 .md 写进
// brain-vault/盘资料/ (Obsidian 同一份文件, 系统 mtime 自动重载)。
//
//   GET  /api/knowledge/list          盘列表 (md + 旧 yaml)
//   GET  /api/knowledge/get?file=     读一个盘 (parsed fields + body)
//   POST /api/knowledge/save          表单 -> frontmatter + body -> .md
//   POST /api/knowledge/preview       AI 眼中的本盘资料 (TODO 已剔除)
//   POST /api/knowledge/inbox         原料箱: 随手丢的原料存 brain-vault/原料箱/

import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { httpError, json, readJson } from "../lib/http.mjs";
import { loadProjectContext, listProjects, normalizeProjectKey } from "../knowledge_layer.mjs";
import { formatProjectSheet } from "../brain_core.mjs";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");

function vaultSheetsDir(runtime) {
  return path.join(runtime.paths.rootDir, "brain-vault", "盘资料");
}
function inboxDir(runtime) {
  return path.join(runtime.paths.rootDir, "brain-vault", "原料箱");
}

function safeName(value, fallback = "untitled") {
  const cleaned = String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || fallback;
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

async function readSheet(runtime, file) {
  const filePath = path.join(vaultSheetsDir(runtime), file);
  if (path.basename(filePath) !== file || !/\.md$/i.test(file)) throw httpError(400, "非法文件名。");
  const raw = await fs.readFile(filePath, "utf8");
  const m = FM_RE.exec(raw);
  if (!m) throw httpError(400, `${file} 缺 frontmatter。`);
  return { file, fields: yaml.load(m[1]) ?? {}, body: m[2].trim() };
}

// 表单 -> frontmatter object。只收白名单字段, 顺序固定, 空的不写。
function buildFrontmatter(input) {
  const f = {};
  f.project_id = safeName(input.project_id || input.name);
  f.name = String(input.name ?? "").trim();
  if (!f.name) throw httpError(400, "盘名 (name) 必填。");
  if (input.one_liner) f.one_liner = String(input.one_liner).trim();
  const area = String(input.area ?? "").trim();
  const landmark = String(input.landmark ?? "").trim();
  if (area || landmark) f.location = { ...(area ? { area } : {}), ...(landmark ? { landmark } : {}) };
  if (input.developer) f.developer = String(input.developer).trim();
  const pMin = Number(input.price_min);
  const pMax = Number(input.price_max);
  if (pMin > 0 && pMax > 0) f.price_range = [pMin, pMax];
  const monthly = Number(input.monthly_from);
  if (monthly > 0) f.monthly_from = monthly;
  const types = Array.isArray(input.types) ? input.types : [];
  const cleanTypes = types
    .map((t) => ({
      ...(t.layout ? { layout: String(t.layout).trim() } : {}),
      ...(Number(t.sqft) > 0 ? { sqft: Number(t.sqft) } : {}),
      ...(Number(t.from) > 0 ? { from: Number(t.from) } : {}),
    }))
    .filter((t) => t.layout);
  if (cleanTypes.length) f.types = cleanTypes;
  const buyers = String(input.target_buyer ?? "").split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean);
  if (buyers.length) f.target_buyer = buyers;
  const promos = (Array.isArray(input.promos) ? input.promos : [])
    .map((p) => ({
      ...(p.desc ? { desc: String(p.desc).trim() } : {}),
      ...(p.valid_until ? { valid_until: String(p.valid_until).slice(0, 10) } : {}),
    }))
    .filter((p) => p.desc);
  if (promos.length) f.promos = promos;
  const doNotSay = String(input.do_not_say ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (doNotSay.length) f.do_not_say = doNotSay;
  const gAddr = String(input.gallery_address ?? "").trim();
  const gHours = String(input.gallery_hours ?? "").trim();
  if (gAddr || gHours) f.gallery = { ...(gAddr ? { address: gAddr } : {}), ...(gHours ? { hours: gHours } : {}) };
  // 进阶字段 (可选): 直接贴 YAML, merge 进来但不覆盖表单字段。
  if (input.extra_yaml && String(input.extra_yaml).trim()) {
    let extra;
    try { extra = yaml.load(String(input.extra_yaml)) ?? {}; }
    catch (e) { throw httpError(400, `进阶 YAML 解析失败: ${e.message}`); }
    if (typeof extra !== "object" || Array.isArray(extra)) throw httpError(400, "进阶 YAML 要是 key: value 结构。");
    for (const [k, v] of Object.entries(extra)) if (!(k in f)) f[k] = v;
  }
  return f;
}

export function registerKnowledgeRoutes(router) {
  router.get("/api/knowledge/list", async (_req, res, runtime) => {
    const dir = vaultSheetsDir(runtime);
    let files = [];
    try {
      files = (await fs.readdir(dir)).filter((f) => /\.md$/i.test(f) && !f.startsWith("_"));
    } catch { /* vault 还没建 */ }
    const sheets = [];
    for (const file of files) {
      try {
        const { fields, body } = await readSheet(runtime, file);
        const todoCount = (body.match(/TODO/gi) ?? []).length;
        sheets.push({ file, name: fields.name ?? file, project_id: fields.project_id ?? null, todoCount });
      } catch {
        sheets.push({ file, name: file, project_id: null, broken: true });
      }
    }
    // 系统实际载入的盘 (含旧 yaml), 用来对照有没有生效
    const loaded = listProjects();
    json(res, 200, { ok: true, sheets, loaded });
  });

  router.get("/api/knowledge/get", async (req, res, runtime) => {
    const url = new URL(req.url, "http://x");
    const file = url.searchParams.get("file") ?? "";
    json(res, 200, { ok: true, ...(await readSheet(runtime, file)) });
  });

  router.post("/api/knowledge/save", async (req, res, runtime) => {
    const body = await readJson(req);
    const fields = buildFrontmatter(body);
    const text = String(body.body ?? "").trim();
    const file = `${safeName(body.file?.replace(/\.md$/i, "") || fields.project_id)}.md`;
    const md = `---\n${yaml.dump(fields, { lineWidth: 200, quotingType: '"' })}---\n\n${text}\n`;
    const dir = vaultSheetsDir(runtime);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, file), md);
    // 提醒: projects.json 里没有这个盘的话, blast/归属不会认得它
    const projects = JSON.parse(await fs.readFile(path.join(runtime.paths.rootDir, "campaign-assets", "projects.json"), "utf8").catch(() => '{"projects":[]}'));
    const known = (projects.projects ?? []).some((p) => normalizeProjectKey(p.id) === normalizeProjectKey(fields.project_id) || normalizeProjectKey(p.name) === normalizeProjectKey(fields.name));
    await runtime.systemLogs?.write({
      level: "info", area: "brain", event: "knowledge_saved",
      message: "盘资料已保存 (脑编辑器)。", context: { file, name: fields.name },
    }).catch(() => {});
    json(res, 200, { ok: true, file, name: fields.name, inProjectsJson: known });
  });

  router.post("/api/knowledge/preview", async (req, res) => {
    const body = await readJson(req);
    const name = String(body.name ?? "").trim();
    if (!name) throw httpError(400, "缺盘名。");
    const ctx = loadProjectContext(name);
    json(res, 200, {
      ok: true,
      matched: ctx.matched,
      preview: ctx.matched ? formatProjectSheet(ctx) : "(系统还没载入这个盘 — 保存后再试)",
      promos: ctx.promos,
      indexLines: ctx.indexLines,
    });
  });

  router.post("/api/knowledge/inbox", async (req, res, runtime) => {
    const body = await readJson(req);
    const text = String(body.text ?? "").trim();
    if (!text) throw httpError(400, "内容是空的。");
    const title = String(body.title ?? "").trim() || "raw";
    const date = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" });
    const file = `${date}-${safeName(title)}.md`;
    const dir = inboxDir(runtime);
    await fs.mkdir(dir, { recursive: true });
    const md = `# ${title}\n\n> 原料箱: ${new Date().toISOString()} 从脑编辑器丢进来, 待整理进盘资料。\n\n${text}\n`;
    await fs.writeFile(path.join(dir, file), md, { flag: "a" === body.append ? "a" : "w" });
    json(res, 200, { ok: true, file });
  });
}
