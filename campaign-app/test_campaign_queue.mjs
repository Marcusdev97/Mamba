import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CampaignRunner } from "./campaign_core.mjs";
import { createCampaignQueueService } from "./lib/campaign-queue-service.mjs";
import { campaignQueueBlockReason } from "./routes/campaign.routes.mjs";

const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-campaign-queue-"));

function fakeRunner(runId, overrides = {}) {
  return {
    runPath: path.join(rootDir, "campaign-data", "runs", `${runId}.json`),
    state: {
      runId,
      projectId: "binastra",
      project: "Binastra",
      flowLabel: "Flow 1 - Project Template",
      mode: "TEST",
      assignments: [{ id: `${runId}-1`, instanceName: "wa_01" }, { id: `${runId}-2`, instanceName: "wa_01" }],
      ...overrides,
    },
  };
}

const queue = createCampaignQueueService({ rootDir });
await queue.ready;

const first = await queue.add(fakeRunner("run_flow2"), { projectId: "binastra", autoAdvance: true });
const second = await queue.add(fakeRunner("run_flow1"), { projectId: "binastra", autoAdvance: false });
assert.equal(first.position, 1);
assert.equal(second.position, 2);
assert.equal((await queue.snapshot()).count, 2);

const duplicate = await queue.add(fakeRunner("run_flow1"), { projectId: "binastra" });
assert.equal(duplicate.position, 2, "double click must not queue the same prepared run twice");
assert.equal((await queue.snapshot()).count, 2);

await queue.setHold("Notion is still updating", "run_active");
const held = await queue.snapshot();
assert.equal(held.hold.reason, "Notion is still updating");

const restoredQueue = createCampaignQueueService({ rootDir });
await restoredQueue.ready;
const restoredSnapshot = await restoredQueue.snapshot();
assert.equal(restoredSnapshot.count, 2, "queue must survive a server restart");
assert.equal(restoredSnapshot.items[0].runId, "run_flow2");
assert.equal(restoredSnapshot.items[1].runId, "run_flow1");
assert.deepEqual(restoredSnapshot.items[0].instanceNames, ["wa_01"], "queue must preserve occupied sender lanes");
assert.equal(restoredSnapshot.hold.runId, "run_active");

await restoredQueue.clearHold();
assert.equal((await restoredQueue.snapshot()).hold, null);
assert.equal(await restoredQueue.remove("run_flow2"), true);
assert.equal((await restoredQueue.peek()).runId, "run_flow1");

const state = (overrides = {}, running = false) => ({ running, state: { status: "COMPLETED", mode: "LIVE", ...overrides } });
assert.match(campaignQueueBlockReason(state({}, true)), /仍在发送/);
assert.match(campaignQueueBlockReason(state({ status: "STOPPED" })), /手动停止/);
assert.match(campaignQueueBlockReason(state({ status: "INTERRUPTED" })), /安全暂停/);
assert.match(campaignQueueBlockReason(state({ flowLabel: "Flow 2 - Layout", advanceStatus: "WAITING" })), /更新 Notion/);
assert.match(campaignQueueBlockReason(state({ flowLabel: "Flow 2 - Layout", advanceStatus: "PARTIAL" })), /PARTIAL/);
assert.equal(campaignQueueBlockReason(state({ flowLabel: "Flow 2 - Layout", advanceStatus: "SUCCEEDED" })), null);
assert.match(campaignQueueBlockReason(state({ notionSync: { status: "RUNNING" } })), /更新 Notion/);
assert.match(campaignQueueBlockReason(state({ notionSync: { status: "FAILED" } })), /上传失败/);
assert.equal(campaignQueueBlockReason(state({ notionSync: { status: "SUCCEEDED" } })), null);
assert.equal(campaignQueueBlockReason(state({
  flowLabel: "Flow 2 - Layout",
  advanceStatus: "WAITING",
  localAdvance: { status: "SUCCEEDED" },
})), null, "Flow 2-10 must free the sender lane after SQLite commits, without waiting for Notion");
assert.equal(campaignQueueBlockReason(state({
  notionSync: { status: "WAITING" },
  localAdvance: { status: "SUCCEEDED" },
})), null, "Flow 1 must use the same local-first queue rule");

const restorePath = path.join(rootDir, "campaign-data", "runs", "run_restore.json");
await fs.mkdir(path.dirname(restorePath), { recursive: true });
await fs.writeFile(restorePath, JSON.stringify({ runId: "run_restore", assignments: [], status: "QUEUED_BATCH" }));
const restoredRunner = new CampaignRunner({ config: {}, env: {} });
restoredRunner.mirrorActiveState = false;
await restoredRunner.restore(restorePath);
assert.equal(restoredRunner.state.runId, "run_restore");
assert.equal(restoredRunner.mirrorActiveState, true, "a queued runner becomes the active mirror when restored for launch");

await fs.rm(rootDir, { recursive: true, force: true });
console.log("✅ all campaign-queue tests passed");
