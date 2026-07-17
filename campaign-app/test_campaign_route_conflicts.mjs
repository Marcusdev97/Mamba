import assert from "node:assert/strict";
import { conflictingRunner } from "./routes/campaign.routes.mjs";

function runner(runId, status, { running = false, instance = "wa_01" } = {}) {
  return {
    running,
    state: {
      runId,
      status,
      instances: [{ name: instance }],
      assignments: [],
    },
  };
}

const ready = runner("run_ready", "READY");
const stopped = runner("run_stopped", "STOPPED");
const campaign = { listRunners: () => [ready] };

assert.equal(conflictingRunner(campaign, ["wa_01"])?.state.runId, "run_ready", "normal Start must still respect an existing READY preview");
assert.equal(conflictingRunner(campaign, ["wa_01"], null, { ignoreReadyPreviews: true }), null, "Resume may ignore a preview that has never started");

const activelyRunning = runner("run_live", "RUNNING", { running: true });
assert.equal(
  conflictingRunner({ listRunners: () => [ready, activelyRunning] }, ["wa_01"], null, { ignoreReadyPreviews: true })?.state.runId,
  "run_live",
  "Resume must never bypass a genuinely RUNNING sender lane",
);

assert.equal(
  conflictingRunner({ listRunners: () => [stopped] }, ["wa_01"], "run_target", { ignoreReadyPreviews: true })?.state.runId,
  "run_stopped",
  "ignoreReadyPreviews must not silently bypass other blocking states",
);

assert.equal(
  conflictingRunner({ listRunners: () => [ready] }, ["wa_02"], null, { ignoreReadyPreviews: true }),
  null,
  "different sender lanes never conflict",
);

console.log("✅ all campaign route conflict tests passed");
