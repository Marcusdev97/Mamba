import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

async function request(method, url, requestBody = null) {
  let status = 0;
  let body = "";
  let headers = {};
  const res = {
    writeHead(value, valueHeaders = {}) { status = value; headers = valueHeaders; },
    end(value) { body = String(value ?? ""); },
  };
  const req = {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      if (requestBody !== null) yield Buffer.from(JSON.stringify(requestBody));
    },
  };
  const handled = await router.dispatch(req, res);
  return { handled, status, headers, body: JSON.parse(body) };
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

console.log("✅ all Project Brain company route tests passed");
