import { spawn } from "node:child_process";

function cleanRunId(value) {
  return String(value || "").trim();
}

export function createCampaignAwakeService({
  platform = process.platform,
  spawnImpl = spawn,
  systemLogs = null,
} = {}) {
  const leases = new Set();
  let child = null;
  let lastError = null;

  function log(level, event, message, context = {}) {
    return systemLogs?.write?.({
      level,
      area: "campaign",
      event,
      message,
      context,
    }).catch(() => {});
  }

  function startProcess() {
    if (platform !== "darwin" || child) return;
    try {
      // This prevents idle sleep while a Campaign is active. macOS still forces
      // clamshell sleep when a laptop lid is closed, so transport monitoring
      // remains the safety boundary after wake.
      child = spawnImpl("/usr/bin/caffeinate", ["-i", "-s"], {
        detached: false,
        stdio: "ignore",
      });
      child.unref?.();
      child.once?.("error", (error) => {
        lastError = String(error?.message || error);
        child = null;
        log("error", "campaign_awake_guard_failed", "Campaign idle-sleep guard could not start.", {
          error: lastError,
          activeLeases: leases.size,
        });
      });
      child.once?.("exit", (code, signal) => {
        child = null;
        if (leases.size) {
          log("warn", "campaign_awake_guard_exited", "Campaign idle-sleep guard exited while a run was active.", {
            code,
            signal,
            activeLeases: leases.size,
          });
        }
      });
      lastError = null;
    } catch (error) {
      child = null;
      lastError = String(error?.message || error);
      log("error", "campaign_awake_guard_failed", "Campaign idle-sleep guard could not start.", {
        error: lastError,
        activeLeases: leases.size,
      });
    }
  }

  function acquire(runId) {
    const key = cleanRunId(runId);
    if (!key) throw new Error("Campaign awake guard requires a runId.");
    leases.add(key);
    startProcess();
    return snapshot();
  }

  function release(runId) {
    const key = cleanRunId(runId);
    if (key) leases.delete(key);
    if (!leases.size && child) {
      child.kill?.("SIGTERM");
      child = null;
    }
    return snapshot();
  }

  function stopAll() {
    leases.clear();
    if (child) child.kill?.("SIGTERM");
    child = null;
  }

  function snapshot() {
    return {
      supported: platform === "darwin",
      active: platform === "darwin" && Boolean(child) && leases.size > 0,
      activeRuns: [...leases],
      lastError,
      limitation: platform === "darwin"
        ? "Prevents idle sleep only; closing the MacBook lid still suspends local Docker and Evolution."
        : "Host idle-sleep guard is only required on macOS.",
    };
  }

  return { acquire, release, stopAll, snapshot };
}
