import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CampaignRunner } from "./campaign_core.mjs";
import { createCampaignTransportGuard, transportFailure } from "./lib/campaign-transport-guard.mjs";

const offline = {
  checkedAt: "2026-07-30T07:00:00.000Z",
  docker: { ok: false, state: "offline", code: "DOCKER_DAEMON_OFFLINE" },
  evolution: { ok: false, code: "EVOLUTION_API_OFFLINE" },
  instances: [],
};
assert.equal(transportFailure(offline, ["wa_01"]).code, "DOCKER_DAEMON_OFFLINE");

let interrupts = 0;
const runner = {
  running: true,
  state: {
    runId: "run_live",
    status: "RUNNING",
    mode: "LIVE",
    project: "Binastra",
    assignments: [{ instanceName: "wa_01" }],
  },
  async interruptForTransportFailure({ code }) {
    interrupts += 1;
    this.running = false;
    this.state.status = "INTERRUPTED";
    this.code = code;
    return true;
  },
};
const guard = createCampaignTransportGuard({
  healthService: { check: async () => offline },
  listRunners: () => [runner],
  failureThreshold: 2,
  intervalMs: 60_000,
});
const first = await guard.tick();
assert.equal(first.interrupted.length, 0, "one short health wobble must not stop a Campaign");
const second = await guard.tick();
assert.equal(second.interrupted.length, 1);
assert.equal(interrupts, 1);
assert.equal(runner.state.status, "INTERRUPTED");
assert.equal(runner.code, "DOCKER_DAEMON_OFFLINE");

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-transport-runner-"));
const realRunner = new CampaignRunner({
  env: {},
  transportPreflight: async () => {
    const error = new Error("wa_01 is not OPEN");
    error.code = "CAMPAIGN_TRANSPORT_UNHEALTHY";
    error.transportCode = "WHATSAPP_INSTANCE_NOT_OPEN";
    throw error;
  },
});
realRunner.state = {
  runId: "run_real",
  status: "RUNNING",
  mode: "LIVE",
  assignments: [],
};
realRunner.runPath = path.join(tempDir, "run_real.json");
realRunner.mirrorActiveState = false;
realRunner.running = true;
await assert.rejects(() => realRunner.assertTransport("wa_01"), /not OPEN/);
assert.equal(await realRunner.interruptForTransportFailure({
  code: "WHATSAPP_INSTANCE_NOT_OPEN",
  message: "wa_01 is not OPEN",
  layer: "instance",
}), true);
assert.equal(realRunner.state.status, "INTERRUPTED");
assert.equal(realRunner.state.interruption.requiresManualResume, true);
assert.equal(JSON.parse(await fs.readFile(realRunner.runPath, "utf8")).status, "INTERRUPTED");

console.log("✅ campaign transport guard tests passed");
