import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import { createRouter } from "./lib/http.mjs";
import { registerProjectBrainRoutes } from "./routes/project-brain.routes.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const project = {
  uid: "company-1",
  name: "Binastra Cochrane",
  developer: "Binastra",
  state: "Kuala Lumpur",
  area: "Cheras",
  location: "MRT",
  propertyType: "Service Residence",
  tenure: "Freehold",
  status: "Pre Launch",
  priceMin: 700000,
  priceMax: 900000,
  priceBand: "RM600k - RM800k",
  buMin: 650,
  buMax: 900,
  totalUnits: "500",
  completion: "",
  source: "Property 213 company API · official list price",
  verified: false,
  qaReady: true,
  qaFlag: "Verify before quoting.",
  completeness: 90,
  parseMode: "company-api",
  raw: { confidentialInternalShape: "not returned" },
};
let refreshCalls = 0;
let detailRefreshCalls = 0;
let detailRefreshError = null;
let detailCacheProjects = {};
const companyDetail = {
  uid: "company-1",
  refreshedAt: "2026-07-17T08:30:00.000Z",
  layout: { title: "10. Layout", value: "Type A 650sf" },
  salesPackage: { title: "13. Sales Package", value: "8% rebate" },
  salesChart: { title: "18. Sales Chart", website: "https://chart.example.test", username: "agent@example.test", passwordAvailable: true },
  unitPlans: [{ id: "plan-a", name: "Type A", imageUrl: "https://property213.blob.core.windows.net/test/type-a.jpg" }],
  sitePlans: [],
  errors: [],
};
detailCacheProjects = { [project.uid]: companyDetail };

const marketDashboard = {
  async readCache() {
    return {
      source: "Property 213 company API",
      collectedAt: "2026-07-17T08:00:00.000Z",
      rawCount: 154,
      includedCount: 132,
      excludedCount: 22,
      excluded: { Penang: 1, Johor: 21 },
      projects: [project],
      latestChanges: [],
    };
  },
  publicProject(value) { const { raw, ...safe } = value; return safe; },
  async connectionStatus() { return { configured: true, credentialSource: "env" }; },
  async projectByUid(uid) { return uid === project.uid ? project : null; },
  async projectDetails(uid) { return uid === project.uid ? companyDetail : null; },
  async readDetailCache() { return { projects: detailCacheProjects }; },
  async refreshProjectDetail(uid) {
    detailRefreshCalls += 1;
    if (detailRefreshError) throw detailRefreshError;
    detailCacheProjects[uid] = companyDetail;
    return companyDetail;
  },
  async salesChartSecret(uid) {
    if (uid !== project.uid) throw new Error("missing");
    return { website: "https://chart.example.test", username: "agent@example.test", password: "secret-test" };
  },
  async refresh() {
    refreshCalls += 1;
    return {
      collectedAt: "2026-07-17T09:00:00.000Z",
      rawCount: 154,
      includedCount: 132,
      excludedCount: 22,
      excluded: { Penang: 1, Johor: 21 },
      newProjects: 0,
      priceChanges: 0,
      statusChanges: 0,
      disappeared: 0,
    };
  },
};
const runtime = {
  host: "127.0.0.1",
  port: 8787,
  paths: { rootDir: ROOT },
  env: {},
  marketDashboard,
  systemLogs: { async write() {} },
};
const router = createRouter(runtime);
registerProjectBrainRoutes(router);

async function requestRaw(method, url, requestBody = null) {
  let status = 0;
  let body = "";
  let headers = {};
  const res = {
    writeHead(value, valueHeaders = {}) { status = value; headers = valueHeaders; },
    end(value) { body = Buffer.isBuffer(value) ? value : String(value ?? ""); },
  };
  const req = {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      if (requestBody !== null) yield Buffer.from(JSON.stringify(requestBody));
    },
  };
  const handled = await router.dispatch(req, res);
  return { handled, status, headers, body };
}

async function request(method, url, requestBody = null) {
  const result = await requestRaw(method, url, requestBody);
  return { ...result, body: JSON.parse(result.body) };
}

const list = await request("GET", "/api/project-brain");
assert.equal(list.status, 200);
assert.equal(list.body.projects.length, 1);
assert.equal(list.body.projects[0].detailKey, "company-1");
assert.equal(list.body.projects[0].activeBrain, true);
assert.equal(list.body.projects[0].raw, undefined, "raw company payload must not be sent to the browser list");
assert.deepEqual(list.body.company.excluded, { Penang: 1, Johor: 21 });

