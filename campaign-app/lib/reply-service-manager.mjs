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
  downConfirmDelayMs = 500,
} = {}) {
  const children = new Map();
  let lastStatus = { tracker: false, brain: false, checkedAt: null };
  let ensurePromise = null;
  let monitor = null;

  function pipeOutput(child, label) {
    child.stdout?.on("data", (chunk) => {
      for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) onLog(`[${label}] ${line}`);
    });
    child.stderr?.on("data", (chunk) => {
      for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) onLog(`[${label}:error] ${line}`);
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
    const [tracker, brain] = await Promise.all([probe(TRACKER_URL), probe(BRAIN_URL)]);
    lastStatus = { tracker, brain, checkedAt: new Date().toISOString() };
    return lastStatus;
  }

  async function confirmedOffline(url) {
    if (await probe(url)) return false;
    await delay(downConfirmDelayMs);
    return !(await probe(url));
  }

  async function ensureOnce() {
    let current = await status();
    if (!current.tracker && await confirmedOffline(TRACKER_URL)) {
      start("reply-tracker", "blaster_tracker.mjs", ["--no-webhook"]);
      const ready = await waitFor(TRACKER_URL);
      if (!ready) onLog("[reply-tracker:error] did not become ready on port 8798.");
    }

    current = await status();
    if (!current.brain && await confirmedOffline(BRAIN_URL)) {
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

  return { ensureStarted, startMonitoring, status, stopManaged, snapshot: () => lastStatus };
}
