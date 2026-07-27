import assert from "node:assert/strict";
import { sanitizeControlCenter } from "./phone-view-server.mjs";

const sanitized = sanitizeControlCenter({
  ok: true,
  generatedAt: "2026-07-27T12:00:00.000Z",
  scope: {
    device: { id: "marcus-mac", name: "Marcus Mac", hostname: "marcus.local" },
    senders: [{ name: "wa_01", number: "60110000000", status: "OPEN", secret: "drop-me" }],
  },
  metrics: { todaySent: 7, todayReplies: 2, followUps: 3, appointments: 1, totalCustomers: 999 },
  campaign: {
    project: "Binastra",
    status: "RUNNING",
    mode: "LIVE",
    total: 12,
    sent: 4,
    pending: 8,
    failed: 0,
    processed: 4,
    running: true,
    instances: ["wa_01"],
  },
  health: [{ id: "server", label: "Mamba Server", state: "online", detail: "Online" }],
  logs: { errorsToday: 0, warningsToday: 1 },
  recent: [{ name: "Private Customer", phone: "60123456789", detail: "Private reply" }],
  queue: [{ label: "Private task" }],
});

assert.equal(sanitized.scope.device.id, "marcus-mac");
assert.equal(sanitized.scope.senders[0].secret, undefined);
assert.equal(sanitized.metrics.totalCustomers, undefined);
assert.equal(sanitized.campaign.pending, 8);
assert.equal(sanitized.recent, undefined, "phone endpoint must not expose customer activity");
assert.equal(sanitized.queue, undefined, "phone endpoint must not expose action links");
assert.doesNotMatch(JSON.stringify(sanitized), /Private Customer|60123456789|Private reply|Private task/);

console.log("✅ Phone View sanitization tests passed");