const detail = await request("GET", "/api/project-brain/detail?uid=company-1");
assert.equal(detail.status, 200);
assert.equal(detail.body.project.name, "Binastra Cochrane");
assert.match(detail.body.project.body, /Read-only company mirror/);
assert.equal(detail.body.project.companyDetail.unitPlans[0].name, "Type A");

const reveal = await request("POST", "/api/project-brain/sales-chart/reveal", { uid: "company-1" });
assert.equal(reveal.status, 200);
assert.equal(reveal.body.salesChart.password, "secret-test");
assert.match(reveal.headers["Cache-Control"], /no-store/);

const refresh = await request("POST", "/api/project-brain/refresh");
assert.equal(refresh.status, 200);
assert.equal(refreshCalls, 1);
assert.match(refresh.body.message, /Penang 1 个、Johor 21 个/);

const exportMd = await requestRaw("GET", "/api/project-brain/export?scope=market&format=md");
assert.equal(exportMd.status, 200);
assert.match(exportMd.headers["Content-Type"], /text\/markdown/);
assert.match(exportMd.headers["Content-Disposition"], /attachment; filename="mamba-project-brain-market-\d{4}-\d{2}-\d{2}\.md"/);
assert.match(exportMd.body, /Binastra Cochrane/);
assert.match(exportMd.body, /8% rebate/, "cached company detail should ride along in the export");
assert.doesNotMatch(exportMd.body, /confidentialInternalShape/, "raw company payload must never be exported");
assert.doesNotMatch(exportMd.body, /agent@example\.test|chart\.example\.test|passwordAvailable/i, "Sales Chart credentials must never be exported");

const exportJson = await request("GET", "/api/project-brain/export?scope=market&format=json");
assert.equal(exportJson.status, 200);
assert.equal(exportJson.body.marketLibrary.count, 1);
assert.equal(exportJson.body.marketLibrary.projects[0].raw, undefined);
assert.equal(exportJson.body.marketLibrary.projects[0].companyDetail.salesChart, undefined);
assert.equal(exportJson.body.marketLibrary.projects[0].priceLabel, "RM700k - RM900k");

const exportXlsx = await requestRaw("GET", "/api/project-brain/export?scope=market");
assert.equal(exportXlsx.status, 200, "xlsx is the default export format");
assert.match(exportXlsx.headers["Content-Type"], /spreadsheetml\.sheet/);
assert.match(exportXlsx.headers["Content-Disposition"], /\.xlsx"$/);
const workbook = XLSX.read(exportXlsx.body, { type: "buffer" });
assert.deepEqual(workbook.SheetNames, ["README", "Market Library"], "scope=market must not ship the Active Brain sheets");
const marketRows = XLSX.utils.sheet_to_json(workbook.Sheets["Market Library"]);
assert.equal(marketRows.length, 1);
assert.equal(marketRows[0].Project, "Binastra Cochrane");
assert.equal(marketRows[0]["Price Min (RM)"], 700000, "prices must stay numeric so Excel can sort them");
assert.equal(marketRows[0]["Sales Package"], "8% rebate");
assert.doesNotMatch(JSON.stringify(workbook), /agent@example\.test|chart\.example\.test|confidentialInternalShape/, "workbook must carry no credentials or raw payload");

// --- 分批抓公司详情 ---
detailCacheProjects = {};
const batchOne = await request("POST", "/api/project-brain/details/fetch-batch", { limit: 5 });
assert.equal(batchOne.status, 200);
assert.equal(batchOne.body.fetched, 1);
assert.equal(batchOne.body.remaining, 0, "缓存里没有的才抓");
assert.equal(detailRefreshCalls, 1);

const batchTwo = await request("POST", "/api/project-brain/details/fetch-batch", {});
assert.equal(batchTwo.body.fetched, 0, "已经抓过的不再打公司 API");
assert.equal(detailRefreshCalls, 1);

detailCacheProjects = {};
detailRefreshError = Object.assign(new Error("token 过期"), { code: "MARKET_COMPANY_TOKEN_EXPIRED" });
const batchExpired = await request("POST", "/api/project-brain/details/fetch-batch", {});
assert.equal(batchExpired.body.tokenExpired, true, "token 过期要立刻停手，不可以继续打");
assert.equal(batchExpired.body.failed.length, 1);
detailRefreshError = null;

const exportBadFormat = await request("GET", "/api/project-brain/export?format=csv");
assert.equal(exportBadFormat.status, 400);
const exportBadScope = await request("GET", "/api/project-brain/export?scope=everything");
assert.equal(exportBadScope.status, 400);

console.log("✅ all Project Brain company route tests passed");
