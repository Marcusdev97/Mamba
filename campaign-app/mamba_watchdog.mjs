import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { listInstances, loadEnv, makeApi } from "./campaign_core.mjs";
import { createEvolutionHealthService } from "./lib/evolution-health-service.mjs";
import { makeHub } from "./telegram_hub.mjs";
import { makeTelegram, escapeHtml } from "./telegram.mjs";
import { watchdogSettingsFromEnv } from "./config/watchdog-config.mjs";
import {
  formatWatchdogStatus,
  summarizeWatchdogHealth,
  unreachableWatchdogHealth,
  watchdogTransition,
} from "./lib/watchdog-service.mjs";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(appDir, "..");
const dataDir = path.join(rootDir, "campaign-data", "watchdog");
const statusPath = path.join(dataDir, "status.json");
const logsDir = path.join(rootDir, "launchd", "logs");
const serverScript = path.join(rootDir, "campaign-app", "server.mjs");

const env = await loadEnv().catch(() => ({}));
const serverUrl = String(env.MAMBA_WATCHDOG_SERVER_URL || process.env.MAMBA_WATCHDOG_SERVER_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const deviceName = String(env.MAMBA_DEVICE_NAME || process.env.MAMBA_DEVICE_NAME || os.hostname()).trim();
const externalHeartbeatUrl = String(env.MAMBA_HEALTHCHECK_URL || process.env.MAMBA_HEALTHCHECK_URL || "").trim();
const autoRestart = String(process.env.MAMBA_WATCHDOG_AUTO_RESTART ?? env.MAMBA_WATCHDOG_AUTO_RESTART ?? "0") === "1";
const once = process.argv.includes("--once");
const dryRun = process.argv.includes("--dry-run");
const hub = makeHub(env);
const telegram = makeTelegram(env);
const watchdogApi = makeApi(env);
const transportHealth = createEvolutionHealthService({
  listInstances: () => listInstances(watchdogApi),
});

let state = await readJson(statusPath, {});
let restartAttemptAt = 0;
let externalPingAt = 0;
let runningCheck = false;
let timing = watchdogSettingsFromEnv({ ...process.env, ...env });
let timer = null;

async function readJson(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, "utf8")); }
  catch { return fallback; }
}

