// 多号码并行 —— 车道启动端点的测试。
//
// 守住四件事：
//   1. 车道绑单一号码（不是把名单分给多个号码）
//   2. 套上那个号码的 mode 节奏（crazy 20-30s ≠ 全局预设）
//   3. 同一号码已有 run 在跑 → 拒绝（一号不能两批）
//   4. 车道 runner 不抢「当前 runner」、不镜像 active-run.json（并发不互相覆盖）
//
// 用假的 campaign runtime，不碰真 Evolution、不真的发送。

import assert from "node:assert/strict";
import { createRouter } from "./lib/http.mjs";
import { registerCampaignRoutes } from "./routes/campaign.routes.mjs";
import { contactGapRange } from "./lib/campaign-schedule.mjs";

// 一个假 runner：记录 prepare 收到什么，run() 立刻结束。
function makeFakeRunner(config) {
  const runner = {
    config,
    mirrorActiveState: true,
    state: null,
    running: false,
    _log: [],
    async prepare({ mode, instances, leads, project }) {
      this.mirrorActiveState = true;   // 真 runner 会这样，端点要负责压回 false
      this.state = {
        runId: `run_test_${instances[0].name}`,
        mode, project, instances,
        assignments: leads.map((lead, i) => ({ id: `j${i}`, lead, status: "QUEUED", part1: null })),
        status: "READY",
      };
    },
    snapshot() { return { runId: this.state.runId, mode: this.state.mode }; },
    refreshAutoScheduleEstimate() {},
    pushLog(m) { this._log.push(m); },
    async saveState() { this.savedMirror = this.mirrorActiveState; },
    async systemLog() {},
    async run() { this.running = false; this.state.status = "COMPLETED"; },
  };
  return runner;
}

const registry = [];
let currentRunnerSet = 0;
const laneGroupLeads = {
  "group-A": [{ name: "Ali", phone: "60111000001" }, { name: "Bee", phone: "60111000002" }],
};

function buildRuntime() {
  const runners = [];
  const campaign = {
    device: { id: "dev-1", name: "Test Mac" },
    firstFlowLabel: "Flow 1 - Project Template",
    async getProject() {
      return { project: { id: "binastra", name: "Binastra" }, config: { campaignId: "binastra", delivery: { replyLookbackDays: 7 } } };
    },
    async openInstances() {
      return [
        { name: "wa_01", owner: "601133698121", status: "OPEN" },
        { name: "wa_03", owner: "60148801997", status: "OPEN" },
      ];
    },
    getTestLeads() { return [{ name: "Tester", phone: "60129999999" }]; },
    async readLeadGroup({ groupId }) {
      return { id: groupId, name: `群 ${groupId}`, leads: laneGroupLeads[groupId] || [] };
    },
    createRunner(config) { const r = makeFakeRunner(config); runners.push(r); return r; },
    formatTime() { return "10:00"; },
    resolveTime() { return new Date(); },
    async applyNotionFlowTemplatesToState() {},
    assertFirstConsoleRunUsesFlow1Only() {},
    setRunner() { currentRunnerSet += 1; },   // 车道**不该**呼叫这个
    registerLaneRunner(r) { registry.push(r); },
    persistRunners: async () => {},
    listRunners: () => registry.map((r) => r),
    getRunner: () => null,
    queue: { async setHold() {} },
  };
  return { campaign, systemLogs: { async write() {} }, host: "127.0.0.1", port: 8787 };
}

const runtime = buildRuntime();
const router = createRouter(runtime);
registerCampaignRoutes(router);

async function post(url, body) {
  let status = 0; let payload = "";
  const res = { writeHead(s) { status = s; }, end(v) { payload = String(v ?? ""); } };
  const req = { method: "POST", url, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } };
  await router.dispatch(req, res);
  return { status, body: JSON.parse(payload || "{}") };
}

// --- LIVE 车道：绑 wa_03、群 A、crazy 节奏 ---
const launch = await post("/api/campaign/lane/launch", {
  project: "binastra", instance: "wa_03", pace: "crazy", mode: "LIVE",
  leadGroupId: "group-A", optIn: true,
});
assert.equal(launch.status, 200, JSON.stringify(launch.body));
assert.equal(launch.body.instance, "wa_03");
assert.equal(launch.body.pace, "crazy");
assert.equal(launch.body.leadCount, 2);

// 1. 只绑一个号码
const laneRunner = registry.find((r) => r.state.runId === "run_test_wa_03");
assert.ok(laneRunner, "车道 runner 要登记进 registry");
assert.equal(laneRunner.state.instances.length, 1, "车道只能绑一个号码");
assert.equal(laneRunner.state.instances[0].name, "wa_03");
assert.equal(laneRunner.state.laneInstance, "wa_03");

// 2. 套上 crazy 节奏
assert.deepEqual(contactGapRange(laneRunner.config), { minSeconds: 20, maxSeconds: 30 }, "车道要用 crazy 的 20-30s");
assert.equal(laneRunner.config.delivery.replyLookbackDays, 7, "原 config 的其他设定要保留");

// 4. 不抢当前 runner、不镜像 active-run.json
assert.equal(currentRunnerSet, 0, "车道不可以设成「当前 runner」");
assert.equal(laneRunner.savedMirror, false, "车道不可以镜像 active-run.json");

// --- 另一条车道：wa_01、普通，跟上面并存 ---
const launch2 = await post("/api/campaign/lane/launch", {
  project: "binastra", instance: "wa_01", pace: "normal", mode: "TEST",
});
assert.equal(launch2.status, 200);
assert.equal(launch2.body.instance, "wa_01");
assert.equal(registry.length, 2, "两条车道并存，各自登记");

// --- 同一号码不能开两批 ---
laneRunner.running = true;   // 假装 wa_03 还在跑
const dup = await post("/api/campaign/lane/launch", {
  project: "binastra", instance: "wa_03", pace: "normal", mode: "LIVE", leadGroupId: "group-A", optIn: true,
});
assert.equal(dup.status, 409, "同一号码正在跑，要拒绝");
assert.match(dup.body.error, /已经在跑/);

// --- 守卫 ---
assert.equal((await post("/api/campaign/lane/launch", { project: "binastra", instance: "", mode: "TEST" })).status, 400);
assert.equal((await post("/api/campaign/lane/launch", { project: "binastra", instance: "wa_01", mode: "LIVE", leadGroupId: "group-A" })).status, 400, "LIVE 没 optIn 要挡");
assert.equal((await post("/api/campaign/lane/launch", { project: "binastra", instance: "wa_01", mode: "LIVE", optIn: true })).status, 400, "LIVE 没选群要挡");
const emptyGroup = await post("/api/campaign/lane/launch", { project: "binastra", instance: "wa_01", mode: "LIVE", leadGroupId: "group-empty", optIn: true });
assert.equal(emptyGroup.status, 400, "空客户群要挡");

console.log("✅ all lane launch tests passed");
