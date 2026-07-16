import assert from "node:assert/strict";
import {
  formatWatchdogStatus,
  summarizeWatchdogHealth,
  unreachableWatchdogHealth,
  watchdogSignature,
  watchdogTransition,
} from "./lib/watchdog-service.mjs";

const healthy = summarizeWatchdogHealth({
  ok: true,
  health: [
    { id: "server", label: "Mamba Server", ok: true, detail: "Online" },
    { id: "whatsapp", label: "WhatsApp", ok: true, detail: "2/2 connected" },
    { id: "tracker", label: "Tracker", ok: true, detail: "Online" },
    { id: "brain", label: "Brain", ok: true, detail: "Online" },
    { id: "notion", label: "Notion", ok: false, detail: "Stale" },
  ],
});
assert.equal(healthy.healthy, true, "stale Notion cache should be visible but must not kill reply monitoring");
assert.equal(watchdogSignature(healthy), "server:up|whatsapp:up|tracker:up|brain:up");
assert.match(formatWatchdogStatus(healthy), /WARN Notion - Stale/);

const down = unreachableWatchdogHealth(new Error("fetch failed"));
const first = watchdogTransition({}, down, { failureThreshold: 2 });
assert.equal(first.shouldReportFailure, false, "one short network wobble must not alert");
const second = watchdogTransition({ consecutiveFailures: 1 }, down, { failureThreshold: 2 });
assert.equal(second.shouldReportFailure, true, "second consecutive failure must alert");

const recovery = watchdogTransition({
  consecutiveFailures: 3,
  reportedSignature: "server:down",
}, healthy, { failureThreshold: 2 });
assert.equal(recovery.shouldReportRecovery, true);
assert.equal(recovery.consecutiveFailures, 0);

console.log("✅ all watchdog tests passed");
