import { spawn } from "node:child_process";
import path from "node:path";

const TRACKER_URL = "http://127.0.0.1:8798/";
const BRAIN_URL = "http://127.0.0.1:8799/";

async function defaultProbe(url, timeoutMs = 1200) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createReplyServiceManager({
  rootDir,
  probe = defaultProbe,
  spawnProcess = spawn,
  onLog = (message) => console.log(message),
  systemLogs = null,
  downConfirmDelayMs = 500,
  brainEnabled = false,
} = {}) {
  const children = new Map();
  let lastStatus = { tracker: false, brain: false, checkedAt: null };
  let ensurePromise = null;
  let monitor = null;

  function persistStructuredIssue(label, line) {
    const prefix = "[reply-tracker:issue] ";
    if (!String(line).startsWith(prefix)) return false;
    try {
      const issue = JSON.parse(String(line).slice(prefix.length));
      if (issue.persistedByTracker === true) return true;
      const message = [
        issue.message,
        issue.impact ? `影响：${issue.impact}` : "",
        issue.action ? `处理：${issue.action}` : "",
      ].filter(Boolean).join(" ");
      systemLogs?.write({
        level: issue.level === "error" ? "error" : "warn",
        area: "notion",
        event: issue.code || "reply_sync_issue",
        message,
        context: { service: label, ...issue },
      }).catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  function pipeOutput(child, label) {
    child.stdout?.on("data", (chunk) => {
      for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
        persistStructuredIssue(label, line);
        onLog(`[${label}] ${line}`);
      }
    });
    child.stderr?.on("data", (chunk) => {
      for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
        onLog(`[${label}:error] ${line}`);
        systemLogs?.write({
          level: "error",
          area: "reply_tracker",
          event: "reply_service_stderr",
          message: `${label} 输出未处理错误。影响：回复追踪或同步可能暂停。处理：在 System Logs 查看 details，修正后重启 Mamba。`,
          context: { service: label, details: line },
        }).catch(() => {});
      }
    });
    child.once?.("exit", (code, signal) => {
      children.delete(label);
      onLog(`[${label}] stopped (${signal || `code ${code ?? "unknown"}`}).`);
    });
  }

  function start(label, scriptName, args = []) {
    if (children.has(label)) return children.get(label);
    const script = path.join(rootDir, "campaign-app", scriptName);
    const child = spawnProcess(process.execPath, [script, ...args], {
      cwd: rootDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.set(label, child);
    pipeOutput(child, label);
    onLog(`[${label}] starting automatically with Campaign Console.`);
    return child;
  }

  async function waitFor(url, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await probe(url)) return true;
      await delay(250);
    }
    return false;
  }

  async function status() {
    const [tracker, brainOnline] = await Promise.all([probe(TRACKER_URL), probe(BRAIN_URL)]);
    lastStatus = {
      tracker,
      brain: brainEnabled ? brainOnline : false,
      brainEnabled,
      mode: brainEnabled ? "brain" : "tracker-only",
      checkedAt: new Date().toISOString(),
    };
    return lastStatus;
  }

  async function trackerDetails() {
    try {
      const response = await fetch(`${TRACKER_URL}api/status`, { signal: AbortSignal.timeout(1500) });
      if (!response.ok) return null;
      const data = await response.json();
      return data?.ok ? data : null;
    } catch {
      return null;
    }
  }

  async function confirmedOffline(url) {
    if (await probe(url)) return false;
    await delay(downConfirmDelayMs);
    return !(await probe(url));
  }

  async function ensureOnce() {
    let current = await status();
    if (!current.tracker && await confirmedOffline(TRACKER_URL)) {
      // Brain owns the Evolution webhook only when the operator explicitly
      // enables it. Otherwise Tracker owns the webhook and records replies
      // without sending anything back to customers.
      start("reply-tracker", "blaster_tracker.mjs", brainEnabled ? ["--no-webhook"] : []);
      const ready = await waitFor(TRACKER_URL);
      if (!ready) onLog("[reply-tracker:error] did not become ready on port 8798.");
    }

    current = await status();
    if (brainEnabled && !current.brain && await confirmedOffline(BRAIN_URL)) {
      start("sales-brain", "brain_service.mjs");
      const ready = await waitFor(BRAIN_URL, 12000);
      if (!ready) onLog("[sales-brain:error] did not become ready on port 8799. Telegram reply alerts are offline.");
    }
    return status();
  }

  function ensureStarted() {
    if (!ensurePromise) {
      ensurePromise = ensureOnce().finally(() => { ensurePromise = null; });
    }
    return ensurePromise;
  }

  function startMonitoring(intervalMs = 15000) {
    if (monitor) return monitor;
    ensureStarted().catch((error) => onLog(`[reply-services:error] ${error.message}`));
    monitor = setInterval(() => {
      ensureStarted().catch((error) => onLog(`[reply-services:error] ${error.message}`));
    }, intervalMs);
    monitor.unref?.();
    return monitor;
  }

  function stopManaged() {
    if (monitor) clearInterval(monitor);
    monitor = null;
    for (const child of children.values()) {
      if (!child.killed) child.kill("SIGTERM");
    }
    children.clear();
  }

  return { ensureStarted, startMonitoring, status, trackerDetails, stopManaged, snapshot: () => lastStatus };
}
