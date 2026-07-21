import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildAutomationPlan, createDailyCampaignService, selectDailyBatch } from "./lib/daily-campaign-service.mjs";

const flowSequence = [
  { key: "flow_1", label: "Flow 1 - Project Template", next: "flow_2", dueDays: 2, cohortDay: "Day 0" },
  { key: "flow_2", label: "Flow 2 - Layout", next: "flow_3", dueDays: 2, cohortDay: "Day 2" },
  { key: "flow_3", label: "Flow 3 - Location", next: "flow_4", dueDays: 2, cohortDay: "Day 4" },
  { key: "flow_4", label: "Flow 4 - Package", next: null, dueDays: null, cohortDay: "Day 6" },
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

const plan = buildAutomationPlan({
  leads: [
    { project: "Binastra", nextFlow: "Flow 3 - Location", phone: "6012", nextDueDate: "2026-07-14" },
    { project: "Binastra", nextFlow: "Flow 2 - Layout", phone: "6011", nextDueDate: "2026-07-12" },
    { project: "Binastra", nextFlow: "Flow 2 - Layout", phone: "6010", nextDueDate: "2026-07-10" },
    { project: "Binastra", nextFlow: "Flow 5 - Furnished List", phone: "6013", nextDueDate: "2026-07-15" },
    { project: "Binastra", nextFlow: "Flow 2 - Layout", phone: "6014", lastReply: "ok", nextDueDate: "2026-07-15" },
  ],
  config: { projects: ["Binastra"], maxLeads: 5 },
  flowSequence,
  mode: "LIVE",
  shift: { mode: "LIVE", today: "2026-07-15", minutes: 10 * 60, stoppedToday: false },
  instances: [{ name: "wa_01" }],
  random: () => 0.5,
});
assert.equal(plan.eligibleCount, 2, "automation plan excludes conditional Flow 5/9 and skips replied plus too-old missed leads");
assert.equal(plan.expiredCount, 1, "too-old missed leads are not auto-backfilled");
assert.equal(plan.capacity.safeCapacityPerSender, 150);
assert.equal(plan.batch.flow, "Flow 2 - Layout", "older eligible due leads are planned first");
assert.equal(plan.slots.length, 1);

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
  getTestLeads: () => [
    { name: "Anson", phone: "60172064505", language: "en" },
    { name: "Mark", phone: "601133698121", language: "en" },
    { name: "Chin", phone: "60168568756", language: "en" },
    { name: "Cici Liu", phone: "60179978682", language: "en" },
  ],
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
const stillOff = await service.update({ maxLeads: 3 });
assert.equal(stillOff.schedulerMode, "OFF", "partial config updates must not turn OFF mode into TEST");

const offReadiness = await service.check();
assert.equal(offReadiness.ready, false, "OFF mode must hold the launch gate");
assert.equal(offReadiness.gates.find((item) => item.key === "mode").ok, false);
assert.equal(offReadiness.batch.project, "Binastra");

await service.update({ schedulerMode: "TEST", maxLeads: 2 });
const readiness = await service.check();
assert.equal(readiness.ready, true);
assert.equal(readiness.batch.project, "Binastra");
assert.equal(readiness.batch.flow, "Flow 1 - Project Template", "TEST cohort starts at Flow 1 instead of using real customer due flow");
assert.equal(readiness.batch.totalDue, 4);
assert.equal(readiness.batch.leads.length, 2, "TEST launch follows the configured daily sample size");
assert.equal(readiness.liveCohort.buckets.find((item) => item.label === "Flow 2 - Layout").count, 1);
assert.equal(readiness.shift.status, "on-shift");
assert.equal(readiness.progress.planned, 2);
assert.equal(readiness.progress.pending, 2);
assert.equal(readiness.repliesToHandle.total, 0);

await service.update({ schedulerMode: "LIVE", maxLeads: 99, time: "10:00" });
const saved = await service.snapshot();
assert.equal(saved.schedulerMode, "LIVE", "LIVE can be displayed as a locked mode");
assert.equal(saved.config.maxLeads, 5, "daily limit is clamped to five");
const liveReadiness = await service.check();
assert.equal(liveReadiness.ready, false, "LIVE must stay held until the real live engine is connected");
assert.equal(liveReadiness.gates.find((item) => item.key === "mode").ok, false);

await service.update({ schedulerMode: "TEST", maxLeads: 5 });
await service.tick();
assert.equal(deep, true, "scheduled launch must perform the deep WhatsApp gate");
assert.equal(executions, 1);
const afterTestLaunch = await service.check();
assert.equal(afterTestLaunch.batch, null, "sent TEST recipients wait for the next due date before Flow 2");
assert.equal(afterTestLaunch.cohort.buckets.find((item) => item.label === "Flow 2 - Layout").count, 4);
assert.equal(afterTestLaunch.progress.sent, 4);
await service.tick();
assert.equal(executions, 1, "same local date must not launch twice");

await fs.writeFile(path.join(rootDir, "campaign-data", "tracker", "heartbeat.json"), JSON.stringify({ heartbeatAt: "2026-07-15T00:00:00.000Z" }));
const stale = await service.check({ deep: false });
assert.equal(stale.ready, false);
assert.equal(stale.gates.find((item) => item.key === "tracker_heartbeat").ok, false);

service.stop();

const queuedRootDir = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-daily-campaign-queued-"));
await fs.mkdir(path.join(queuedRootDir, "campaign-data", "tracker"), { recursive: true });
await fs.writeFile(path.join(queuedRootDir, "campaign-data", "tracker", "heartbeat.json"), JSON.stringify({ heartbeatAt: now.toISOString() }));
const queuedService = createDailyCampaignService({
  rootDir: queuedRootDir,
  flowSequence,
  clock: () => now,
  replyServices: { status: async () => ({ tracker: true, brain: true }) },
  openInstances: async () => [{ name: "wa_01", number: "60110000000" }],
  getTestLeads: () => [{ name: "Anson", phone: "60172064505", language: "en" }],
  getRunner: () => null,
  queue: { snapshot: async () => ({ count: 0, hold: null }) },
  fetchDuePlan: async () => ({
    leads: [{ project: "Binastra", nextFlow: "Flow 2 - Layout", phone: "60120000001" }],
    whatsappCheck: { safeToSend: true, scanSource: "evolution-deep" },
  }),
  executeTest: async () => ({ runId: "run_queued", queued: true }),
});
await queuedService.ready;
await queuedService.update({ schedulerMode: "TEST", maxLeads: 1 });
const queuedResult = await queuedService.runTest();
assert.equal(queuedResult.status, "QUEUED_TEST");
const queuedSnapshot = await queuedService.snapshot();
assert.equal(queuedSnapshot.state.lastRun.status, "QUEUED_TEST");
assert.equal(queuedSnapshot.testCohort[0].nextFlow, "Flow 1 - Project Template", "queued TEST runs must not advance before any message is sent");
const queuedReadiness = await queuedService.check();
assert.equal(queuedReadiness.progress.sent, 0, "queued TEST runs are not counted as sent");
queuedService.stop();

const lateRootDir = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-daily-campaign-late-"));
const lateNow = new Date("2026-07-15T13:13:00.000Z"); // 21:13 Kuala Lumpur
await fs.mkdir(path.join(lateRootDir, "campaign-data", "tracker"), { recursive: true });
await fs.writeFile(path.join(lateRootDir, "campaign-data", "tracker", "heartbeat.json"), JSON.stringify({ heartbeatAt: lateNow.toISOString() }));
const lateService = createDailyCampaignService({
  rootDir: lateRootDir,
  flowSequence,
  clock: () => lateNow,
  replyServices: { status: async () => ({ tracker: true, brain: true }) },
  openInstances: async () => [{ name: "wa_01", number: "60110000000" }],
  getTestLeads: () => [{ name: "Anson", phone: "60172064505", language: "en" }],
  getRunner: () => null,
  queue: { snapshot: async () => ({ count: 0, hold: null }) },
  fetchDuePlan: async () => ({ leads: [], whatsappCheck: { safeToSend: true, scanSource: "tracker" } }),
  executeTest: async () => ({ runId: "late" }),
});
await lateService.ready;
await lateService.update({ schedulerMode: "TEST", maxLeads: 2 });
const lateReadiness = await lateService.check();
assert.equal(lateReadiness.ready, false, "after-hours start must wait for the next shift");
assert.equal(lateReadiness.shift.status, "off-shift");
assert.equal(lateReadiness.shift.remainingLabel, "明天 10:00");
assert.equal(lateReadiness.workPreview.title, "明天开工");
assert.equal(lateReadiness.workPreview.employeeLabel, "wa_01");
assert.equal(lateReadiness.workPreview.startLabel, "明天 10:00");
assert.equal(lateReadiness.workPreview.finishLabel, "明天 10:01");
assert.equal(lateReadiness.workPreview.sendCount, 1);
lateService.stop();

await fs.rm(rootDir, { recursive: true, force: true });
await fs.rm(queuedRootDir, { recursive: true, force: true });
await fs.rm(lateRootDir, { recursive: true, force: true });
console.log("✅ all daily-campaign tests passed");
