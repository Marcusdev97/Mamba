import { spawn } from "node:child_process";
import path from "node:path";

const TRACKER_PORTS = [8798, 8800, 8801, 8802, 8803, 8804, 8805, 8806, 8807, 8808];
const BRAIN_URL = "http://127.0.0.1:8799/";

function trackerUrl(port) {
  return `http://127.0.0.1:${port}/`;
}

async function fetchJson(url, timeoutMs = 1200) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

// A port is a healthy tracker only when the service identifies itself. A plain
// HTTP 200 is intentionally not enough: an old Campaign Console may be running
// on the same port and must never be mistaken for the reply listener.
async function defaultTrackerProbe(url, timeoutMs = 1200) {
  const data = await fetchJson(`${url}api/status`, timeoutMs);
  return data?.ok === true && data?.service === "reply-tracker";
}

async function defaultAnyServiceProbe(url, timeoutMs = 900) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch (error) {
    // fetch rejects on a connection error, but an HTTP error response still
    // proves that something owns this port.
    return !/fetch failed|ECONNREFUSED|UND_ERR_CONNECT/i.test(String(error?.message || error));
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createReplyServiceManager({
  rootDir,
  probe = null,
  portProbe = null,
  spawnProcess = spawn,
  onLog = (message) => console.log(message),
  systemLogs = null,
  downConfirmDelayMs = 500,
  brainEnabled = false,
  trackerPorts = TRACKER_PORTS,
} = {}) {
  // Tests and callers may provide the legacy boolean probe. In production the
  // tracker probe validates /api/status and the explicit service marker.
  const trackerProbe = probe || defaultTrackerProbe;
  const anyServiceProbe = portProbe || (probe ? probe : defaultAnyServiceProbe);
  const candidatePorts = [...new Set(trackerPorts.map(Number))]
    .filter((port) => Number.isInteger(port) && port > 0 && port !== 8799);
  const children = new Map();
  let lastStatus = {
    tracker: false,
    trackerState: "closed",
    trackerPort: null,
    trackerUrl: null,
    portConflicts: [],
    brain: false,
    checkedAt: null,
  };
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

  function start(label, scriptName, args = [], envOverrides = {}) {
    if (children.has(label)) return children.get(label);
    const script = path.join(rootDir, "campaign-app", scriptName);
    const child = spawnProcess(process.execPath, [script, ...args], {
      cwd: rootDir,
      env: { ...process.env, ...envOverrides },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.set(label, child);
    pipeOutput(child, label);
    onLog(`[${label}] starting automatically with Campaign Console.`);
    return child;
  }

  async function discoverTracker() {
    const results = await Promise.all(candidatePorts.map(async (port) => ({
      port,
      online: await trackerProbe(trackerUrl(port)),
    })));
    return results.find((item) => item.online) || null;
  }

  async function inspectConflicts(activePort = null) {
    const checks = await Promise.all(candidatePorts.map(async (port) => {
      if (port === activePort) return null;
      const url = trackerUrl(port);
      if (await trackerProbe(url)) return null;
      return await anyServiceProbe(url) ? port : null;
    }));
    return checks.filter(Number.isInteger);
  }

  async function chooseTrackerPort() {
    const existing = await discoverTracker();
    if (existing) return { ...existing, existing: true };
    for (const port of candidatePorts) {
      const url = trackerUrl(port);
      if (!(await anyServiceProbe(url))) return { port, online: false, existing: false };
    }
    return null;
  }

  async function waitFor(url, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await trackerProbe(url)) return true;
      await delay(250);
    }
    return false;
  }

  async function status() {
    const [found, brainOnline] = await Promise.all([
      discoverTracker(),
      anyServiceProbe(BRAIN_URL),
    ]);
    const conflicts = await inspectConflicts(found?.port ?? null);
    lastStatus = {
      tracker: Boolean(found),
      trackerState: found ? "open" : conflicts.length ? "blocked" : "closed",
      trackerPort: found?.port ?? null,
      trackerUrl: found ? trackerUrl(found.port) : null,
      preferredPort: candidatePorts[0] ?? null,
      portConflicts: conflicts,
      brain: brainEnabled ? brainOnline : false,
      brainEnabled,
      mode: brainEnabled ? "brain" : "tracker-only",
      checkedAt: new Date().toISOString(),
    };
    return lastStatus;
  }

  async function trackerDetails() {
    const current = await status();
    if (!current.trackerUrl) return null;
    const data = await fetchJson(`${current.trackerUrl}api/status`, 1500);
    return data?.ok === true && data?.service === "reply-tracker" ? data : null;
  }

  async function confirmedTrackerOffline() {
    if (await discoverTracker()) return false;
    await delay(downConfirmDelayMs);
    return !(await discoverTracker());
  }

  async function ensureOnce() {
    let current = await status();
    if (!current.tracker && await confirmedTrackerOffline()) {
      // Brain owns the Evolution webhook only when the operator explicitly
      // enables it. Otherwise Tracker owns the webhook and records replies
      // without sending anything back to customers.
      const selected = await chooseTrackerPort();
      if (!selected) {
        const message = `Reply Tracker 无法启动：动态端口 ${candidatePorts.join(", ")} 全部被占用。`;
        onLog(`[reply-tracker:error] ${message}`);
        systemLogs?.write({
          level: "error",
          area: "reply_tracker",
          event: "TRACKER_PORTS_EXHAUSTED",
          message: `${message} 影响：客户回复不会进入 Telegram。处理：关闭重复的 Mamba/Node 服务后，在 Control Center 点击刷新 Tracker。`,
          context: { candidatePorts },
        }).catch(() => {});
      } else if (!selected.existing) {
        const port = selected.port;
        const args = brainEnabled ? ["--no-webhook"] : [];
        start("reply-tracker", "blaster_tracker.mjs", args, {
          TRACKER_PORT: String(port),
          TRACKER_WEBHOOK_URL: `http://host.docker.internal:${port}/webhook/evolution`,
        });
        const ready = await waitFor(trackerUrl(port));
        if (!ready) onLog(`[reply-tracker:error] did not become ready on dynamic port ${port}.`);
      }
    }

    current = await status();
    if (brainEnabled && !current.brain && !(await anyServiceProbe(BRAIN_URL))) {
      await delay(downConfirmDelayMs);
      if (!(await anyServiceProbe(BRAIN_URL))) {
        start("sales-brain", "brain_service.mjs");
        const deadline = Date.now() + 12000;
        while (Date.now() < deadline && !(await anyServiceProbe(BRAIN_URL))) await delay(250);
        if (!(await anyServiceProbe(BRAIN_URL))) onLog("[sales-brain:error] did not become ready on port 8799. Telegram reply alerts are offline.");
      }
    }
    return status();
  }

  function ensureStarted() {
    if (!ensurePromise) {
      ensurePromise = ensureOnce().finally(() => { ensurePromise = null; });
    }
    return ensurePromise;
  }

  async function refreshTracker() {
    let current = await ensureStarted();
    if (!current.trackerUrl) {
      return { ok: false, ...current, error: "Reply Tracker 仍未启动；请检查全部动态端口是否被占用。" };
    }
    try {
      const response = await fetch(`${current.trackerUrl}api/refresh`, {
        method: "POST",
        signal: AbortSignal.timeout(15000),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok === false) throw new Error(result.error || `HTTP ${response.status}`);
      current = await status();
      return { ok: true, ...current, webhook: result.webhook || null };
    } catch (error) {
      current = await status();
      return { ok: false, ...current, error: `Tracker 已运行，但刷新 WhatsApp webhook 失败：${error.message}` };
    }
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

  return {
    ensureStarted,
    refreshTracker,
    startMonitoring,
    status,
    trackerDetails,
    stopManaged,
    snapshot: () => lastStatus,
  };
}
