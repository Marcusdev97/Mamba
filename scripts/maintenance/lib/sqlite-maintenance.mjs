import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const TERMINAL_RUN_STATUSES = new Set(["COMPLETED", "STOPPED", "CANCELLED", "FAILED"]);
const ALWAYS_BLOCKING_RUN_STATUSES = new Set(["RUNNING", "QUEUED_BATCH", "SENDING"]);
const DEFAULT_RECENT_WINDOW_MS = 15 * 60 * 1000;

export function clean(value) {
  return String(value ?? "").trim();
}

export function sqlText(value) {
  return `'${String(value ?? "").replaceAll("'", "''")}'`;
}

export function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

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
    // A valid Campaign can intentionally wait longer than the freshness window
    // between recipients. Never treat RUNNING/SENDING as stale automatically;
    // the operator must finish or explicitly resolve that Run first.
    if (!ALWAYS_BLOCKING_RUN_STATUSES.has(status) && Date.now() - updatedAt > recentWindowMs) continue;
    activeRuns.push({ runId, status, updatedAt: new Date(updatedAt).toISOString() });
    for (const assignment of run.assignments || []) {
      const phone = clean(assignment?.lead?.phone).replace(/\D/g, "");
      if (phone) phones.add(phone);
    }
  }
  return { activeRuns, phones };
}

export function backupSqliteDatabase({
  binary,
  rootDir,
  databasePath,
  prefix,
} = {}) {
  const backupDir = path.join(rootDir, "campaign-data", "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `${prefix}-${stamp}.sqlite`);
  execFileSync(binary, ["-batch", databasePath, `.backup ${sqlText(backupPath)}`], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  return backupPath;
}
