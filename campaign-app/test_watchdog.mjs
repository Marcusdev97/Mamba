import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {
  DEFAULT_WATCHDOG_SETTINGS,
  validateWatchdogSettings,
  watchdogSettingsFromEnv,
  watchdogSettingsToEnv,
} from "./config/watchdog-config.mjs";
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
const t0 = Date.parse("2026-08-02T00:00:00.000Z");
const first = watchdogTransition({}, down, { failureDelayMs: 60_000, nowMs: t0 });
assert.equal(first.shouldReportFailure, false, "one short network wobble must not alert");
const early = watchdogTransition({
  healthy: false,
  consecutiveFailures: 1,
  failureStartedAt: first.failureStartedAt,
}, down, { failureDelayMs: 60_000, nowMs: t0 + 59_000 });
assert.equal(early.shouldReportFailure, false, "failure must remain quiet until the configured delay passes");
const second = watchdogTransition({
  healthy: false,
  consecutiveFailures: 2,
  failureStartedAt: first.failureStartedAt,
}, down, { failureDelayMs: 60_000, nowMs: t0 + 60_000 });
assert.equal(second.shouldReportFailure, true, "confirmed failure must alert after the configured delay");
const repeated = watchdogTransition({
  healthy: false,
  consecutiveFailures: 2,
  failureStartedAt: first.failureStartedAt,
  lastFailureAlertAt: new Date(t0 + 60_000).toISOString(),
  reportedSignature: second.signature,
}, down, { failureDelayMs: 60_000, reminderIntervalMs: 0, nowMs: t0 + 120_000 });
assert.equal(repeated.shouldReportFailure, false, "the same confirmed failure must not repeatedly alert");
assert.equal(repeated.shouldReportReminder, false, "zero reminder interval must keep the same incident quiet");

const reminder = watchdogTransition({
  healthy: false,
  consecutiveFailures: 3,
  failureStartedAt: first.failureStartedAt,
  lastFailureAlertAt: new Date(t0 + 60_000).toISOString(),
  reportedSignature: second.signature,
}, down, { failureDelayMs: 60_000, reminderIntervalMs: 30 * 60_000, nowMs: t0 + 31 * 60_000 });
assert.equal(reminder.shouldReportReminder, true, "explicit reminder timing must be honored");

const recovery = watchdogTransition({
  healthy: false,
  consecutiveFailures: 3,
  lastFailureAlertAt: new Date(t0 + 60_000).toISOString(),
  reportedSignature: "server:down",
}, healthy, { nowMs: t0 + 32 * 60_000 });
assert.equal(recovery.shouldReportRecovery, true);
assert.equal(recovery.consecutiveFailures, 0);

const stableRecovery = watchdogTransition({
  healthy: true,
  consecutiveFailures: 0,
}, healthy, { nowMs: t0 + 33 * 60_000 });
assert.equal(stableRecovery.shouldReportRecovery, false, "healthy checks must stay silent after recovery");

assert.deepEqual(watchdogSettingsFromEnv({}), DEFAULT_WATCHDOG_SETTINGS);
assert.deepEqual(watchdogSettingsFromEnv({
  MAMBA_WATCHDOG_TELEGRAM_ENABLED: "0",
  MAMBA_WATCHDOG_INTERVAL_SECONDS: "45",
  MAMBA_WATCHDOG_TELEGRAM_DELAY_MINUTES: "5",
  MAMBA_WATCHDOG_TELEGRAM_REMINDER_MINUTES: "60",
}), { telegramNotificationsEnabled: false, checkIntervalSeconds: 45, failureDelayMinutes: 5, reminderMinutes: 60 });
assert.throws(() => validateWatchdogSettings({ telegramNotificationsEnabled: "maybe" }), /开启或关闭/);
assert.throws(() => validateWatchdogSettings({ checkIntervalSeconds: 5 }), /15–600/);
assert.equal(validateWatchdogSettings({ failureDelayMinutes: 6 * 60 }).failureDelayMinutes, 360,
  "Telegram failure delay must support six hours");
assert.throws(() => validateWatchdogSettings({ failureDelayMinutes: 1441 }), /1–1440/);
assert.deepEqual(watchdogSettingsToEnv({
  telegramNotificationsEnabled: false,
  checkIntervalSeconds: 60,
  failureDelayMinutes: 10,
  reminderMinutes: 0,
}), {
  MAMBA_WATCHDOG_TELEGRAM_ENABLED: "0",
  MAMBA_WATCHDOG_INTERVAL_SECONDS: "60",
  MAMBA_WATCHDOG_TELEGRAM_DELAY_MINUTES: "10",
  MAMBA_WATCHDOG_TELEGRAM_REMINDER_MINUTES: "0",
});

const watchdogSource = await fs.readFile(new URL("./mamba_watchdog.mjs", import.meta.url), "utf8");
assert.doesNotMatch(watchdogSource, /心跳正常|MAMBA_WATCHDOG_TELEGRAM_MINUTES|lastTelegramHeartbeatAt/,
  "Watchdog must not send periodic healthy Telegram heartbeats");
assert.match(watchdogSource, /reloadTiming/, "Watchdog must reload Settings timing without restarting a Campaign");
assert.match(watchdogSource, /timing\.telegramNotificationsEnabled && \(transition\.shouldReportFailure/,
  "Watchdog failure and reminder Telegram delivery must respect the operator switch");
assert.match(watchdogSource, /timing\.telegramNotificationsEnabled && transition\.shouldReportRecovery/,
  "Watchdog recovery Telegram delivery must respect the operator switch");
assert.doesNotMatch(watchdogSource, /setInterval\(/, "dynamic timing must not be frozen in a process-lifetime interval");

const settingsHtml = await fs.readFile(new URL("./settings.html", import.meta.url), "utf8");
assert.match(settingsHtml, /watchdogFailureDelayValue/);
assert.match(settingsHtml, /watchdogFailureDelayUnit/);
assert.match(settingsHtml, /watchdogReminderValue/);
assert.match(settingsHtml, /watchdogTelegramNotificationsEnabled/);
assert.match(settingsHtml, /Telegram 通知总开关/);
assert.match(settingsHtml, /支持最长 24 小时/);
const settingsRoutes = await fs.readFile(new URL("./routes/settings.routes.mjs", import.meta.url), "utf8");
assert.match(settingsRoutes, /watchdogSettingsFromBody/);

console.log("✅ all watchdog tests passed");
