import assert from "node:assert/strict";
import fs from "node:fs/promises";
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
    { id: "docker", label: "Docker Engine", ok: true, detail: "Online" },
    { id: "evolution", label: "Evolution API", ok: true, detail: "Online" },
    { id: "whatsapp", label: "WhatsApp", ok: true, detail: "2/2 connected" },
    { id: "tracker", label: "Tracker", ok: true, detail: "Online" },
    { id: "brain", label: "Brain", ok: true, detail: "Online" },
    { id: "notion", label: "Notion", ok: false, detail: "Stale" },
  ],
});
assert.equal(healthy.healthy, true, "stale Notion cache should be visible but must not kill reply monitoring");
assert.equal(watchdogSignature(healthy), "server:up|docker:up|evolution:up|whatsapp:up|tracker:up|brain:up");
assert.match(formatWatchdogStatus(healthy), /WARN Notion - Stale/);

const legacy = summarizeWatchdogHealth({
  ok: true,
  health: [
    { id: "server", label: "Mamba Server", ok: true, detail: "Online" },
    { id: "whatsapp", label: "WhatsApp", ok: true, detail: "2/2 connected" },
    { id: "tracker", label: "Tracker", ok: true, detail: "Online" },
    { id: "brain", label: "Brain", ok: true, detail: "Online" },
  ],
});
assert.equal(legacy.healthy, true, "rolling upgrade must infer Docker/Evolution from the legacy WhatsApp signal");
assert.match(legacy.components.find((item) => item.id === "docker").detail, /Rolling upgrade/);

const down = unreachableWatchdogHealth(new Error("fetch failed"));
const first = watchdogTransition({}, down, { failureThreshold: 2 });
assert.equal(first.shouldReportFailure, false, "one short network wobble must not alert");
const second = watchdogTransition({ consecutiveFailures: 1 }, down, { failureThreshold: 2 });
assert.equal(second.shouldReportFailure, true, "second consecutive failure must alert");
const repeated = watchdogTransition({
  consecutiveFailures: 2,
  reportedSignature: second.signature,
}, down, { failureThreshold: 2 });
assert.equal(repeated.shouldReportFailure, false, "the same confirmed failure must not repeatedly alert");

const recovery = watchdogTransition({
  consecutiveFailures: 3,
  reportedSignature: "server:down",
}, healthy, { failureThreshold: 2 });
assert.equal(recovery.shouldReportRecovery, true);
assert.equal(recovery.consecutiveFailures, 0);

const stableRecovery = watchdogTransition({
  consecutiveFailures: 0,
  reportedSignature: recovery.signature,
}, healthy, { failureThreshold: 2 });
assert.equal(stableRecovery.shouldReportRecovery, false, "healthy checks must stay silent after recovery");

const watchdogSource = await fs.readFile(new URL("./mamba_watchdog.mjs", import.meta.url), "utf8");
assert.doesNotMatch(watchdogSource, /心跳正常|MAMBA_WATCHDOG_TELEGRAM_MINUTES|lastTelegramHeartbeatAt/,
  "Watchdog must not send periodic healthy Telegram heartbeats");

console.log("✅ all watchdog tests passed");
