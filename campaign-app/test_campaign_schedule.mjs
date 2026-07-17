import assert from "node:assert/strict";
import {
  CampaignRunner,
  RecipientNotOnWhatsAppError,
  campaignOutcomeSummary,
  isRecipientNotOnWhatsAppError,
  isResumableJobStatus,
} from "./campaign_core.mjs";
import {
  AUTO_SCHEDULE,
  FIXED_SCHEDULE,
  campaignPacing,
  contactGapRange,
  estimateAutoEnd,
  partGapRange,
  randomGapSeconds,
  scheduleModeForEnd,
} from "./lib/campaign-schedule.mjs";

const config = {
  delivery: {
    partGapSeconds: 45,
    partGapMaxSeconds: 75,
    contactGapSeconds: { min: 45, max: 75 },
  },
};

const start = new Date("2026-07-17T01:00:00.000Z");
assert.equal(campaignPacing(config).floorMs, 120_000);
assert.equal(campaignPacing(config, 3).floorMs, 180_000, "3 Parts must reserve both Part gaps plus the customer gap");
assert.equal(estimateAutoEnd(start, 27, config).toISOString(), "2026-07-17T01:54:00.000Z");
assert.equal(estimateAutoEnd(start, 169, config).toISOString(), "2026-07-17T06:38:00.000Z");
assert.equal(estimateAutoEnd(start, 70, config, 3).toISOString(), "2026-07-17T04:30:00.000Z");
assert.deepEqual(partGapRange(config), { minSeconds: 45, maxSeconds: 75 });
assert.deepEqual(contactGapRange(config), { minSeconds: 45, maxSeconds: 75 });
assert.equal(randomGapSeconds({ minSeconds: 45, maxSeconds: 75 }, () => 0), 45);
assert.equal(randomGapSeconds({ minSeconds: 45, maxSeconds: 75 }, () => 1), 75);
assert.equal(AUTO_SCHEDULE, "AUTO");
assert.equal(FIXED_SCHEDULE, "FIXED");
assert.equal(scheduleModeForEnd(""), AUTO_SCHEDULE);
assert.equal(scheduleModeForEnd("   "), AUTO_SCHEDULE);
assert.equal(scheduleModeForEnd("21:00"), FIXED_SCHEDULE);
assert.equal(isResumableJobStatus("QUEUED"), true);
assert.equal(isResumableJobStatus("WAITING_PART3"), true);
assert.equal(isResumableJobStatus("SENDING_PART2"), true);
assert.equal(isResumableJobStatus("SENT"), false);
assert.equal(isResumableJobStatus("FAILED"), false);
assert.equal(isRecipientNotOnWhatsAppError(new Error('send failed: {"exists":false}')), true);
assert.equal(isRecipientNotOnWhatsAppError({ error: "不是 WhatsApp 号码 (not on WhatsApp)" }), true);
assert.equal(isRecipientNotOnWhatsAppError(new Error("HTTP 500 provider unavailable")), false);
assert.equal(isRecipientNotOnWhatsAppError(new Error("Could not send WhatsApp message: HTTP 500")), false);

function queuedAssignments(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `lead-${index + 1}`,
    lead: { name: `Lead ${index + 1}` },
    status: "QUEUED",
  }));
}

{
  const runner = new CampaignRunner({ config, env: {} });
  runner.state = {
    mode: "LIVE",
    scheduleMode: "AUTO",
    startAt: "2020-01-01T00:00:00.000Z",
    endAt: "2020-01-01T01:00:00.000Z",
    assignments: queuedAssignments(3).map((job) => ({
      ...job,
      part2Text: "Part 2",
      extraParts: [{ text: "Part 3" }],
    })),
  };
  const before = Date.now();
  runner.rebaseSchedule();
  const times = runner.state.assignments.map((job) => new Date(job.scheduledAt).getTime());
  assert.ok(times[0] >= before);
  assert.ok(times[1] - times[0] >= 180_000, "AUTO with 3 Parts must not use the old 120-second slot");
}

