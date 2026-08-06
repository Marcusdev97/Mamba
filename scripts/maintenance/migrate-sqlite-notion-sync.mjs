import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  backupSqliteDatabase,
  clean,
  recentActiveRunState,
  sqlText,
} from "./lib/sqlite-maintenance.mjs";

export const SQLITE_NOTION_SYNC_MIGRATION_VERSION = 304;
export const SQLITE_NOTION_SYNC_MIGRATION_NAME = "sqlite-notion-sync-v1";
export const SQLITE_NOTION_SYNC_CONFIRMATION = "APPLY_SQLITE_NOTION_SYNC_V1";

const REQUIRED_TABLES = Object.freeze([
  "crm_customer_profiles",
  "notion_entity_map",
  "sync_inbox",
  "sync_conflicts",
  "sync_audit_events",
  "sync_reconciliation_runs",
]);

function sqlite(binary, databasePath, sql, { json = true, readOnly = true } = {}) {
  const args = [
    ...(readOnly ? ["-readonly"] : []),
    "-batch",
    ...(json ? ["-json"] : []),
    databasePath,
    sql,
  ];
  const output = execFileSync(binary, args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  return json ? (clean(output) ? JSON.parse(output) : []) : output;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function tableNames(binary, databasePath) {
  return new Set(sqlite(binary, databasePath, `
SELECT name FROM sqlite_master WHERE type='table' AND name IN (${REQUIRED_TABLES.map(sqlText).join(",")});
`).map((row) => row.name));
}

function migrationColumns(binary, databasePath) {
  return new Set(sqlite(binary, databasePath, "PRAGMA table_info(schema_migrations);").map((row) => row.name));
}

function activeDatabaseRuns(binary, databasePath) {
  const tables = sqlite(binary, databasePath, "SELECT name FROM sqlite_master WHERE type='table' AND name='campaign_runs';");
  if (!tables.length) return [];
  return sqlite(binary, databasePath, `
SELECT run_id AS runId,status,mode,started_at AS startedAt
FROM campaign_runs WHERE status IN ('RUNNING','SENDING','QUEUED_BATCH') ORDER BY started_at DESC;
`);
}

export function sqliteNotionSyncMigrationPlan({
  rootDir,
  databasePath,
  binary = "/usr/bin/sqlite3",
  migrationPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../campaign-app/migrations/304-sqlite-notion-sync.sql"),
} = {}) {
  if (!fs.existsSync(binary)) throw new Error(`找不到 sqlite3：${binary}`);
  if (!fs.existsSync(databasePath)) throw new Error(`找不到数据库：${databasePath}`);
  const sql = fs.readFileSync(migrationPath, "utf8");
  const checksum = sha256(sql);
  const auditColumns = migrationColumns(binary, databasePath);
  const hasMigrationAudit = ["checksum", "duration_ms", "result"].every((column) => auditColumns.has(column));
  const migration303 = sqlite(binary, databasePath, "SELECT version FROM schema_migrations WHERE version=303;");
  const applied = hasMigrationAudit
    ? sqlite(binary, databasePath, `SELECT version, name, checksum, applied_at AS appliedAt, duration_ms AS durationMs, result FROM schema_migrations WHERE version=${SQLITE_NOTION_SYNC_MIGRATION_VERSION};`)
    : [];
  if (applied[0]?.checksum && applied[0].checksum !== checksum) {
    const error = new Error("SQLite ↔ Notion migration checksum 与已应用记录不一致；禁止继续。");
    error.code = "SQLITE_NOTION_SYNC_MIGRATION_CHECKSUM_MISMATCH";
    throw error;
  }
  const presentTables = tableNames(binary, databasePath);
  const fileActiveRuns = recentActiveRunState(rootDir).activeRuns;
  const databaseActiveRuns = activeDatabaseRuns(binary, databasePath);
  const activeRuns = [
    ...fileActiveRuns.map((run) => ({ source: "run_state", ...run })),
    ...databaseActiveRuns.map((run) => ({ source: "sqlite", ...run })),
  ];
  const blockers = [];
  if (!hasMigrationAudit || !migration303.length) blockers.push("migration_303_required");
  if (activeRuns.length) blockers.push("active_campaigns");
  return {
    version: SQLITE_NOTION_SYNC_MIGRATION_VERSION,
    name: SQLITE_NOTION_SYNC_MIGRATION_NAME,
    checksum,
    applied: applied.length === 1,
    activeRuns,
    blockers,
    tables: {
      required: [...REQUIRED_TABLES],
      present: [...presentTables],
      missing: REQUIRED_TABLES.filter((table) => !presentTables.has(table)),
    },
    sql,
  };
}

export function migrateSqliteNotionSync({
  rootDir,
  databasePath,
  apply = false,
  confirmation = "",
  binary = "/usr/bin/sqlite3",
  migrationPath,
} = {}) {
  const plan = sqliteNotionSyncMigrationPlan({ rootDir, databasePath, binary, migrationPath });
  const { sql, ...publicPlan } = plan;
  const report = { mode: apply ? "apply" : "dry-run", databasePath, plan: publicPlan };
  if (!apply || plan.applied) return report;
  if (confirmation !== SQLITE_NOTION_SYNC_CONFIRMATION) {
    const error = new Error(`Apply 需要 --confirm ${SQLITE_NOTION_SYNC_CONFIRMATION}。`);
    error.code = "SQLITE_NOTION_SYNC_CONFIRMATION_REQUIRED";
    error.report = report;
    throw error;
  }
  if (plan.blockers.length) {
    const error = new Error(`SQLite ↔ Notion migration 已暂停：${plan.blockers.join(", ")}。`);
    error.code = plan.blockers.includes("active_campaigns")
      ? "ACTIVE_CAMPAIGN_BLOCKS_SCHEMA_MIGRATION"
      : "SQLITE_303_MIGRATION_REQUIRED";
    error.report = report;
    throw error;
  }
  const backupPath = backupSqliteDatabase({
    binary,
    rootDir,
    databasePath,
    prefix: "before-sqlite-notion-sync",
  });
  const startedAt = Date.now();
  const appliedAt = new Date().toISOString();
  sqlite(binary, databasePath, `
PRAGMA foreign_keys=ON;
BEGIN IMMEDIATE;
${sql}
INSERT INTO schema_migrations(version, name, checksum, applied_at, duration_ms, result)
VALUES (${SQLITE_NOTION_SYNC_MIGRATION_VERSION}, ${sqlText(SQLITE_NOTION_SYNC_MIGRATION_NAME)}, ${sqlText(plan.checksum)}, ${sqlText(appliedAt)}, 0, 'APPLIED');
INSERT INTO metadata(key, value, updated_at) VALUES
  ('sqlite_notion_sync_schema', '304', ${sqlText(appliedAt)}),
  ('last_backup_at', ${sqlText(appliedAt)}, ${sqlText(appliedAt)}),
  ('last_migrated_at', ${sqlText(appliedAt)}, ${sqlText(appliedAt)})
ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at;
COMMIT;
`, { json: false, readOnly: false });
  const durationMs = Date.now() - startedAt;
  sqlite(binary, databasePath, `UPDATE schema_migrations SET duration_ms=${durationMs} WHERE version=${SQLITE_NOTION_SYNC_MIGRATION_VERSION};`, { json: false, readOnly: false });
  const quickCheck = sqlite(binary, databasePath, "PRAGMA quick_check;");
  const foreignKeyErrors = sqlite(binary, databasePath, "PRAGMA foreign_key_check;");
  const after = sqliteNotionSyncMigrationPlan({ rootDir, databasePath, binary, migrationPath });
  if (quickCheck[0]?.quick_check !== "ok" || foreignKeyErrors.length || after.tables.missing.length) {
    const error = new Error(`Migration 验证失败；请使用备份恢复：${backupPath}`);
    error.code = "SQLITE_NOTION_SYNC_MIGRATION_VERIFICATION_FAILED";
    error.report = { ...report, backupPath, quickCheck, foreignKeyErrors, after: { ...after, sql: undefined } };
    throw error;
  }
  return {
    ...report,
    backupPath,
    verification: { quickCheck: "ok", foreignKeyErrors: 0, missingTables: [] },
    appliedPlan: { ...after, sql: undefined },
  };
}

function parseArgs(argv) {
  const result = { apply: false, confirmation: "", root: "", db: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") result.apply = true;
    else if (arg === "--dry-run") result.apply = false;
    else if (arg === "--confirm") result.confirmation = argv[index += 1] || "";
    else if (arg.startsWith("--confirm=")) result.confirmation = arg.slice("--confirm=".length);
    else if (arg === "--root") result.root = argv[index += 1] || "";
    else if (arg.startsWith("--root=")) result.root = arg.slice("--root=".length);
    else if (arg === "--db") result.db = argv[index += 1] || "";
    else if (arg.startsWith("--db=")) result.db = arg.slice("--db=".length);
    else throw new Error(`不支持的参数：${arg}`);
  }
  return result;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const rootDir = path.resolve(args.root || defaultRoot);
  const databasePath = path.resolve(args.db || path.join(rootDir, "campaign-data", "mamba.sqlite"));
  try {
    console.log(JSON.stringify(migrateSqliteNotionSync({
      rootDir,
      databasePath,
      apply: args.apply,
      confirmation: args.confirmation,
    }), null, 2));
  } catch (error) {
    if (error.report) console.error(JSON.stringify(error.report, null, 2));
    console.error(`[${error.code || "SQLITE_NOTION_SYNC_MIGRATION_FAILED"}] ${error.message}`);
    process.exitCode = 1;
  }
}
