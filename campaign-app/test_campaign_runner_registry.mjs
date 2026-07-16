import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createCampaignRunnerRegistry,
  instanceSetsOverlap,
  runnerInstanceNames,
} from "./lib/campaign-runner-registry.mjs";

const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-runner-registry-"));
const registry = createCampaignRunnerRegistry({ rootDir });

function runner(runId, instanceName, status = "RUNNING") {
  return {
    running: status === "RUNNING",
    state: {
      runId,
      projectId: "binastra",
      project: "Binastra",
      mode: "TEST",
      status,
      assignments: [{ instanceName, lead: { phone: "60100000000" } }],
    },
  };
}

const flow1 = runner("run_flow1_wa02", "wa_02");
const flow2 = runner("run_flow2_wa01", "wa_01");
registry.register(flow1);
registry.register(flow2);

assert.equal(registry.get().state.runId, "run_flow2_wa01");
assert.equal(registry.get("run_flow1_wa02"), flow1);
assert.deepEqual(runnerInstanceNames(flow1), ["wa_02"]);
assert.equal(instanceSetsOverlap(runnerInstanceNames(flow1), runnerInstanceNames(flow2)), false, "different senders may run together");
assert.equal(instanceSetsOverlap(["wa_01"], runnerInstanceNames(flow2)), true, "same sender must conflict");

await registry.persist();
const restoredIndex = await createCampaignRunnerRegistry({ rootDir }).loadIndex();
assert.equal(restoredIndex.latestRunId, "run_flow2_wa01");
assert.equal(restoredIndex.runs.length, 2);
assert.deepEqual(restoredIndex.runs.find((item) => item.runId === "run_flow1_wa02").instanceNames, ["wa_02"]);

await fs.rm(rootDir, { recursive: true, force: true });
console.log("✅ all campaign-runner-registry tests passed");