{
  const runner = new CampaignRunner({ config, env: {} });
  const observed = [];
  runner.state = {
    mode: "LIVE",
    scheduleMode: "AUTO",
    startAt: new Date(0).toISOString(),
    endAt: new Date(Date.now() + 60_000).toISOString(),
    assignments: [
      { id: "partial", status: "WAITING_PART3", scheduledAt: new Date(0).toISOString() },
      { id: "done", status: "SENT", scheduledAt: new Date(0).toISOString() },
    ],
  };
  runner.saveState = async () => {};
  runner.processJob = async (job) => { observed.push(job.id); job.status = "SENT"; };
  await runner.runQueue();
  assert.deepEqual(observed, ["partial"], "Resume must continue an interrupted Part without resending completed jobs");
}

{
  const runner = new CampaignRunner({ config, env: {} });
  const sent = [];
  runner.state = {
    mode: "LIVE",
    scheduleMode: "AUTO",
    startAt: new Date(0).toISOString(),
    endAt: new Date(Date.now() + 60_000).toISOString(),
    assignments: [],
  };
  const job = {
    id: "partial-extra",
    status: "WAITING_PART3",
    scheduledAt: new Date(0).toISOString(),
    instanceName: "wa_01",
    lead: { name: "Partial Lead", phone: "60123456789" },
    part1: { sentAt: "2026-07-17T01:00:00.000Z" },
    part2: { sentAt: "2026-07-17T01:01:00.000Z" },
    part1Text: "P1",
    part2Text: "P2",
    extraParts: [{ text: "P3", media: "", sentInfo: null }],
  };
  runner.state.assignments = [job];
  runner.suppression = new Set();
  runner.saveState = async () => {};
  runner.waitBetweenParts = async (_job, part) => { observedPart.push(part); };
  const observedPart = [];
  runner.sendMediaWithRetry = async (_instance, _phone, text) => {
    sent.push(text);
    return { sentAt: new Date().toISOString() };
  };
  await runner.processJob(job);
  assert.deepEqual(observedPart, [3], "A Part 3 resume must not wait for Part 2 again");
  assert.deepEqual(sent, ["P3"], "A Part 3 resume must send only the unfinished Part");
  assert.equal(job.status, "SENT");
}

{
  const runner = new CampaignRunner({ config, env: {} });
  runner.state = {
    mode: "LIVE",
    scheduleMode: "AUTO",
    startAt: start.toISOString(),
    endAt: new Date(start.getTime() + 120_000).toISOString(),
    assignments: queuedAssignments(70).map((job) => ({
      ...job,
      part2Text: "Part 2",
      extraParts: [{ text: "Part 3" }],
    })),
  };
  runner.refreshAutoScheduleEstimate();
  assert.equal(runner.state.endAt, "2026-07-17T04:30:00.000Z", "preview must show the 3-Part AUTO estimate");
}

{
  const runner = new CampaignRunner({ config, env: {} });
  runner.state = {
    mode: "LIVE",
    scheduleMode: "AUTO",
    startAt: new Date().toISOString(),
    endAt: new Date(Date.now() + 60_000).toISOString(),
    assignments: queuedAssignments(2).map((job) => ({ ...job, scheduledAt: new Date(0).toISOString() })),
  };
  runner.saveState = async () => {};
  const observed = [];
  runner.processJob = async (job) => {
    observed.push(new Date(job.scheduledAt).getTime());
    job.status = "SENT";
  };
  const before = Date.now();
  await runner.runQueue();
  assert.ok(observed[1] >= before + 45_000, "next customer must retain a contact gap after the previous job completes");
}

