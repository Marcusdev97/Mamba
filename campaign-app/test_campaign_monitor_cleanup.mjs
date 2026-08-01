import assert from "node:assert/strict";
import {
  CANCEL_MONITOR_RUNS_CONFIRMATION,
  createCampaignMonitorCleanupService,
} from "./lib/campaign-monitor-cleanup-service.mjs";

const cancelled = [];
const forgotten = [];
const queueRemoved = [];
let persisted = 0;
const runners = [
  {
    running: false,
    state: { runId: "run_interrupted", status: "INTERRUPTED" },
    async cancel({ reason }) {
      cancelled.push({ runId: this.state.runId, reason });
      this.state.status = "CANCELLED";
    },
  },
  {
    running: false,
    state: { runId: "run_completed", status: "COMPLETED" },
    async cancel() { throw new Error("completed run must not be cancelled again"); },
  },
  {
    running: false,
    state: { runId: "run_preview", status: "READY" },
    async cancel() { throw new Error("unrequested preview must stay untouched"); },
  },
];

const queueItems = [
  { runId: "run_interrupted" },
  { runId: "run_queue_only" },
  { runId: "run_preview" },
];
const service = createCampaignMonitorCleanupService({
  listRunners: () => runners,
  forgetRunner(runId) { forgotten.push(runId); return true; },
  async persistRunners() { persisted += 1; },
  queue: {
    async snapshot() { return { items: queueItems }; },
    async remove(runId) { queueRemoved.push(runId); return true; },
    async clearHold() {},
  },
});

await assert.rejects(
  service.cancelRuns({ runIds: ["run_interrupted"] }),
  (error) => error.code === "CAMPAIGN_CANCEL_CONFIRMATION_REQUIRED",
);

const result = await service.cancelRuns({
  runIds: ["run_interrupted", "run_completed", "run_queue_only"],
  confirmation: CANCEL_MONITOR_RUNS_CONFIRMATION,
});
assert.deepEqual(queueRemoved, ["run_interrupted", "run_queue_only"]);
assert.deepEqual(cancelled.map((item) => item.runId), ["run_interrupted"]);
assert.deepEqual(forgotten, ["run_interrupted", "run_completed"]);
assert.equal(persisted, 1);
assert.equal(result.requested, 3);
assert.deepEqual(result.queueRemoved, ["run_interrupted", "run_queue_only"]);
assert.equal(runners[2].state.status, "READY");

console.log("✅ campaign monitor bulk cleanup tests passed");
