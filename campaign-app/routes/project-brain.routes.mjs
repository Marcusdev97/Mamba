import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { httpError, json } from "../lib/http.mjs";
import { listProjects, normalizeProjectKey } from "../knowledge_layer.mjs";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");
// The closing delimiter must be the whole line. Several project descriptions
// contain long dashed separators which are content, not frontmatter endings.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/;

function marketDir(runtime) {
  return path.join(runtime.paths.rootDir, "brain-vault-import", "市场库");
}

function numericRange(value) {
  if (!Array.isArray(value)) return [null, null];
  const numbers = value.slice(0, 2).map((item) => Number(item));
  return numbers.map((item) => Number.isFinite(item) && item > 0 ? item : null);
}

// Fable 的第一批导出里有些 quoted scalar 直接跨行，严格 YAML 会拒绝。
// Dashboard 只读这些文件，所以这里做保守 fallback：按 top-level key 拆值，
// 不改原文件，也不让损坏的扩展字段进入 Active Brain。
function parseLenientFrontmatter(source) {
  const fields = {};
  let currentKey = null;
  let chunks = [];
  const commit = () => {
    if (!currentKey) return;
    const raw = chunks.join("\n").trim();
    if (["price_range_rm", "bu_range_sf"].includes(currentKey)) {
      fields[currentKey] = (raw.match(/-?[\d.]+/g) ?? []).slice(0, 2).map(Number);
    } else if (currentKey === "tags") {
      fields[currentKey] = chunks.map((line) => line.match(/^\s*-\s*(.+)$/)?.[1]?.trim()).filter(Boolean);
    } else if (currentKey === "verified") {
      fields[currentKey] = /^true\b/i.test(raw);
    } else {
      fields[currentKey] = raw
        .replace(/\s+#.*$/, "")
        .replace(/^"/, "")
        .replace(/"$/, "")
        .replace(/\\"/g, '"')
        .trim();
    }
  };
  for (const line of source.split(/\r?\n/)) {
    const keyMatch = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (keyMatch) {
      commit();
      currentKey = keyMatch[1];
      chunks = [keyMatch[2]];
    } else if (currentKey) {
      chunks.push(line);
    }
  }
  commit();
  return fields;
}

function priceBand(minimum) {
  if (!minimum) return "Missing";
  if (minimum < 400000) return "Below RM400k";
  if (minimum < 600000) return "RM400k - RM600k";
  if (minimum < 800000) return "RM600k - RM800k";
  if (minimum < 1000000) return "RM800k - RM1m";
  return "RM1m+";
}

function isActiveProject(name, activeProjects) {
  const key = normalizeProjectKey(name);
  return activeProjects.some((project) => {
    const activeKey = normalizeProjectKey(project.name);
    return key === activeKey || key.startsWith(`${activeKey}_`) || activeKey.startsWith(`${key}_`);
  });
}

function completenessOf(fields) {
  const checks = [
    fields.name,
    fields.developer,
    fields.state && fields.state !== "Unassigned",
    fields.area && fields.area !== "Unassigned",
    fields.location,
    fields.property_type,
    fields.tenure,
    fields.completion,
    numericRange(fields.price_range_rm)[0],
    numericRange(fields.bu_range_sf)[0],
    fields.total_units,
    fields.source,
  ];
  return Math.round((checks.filter(Boolean).length / checks.length) * 100);
}

function parseProject(file, raw, activeProjects, includeBody = false) {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) throw new Error(`${file} 缺 YAML frontmatter。`);
  let fields;
  let parseMode = "yaml";
  try {
    fields = yaml.load(match[1]) ?? {};
  } catch {
    fields = parseLenientFrontmatter(match[1]);
    parseMode = "recovered";
  }
  if (!fields.name) throw new Error(`${file} 无法读取项目名称。`);
  const [priceMin, priceMax] = numericRange(fields.price_range_rm);
  const [buMin, buMax] = numericRange(fields.bu_range_sf);
  // Read these safety flags directly too. They are one-line fields even in the
  // malformed Fable exports and must never be lost behind an earlier bad quote.
  const qaInline = match[1].match(/^qa_flag:\s*(.+)$/m)?.[1]
    ?.replace(/\s+#.*$/, "")
    .replace(/^["']|["']$/g, "")
    .trim();
  const verifiedInline = match[1].match(/^verified:\s*(true|false)\b/im)?.[1];
  const qaFlag = String(qaInline ?? fields.qa_flag ?? "Not checked").trim();
  const qaReady = qaFlag.toUpperCase() === "OK";
  const state = String(fields.state ?? "Unassigned").trim() || "Unassigned";
  const area = String(fields.area ?? "Unassigned").trim() || "Unassigned";

  return {
    file,
    name: String(fields.name ?? file.replace(/\.md$/i, "")),
    uid: String(fields.uid ?? ""),
    developer: String(fields.developer ?? ""),
    state,
    area,
    location: String(fields.location ?? ""),
    propertyType: String(fields.property_type ?? ""),
    tenure: String(fields.tenure ?? "Unknown"),
    landTitle: String(fields.land_title ?? ""),
    landSize: String(fields.land_size ?? ""),
    completion: String(fields.completion ?? ""),
    totalUnits: String(fields.total_units ?? ""),
    priceMin,
    priceMax,
    priceBand: priceBand(priceMin),
    buMin,
    buMax,
    tags: Array.isArray(fields.tags) ? fields.tags.map(String) : [],
    source: String(fields.source ?? ""),
    verified: verifiedInline ? verifiedInline.toLowerCase() === "true" : fields.verified === true,
    qaFlag,
    qaReady,
    completeness: completenessOf(fields),
    activeBrain: isActiveProject(fields.name, activeProjects),
    parseMode,
    ...(includeBody ? { body: match[2].trim() } : {}),
  };
}

function countBy(items, key) {
  const counts = new Map();
  for (const item of items) counts.set(item[key], (counts.get(item[key]) ?? 0) + 1);
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

async function loadMarket(runtime, includeBody = false) {
  const dir = marketDir(runtime);
  let files;
  try {
    files = (await fs.readdir(dir))
      .filter((file) => file.endsWith(".md") && !file.startsWith("_"))
      .sort();
  } catch (error) {
    if (error.code === "ENOENT") throw httpError(404, "找不到 brain-vault-import/市场库。请先把 Fable 输出放进 Mamba。", "MARKET_LIBRARY_MISSING");
    throw error;
  }

  const activeProjects = listProjects();
  const projects = [];
  const parseErrors = [];
  for (const file of files) {
    try {
      const raw = await fs.readFile(path.join(dir, file), "utf8");
      projects.push(parseProject(file, raw, activeProjects, includeBody));
    } catch (error) {
      parseErrors.push({ file, error: error.message });
    }
  }
  return { projects, activeProjects, parseErrors };
}

export function registerProjectBrainRoutes(router) {
  router.get("/api/project-brain", async (_req, res, runtime) => {
    const { projects, activeProjects, parseErrors } = await loadMarket(runtime);
    const qaReady = projects.filter((project) => project.qaReady).length;
    const verified = projects.filter((project) => project.verified).length;
    const activeMatches = projects.filter((project) => project.activeBrain).length;

    json(res, 200, {
      ok: true,
      generatedAt: new Date().toISOString(),
      source: "brain-vault-import/市场库",
      summary: {
        marketProjects: projects.length,
        activeBrainSheets: activeProjects.length,
        activeMarketMatches: activeMatches,
        qaReady,
        needsReview: projects.length - qaReady,
        verified,
        missingPrice: projects.filter((project) => !project.priceMin).length,
        unassignedArea: projects.filter((project) => project.area === "Unassigned").length,
        parseErrors: parseErrors.length,
        recoveredFiles: projects.filter((project) => project.parseMode === "recovered").length,
      },
      activeProjects,
      distributions: {
        states: countBy(projects, "state"),
        tenures: countBy(projects, "tenure"),
        priceBands: countBy(projects, "priceBand"),
      },
      projects,
      parseErrors,
    });
  });

  router.get("/api/project-brain/detail", async (req, res, runtime) => {
    const url = new URL(req.url, "http://mamba.local");
    const file = url.searchParams.get("file") ?? "";
    if (!file || path.basename(file) !== file || !file.endsWith(".md") || file.startsWith("_")) {
      throw httpError(400, "项目文件名不正确。", "INVALID_PROJECT_FILE");
    }
    const filePath = path.join(marketDir(runtime), file);
    let raw;
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") throw httpError(404, `找不到项目资料: ${file}`, "PROJECT_NOT_FOUND");
      throw error;
    }
    json(res, 200, { ok: true, project: parseProject(file, raw, listProjects(), true) });
  });
}