{
  const runner = new CampaignRunner({ config, env: {} });
  runner.state = {
    mode: "LIVE",
    scheduleMode: "AUTO",
    startAt: "2020-01-01T00:00:00.000Z",
    endAt: "2020-01-01T00:54:00.000Z",
    assignments: queuedAssignments(27),
  };
  const before = Date.now();
  runner.rebaseSchedule();
  const times = runner.state.assignments.map((job) => new Date(job.scheduledAt).getTime());
  assert.ok(times[0] >= before, "queued AUTO batch must start from its real launch time");
  for (let index = 1; index < times.length; index += 1) {
    assert.ok(times[index] - times[index - 1] >= 120_000, "AUTO must keep the hard safety floor");
  }
  assert.equal(new Date(runner.state.endAt).getTime(), times.at(-1) + 120_000);
}

{
  const runner = new CampaignRunner({ config, env: {} });
  const now = Date.now();
  runner.state = {
    mode: "LIVE",
    scheduleMode: "FIXED",
    startAt: new Date(now).toISOString(),
    endAt: new Date(now + 4 * 60 * 60 * 1000).toISOString(),
    assignments: queuedAssignments(3),
  };
  runner.rebaseSchedule();
  const times = runner.state.assignments.map((job) => new Date(job.scheduledAt).getTime());
  assert.ok(times[1] - times[0] > 120_000, "FIXED mode should spread leads across the requested window");
}

{
  const runner = new CampaignRunner({ config: { delivery: { replyLookbackDays: 0 } }, env: {} });
  const job = {
    id: "no-whatsapp",
    status: "QUEUED",
    scheduledAt: new Date(0).toISOString(),
    instanceName: "wa_01",
    lead: { name: "No WhatsApp", phone: "60111111111" },
    part1Text: "Hello",
    part1Media: "",
    part2Text: "",
    part2Media: "",
  };
  runner.state = {
    mode: "LIVE",
    scheduleMode: "AUTO",
    startAt: new Date(0).toISOString(),
    endAt: new Date(Date.now() + 60_000).toISOString(),
    assignments: [job],
  };
  runner.suppression = new Set();
  runner.saveState = async () => {};
  runner.systemLog = async () => {};
  runner.sendMediaWithRetry = async () => { throw new RecipientNotOnWhatsAppError(); };
  await runner.processJob(job);
  assert.equal(job.status, "SKIPPED_NO_WHATSAPP", "a non-WhatsApp number is an unreachable skip, not a send failure");
  assert.equal(runner.consecutiveFailures, 0, "an unreachable number must not contribute to auto-stop failures");
  assert.equal(runner.stopped, false, "an unreachable number must not stop the campaign");
}

{
  const runner = new CampaignRunner({ config, env: {} });
  runner.state = {
    assignments: [
      { id: "legacy-no-wa", status: "FAILED", error: "不是 WhatsApp 号码 (not on WhatsApp)" },
      { id: "provider-error", status: "FAILED", error: "Evolution HTTP 500" },
      { id: "sent", status: "SENT", part1: { sentAt: new Date().toISOString() } },
    ],
  };
  assert.equal(runner.retryFailedOnly(), 1, "only a genuine send error should enter the retry queue");
  assert.equal(runner.state.assignments[0].status, "SKIPPED_NO_WHATSAPP");
  assert.equal(runner.state.assignments[1].status, "QUEUED");
}

{
  const outcomes = campaignOutcomeSummary([
    { status: "SENT", part1: { sentAt: new Date().toISOString() } },
    { status: "WAITING_PART3", part1: { sentAt: new Date().toISOString() } },
    { status: "SKIPPED_NO_WHATSAPP" },
    { status: "SKIPPED_REPLIED" },
    { status: "FAILED" },
  ]);
  assert.deepEqual(outcomes, {
    total: 5,
    processed: 4,
    contacted: 1,
    pending: 1,
    skipped: 2,
    noWhatsapp: 1,
    failed: 1,
    percent: 80,
  });
}

console.log("✅ all campaign-schedule tests passed");
