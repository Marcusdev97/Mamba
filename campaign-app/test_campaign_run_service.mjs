import assert from "node:assert/strict";
import { createCampaignRunService } from "./lib/campaign-run-service.mjs";

function makeService(execFileFn) {
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
  });
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

console.log("✅ all campaign-run-service tests passed");
