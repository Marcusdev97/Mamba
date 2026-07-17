import fs from "node:fs/promises";
import path from "node:path";

const CACHE_FORMAT = "mamba-property213-market-v1";
const DETAIL_CACHE_FORMAT = "mamba-property213-project-detail-v1";
const PAGE_LIMIT = 500;
const EXCLUDED_REGION_PATTERNS = [
  { key: "Penang", pattern: /\b(?:penang|pulau\s+pinang)\b/i },
  { key: "Johor", pattern: /\bjohor\b/i },
];

function clean(value) {
  return String(value ?? "").trim();
}

function redactSecretText(value) {
  return String(value ?? "")
    .replace(/([?&](?:token|appkey|userid)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\b(token|appkey|userid)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
}

function htmlToText(value) {
  return clean(value)
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(?:p|div|li|h[1-6])\s*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function safeHttpUrl(value) {
  let candidate = clean(value);
  if (!candidate) return "";
  if (candidate.startsWith("//")) candidate = `https:${candidate}`;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate) && /^[\w.-]+\.[a-z]{2,}(?:\/|$)/i.test(candidate)) {
    candidate = `https://${candidate}`;
  }
  try {
    const url = new URL(candidate);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

function numberOrNull(value) {
  const parsed = Number(String(value ?? "").replace(/[,\s]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function firstValue(record, ...keys) {
  for (const key of keys) {
    if (record?.[key] !== null && record?.[key] !== undefined && clean(record[key]) !== "") return record[key];
  }
  return "";
}

function exclusionReason(record) {
  const geography = [record?.State ?? record?.state, record?.Area ?? record?.area, record?.Location ?? record?.location]
    .map(clean).filter(Boolean).join(" ");
  return EXCLUDED_REGION_PATTERNS.find((item) => item.pattern.test(geography))?.key || "";
}

export function isExcludedMarketProject(record) {
  return Boolean(exclusionReason(record));
}

function priceBand(minimum) {
  if (!minimum) return "Missing";
  if (minimum < 400000) return "Below RM400k";
  if (minimum < 600000) return "RM400k - RM600k";
  if (minimum < 800000) return "RM600k - RM800k";
  if (minimum < 1000000) return "RM800k - RM1m";
  return "RM1m+";
}

function completenessOf(project) {
  const checks = [
    project.name,
    project.developer,
    project.state,
    project.area,
    project.location,
    project.propertyType,
    project.tenure,
    project.status,
    project.priceMin,
    project.buMin,
    project.totalUnits,
  ];
  return Math.round(checks.filter(Boolean).length / checks.length * 100);
}

export function normalizeCompanyProject(record, collectedAt = new Date().toISOString()) {
  const uid = clean(firstValue(record, "ProjectUID", "ProjectUid", "UID", "uid"));
  const name = clean(firstValue(record, "Project", "ProjectName", "Name", "name"));
  if (!uid || !name) return null;
  const priceMin = numberOrNull(firstValue(record, "PriceFrom", "PriceMin", "price_from"));
  const priceMax = numberOrNull(firstValue(record, "PriceTo", "PriceMax", "price_to"));
  const project = {
    uid,
    file: "",
    name,
    developer: clean(firstValue(record, "DeveloperName", "Developer", "developer")),
    state: clean(firstValue(record, "State", "state")) || "Unassigned",
    area: clean(firstValue(record, "Area", "area")) || "Unassigned",
    location: clean(firstValue(record, "Location", "Address", "location")),
    propertyType: clean(firstValue(record, "PropertyType", "Type", "property_type")),
    tenure: clean(firstValue(record, "Tenure", "tenure")) || "Unknown",
    landTitle: clean(firstValue(record, "LandTitle", "land_title")),
    completion: clean(firstValue(record, "CompletionDate", "ExpectedCompletion", "Completion", "completion")),
    totalUnits: clean(firstValue(record, "TotalUnit", "TotalUnits", "total_units")),
    totalBlocks: clean(firstValue(record, "TotalBlock", "TotalBlocks", "total_blocks")),
    status: clean(firstValue(record, "ProjectStatus", "Status", "status")),
    priceMin,
    priceMax,
    priceBand: priceBand(priceMin),
    buMin: numberOrNull(firstValue(record, "BuiltUpFrom", "BuiltUpMin", "bu_min")),
    buMax: numberOrNull(firstValue(record, "BuiltUpTo", "BuiltUpMax", "bu_max")),
    pictureUrl: clean(firstValue(record, "Picture", "PictureURL", "Image", "picture")),
    source: "Property 213 company API · official list price",
    sourceType: "property213_api",
    verified: false,
    parseMode: "company-api",
    collectedAt,
    raw: record,
  };
  project.completeness = completenessOf(project);
  project.qaReady = project.completeness >= 75;
  project.qaFlag = project.qaReady
    ? "Company record is structurally complete. Verify list price before quoting."
    : "Company record has missing fields. Review before quoting.";
  return project;
}

function credentialsFromEnv(env = {}) {
  return {
    account: clean(env.P213_ACCOUNT || env.PROPERTY213_ACCOUNT),
    appkey: clean(env.P213_APPKEY || env.PROPERTY213_APPKEY),
    token: clean(env.P213_TOKEN || env.PROPERTY213_TOKEN),
    userid: clean(env.P213_USERID || env.PROPERTY213_USERID),
  };
}

function parseSecretSource(source) {
  const values = {};
  for (const key of ["account", "appkey", "token", "userid"]) {
    const match = source.match(new RegExp(`\\b${key}\\s*:\\s*(["'])([\\s\\S]*?)\\1`));
    if (match) values[key] = match[2];
  }
  return values;
}

function completeCredentials(value) {
  return Boolean(value?.account && value?.appkey && value?.token && value?.userid);
}

function publicProject(project) {
  const { raw, ...safe } = project;
  return safe;
}

function normalizeInformationRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row, index) => ({
      title: clean(firstValue(row, "Title", "Name", "Label")),
      value: htmlToText(firstValue(row, "Value", "Description", "Content")),
      sequence: Number(firstValue(row, "Sequence", "Sort", "Order")) || index + 1,
    }))
    .filter((row) => row.title || row.value)
    .sort((a, b) => a.sequence - b.sequence);
}

function informationSection(rows, pattern) {
  const match = rows.find((row) => pattern.test(row.title));
  return match ? { title: match.title, value: match.value } : null;
}

function salesChartFrom(rows) {
  const section = informationSection(rows, /(?:sales|price)\s*chart/i);
  const value = section?.value || "";
  const website = safeHttpUrl(value.match(/https?:\/\/[^\s<>"']+/i)?.[0] || "");
  const username = clean(value.match(/(?:email(?:\s+address)?|username|user\s*id|login)\s*[:：]\s*([^\s]+)/i)?.[1] || "");
  const password = clean(value.match(/password\s*[:：]\s*([^\n\r]+)/i)?.[1] || "");
  return {
    safe: section ? { title: section.title, website, username, passwordAvailable: Boolean(password) } : null,
    password,
  };
}

function normalizePlan(row, kind) {
  const imageUrl = safeHttpUrl(firstValue(row, "FloorPlan", "SitePlan", "Plan", "Image", "Picture", "URL", "Url"));
  return {
    id: clean(firstValue(row, "FloorPlanID", "SitePlanID", "PlanID", "ID")),
    kind,
    name: clean(firstValue(row, "Name", "FullName", "Title", "Type")) || (kind === "site" ? "Site / Floor Plan" : "Unit Plan"),
    builtUp: numberOrNull(firstValue(row, "BuiltUp", "BuiltUpFrom", "Size")),
    bedrooms: clean(firstValue(row, "Bedroom", "Bedrooms", "Room")),
    bathrooms: clean(firstValue(row, "Bathroom", "Bathrooms")),
    carParks: clean(firstValue(row, "CarPark", "CarParks", "Parking")),
    balcony: row?.Balcony === true,
    dualKey: row?.DualKey === true,
    imageUrl,
  };
}

export function normalizeCompanyProjectDetails({ uid, informationRows, unitPlanRows, sitePlanRows, collectedAt = new Date().toISOString(), errors = [] }) {
  const information = normalizeInformationRows(informationRows);
  const salesChart = salesChartFrom(information);
  return {
    detail: {
      uid: clean(uid),
      refreshedAt: collectedAt,
      layout: informationSection(information, /(?:built\s*up.*layout|layout.*built\s*up|\blayout\b)/i),
      salesPackage: informationSection(information, /sales\s*package/i),
      salesChart: salesChart.safe,
      unitPlans: (Array.isArray(unitPlanRows) ? unitPlanRows : []).map((row) => normalizePlan(row, "unit")),
      sitePlans: (Array.isArray(sitePlanRows) ? sitePlanRows : []).map((row) => normalizePlan(row, "site")),
      errors,
    },
    secret: salesChart.password,
  };
}

function responseError(status, body) {
  const code = Number(body?.Code || status || 0);
  if ([401, 403].includes(status) || [401, 403].includes(code) || /token|unauthor|login|expired/i.test(clean(body?.Message || body?.Error))) {
    const error = new Error("公司 Property 213 登录 token 已过期或无权限。请更新本机凭证后再刷新。");
    error.code = "MARKET_COMPANY_TOKEN_EXPIRED";
    error.statusCode = 401;
    return error;
  }
  const error = new Error(`公司楼盘接口返回异常（HTTP ${status || "?"}${code ? ` / Code ${code}` : ""}）。`);
  error.code = "MARKET_COMPANY_API_FAILED";
  error.statusCode = 502;
  return error;
}

export function createMarketDashboardService({
  rootDir,
  env = {},
  fetchFn = globalThis.fetch,
  clock = () => new Date(),
  cachePath = path.join(rootDir, "campaign-data", "market-dashboard", "property213-projects.json"),
  detailCachePath = path.join(rootDir, "campaign-data", "market-dashboard", "property213-project-details.json"),
  secretPath = path.join(rootDir, "campaign-app", "market-dashboard.secret.js"),
} = {}) {
  let refreshPromise = null;
  const detailRefreshPromises = new Map();
  const salesChartPasswords = new Map();

  async function credentials() {
    const fromEnv = credentialsFromEnv(env);
    if (completeCredentials(fromEnv)) return { ...fromEnv, source: "env" };
    try {
      const fromFile = parseSecretSource(await fs.readFile(secretPath, "utf8"));
      if (completeCredentials(fromFile)) return { ...fromFile, source: "local-secret-file" };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const error = new Error("尚未配置公司楼盘连接。请在 evolution-pilot/.env 设置 P213_ACCOUNT、P213_APPKEY、P213_TOKEN、P213_USERID。");
    error.code = "MARKET_COMPANY_CREDENTIALS_MISSING";
    error.statusCode = 409;
    throw error;
  }

  async function connectionStatus() {
    try {
      const value = await credentials();
      return { configured: true, credentialSource: value.source };
    } catch (error) {
      if (error.code === "MARKET_COMPANY_CREDENTIALS_MISSING") return { configured: false, credentialSource: null };
      throw error;
    }
  }

  async function readCache() {
    try {
      const value = JSON.parse(await fs.readFile(cachePath, "utf8"));
      if (value?.format !== CACHE_FORMAT || !Array.isArray(value?.projects)) return null;
      return value;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      const wrapped = new Error(`公司楼盘缓存损坏：${error.message}`);
      wrapped.code = "MARKET_CACHE_INVALID";
      throw wrapped;
    }
  }

  async function writeCache(value) {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    const tempPath = `${cachePath}.tmp.${process.pid}.${Date.now()}`;
    await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tempPath, cachePath);
    await fs.chmod(cachePath, 0o600);
  }

  async function readDetailCache() {
    try {
      const value = JSON.parse(await fs.readFile(detailCachePath, "utf8"));
      if (value?.format !== DETAIL_CACHE_FORMAT || !value?.projects || typeof value.projects !== "object") return null;
      return value;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      const wrapped = new Error(`公司楼盘详情缓存损坏：${error.message}`);
      wrapped.code = "MARKET_DETAIL_CACHE_INVALID";
      throw wrapped;
    }
  }

  async function writeDetailCache(value) {
    await fs.mkdir(path.dirname(detailCachePath), { recursive: true });
    const tempPath = `${detailCachePath}.tmp.${process.pid}.${Date.now()}`;
    await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tempPath, detailCachePath);
    await fs.chmod(detailCachePath, 0o600);
  }

  async function fetchCompanyRows(url, section) {
    if (typeof fetchFn !== "function") {
      const error = new Error("当前 Node 环境没有 fetch，无法连接公司楼盘接口。");
      error.code = "MARKET_FETCH_UNAVAILABLE";
      throw error;
    }
    let response;
    try {
      response = await fetchFn(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30000) });
    } catch (error) {
      const wrapped = new Error(`读取公司楼盘${section}失败：${redactSecretText(error.message)}`);
      wrapped.code = "MARKET_COMPANY_NETWORK_FAILED";
      wrapped.statusCode = 502;
      throw wrapped;
    }
    let body;
    try { body = await response.json(); } catch { body = null; }
    if (!response.ok || !body || Number(body.Code) !== 200 || body.Result === undefined) {
      throw responseError(response.status, body);
    }
    let rows;
    try { rows = typeof body.Result === "string" ? JSON.parse(body.Result) : body.Result; } catch (error) {
      const wrapped = new Error(`公司楼盘${section}无法解析：${error.message}`);
      wrapped.code = "MARKET_COMPANY_RESPONSE_INVALID";
      wrapped.statusCode = 502;
      throw wrapped;
    }
    if (rows === null || rows === undefined) return [];
    return Array.isArray(rows) ? rows : [rows];
  }

  async function fetchAllProjects() {
    if (typeof fetchFn !== "function") {
      const error = new Error("当前 Node 环境没有 fetch，无法连接公司楼盘接口。");
      error.code = "MARKET_FETCH_UNAVAILABLE";
      throw error;
    }
    const auth = await credentials();
    const all = [];
    const seen = new Set();
    for (let page = 0; page < 20; page += 1) {
      const offset = page * PAGE_LIMIT;
      const query = new URLSearchParams({
        limit: String(PAGE_LIMIT),
        offset: String(offset),
        appkey: auth.appkey,
        token: auth.token,
        userid: auth.userid,
        active: "true",
      });
      const url = `https://app_api.property213.com/v22/accounts/${encodeURIComponent(auth.account)}/projects?${query}`;
      let response;
      try {
        response = await fetchFn(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30000) });
      } catch (error) {
        const wrapped = new Error(`连接公司楼盘接口失败：${redactSecretText(error.message)}`);
        wrapped.code = "MARKET_COMPANY_NETWORK_FAILED";
        wrapped.statusCode = 502;
        throw wrapped;
      }
      let body;
      try { body = await response.json(); } catch { body = null; }
      if (!response.ok || !body || Number(body.Code) !== 200 || body.Result === undefined) {
        throw responseError(response.status, body);
      }
      let rows;
      try { rows = typeof body.Result === "string" ? JSON.parse(body.Result) : body.Result; } catch (error) {
        const wrapped = new Error(`公司楼盘数据无法解析：${error.message}`);
        wrapped.code = "MARKET_COMPANY_RESPONSE_INVALID";
        wrapped.statusCode = 502;
        throw wrapped;
      }
      if (!Array.isArray(rows)) {
        const error = new Error("公司楼盘接口 Result 不是项目列表。");
        error.code = "MARKET_COMPANY_RESPONSE_INVALID";
        error.statusCode = 502;
        throw error;
      }
      let added = 0;
      for (const row of rows) {
        const uid = clean(firstValue(row, "ProjectUID", "ProjectUid", "UID", "uid"));
        if (!uid || seen.has(uid)) continue;
        seen.add(uid);
        all.push(row);
        added += 1;
      }
      if (rows.length < PAGE_LIMIT || added === 0) break;
    }
    return all;
  }

  function detectChanges(previous, projects, detectedAt) {
    const previousByUid = new Map((previous?.projects || []).map((project) => [project.uid, project]));
    const currentByUid = new Map(projects.map((project) => [project.uid, project]));
    const changes = [];
    if (previousByUid.size) {
      for (const project of projects) {
        const old = previousByUid.get(project.uid);
        if (!old) {
          changes.push({ projectUid: project.uid, projectName: project.name, type: "NEW_PROJECT", field: "project", oldValue: null, newValue: project.name, detectedAt });
          continue;
        }
        for (const [field, type] of [["priceMin", "PRICE_CHANGE"], ["priceMax", "PRICE_CHANGE"], ["status", "STATUS_CHANGE"]]) {
          if ((old[field] ?? null) !== (project[field] ?? null)) {
            changes.push({ projectUid: project.uid, projectName: project.name, type, field, oldValue: old[field] ?? null, newValue: project[field] ?? null, detectedAt });
          }
        }
      }
      for (const old of previousByUid.values()) {
        if (!currentByUid.has(old.uid)) changes.push({ projectUid: old.uid, projectName: old.name, type: "DISAPPEARED", field: "active", oldValue: true, newValue: false, detectedAt });
      }
    }
    return changes;
  }

  async function performRefresh() {
    const previous = await readCache();
    const collectedAt = new Date(clock()).toISOString();
    const rawRows = await fetchAllProjects();
    const excluded = { Penang: 0, Johor: 0 };
    const projects = [];
    for (const row of rawRows) {
      const reason = exclusionReason(row);
      if (reason) {
        excluded[reason] += 1;
        continue;
      }
      const normalized = normalizeCompanyProject(row, collectedAt);
      if (normalized) projects.push(normalized);
    }
    projects.sort((a, b) => a.name.localeCompare(b.name));
    const changes = detectChanges(previous, projects, collectedAt);
    const cache = {
      format: CACHE_FORMAT,
      collectedAt,
      source: "Property 213 company API",
      rawCount: rawRows.length,
      includedCount: projects.length,
      excludedCount: excluded.Penang + excluded.Johor,
      excluded,
      projects,
      latestChanges: changes,
      changeHistory: [...(previous?.changeHistory || []), ...changes].slice(-5000),
    };
    await writeCache(cache);
    return {
      collectedAt,
      rawCount: cache.rawCount,
      includedCount: cache.includedCount,
      excludedCount: cache.excludedCount,
      excluded,
      newProjects: changes.filter((change) => change.type === "NEW_PROJECT").length,
      priceChanges: changes.filter((change) => change.type === "PRICE_CHANGE").length,
      statusChanges: changes.filter((change) => change.type === "STATUS_CHANGE").length,
      disappeared: changes.filter((change) => change.type === "DISAPPEARED").length,
    };
  }

  async function refresh() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = performRefresh().finally(() => { refreshPromise = null; });
    return refreshPromise;
  }

  async function projectByUid(uid) {
    const cache = await readCache();
    return cache?.projects?.find((project) => project.uid === clean(uid)) || null;
  }

  async function performProjectDetailRefresh(uid) {
    const projectUid = clean(uid);
    const project = await projectByUid(projectUid);
    if (!project) {
      const error = new Error("公司楼盘缓存里找不到这个项目。请先按「从公司刷新」。");
      error.code = "MARKET_PROJECT_NOT_FOUND";
      error.statusCode = 404;
      throw error;
    }
    const auth = await credentials();
    const query = new URLSearchParams({ appkey: auth.appkey, token: auth.token, userid: auth.userid });
    const base = `https://app_api.property213.com/v7/accounts/${encodeURIComponent(auth.account)}/projects/${encodeURIComponent(projectUid)}`;
    const requests = [
      { key: "information", label: "Information", url: `${base}/details?${query}` },
      { key: "unitPlans", label: "Unit Plan", url: `${base}/units/plans?${query}` },
      { key: "sitePlans", label: "Site / Floor Plan", url: `${base}/units/plans/site?${query}` },
    ];
    const settled = await Promise.allSettled(requests.map((request) => fetchCompanyRows(request.url, request.label)));
    const authFailure = settled.find((result) => result.status === "rejected" && result.reason?.code === "MARKET_COMPANY_TOKEN_EXPIRED");
    if (authFailure) throw authFailure.reason;
    if (settled.every((result) => result.status === "rejected")) throw settled[0].reason;
    const values = { information: [], unitPlans: [], sitePlans: [] };
    const errors = [];
    settled.forEach((result, index) => {
      const request = requests[index];
      if (result.status === "fulfilled") values[request.key] = result.value;
      else errors.push({ section: request.label, code: result.reason?.code || "MARKET_DETAIL_SECTION_FAILED", message: result.reason?.message || `${request.label} 读取失败。` });
    });
    const normalized = normalizeCompanyProjectDetails({
      uid: projectUid,
      informationRows: values.information,
      unitPlanRows: values.unitPlans,
      sitePlanRows: values.sitePlans,
      collectedAt: new Date(clock()).toISOString(),
      errors,
    });
    if (normalized.secret) salesChartPasswords.set(projectUid, normalized.secret);
    else salesChartPasswords.delete(projectUid);
    const cache = await readDetailCache() || { format: DETAIL_CACHE_FORMAT, projects: {} };
    cache.projects[projectUid] = normalized.detail;
    cache.updatedAt = normalized.detail.refreshedAt;
    await writeDetailCache(cache);
    return normalized.detail;
  }

  async function refreshProjectDetail(uid) {
    const projectUid = clean(uid);
    if (detailRefreshPromises.has(projectUid)) return detailRefreshPromises.get(projectUid);
    const promise = performProjectDetailRefresh(projectUid).finally(() => detailRefreshPromises.delete(projectUid));
    detailRefreshPromises.set(projectUid, promise);
    return promise;
  }

  async function projectDetails(uid, { force = false } = {}) {
    const projectUid = clean(uid);
    if (!force) {
      const cache = await readDetailCache();
      if (cache?.projects?.[projectUid]) return cache.projects[projectUid];
    }
    return refreshProjectDetail(projectUid);
  }

  async function salesChartSecret(uid) {
    const projectUid = clean(uid);
    if (!salesChartPasswords.has(projectUid)) await refreshProjectDetail(projectUid);
    const password = salesChartPasswords.get(projectUid) || "";
    const detail = await projectDetails(projectUid);
    if (!password) {
      const error = new Error("这个楼盘的 Information 没有提供 Sales Chart 密码。");
      error.code = "MARKET_SALES_CHART_PASSWORD_MISSING";
      error.statusCode = 404;
      throw error;
    }
    return {
      website: detail.salesChart?.website || "",
      username: detail.salesChart?.username || "",
      password,
    };
  }

  return {
    cachePath,
    detailCachePath,
    connectionStatus,
    readCache,
    readDetailCache,
    refresh,
    refreshProjectDetail,
    projectByUid,
    projectDetails,
    salesChartSecret,
    publicProject,
  };
}
