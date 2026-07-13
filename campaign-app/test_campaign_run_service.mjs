import assert from "node:assert/strict";
import { createCampaignRunService } from "./lib/campaign-run-service.mjs";

function makeService(execFileFn, overrides = {}) {
  return createCampaignRunService({
    appDir: "/tmp/mamba-test",
    blastDatabaseId: "db",
    notion: async () => ({}),
    normalizePhone: (value) => value,
    nfSelect: () => "",
    nfAddDaysKL: () => "",
    klDateTime: () => "",
    flowByLabel: () => null,
    flowStateAfter: () => ({}),
    execFileFn,
    ...overrides,
  });
}

function makeFlowRunner() {
  const runner = makeRunner();
  runner.state = {
    mode: "LIVE",
    project: "Binastra",
    flowLabel: "Flow 2 - Layout",
    assignments: [{ lead: { name: "Test Lead", phone: "60123456789" }, part1: { sentAt: "2026-07-13T04:00:00.000Z" } }],
  };
  return runner;
}

function makeRunner() {
  const logs = [];
  let saves = 0;
  return {
    runPath: "/tmp/mamba-test/run.json",
    state: { mode: "LIVE", assignments: [] },
    pushLog(message) { logs.push(message); },
    async saveState() { saves += 1; },
    get saves() { return saves; },
    logs,
  };
}

{
  const service = makeService((_node, _args, _options, callback) => callback(null, "uploaded 2 rows\n", ""));
  const runner = makeRunner();
  await service.autoNotionUpload(runner);
  assert.equal(runner.state.notionSync.status, "SUCCEEDED");
  assert.equal(runner.state.notionSync.error, null);
  assert.match(runner.state.notionSync.message, /更新完成/);
  assert.ok(runner.state.notionSync.startedAt);
  assert.ok(runner.state.notionSync.finishedAt);
  assert.equal(runner.saves, 2);
}

{
  const service = makeService((_node, _args, _options, callback) => {
    const error = new Error("exit 1");
    callback(error, "", "Notion token expired");
  });
  const runner = makeRunner();
  await service.autoNotionUpload(runner);
  assert.equal(runner.state.notionSync.status, "FAILED");
  assert.match(runner.state.notionSync.error, /token expired/);
  assert.equal(runner.saves, 2);
}

{
  let called = false;
  const service = makeService(() => { called = true; });
  const runner = makeRunner();
  runner.state.mode = "TEST";
  const result = await service.autoNotionUpload(runner);
  assert.equal(result, null);
  assert.equal(called, false);
  assert.equal(runner.state.notionSync, undefined);
}

{
  const calls = [];
  const page = {
    id: "page-1",
    properties: {
      "Stop Flag": { checkbox: false },
      "Sequence Status": { select: { name: "Running" } },
      "Next Flow": { select: { name: "Flow 2 - Layout" } },
      "Last Flow Sent": { select: { name: "Flow 1 - Project Template" } },
    },
  };
  const service = makeService(() => {}, {
    notion: async (method, pathname, body) => {
      calls.push({ method, pathname, body });
      return method === "POST" ? { results: [page] } : {};
    },
    nfSelect: (item, name) => item?.properties?.[name]?.select?.name || "",
    nfAddDaysKL: () => "2026-07-15",
    flowByLabel: (label) => label === "Flow 2 - Layout" ? { key: "flow_2" } : null,
    flowStateAfter: () => ({
      lastFlowLabel: "Flow 2 - Layout",
      nextFlowLabel: "Flow 3 - Location",
      cohortDay: "Day 2",
      dueDays: 2,
    }),
  });
  const runner = makeFlowRunner();
  await service.autoAdvanceFlow(runner);
  assert.equal(runner.state.advanceStatus, "SUCCEEDED");
  assert.equal(runner.state.advanceDone, true);
  assert.equal(runner.state.advanceSummary.advanced, 1);
  assert.equal(calls[0].body.filter.and[1].property, "Project");
  assert.equal(calls[1].body.properties["Next Flow"].select.name, "Flow 3 - Location");
}

{
  const service = makeService(() => {}, {
    notion: async () => ({ results: [] }),
    nfSelect: () => "",
    nfAddDaysKL: () => "2026-07-15",
    flowByLabel: () => ({ key: "flow_2" }),
    flowStateAfter: () => ({ lastFlowLabel: "Flow 2 - Layout", nextFlowLabel: "Flow 3 - Location", cohortDay: "Day 2", dueDays: 2 }),
  });
  const runner = makeFlowRunner();
  await service.autoAdvanceFlow(runner);
  assert.equal(runner.state.advanceStatus, "PARTIAL");
  assert.equal(runner.state.advanceDone, false);
  assert.equal(runner.state.advanceSummary.notFound, 1);
}

{
  const page = {
    id: "page-1",
    properties: {
      "Stop Flag": { checkbox: false },
      "Sequence Status": { select: { name: "Running" } },
      "Next Flow": { select: { name: "Flow 2 - Layout" } },
    },
  };
  const service = makeService(() => {}, {
    notion: async (method) => {
      if (method === "PATCH") throw new Error("Notion rate limit");
      return { results: [page] };
    },
    nfSelect: (item, name) => item?.properties?.[name]?.select?.name || "",
    nfAddDaysKL: () => "2026-07-15",
    flowByLabel: () => ({ key: "flow_2" }),
    flowStateAfter: () => ({ lastFlowLabel: "Flow 2 - Layout", nextFlowLabel: "Flow 3 - Location", cohortDay: "Day 2", dueDays: 2 }),
  });
  const runner = makeFlowRunner();
  await assert.rejects(() => service.autoAdvanceFlow(runner), /rate limit/);
  assert.equal(runner.state.advanceStatus, "FAILED");
  assert.equal(runner.state.advanceDone, false);
  assert.match(runner.state.advanceError, /rate limit/);
}

console.log("✅ all campaign-run-service tests passed");
