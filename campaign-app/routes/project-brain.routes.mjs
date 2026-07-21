import fs from "node:fs/promises";
import path from "node:path";
import { httpError, json, readJson } from "../lib/http.mjs";
import { createMarketDashboardService, isExcludedMarketProject } from "../lib/market-dashboard-service.mjs";
import { buildProjectBrainExport, buildProjectBrainWorkbook, renderProjectBrainMarkdown } from "../lib/project-brain-export.mjs";
import {
  fillFromLegacyKb,
  LEGACY_KB_DIR,
  loadLegacyMarketKb,
  numericRange,
  parseFrontmatter,
} from "../lib/market-legacy-kb.mjs";
import { listProjects, loadProjectContext, normalizeProjectKey } from "../knowledge_layer.mjs";

function jsonNoStore(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, max-age=0",
    Pragma: "no-cache",
  });
  res.end(JSON.stringify(data));
}

function marketDir(runtime) {
  return path.join(runtime.paths.rootDir, ...LEGACY_KB_DIR);
}

const fallbackServices = new WeakMap();
function companyMarket(runtime) {
  if (runtime.marketDashboard) return runtime.marketDashboard;
  if (!fallbackServices.has(runtime)) {
    fallbackServices.set(runtime, createMarketDashboardService({
      rootDir: runtime.paths.rootDir,
      env: runtime.env,
    }));
  }
  return fallbackServices.get(runtime);
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
  const parsed = parseFrontmatter(raw);
  if (!parsed) throw new Error(`${file} 缺 YAML frontmatter。`);
  const { fields, body, source: frontmatter, parseMode } = parsed;
  if (!fields.name) throw new Error(`${file} 无法读取项目名称。`);
  const [priceMin, priceMax] = numericRange(fields.price_range_rm);
  const [buMin, buMax] = numericRange(fields.bu_range_sf);
  // Read these safety flags directly too. They are one-line fields even in the
  // malformed Fable exports and must never be lost behind an earlier bad quote.
  const qaInline = frontmatter.match(/^qa_flag:\s*(.+)$/m)?.[1]
    ?.replace(/\s+#.*$/, "")
    .replace(/^["']|["']$/g, "")
    .trim();
  const verifiedInline = frontmatter.match(/^verified:\s*(true|false)\b/im)?.[1];
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
    ...(includeBody ? { body: body.trim() } : {}),
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
  const company = companyMarket(runtime);
  const cached = await company.readCache();
  if (cached?.projects?.length) {
    const activeProjects = listProjects();
    // 公司 API 只给薄薄一层清单。completion / land size / maintenance 这些回客户
    // 常被问到的栏位，靠旧 KB 按 uid 补空 —— 只补公司没填的，绝不覆盖。
    const legacyKb = await loadLegacyMarketKb(runtime.paths.rootDir);
    const projects = cached.projects.map((project) => {
      const safe = company.publicProject(project);
      const merged = fillFromLegacyKb(safe, legacyKb.get(project.uid));
      return {
        ...merged,
        detailKey: project.uid,
        activeBrain: isActiveProject(project.name, activeProjects),
        ...(includeBody ? {
          body: [
            `Official project status: ${project.status || "Not listed"}`,
            `Official list price: ${project.priceMin || "Not listed"}${project.priceMax && project.priceMax !== project.priceMin ? ` - ${project.priceMax}` : ""}`,
            "This is a read-only company mirror. Verify before quoting; it never updates Project Editor automatically.",
          ].join("\n"),
        } : {}),
      };
    });
    return {
      projects,
      activeProjects,
      parseErrors: [],
      source: cached.source,
      company: {
        cached: true,
        collectedAt: cached.collectedAt,
        rawCount: cached.rawCount,
        includedCount: cached.includedCount,
        excludedCount: cached.excludedCount,
        excluded: cached.excluded,
        latestChanges: cached.latestChanges || [],
        legacyFilledProjects: projects.filter((project) => project.legacyFilled?.length).length,
      },
    };
  }

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
      const project = parseProject(file, raw, activeProjects, includeBody);
      if (!isExcludedMarketProject(project)) projects.push(project);
    } catch (error) {
      parseErrors.push({ file, error: error.message });
    }
  }
  return {
    projects,
    activeProjects,
    parseErrors,
    source: "brain-vault-import/市场库 (尚未从公司刷新)",
    company: { cached: false, collectedAt: null, rawCount: 0, includedCount: 0, excludedCount: 0, excluded: { Penang: 0, Johor: 0 }, latestChanges: [] },
  };
}

const EXPORT_CONTENT_TYPES = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  md: "text/markdown; charset=utf-8",
  json: "application/json; charset=utf-8",
};

