import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { loadEnv } from "./campaign_core.mjs";
import { makeHub } from "./telegram_hub.mjs";
import { makeTelegram, escapeHtml } from "./telegram.mjs";
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
const checkIntervalMs = Math.max(15_000, Number(env.MAMBA_WATCHDOG_INTERVAL_SECONDS || process.env.MAMBA_WATCHDOG_INTERVAL_SECONDS || 30) * 1000);
const heartbeatIntervalMs = Math.max(15 * 60_000, Number(env.MAMBA_WATCHDOG_TELEGRAM_MINUTES || process.env.MAMBA_WATCHDOG_TELEGRAM_MINUTES || 60) * 60_000);
const externalHeartbeatUrl = String(env.MAMBA_HEALTHCHECK_URL || process.env.MAMBA_HEALTHCHECK_URL || "").trim();
const autoRestart = String(env.MAMBA_WATCHDOG_AUTO_RESTART || process.env.MAMBA_WATCHDOG_AUTO_RESTART || "1") !== "0";
const once = process.argv.includes("--once");
const dryRun = process.argv.includes("--dry-run");
const hub = makeHub(env);
const telegram = makeTelegram(env);

let state = await readJson(statusPath, {});
let restartAttemptAt = 0;
let externalPingAt = 0;
let runningCheck = false;

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
    return unreachableWatchdogHealth(error, { serverUrl });
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

async function checkOnce({ startup = false } = {}) {
  if (runningCheck) return;
  runningCheck = true;
  try {
    let snapshot = await fetchHealth();
    let restarted = false;
    if (!snapshot.reachable) {
      restarted = await startMambaServer();
      if (restarted) {
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        snapshot = await fetchHealth();
      }
    }

    const transition = watchdogTransition(state, snapshot, { failureThreshold: 2 });
    const now = new Date().toISOString();
    const lastHeartbeatMs = new Date(state.lastTelegramHeartbeatAt || 0).getTime();
    const heartbeatDue = snapshot.healthy
      && (!Number.isFinite(lastHeartbeatMs) || Date.now() - lastHeartbeatMs >= heartbeatIntervalMs);

    let reportSent = false;
    let heartbeatSent = false;
    if (transition.shouldReportFailure) {
      reportSent = await notify(`🔴 <b>服务异常</b>\n${escapeHtml(formatWatchdogStatus(snapshot))}${restarted ? "\n已尝试自动重启 Mamba。" : ""}`)
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
    } else if (snapshot.healthy && (startup || heartbeatDue)) {
      heartbeatSent = await notify(`🟢 <b>心跳正常</b>\n${escapeHtml(formatWatchdogStatus(snapshot))}`)
        .then(() => true)
        .catch((error) => {
          console.log(`[watchdog] Telegram heartbeat failed: ${error.message}`);
          return false;
        });
    }

    await pingExternal(snapshot);
    state = {
      version: 1,
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
      reportedSignature: reportSent ? transition.signature : state.reportedSignature || "",
      lastRestartAttemptAt: restarted ? now : state.lastRestartAttemptAt || null,
      lastTelegramHeartbeatAt: heartbeatSent ? now : state.lastTelegramHeartbeatAt || null,
      externalHeartbeatConfigured: Boolean(externalHeartbeatUrl),
    };
    await atomicWrite(statusPath, state);
    console.log(`[watchdog] ${now} ${snapshot.healthy ? "HEALTHY" : "CHECK"} · ${formatWatchdogStatus(snapshot).replaceAll("\n", " · ")}`);
  } finally {
    runningCheck = false;
  }
}

console.log(`Mamba Watchdog · ${deviceName}`);
console.log(`Watching ${serverUrl} every ${Math.round(checkIntervalMs / 1000)} seconds.`);
console.log(`Telegram heartbeat every ${Math.round(heartbeatIntervalMs / 60000)} minutes.`);
console.log(externalHeartbeatUrl ? "External dead-man heartbeat enabled." : "External dead-man heartbeat not configured.");

await checkOnce({ startup: true });
if (once) process.exit(0);
const timer = setInterval(() => {
  checkOnce().catch((error) => console.log(`[watchdog] Check failed: ${error.message}`));
}, checkIntervalMs);

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    clearInterval(timer);
    process.exit(0);
  });
}