async function atomicWrite(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp.${process.pid}`;
  await fsp.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await fsp.rename(temp, file);
}

async function reloadTiming() {
  const latest = await loadEnv().catch(() => ({}));
  timing = watchdogSettingsFromEnv({ ...process.env, ...latest });
  return timing;
}

async function notify(text) {
  const body = `<b>Mamba Watchdog · ${escapeHtml(deviceName)}</b>\n${text}`;
  if (dryRun) {
    console.log(`[watchdog:dry-run] ${body.replace(/<[^>]+>/g, "")}`);
    return { dryRun: true };
  }
  if (hub.hasOps) return hub.postOps(body);
  if (telegram.enabled && telegram.hasChatId) return telegram.send(body);
  console.log(`[watchdog] Telegram is not configured. ${body.replace(/<[^>]+>/g, "")}`);
  return { skipped: "telegram not configured" };
}

async function fetchHealth() {
  try {
    const response = await fetch(`${serverUrl}/api/control-center`, {
      signal: AbortSignal.timeout(7000),
      headers: { Accept: "application/json" },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok !== true) {
      throw new Error(payload.error || `Mamba HTTP ${response.status}`);
    }
    return summarizeWatchdogHealth(payload, { serverUrl });
  } catch (error) {
    const unavailable = unreachableWatchdogHealth(error, { serverUrl });
    const transport = await transportHealth.check().catch(() => null);
    if (!transport) return unavailable;
    const replacements = new Map([
      ["docker", { ...transport.docker, label: "Docker Engine" }],
      ["evolution", { ...transport.evolution, label: "Evolution API" }],
      ["whatsapp", { ...transport.whatsapp, label: "WhatsApp Instances" }],
    ]);
    unavailable.components = unavailable.components.map((item) => replacements.get(item.id) || item);
    unavailable.failed = unavailable.components.filter((item) => !item.ok);
    return unavailable;
  }
}

async function startMambaServer() {
  const now = Date.now();
  if (dryRun || !autoRestart || now - restartAttemptAt < 120_000) return false;
  restartAttemptAt = now;
  await fsp.mkdir(logsDir, { recursive: true });
  const outFd = fs.openSync(path.join(logsDir, "com.mamba.server.watchdog.log"), "a");
  const errFd = fs.openSync(path.join(logsDir, "com.mamba.server.watchdog.err.log"), "a");
  const child = spawn(process.execPath, [serverScript], {
    cwd: rootDir,
    env: { ...process.env, MAMBA_AUTO_OPEN: "0" },
    detached: true,
    stdio: ["ignore", outFd, errFd],
  });
  child.unref();
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  console.log(`[watchdog] Restart requested for Mamba Server (pid ${child.pid}).`);
  return true;
}

async function pingExternal(snapshot) {
  if (!externalHeartbeatUrl || !snapshot.healthy || Date.now() - externalPingAt < 5 * 60_000) return;
  externalPingAt = Date.now();
  await fetch(externalHeartbeatUrl, { signal: AbortSignal.timeout(10_000) })
    .catch((error) => console.log(`[watchdog] External heartbeat failed: ${error.message}`));
}

async function checkOnce() {
  if (runningCheck) return;
  runningCheck = true;
  try {
    await reloadTiming();
    let snapshot = await fetchHealth();
    let restarted = false;
    if (!snapshot.reachable) {
      restarted = await startMambaServer();
      if (restarted) {
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        snapshot = await fetchHealth();
      }
    }

    const nowMs = Date.now();
    const transition = watchdogTransition(state, snapshot, {
      failureDelayMs: timing.failureDelayMinutes * 60_000,
      reminderIntervalMs: timing.reminderMinutes * 60_000,
      nowMs,
    });
    const now = new Date(nowMs).toISOString();

    let reportSent = false;
    if (transition.shouldReportFailure || transition.shouldReportReminder) {
      const title = transition.shouldReportReminder ? "持续异常提醒" : "服务异常";
      reportSent = await notify(`🔴 <b>${title}</b>\n${escapeHtml(formatWatchdogStatus(snapshot))}${restarted ? "\n已尝试自动重启 Mamba。" : ""}`)
        .then(() => true)
        .catch((error) => {
          console.log(`[watchdog] Telegram failure alert failed: ${error.message}`);
          return false;
        });
    } else if (transition.shouldReportRecovery) {
      reportSent = await notify(`🟢 <b>服务已恢复</b>\n${escapeHtml(formatWatchdogStatus(snapshot))}`)
        .then(() => true)
        .catch((error) => {
          console.log(`[watchdog] Telegram recovery alert failed: ${error.message}`);
          return false;
        });
    }

    await pingExternal(snapshot);
    state = {
      version: 2,
      deviceName,
      pid: process.pid,
      startedAt: state.startedAt || now,
      heartbeatAt: now,
      serverUrl,
      healthy: snapshot.healthy,
      reachable: snapshot.reachable,
      components: snapshot.components,
      notion: snapshot.notion,
      consecutiveFailures: transition.consecutiveFailures,
      failureStartedAt: snapshot.healthy ? null : transition.failureStartedAt,
      lastFailureAlertAt: snapshot.healthy ? null : (reportSent ? now : state.lastFailureAlertAt || null),
      reportedSignature: snapshot.healthy ? "" : (reportSent ? transition.signature : state.reportedSignature || ""),
      timing,
      lastRestartAttemptAt: restarted ? now : state.lastRestartAttemptAt || null,
      externalHeartbeatConfigured: Boolean(externalHeartbeatUrl),
    };
    if (!dryRun) await atomicWrite(statusPath, state);
    console.log(`[watchdog] ${now} ${snapshot.healthy ? "HEALTHY" : "CHECK"} · ${formatWatchdogStatus(snapshot).replaceAll("\n", " · ")}`);
  } finally {
    runningCheck = false;
  }
}

console.log(`Mamba Watchdog · ${deviceName}`);
console.log(`Watching ${serverUrl}; timing is managed in Mamba Settings.`);
console.log("Telegram reports after the configured failure delay; reminders are off unless enabled.");
console.log(externalHeartbeatUrl ? "External dead-man heartbeat enabled." : "External dead-man heartbeat not configured.");

await checkOnce();
if (once) process.exit(0);

async function scheduleNextCheck() {
  await reloadTiming();
  timer = setTimeout(async () => {
    await checkOnce().catch((error) => console.log(`[watchdog] Check failed: ${error.message}`));
    await scheduleNextCheck();
  }, timing.checkIntervalSeconds * 1000);
}

await scheduleNextCheck();

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    clearTimeout(timer);
    process.exit(0);
  });
}