// Active Brain 那几个盘的完整资料 + 已核实事实。fact 没写 project 的算通用，
// 只收一次，不然每个盘都重复一遍，喂给 AI 全是噪音。
function loadActiveBrainExport() {
  const entries = [];
  const generic = new Map();
  for (const { name, file } of listProjects()) {
    const context = loadProjectContext(name);
    const key = normalizeProjectKey(name);
    const facts = [];
    for (const fact of context.facts) {
      if (normalizeProjectKey(fact.project) === key) facts.push(fact);
      else generic.set(`${fact.category ?? ""}::${fact.fact}`, fact);
    }
    entries.push({
      name: context.projectName ?? name,
      file,
      sheet: context.sheet ?? {},
      promos: context.promos ?? [],
      facts,
    });
  }
  return { projects: entries, genericFacts: [...generic.values()] };
}

export function registerProjectBrainRoutes(router) {
  router.get("/api/project-brain", async (_req, res, runtime) => {
    const { projects, activeProjects, parseErrors, source, company } = await loadMarket(runtime);
    const qaReady = projects.filter((project) => project.qaReady).length;
    const verified = projects.filter((project) => project.verified).length;
    const activeMatches = projects.filter((project) => project.activeBrain).length;

    json(res, 200, {
      ok: true,
      generatedAt: new Date().toISOString(),
      source,
      company: {
        ...company,
        ...await companyMarket(runtime).connectionStatus(),
      },
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
    const uid = url.searchParams.get("uid") ?? "";
    if (uid) {
      const company = companyMarket(runtime);
      const project = await company.projectByUid(uid);
      if (!project) throw httpError(404, "公司楼盘缓存里找不到这个项目。请按「从公司刷新」后再试。", "MARKET_PROJECT_NOT_FOUND");
      const companyDetail = await company.projectDetails(uid, { force: url.searchParams.get("refresh") === "1" });
      const activeProjects = listProjects();
      const legacyKb = await loadLegacyMarketKb(runtime.paths.rootDir);
      const safe = fillFromLegacyKb(company.publicProject(project), legacyKb.get(project.uid));
      json(res, 200, {
        ok: true,
        project: {
          ...safe,
          detailKey: project.uid,
          activeBrain: isActiveProject(project.name, activeProjects),
          body: [
            `Official project status: ${project.status || "Not listed"}`,
            `Official list price: ${project.priceMin || "Not listed"}${project.priceMax && project.priceMax !== project.priceMin ? ` - ${project.priceMax}` : ""}`,
            "Read-only company mirror. List price is not net price; verify before quoting.",
          ].join("\n"),
          companyDetail,
        },
      });
      return;
    }
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

  // 导出整个 Project Brain。xlsx 给人开 Excel 看/筛选，md 给 ChatGPT 直接读，json 给程式接。
  // Sales Chart 登入资料和公司 raw payload 由 project-brain-export 挡掉，不会出现在档案里。
  router.get("/api/project-brain/export", async (req, res, runtime) => {
    const url = new URL(req.url, "http://mamba.local");
    const format = (url.searchParams.get("format") || "xlsx").toLowerCase();
    const scope = (url.searchParams.get("scope") || "all").toLowerCase();
    if (!EXPORT_CONTENT_TYPES[format]) throw httpError(400, "导出格式只支持 xlsx / md / json。", "INVALID_EXPORT_FORMAT");
    if (!["all", "active", "market"].includes(scope)) throw httpError(400, "导出范围只支持 all / active / market。", "INVALID_EXPORT_SCOPE");

    let market = { projects: [], source: "", company: {} };
    let details = {};
    if (scope !== "active") {
      market = await loadMarket(runtime, true);
      const cache = await companyMarket(runtime).readDetailCache?.();
      details = cache?.projects ?? {};
    }
    const active = scope === "market" ? { projects: [], genericFacts: [] } : loadActiveBrainExport();

    const payload = buildProjectBrainExport({
      generatedAt: new Date().toISOString(),
      scope,
      source: market.source,
      company: market.company,
      marketProjects: market.projects,
      details,
      activeProjects: active.projects,
      genericFacts: active.genericFacts,
    });
    let body;
    if (format === "xlsx") body = buildProjectBrainWorkbook(payload);
    else if (format === "json") body = `${JSON.stringify(payload, null, 2)}\n`;
    else body = renderProjectBrainMarkdown(payload);

    const filename = `mamba-project-brain-${scope}-${new Date().toISOString().slice(0, 10)}.${format}`;
    res.writeHead(200, {
      "Content-Type": EXPORT_CONTENT_TYPES[format],
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store, max-age=0",
    });
    res.end(body);
  });

  router.post("/api/project-brain/sales-chart/reveal", async (req, res, runtime) => {
    const body = await readJson(req);
    const uid = String(body?.uid || "").trim();
    if (!uid) throw httpError(400, "缺少楼盘 UID，无法读取 Sales Chart。", { code: "MARKET_PROJECT_UID_REQUIRED" });
    const secret = await companyMarket(runtime).salesChartSecret(uid);
    jsonNoStore(res, 200, { ok: true, salesChart: secret });
  });

  // 分批把公司详情 (Layout / Sales Package / Plans) 抓齐。一个盘要打 3 次公司 API，
  // 132 个盘 = 近 400 次请求 —— 一口气打完既会把 HTTP 请求挂死，也太粗鲁。
  // 所以一次只抓一小批、只抓缓存里没有的，前端反复呼叫直到 remaining 归零。
  // 中途关掉页面也不怕，已经抓到的都写进缓存了，下次接着抓。
  router.post("/api/project-brain/details/fetch-batch", async (req, res, runtime) => {
    const body = await readJson(req).catch(() => ({}));
    const limit = Math.min(Math.max(Number(body?.limit) || 8, 1), 25);
    const company = companyMarket(runtime);
    const cached = await company.readCache();
    if (!cached?.projects?.length) throw httpError(409, "公司楼盘缓存是空的。请先按「从公司刷新」。", "MARKET_CACHE_EMPTY");

    const detailCache = await company.readDetailCache?.();
    const missing = cached.projects
      .filter((project) => project.uid && !detailCache?.projects?.[project.uid])
      .map((project) => ({ uid: project.uid, name: project.name }));

    const batch = missing.slice(0, limit);
    const failed = [];
    let fetched = 0;
    let tokenExpired = false;
    for (const project of batch) {
      try {
        await company.refreshProjectDetail(project.uid);
        fetched += 1;
      } catch (error) {
        failed.push({ name: project.name, error: error.message });
        // Token 过期再打下去只会一路失败，直接停手让使用者去换凭证。
        if (error.code === "MARKET_COMPANY_TOKEN_EXPIRED") { tokenExpired = true; break; }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    await runtime.systemLogs?.write({
      level: failed.length ? "warn" : "info",
      area: "market_dashboard",
      event: "property213_detail_batch",
      message: `Company detail batch: ${fetched} fetched, ${failed.length} failed, ${missing.length - fetched} remaining.`,
      context: { fetched, failed: failed.length, remaining: missing.length - fetched, tokenExpired },
    }).catch(() => {});

    json(res, 200, {
      ok: true,
      total: cached.projects.length,
      fetched,
      failed,
      remaining: Math.max(missing.length - fetched, 0),
      tokenExpired,
    });
  });

  router.post("/api/project-brain/refresh", async (_req, res, runtime) => {
    const result = await companyMarket(runtime).refresh();
    await runtime.systemLogs?.write({
      level: "info",
      area: "market_dashboard",
      event: "property213_refresh_completed",
      message: `Company market refresh completed: ${result.includedCount} included, ${result.excludedCount} excluded.`,
      context: result,
    }).catch(() => {});
    json(res, 200, {
      ok: true,
      message: `已从公司更新 ${result.includedCount} 个楼盘，并排除 Penang ${result.excluded.Penang} 个、Johor ${result.excluded.Johor} 个。`,
      result,
    });
  });
}
