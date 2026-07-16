import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTrackerReliabilityService, trackerHeartbeatStatus } from "./lib/tracker-reliability-service.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-tracker-reliability-"));
const trackerDir = path.join(root, "tracker");
const now = new Date("2026-07-15T10:00:00.000Z");
const event = { id: "msg-1", phone: "60111111111", receivedAt: "2026-07-15T09:55:00.000Z", text: "price?" };

const first = createTrackerReliabilityService({ trackerDir, clock: () => now, processId: 123 });
await first.init();
await first.enqueue(event, {
  attempts: 2,
  lastError: "Notion offline",
  errorCode: "NOTION_NETWORK_FAILED",
  nextRetryAt: "2026-07-15T10:01:00.000Z",
  help: "Check the network",
});
await first.heartbeat({ startedAt: "2026-07-15T09:00:00.000Z", lastReplyAt: event.receivedAt });
assert.equal(first.snapshot().pendingCount, 1);

const restarted = createTrackerReliabilityService({ trackerDir, clock: () => now, processId: 456 });
await restarted.init();
assert.equal(restarted.snapshot().pendingCount, 1, "pending Notion reply must survive tracker restart");
assert.equal(restarted.values()[0].attempts, 2);
assert.equal(restarted.values()[0].errorCode, "NOTION_NETWORK_FAILED");
assert.equal(restarted.values()[0].nextRetryAt, "2026-07-15T10:01:00.000Z");
await restarted.updateMany([
  { event, options: { status: "manual_review", errorCode: "NOTION_REPLY_MANUAL_REVIEW" } },
  { event: { ...event, id: "msg-2" }, options: { attempts: 1 } },
]);
assert.equal(restarted.snapshot().pendingCount, 2);
assert.equal(restarted.snapshot().manualReviewCount, 1);
await restarted.removeMany(["msg-1", "msg-2"]);
assert.equal(restarted.snapshot().pendingCount, 0);

const fresh = trackerHeartbeatStatus({ heartbeatAt: "2026-07-15T09:59:30.000Z", lastReplyAt: "2026-07-14T10:00:00.000Z" }, { now });
assert.equal(fresh.fresh, true, "old customer reply must not make a live tracker unhealthy");
assert.equal(fresh.lastReplyAgeMinutes, 1440);
assert.equal(fresh.manualReviewNotionReplies, 0);
const stale = trackerHeartbeatStatus({ heartbeatAt: "2026-07-15T09:55:00.000Z" }, { now });
assert.equal(stale.fresh, false);

await fs.rm(root, { recursive: true, force: true });
console.log("✅ all tracker-reliability tests passed");
