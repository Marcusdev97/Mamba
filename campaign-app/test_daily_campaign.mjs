import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDailyCampaignService, selectDailyBatch } from "./lib/daily-campaign-service.mjs";

const flowSequence = [
  { label: "Flow 2 - Layout" },
  { label: "Flow 3 - Location" },
  { label: "Flow 4 - Package" },
];
const config = { projects: ["Binastra", "Enlace"], maxLeads: 2 };
const batch = selectDailyBatch([
  { project: "Gen Starz", nextFlow: "Flow 2 - Layout", phone: "1" },
  { project: "Binastra", nextFlow: "Flow 3 - Location", phone: "2" },
  { project: "Enlace", nextFlow: "Flow 2 - Layout", phone: "3" },
  { project: "Enlace", nextFlow: "Flow 2 - Layout", phone: "4" },
  { project: "Enlace", nextFlow: "Flow 2 - Layout", phone: "5" },
  { project: "Binastra", nextFlow: "Flow 5 - Furnished List", phone: "6" },
], config, flowSequence);
assert.equal(batch.project, "Enlace");
assert.equal(batch.flow, "Flow 2 - Layout");
assert.equal(batch.totalDue, 3);
assert.equal(batch.leads.length, 2);

const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-daily-campaign-"));
const now = new Date("2026-07-15T02:00:00.000Z"); // 10:00 Kuala Lumpur
await fs.mkdir(path.join(rootDir, "campaign-data", "tracker"), { recursive: true });
await fs.writeFile(path.join(rootDir, "campaign-data", "tracker", "heartbeat.json"), JSON.stringify({
  heartbeatAt: now.toISOString(),
  lastReplyAt: "2026-07-14T02:00:00.000Z",
  pendingNotionReplies: 0,
}));

let executions = 0;
let deep = false;
const service = createDailyCampaignService({
  rootDir,
  flowSequence,
  clock: () => now,
  replyServices: { status: async () => ({ tracker: true, brain: true }) },
  openInstances: async () => [{ name: "wa_01", number: "60110000000" }],
  getRunner: () => null,
  queue: { snapshot: async () => ({ count: 0, hold: null }) },
  fetchDuePlan: async ({ deep: deepValue }) => {
    deep = deepValue;
    return {
      leads: [{ project: "Binastra", nextFlow: "Flow 2 - Layout", phone: "60120000001" }],
      whatsappCheck: { safeToSend: true, scanSource: deepValue ? "evolution-deep" : "tracker" },
    };
  },
  executeTest: async () => { executions += 1; return { runId: "run_test" }; },
});
await service.ready;

const initial = await service.snapshot();
assert.equal(initial.config.enabled, false, "scheduler must be off by default");
assert.equal(initial.config.mode, "TEST", "scheduler must never default to LIVE");

const readiness = await service.check();
assert.equal(readiness.ready, true);
assert.equal(readiness.batch.project, "Binastra");

await service.update({ enabled: true, mode: "LIVE", maxLeads: 99, time: "10:00" });
const saved = await service.snapshot();
assert.equal(saved.config.mode, "TEST", "service sanitizes LIVE back to TEST");
assert.equal(saved.config.maxLeads, 5, "daily limit is clamped to five");

await service.tick();
assert.equal(deep, true, "scheduled launch must perform the deep WhatsApp gate");
assert.equal(executions, 1);
await service.tick();
assert.equal(executions, 1, "same local date must not launch twice");

await fs.writeFile(path.join(rootDir, "campaign-data", "tracker", "heartbeat.json"), JSON.stringify({ heartbeatAt: "2026-07-15T00:00:00.000Z" }));
const stale = await service.check({ deep: false });
assert.equal(stale.ready, false);
assert.equal(stale.gates.find((item) => item.key === "tracker_heartbeat").ok, false);

service.stop();
await fs.rm(rootDir, { recursive: true, force: true });
console.log("✅ all daily-campaign tests passed");
