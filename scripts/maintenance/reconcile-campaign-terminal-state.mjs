import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  backupSqliteDatabase,
  clean,
  readJson,
  recentActiveRunState,
  sqlText,
} from "./lib/sqlite-maintenance.mjs";

const TERMINAL = new Set(["COMPLETED", "STOPPED", "CANCELLED", "FAILED"]);
const REPAIRABLE_DATABASE_STATUSES = new Set(["QUEUED", "RUNNING", "PARTIAL"]);

function sqliteJson(binary, databasePath, sql, { readOnly = true } = {}) {
  const args = [
    ...(readOnly ? ["-readonly"] : []),
    "-batch",
    "-json",
    databasePath,
    sql,
  ];
  const output = execFileSync(binary, args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  return clean(output) ? JSON.parse(output) : [];
}

function runFiles(rootDir) {
  const runsDir = path.join(rootDir, "campaign-data", "runs");
  let names = [];
  try {
    names = fs.readdirSync(runsDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJson(path.join(runsDir, name), null))
    .filter((run) => run?.runId && Array.isArray(run?.assignments));
}

function terminalEvidence(run) {
  const status = clean(run?.status).toUpperCase();
  if (!TERMINAL.has(status)) return null;
  const assignments = run.assignments || [];
  return {
    runId: clean(run.runId),
    status,
    requested: assignments.length,
    sent: assignments.filter((job) => job?.status === "SENT").length,
    failed: assignments.filter((job) => job?.status === "FAILED").length,
    finishedAt: run.updatedAt || run.endAt || run.completedAt || null,
  };
}

function databaseRuns(binary, databasePath) {
  return new Map(sqliteJson(binary, databasePath, `
SELECT run_id AS runId, status, requested_count AS requested, sent_count AS sent,
       failed_count AS failed, finished_at AS finishedAt
FROM campaign_runs;`).map((row) => [row.runId, row]));
}

function buildReport(binary, rootDir, databasePath) {
  const rows = databaseRuns(binary, databasePath);
  const repairable = [];
  const missingDatabase = [];
  const terminalConflicts = [];
  for (const run of runFiles(rootDir)) {
    const evidence = terminalEvidence(run);
    if (!evidence) continue;
    const current = rows.get(evidence.runId);
    if (!current) {
      missingDatabase.push(evidence);
      continue;
    }
    const databaseStatus = clean(current.status).toUpperCase();
    if (REPAIRABLE_DATABASE_STATUSES.has(databaseStatus)) {
      repairable.push({ ...evidence, databaseStatus });
    } else if (TERMINAL.has(databaseStatus) && databaseStatus !== evidence.status) {
      terminalConflicts.push({
        runId: evidence.runId,
        databaseStatus,
        runFileStatus: evidence.status,
      });
    }
  }
  return {
    repairable,
    missingDatabase,
    terminalConflicts,
  };
}

function applyRepairs(binary, databasePath, rows) {
  if (!rows.length) return 0;
  const now = new Date().toISOString();
  const statements = ["BEGIN IMMEDIATE;"];
  for (const row of rows) {
    statements.push(`
UPDATE campaign_runs SET
  status=${sqlText(row.status)},
  requested_count=MAX(requested_count, ${Number(row.requested) || 0}),
  sent_count=MAX(sent_count, ${Number(row.sent) || 0}),
  failed_count=MAX(failed_count, ${Number(row.failed) || 0}),
  finished_at=COALESCE(finished_at, ${row.finishedAt ? sqlText(row.finishedAt) : sqlText(now)})
WHERE run_id=${sqlText(row.runId)}
  AND status IN ('QUEUED','RUNNING','PARTIAL');`);
  }
  statements.push("COMMIT;");
  sqliteJson(binary, databasePath, statements.join("\n"), { readOnly: false });
  return rows.length;
}

export function reconcileCampaignTerminalState({
  rootDir,
  databasePath,
  apply = false,
  binary = "/usr/bin/sqlite3",
} = {}) {
  if (!fs.existsSync(binary)) throw new Error(`找不到 sqlite3：${binary}`);
  if (!fs.existsSync(databasePath)) throw new Error(`找不到数据库：${databasePath}`);
  const activeRuns = recentActiveRunState(rootDir).activeRuns;
  const comparison = buildReport(binary, rootDir, databasePath);
  const report = {
    mode: apply ? "apply" : "dry-run",
    databasePath,
    activeRuns,
    repairable: comparison.repairable,
    missingDatabase: comparison.missingDatabase,
    terminalConflicts: comparison.terminalConflicts,
  };
  if (!apply) return report;
  if (activeRuns.length) {
    const error = new Error(`仍有 ${activeRuns.length} 个近期活动 Campaign；拒绝修复历史 terminal state。`);
    error.code = "ACTIVE_CAMPAIGN_BLOCKS_TERMINAL_RECONCILIATION";
    error.report = report;
    throw error;
  }
  if (comparison.terminalConflicts.length) {
    const error = new Error("发现已经是 terminal 但两边状态不同的 Run；需要人工判断，拒绝自动覆盖。");
    error.code = "CAMPAIGN_TERMINAL_CONFLICT";
    error.report = report;
    throw error;
  }
  const backupPath = backupSqliteDatabase({
    binary,
    rootDir,
    databasePath,
    prefix: "before-campaign-terminal-reconciliation",
  });
  const applied = applyRepairs(binary, databasePath, comparison.repairable);
  const quickCheck = sqliteJson(binary, databasePath, "PRAGMA quick_check;");
  return {
    ...report,
    backupPath,
    applied,
    verification: {
      quickCheck: quickCheck[0]?.quick_check || "unknown",
      remainingRepairable: buildReport(binary, rootDir, databasePath).repairable.length,
    },
  };
}

function parseArgs(argv) {
  const args = { apply: false, root: "", db: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--dry-run") args.apply = false;
    else if (arg === "--root") args.root = argv[index += 1] || "";
    else if (arg.startsWith("--root=")) args.root = arg.slice("--root=".length);
    else if (arg === "--db") args.db = argv[index += 1] || "";
    else if (arg.startsWith("--db=")) args.db = arg.slice("--db=".length);
    else throw new Error(`不支持的参数：${arg}`);
  }
  return args;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const rootDir = path.resolve(args.root || defaultRoot);
  const databasePath = path.resolve(args.db || path.join(rootDir, "campaign-data", "mamba.sqlite"));
  try {
    console.log(JSON.stringify(reconcileCampaignTerminalState({
      rootDir,
      databasePath,
      apply: args.apply,
    }), null, 2));
  } catch (error) {
    if (error.report) console.error(JSON.stringify(error.report, null, 2));
    console.error(error.message);
    process.exitCode = 1;
  }
}
