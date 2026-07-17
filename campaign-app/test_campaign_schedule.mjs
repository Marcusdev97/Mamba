import assert from "node:assert/strict";
import { CampaignRunner } from "./campaign_core.mjs";
import {
  AUTO_SCHEDULE,
  FIXED_SCHEDULE,
  campaignPacing,
  estimateAutoEnd,
  scheduleModeForEnd,
} from "./lib/campaign-schedule.mjs";

const config = {
  delivery: {
    partGapSeconds: 45,
    contactGapSeconds: { min: 45, max: 75 },
  },
};

const start = new Date("2026-07-17T01:00:00.000Z");
assert.equal(campaignPacing(config).floorMs, 120_000);
assert.equal(estimateAutoEnd(start, 27, config).toISOString(), "2026-07-17T01:54:00.000Z");
assert.equal(estimateAutoEnd(start, 169, config).toISOString(), "2026-07-17T06:38:00.000Z");
assert.equal(AUTO_SCHEDULE, "AUTO");
assert.equal(FIXED_SCHEDULE, "FIXED");
assert.equal(scheduleModeForEnd(""), AUTO_SCHEDULE);
assert.equal(scheduleModeForEnd("   "), AUTO_SCHEDULE);
assert.equal(scheduleModeForEnd("21:00"), FIXED_SCHEDULE);

function queuedAssignments(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `lead-${index + 1}`,
    status: "QUEUED",
  }));
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

console.log("✅ all campaign-schedule tests passed");
