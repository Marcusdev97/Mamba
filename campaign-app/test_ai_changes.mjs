import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSettingsService } from "./lib/settings-service.mjs";

const payload = JSON.parse(await fs.readFile(new URL("./assets/ai-changes.json", import.meta.url), "utf8"));
const html = await fs.readFile(new URL("./ai-changes.html", import.meta.url), "utf8");
const staticRoutes = await fs.readFile(new URL("./routes/static.routes.mjs", import.meta.url), "utf8");
const shell = await fs.readFile(new URL("./assets/mamba-shell.js", import.meta.url), "utf8");
const settingsHtml = await fs.readFile(new URL("./settings.html", import.meta.url), "utf8");
const settingsRoutes = await fs.readFile(new URL("./routes/settings.routes.mjs", import.meta.url), "utf8");
const campaignRoutes = await fs.readFile(new URL("./routes/campaign.routes.mjs", import.meta.url), "utf8");
const brainService = await fs.readFile(new URL("./brain_service.mjs", import.meta.url), "utf8");

assert.equal(payload.version, 2);
assert.ok(Array.isArray(payload.recordingStandard));
assert.deepEqual(payload.recordingStandard, [
  "为什么要改",
  "改了什么",
  "影响哪里",
  "现在怎么用",
  "怎么验证",
  "对应 Git commit",
]);
assert.ok(Array.isArray(payload.changes) && payload.changes.length >= 3);
for (const item of payload.changes) {
  assert.ok(item.id);
  assert.ok(item.title);
  assert.ok(item.before?.text);
  assert.ok(item.after?.text);
  assert.ok(Array.isArray(item.types) && item.types.length);
}
const currentFormatChanges = payload.changes.filter((item) => item.date >= "2026-07-27");
assert.ok(currentFormatChanges.length >= 4);
for (const item of currentFormatChanges) {
  assert.equal(item.status, "verified");
  assert.ok(item.area);
  assert.ok(item.reason);
  assert.ok(item.impact);
  assert.ok(item.usage);
  assert.ok(item.commit);
  assert.ok(Array.isArray(item.verification) && item.verification.length);
}
assert.match(html, /data-testid="ai-change-list"/);
assert.match(html, /以前/);
assert.match(html, /现在/);
assert.match(html, /为什么要改/);
assert.match(html, /验证结果/);
assert.match(html, /searchInput/);
assert.match(staticRoutes, /"\/ai-changes": "ai-changes\.html"/);
assert.match(staticRoutes, /"application\/json; charset=utf-8"/);
assert.match(shell, /label: "AI Changes", href: "\/ai-changes"/);
assert.doesNotMatch(settingsHtml, /Kimi|Moonshot/i);
assert.doesNotMatch(settingsRoutes, /Kimi|Moonshot/i);
assert.doesNotMatch(brainService, /Kimi|Moonshot/i);
assert.doesNotMatch(campaignRoutes, /getTestLeads\(body\.testRecipients/, "Campaign routes must not override Settings TEST_LEADS");

const emptySettings = createSettingsService({
  env: {},
  envPath: "/tmp/mamba-test-unused.env",
  getNotionToken: () => "",
  notion: async () => ({}),
}).snapshot();
assert.deepEqual(emptySettings.testRecipients, [], "Settings must never invent default TEST recipients");
assert.equal(emptySettings.testLeadsEnv.configured, false);
assert.deepEqual(emptySettings.watchdog, {
  telegramNotificationsEnabled: true,
  checkIntervalSeconds: 30,
  failureDelayMinutes: 1,
  reminderMinutes: 0,
});

const settingsDir = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-settings-"));
const envPath = path.join(settingsDir, ".env");
const env = {};
const writableSettings = createSettingsService({
  env,
  envPath,
  getNotionToken: () => "",
  notion: async () => ({}),
});
await writableSettings.writeEnvValues({ TEST_LEADS: "Test User:60123456789:en" });
await writableSettings.writeEnvValues({
  MAMBA_WATCHDOG_TELEGRAM_ENABLED: "0",
  MAMBA_WATCHDOG_INTERVAL_SECONDS: "60",
  MAMBA_WATCHDOG_TELEGRAM_DELAY_MINUTES: "5",
  MAMBA_WATCHDOG_TELEGRAM_REMINDER_MINUTES: "0",
});
assert.match(await fs.readFile(envPath, "utf8"), /^TEST_LEADS=Test User:60123456789:en$/m);
assert.equal((await fs.stat(envPath)).mode & 0o777, 0o600, "Settings env must remain private");
assert.equal(writableSettings.snapshot().testLeadsEnv.count, 1);
assert.deepEqual(writableSettings.snapshot().watchdog, {
  telegramNotificationsEnabled: false,
  checkIntervalSeconds: 60,
  failureDelayMinutes: 5,
  reminderMinutes: 0,
});
await fs.rm(settingsDir, { recursive: true, force: true });

console.log("✅ AI change log page tests passed");
