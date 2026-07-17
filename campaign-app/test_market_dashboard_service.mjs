import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createMarketDashboardService,
  isExcludedMarketProject,
  normalizeCompanyProject,
} from "./lib/market-dashboard-service.mjs";

const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-market-dashboard-test-"));
const cachePath = path.join(rootDir, "campaign-data", "market-dashboard", "property213-projects.json");
const credentials = {
  P213_ACCOUNT: "account-test",
  P213_APPKEY: "appkey-secret",
  P213_TOKEN: "token-secret",
  P213_USERID: "user-test",
};
let now = new Date("2026-07-17T08:00:00.000Z");
let fetchCalls = 0;
let version = 1;
const rows = () => [
  {
    ProjectUID: "kl-1", Project: "KL Residence", DeveloperName: "KL Dev",
    State: "Kuala Lumpur", Area: "Cheras", Location: "MRT", PropertyType: "Condo",
    Tenure: "Freehold", ProjectStatus: "Pre Launch", PriceFrom: version === 1 ? 500000 : 520000,
    PriceTo: 700000, BuiltUpFrom: 650, BuiltUpTo: 900, TotalUnit: 500,
  },
  { ProjectUID: "pg-1", Project: "Island Home", State: "Pulau Pinang", Area: "Bayan Lepas" },
  { ProjectUID: "jh-1", Project: "Southern Home", State: "JOHOR", Area: "Johor Bahru" },
  { ProjectUID: "sel-1", Project: "Selangor Home", State: "Selangor", Area: "Petaling Jaya", PriceFrom: 400000 },
  ...(version === 2 ? [{ ProjectUID: "kl-2", Project: "New KL Project", State: "Kuala Lumpur", Area: "KLCC", PriceFrom: 900000 }] : []),
];

const fetchFn = async (url) => {
  fetchCalls += 1;
  if (/\/details\?/.test(url)) {
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          Code: 200,
          Result: JSON.stringify([
            { Title: "10. Built Up - Layout - Car Park - SPA Price", Value: "Type A 650sf<br>Type B 900sf", Sequence: 10 },
            { Title: "13. Sales Package", Value: "8% rebate<br>Free SPA legal fee", Sequence: 13 },
            { Title: "18. Sales Chart (Where to refer?)", Value: "Website: https://chart.example.test/login<br>Email address: agent@example.test<br>Password: local-only-secret", Sequence: 18 },
          ]),
        };
      },
    };
  }
  if (/\/units\/plans\/site\?/.test(url)) {
    return { ok: true, status: 200, async json() { return { Code: 200, Result: "[]" }; } };
  }
  if (/\/units\/plans\?/.test(url)) {
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          Code: 200,
          Result: JSON.stringify([{ FloorPlanID: "plan-a", Name: "Type A", BuiltUp: 650, Bedroom: "2", Bathroom: 2, CarPark: 1, FloorPlan: "https://property213.blob.core.windows.net/test/unit/type-a.jpg" }]),
        };
      },
    };
  }
  assert.match(url, /active=true/);
  assert.match(url, /account-test/);
  return {
    ok: true,
    status: 200,
    async json() { return { Code: 200, Result: JSON.stringify(rows()) }; },
  };
};

const service = createMarketDashboardService({ rootDir, env: credentials, fetchFn, cachePath, clock: () => now });
assert.deepEqual(await service.connectionStatus(), { configured: true, credentialSource: "env" });
const first = await service.refresh();
assert.equal(first.rawCount, 4);
assert.equal(first.includedCount, 2);
assert.deepEqual(first.excluded, { Penang: 1, Johor: 1 });
assert.equal(first.newProjects, 0, "first baseline refresh should not label every project as new");

const firstCache = await service.readCache();
assert.deepEqual(firstCache.projects.map((project) => project.uid), ["kl-1", "sel-1"]);
assert.ok(firstCache.projects.every((project) => !/penang|johor/i.test(`${project.state} ${project.area}`)));
const serialized = await fs.readFile(cachePath, "utf8");
assert.doesNotMatch(serialized, /token-secret|appkey-secret/, "credentials must never be written into the market cache");

version = 2;
now = new Date("2026-07-17T09:00:00.000Z");
const second = await service.refresh();
assert.equal(second.includedCount, 3);
assert.equal(second.newProjects, 1);
assert.equal(second.priceChanges, 1);
assert.equal((await service.projectByUid("kl-1")).priceMin, 520000);

const projectDetail = await service.projectDetails("kl-1", { force: true });
assert.match(projectDetail.layout.value, /Type A 650sf/);
assert.match(projectDetail.salesPackage.value, /8% rebate/);
assert.equal(projectDetail.salesChart.website, "https://chart.example.test/login");
assert.equal(projectDetail.salesChart.username, "agent@example.test");
assert.equal(projectDetail.salesChart.passwordAvailable, true);
assert.equal(projectDetail.unitPlans.length, 1);
assert.equal(projectDetail.unitPlans[0].name, "Type A");
assert.equal(projectDetail.sitePlans.length, 0);
const detailCacheSerialized = await fs.readFile(service.detailCachePath, "utf8");
assert.doesNotMatch(detailCacheSerialized, /local-only-secret/, "Sales Chart password must never be written to disk");
assert.equal((await service.salesChartSecret("kl-1")).password, "local-only-secret");

let slowResolve;
let startedResolve;
const started = new Promise((resolve) => { startedResolve = resolve; });
const slowService = createMarketDashboardService({
  rootDir,
  env: credentials,
  cachePath: path.join(rootDir, "slow.json"),
  fetchFn: () => {
    startedResolve();
    return new Promise((resolve) => { slowResolve = resolve; });
  },
});
const concurrentA = slowService.refresh();
const concurrentB = slowService.refresh();
await started;
slowResolve({ ok: true, status: 200, json: async () => ({ Code: 200, Result: "[]" }) });
assert.strictEqual(await concurrentA, await concurrentB, "duplicate button clicks should join one refresh");

const expired = createMarketDashboardService({
  rootDir,
  env: credentials,
  cachePath: path.join(rootDir, "expired.json"),
  fetchFn: async () => ({ ok: false, status: 401, json: async () => ({ Code: 401, Message: "token expired" }) }),
});
await assert.rejects(expired.refresh(), (error) => error.code === "MARKET_COMPANY_TOKEN_EXPIRED" && error.statusCode === 401);

assert.equal(isExcludedMarketProject({ state: "Penang" }), true);
assert.equal(isExcludedMarketProject({ State: "Johor", Area: "Iskandar" }), true);
assert.equal(isExcludedMarketProject({ State: "Kuala Lumpur", Area: "Johor Street" }), true, "location labels mentioning Johor are conservatively excluded");
assert.equal(isExcludedMarketProject({ State: "Selangor", Area: "Petaling Jaya" }), false);
assert.equal(normalizeCompanyProject({ ProjectUID: "x", Project: "X", PriceFrom: "600,000" }).priceMin, 600000);

console.log("✅ all Market Dashboard company refresh tests passed");
