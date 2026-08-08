import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { backupSqliteDatabase, clean, recentActiveRunState, sqlText } from "./lib/sqlite-maintenance.mjs";

export const CAMPAIGN_MODEL_MIGRATION_VERSION = 308;
export const CAMPAIGN_MODEL_MIGRATION_NAME = "campaign-model";
export const CAMPAIGN_MODEL_CONFIRMATION = "APPLY_CAMPAIGN_MODEL_V1";

const REQUIRED_TABLES = Object.freeze(["campaigns", "campaign_members", "campaign_steps", "campaign_runs", "send_jobs", "campaign_outcomes"]);
const REQUIRED_RUN_COLUMNS = Object.freeze(["campaign_id", "step_id", "connection_id", "device_id", "summary_json"]);

function sqlite(binary, databasePath, sql, { json = true, readOnly = true, foreignKeys = true } = {}) {
  const statements = foreignKeys ? sql : `PRAGMA foreign_keys=OFF;\n${sql}`;
  const output = execFileSync(binary, [
    ...(readOnly ? ["-readonly"] : []), "-batch", ...(json ? ["-json"] : []), databasePath, statements,
  ], { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
  return json ? (clean(output) ? JSON.parse(output) : []) : output;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function campaignModelMigrationPlan({
  rootDir,
  databasePath,
  binary = "/usr/bin/sqlite3",
  migrationPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../campaign-app/migrations/308-campaign-model.sql"),
} = {}) {
  if (!fs.existsSync(binary)) throw new Error(`找不到 sqlite3：${binary}`);
  if (!fs.existsSync(databasePath)) throw new Error(`找不到数据库：${databasePath}`);
  const sql = fs.readFileSync(migrationPath, "utf8");
  const checksum = sha256(sql);
  const migrations = sqlite(binary, databasePath, "SELECT version,name,checksum,applied_at AS appliedAt FROM schema_migrations ORDER BY version;");
  const applied = migrations.find((item) => Number(item.version) === CAMPAIGN_MODEL_MIGRATION_VERSION) || null;
  if (applied?.checksum && applied.checksum !== checksum) {
    const error = new Error("Campaign Model migration checksum 与已应用记录不一致；禁止继续。");
    error.code = "CAMPAIGN_MODEL_MIGRATION_CHECKSUM_MISMATCH";
    throw error;
  }
  const existingTables = new Set(sqlite(binary, databasePath, `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${REQUIRED_TABLES.map(sqlText).join(",")});`).map((row) => row.name));
  const existingColumns = new Set(sqlite(binary, databasePath, "PRAGMA table_info(campaign_runs);").map((row) => row.name));
  const fileRuns = recentActiveRunState(rootDir).activeRuns.map((item) => ({ source: "run_state", ...item }));
  const dbRuns = sqlite(binary, databasePath, "SELECT run_id AS runId,status,mode,started_at AS startedAt FROM campaign_runs WHERE status IN ('RUNNING','SENDING','QUEUED_BATCH') ORDER BY started_at DESC;").map((item) => ({ source: "sqlite", ...item }));
  const partialSchema = !applied && (existingTables.has("campaigns") || existingTables.has("campaign_members") || existingTables.has("campaign_outcomes") || existingColumns.has("campaign_id"));
  const blockers = [];
  if (!migrations.some((item) => Number(item.version) === 307)) blockers.push("migration_307_required");
  if (partialSchema) blockers.push("partial_campaign_model_schema");
  if (fileRuns.length || dbRuns.length) blockers.push("active_campaigns");
  return {
    version: CAMPAIGN_MODEL_MIGRATION_VERSION,
    name: CAMPAIGN_MODEL_MIGRATION_NAME,
    checksum,
    applied: Boolean(applied),
    blockers,
    activeRuns: [...fileRuns, ...dbRuns],
    tables: { required: [...REQUIRED_TABLES], present: [...existingTables], missing: REQUIRED_TABLES.filter((table) => !existingTables.has(table)) },
    runColumns: { required: [...REQUIRED_RUN_COLUMNS], present: REQUIRED_RUN_COLUMNS.filter((column) => existingColumns.has(column)), missing: REQUIRED_RUN_COLUMNS.filter((column) => !existingColumns.has(column)) },
    sql,
  };
}

export function migrateCampaignModel({ rootDir, databasePath, apply = false, confirmation = "", binary = "/usr/bin/sqlite3", migrationPath } = {}) {
  const plan = campaignModelMigrationPlan({ rootDir, databasePath, binary, migrationPath });
  const { sql, ...publicPlan } = plan;
  const report = { mode: apply ? "apply" : "dry-run", databasePath, plan: publicPlan };
  if (!apply || plan.applied) return report;
  if (confirmation !== CAMPAIGN_MODEL_CONFIRMATION) {
    const error = new Error(`Apply 需要 --confirm ${CAMPAIGN_MODEL_CONFIRMATION}。`);
    error.code = "CAMPAIGN_MODEL_CONFIRMATION_REQUIRED";
    error.report = report;
    throw error;
  }
  if (plan.blockers.length) {
    const error = new Error(`Campaign Model migration 已暂停：${plan.blockers.join(", ")}。`);
    error.code = plan.blockers.includes("active_campaigns") ? "ACTIVE_CAMPAIGN_BLOCKS_SCHEMA_MIGRATION" : "CAMPAIGN_MODEL_MIGRATION_BLOCKED";
    error.report = report;
    throw error;
  }
  const backupPath = backupSqliteDatabase({ binary, rootDir, databasePath, prefix: "before-campaign-model" });
  const appliedAt = new Date().toISOString();
  const started = Date.now();
  sqlite(binary, databasePath, `BEGIN IMMEDIATE;
${sql}
INSERT INTO schema_migrations(version,name,checksum,applied_at,duration_ms,result)
VALUES (${CAMPAIGN_MODEL_MIGRATION_VERSION},${sqlText(CAMPAIGN_MODEL_MIGRATION_NAME)},${sqlText(plan.checksum)},${sqlText(appliedAt)},0,'APPLIED');
INSERT INTO metadata(key,value,updated_at) VALUES
  ('campaign_model_schema','308',${sqlText(appliedAt)}),
  ('last_backup_at',${sqlText(appliedAt)},${sqlText(appliedAt)}),
  ('last_migrated_at',${sqlText(appliedAt)},${sqlText(appliedAt)})
ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;
COMMIT;`, { json: false, readOnly: false, foreignKeys: false });
  const durationMs = Date.now() - started;
  sqlite(binary, databasePath, `UPDATE schema_migrations SET duration_ms=${durationMs} WHERE version=${CAMPAIGN_MODEL_MIGRATION_VERSION};`, { json: false, readOnly: false });
  const quickCheck = sqlite(binary, databasePath, "PRAGMA quick_check;");
  const foreignKeys = sqlite(binary, databasePath, "PRAGMA foreign_key_check;");
  const after = campaignModelMigrationPlan({ rootDir, databasePath, binary, migrationPath });
  if (quickCheck[0]?.quick_check !== "ok" || foreignKeys.length || after.tables.missing.length || after.runColumns.missing.length) {
    const error = new Error(`Migration 验证失败；请使用备份恢复：${backupPath}`);
    error.code = "CAMPAIGN_MODEL_MIGRATION_VERIFICATION_FAILED";
    error.report = { ...report, backupPath, quickCheck, foreignKeys, missingTables: after.tables.missing, missingRunColumns: after.runColumns.missing };
    throw error;
  }
  return { ...report, backupPath, verification: { quickCheck: "ok", foreignKeyErrors: 0, missingTables: [], missingRunColumns: [] }, appliedPlan: { ...after, sql: undefined } };
}

function parseArgs(argv) {
  const result = { apply: false, confirmation: "", root: "", db: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") result.apply = true;
    else if (arg === "--dry-run") result.apply = false;
    else if (arg === "--confirm") result.confirmation = argv[index += 1] || "";
    else if (arg.startsWith("--confirm=")) result.confirmation = arg.slice(10);
    else if (arg === "--root") result.root = argv[index += 1] || "";
    else if (arg.startsWith("--root=")) result.root = arg.slice(7);
    else if (arg === "--db") result.db = argv[index += 1] || "";
    else if (arg.startsWith("--db=")) result.db = arg.slice(5);
    else throw new Error(`不支持的参数：${arg}`);
  }
  return result;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const rootDir = path.resolve(args.root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."));
  const databasePath = path.resolve(args.db || path.join(rootDir, "campaign-data", "mamba.sqlite"));
  try {
    console.log(JSON.stringify(migrateCampaignModel({ rootDir, databasePath, apply: args.apply, confirmation: args.confirmation }), null, 2));
  } catch (error) {
    if (error.report) console.error(JSON.stringify(error.report, null, 2));
    console.error(`[${error.code || "CAMPAIGN_MODEL_MIGRATION_FAILED"}] ${error.message}`);
    process.exitCode = 1;
  }
}
