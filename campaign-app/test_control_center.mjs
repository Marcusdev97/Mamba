import assert from "node:assert/strict";
import { campaignSummary, recentActivity, summarizeRecords } from "./routes/control-center.routes.mjs";

const records = [
  {
    id: "reply",
    name: "Warm Lead",
    project: "Gen Starz",
    lastBlastAt: "2026-07-12T01:00:00.000Z",
    lastReplyAt: "2026-07-12T02:00:00.000Z",
    lastReplyText: "Can view this weekend?",
    nextAction: "Book Appointment",
    appointmentStatus: "Confirmed",
  },
  {
    id: "overdue",
    name: "Follow Up Lead",
    lastBlastAt: "2026-07-11T01:00:00.000Z",
    followUpAt: "2026-07-11T04:00:00.000Z",
    nextAction: "Follow Up",
  },
  {
    id: "stopped",
    name: "Stopped Lead",
    lastReplyAt: "2026-07-12T03:00:00.000Z",
    lastReplyText: "Stop",
    status: "Not Interested",
    stopFlag: true,
    followUpAt: "2026-07-11T04:00:00.000Z",
  },
];

const metrics = summarizeRecords(records, "2026-07-12");
assert.equal(metrics.totalCustomers, 3);
assert.equal(metrics.todaySent, 1);
assert.equal(metrics.todayReplies, 2);
assert.equal(metrics.overdue, 1, "STOP leads must not appear in overdue work");
assert.equal(metrics.appointments, 1);
assert.equal(metrics.followUps, 2, "Only active replied/actionable leads belong in the work queue");

const recent = recentActivity(records);
assert.equal(recent.length, 3);
assert.equal(recent[0].id, "stopped");
assert.equal(recent[0].type, "stop");
assert.equal(recent[1].type, "reply");

const campaign = campaignSummary({
  running: true,
  stopped: false,
  state: {
    runId: "run_test",
    project: "Binastra",
    status: "RUNNING",
    mode: "TEST",
    instances: [{ name: "wa_01" }],
    assignments: [
      { status: "SENT" },
      { status: "FAILED" },
      { status: "SKIPPED_MANUAL" },
      { status: "QUEUED" },
    ],
  },
});
assert.equal(campaign.total, 4);
assert.equal(campaign.sent, 1);
assert.equal(campaign.failed, 1);
assert.equal(campaign.skipped, 1);
assert.deepEqual(campaign.instances, ["wa_01"]);

console.log("✅ all control-center tests passed");
