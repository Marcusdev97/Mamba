import fs from "node:fs";
import path from "node:path";

const TERMINAL_RUN_STATUSES = new Set(["COMPLETED", "STOPPED", "CANCELLED", "FAILED"]);
const ALWAYS_BLOCKING_RUN_STATUSES = new Set(["RUNNING", "QUEUED_BATCH", "SENDING"]);
const DEFAULT_RECENT_WINDOW_MS = 15 * 60 * 1000;

function clean(value) {
  return String(value ?? "").trim();
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

// Schema changes must use the same persisted Campaign evidence as maintenance
// scripts. A RUNNING/SENDING run never becomes safe merely because it is old.
export function recentActiveRunState(rootDir, { recentWindowMs = DEFAULT_RECENT_WINDOW_MS } = {}) {
  const registry = readJson(path.join(rootDir, "campaign-data", "active-runs.json"), {});
  const activeRuns = [];
  const phones = new Set();
  for (const item of registry?.runs || []) {
    const runId = clean(item?.runId);
    if (!runId) continue;
    const runPath = path.join(rootDir, "campaign-data", "runs", `${runId}.json`);
    const run = readJson(runPath, null);
    if (!run || !fs.existsSync(runPath)) continue;
    const status = clean(run.status || item.status).toUpperCase();
    const updatedAt = Math.max(
      new Date(run.updatedAt || 0).getTime() || 0,
      fs.statSync(runPath).mtimeMs,
    );
    if (TERMINAL_RUN_STATUSES.has(status)) continue;
    if (!ALWAYS_BLOCKING_RUN_STATUSES.has(status) && Date.now() - updatedAt > recentWindowMs) continue;
    activeRuns.push({ runId, status, updatedAt: new Date(updatedAt).toISOString() });
    for (const assignment of run.assignments || []) {
      const phone = clean(assignment?.lead?.phone).replace(/\D/g, "");
      if (phone) phones.add(phone);
    }
  }
  return { activeRuns, phones };
}
