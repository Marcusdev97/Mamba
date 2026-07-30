import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GOLDEN_CONVERSATION_SCHEMA_SQL,
  GOLDEN_FOLLOWUP_SCHEMA_SQL,
  INSTANCE_IDENTITY_SCHEMA_SQL,
  LID_MAP_SCHEMA_SQL,
  RUNTIME_SCHEMA_PATCH_NAME,
  RUNTIME_SCHEMA_PATCH_VERSION,
} from "../../campaign-app/lib/v3-runtime-schema.mjs";
import {
  backupSqliteDatabase,
  clean,
  recentActiveRunState,
  sqlText,
} from "./lib/sqlite-maintenance.mjs";

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

function tableColumns(binary, databasePath, table) {
  return sqlite(binary, databasePath, `PRAGMA table_info(${table});`).map((row) => row.name);
}

function migrationPlan(binary, databasePath) {
  const instanceColumns = tableColumns(binary, databasePath, "instance_identity");
  const lidColumns = tableColumns(binary, databasePath, "lid_map");
  const goldenColumns = tableColumns(binary, databasePath, "golden_conversations");
  const followupColumns = tableColumns(binary, databasePath, "followup_log");
  const applied = sqlite(
    binary,
    databasePath,
    `SELECT version, name, applied_at AS appliedAt FROM schema_migrations WHERE version=${RUNTIME_SCHEMA_PATCH_VERSION};`,
  );

  let goldenAction = "none";
  if (!goldenColumns.length) goldenAction = "create";
  else if (goldenColumns.includes("lead_code") && goldenColumns.includes("source_hash")) {
    goldenAction = goldenColumns.includes("last_customer_reply_at") ? "none" : "add_last_customer_reply_at";
  } else if (goldenColumns.includes("golden_key")) {
    if (tableColumns(binary, databasePath, "golden_conversations_legacy_v3").length) {
      const error = new Error("发现旧 Golden Conversation 备份，但主表仍是旧结构；需要人工检查上次未完成的迁移。");
      error.code = "GC_PARTIAL_MIGRATION";
      throw error;
    }
    goldenAction = "migrate_legacy";
  } else {
    const error = new Error("golden_conversations 结构无法识别；已停止迁移以保护资料。");
    error.code = "GC_UNKNOWN_SCHEMA";
    throw error;
  }

  return {
    version: RUNTIME_SCHEMA_PATCH_VERSION,
    name: RUNTIME_SCHEMA_PATCH_NAME,
    alreadyRecorded: applied.length === 1,
    actions: {
      instanceIdentity: instanceColumns.length ? "none" : "create",
      lidMap: lidColumns.length ? "none" : "create",
      goldenConversations: goldenAction,
      followupLog: followupColumns.length ? "none" : "create",
    },
  };
}

function migrationSql(plan) {
  const statements = ["PRAGMA foreign_keys=OFF;", "BEGIN IMMEDIATE;"];
  if (plan.actions.goldenConversations === "migrate_legacy") {
    statements.push(`
DROP TABLE IF EXISTS followup_log;
ALTER TABLE golden_conversations RENAME TO golden_conversations_legacy_v3;
${GOLDEN_CONVERSATION_SCHEMA_SQL}
INSERT INTO golden_conversations(
  lead_code, project_code, source_channel, language, customer_role, primary_purpose,
  first_reply_type, outcome, outcome_updated_at, friction_removers, reconfirmed,
  decision_trace, conversation_text, do_not_copy, pk_conflicts, created_at, source_hash
)
SELECT
  printf('LEGACY%04d', rowid), project_code, 'legacy_notion', '', '', 'unknown',
  'perfunctory', 'Active', COALESCE(updated_at, created_at), '[]', 0,
  '[]', conversation_text, '[]', '[]', created_at,
  CASE WHEN trim(COALESCE(conversation_hash,'')) <> ''
    THEN 'legacy:' || conversation_hash
    ELSE 'legacy:' || lower(hex(randomblob(32))) END
FROM golden_conversations_legacy_v3;
INSERT INTO metadata(key, value, updated_at)
VALUES ('gc_legacy_backup_table', 'golden_conversations_legacy_v3', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at;`);
  } else if (plan.actions.goldenConversations === "create") {
    statements.push(GOLDEN_CONVERSATION_SCHEMA_SQL);
  } else if (plan.actions.goldenConversations === "add_last_customer_reply_at") {
    statements.push("ALTER TABLE golden_conversations ADD COLUMN last_customer_reply_at TEXT;");
  }

  statements.push(
    INSTANCE_IDENTITY_SCHEMA_SQL,
    LID_MAP_SCHEMA_SQL,
    GOLDEN_FOLLOWUP_SCHEMA_SQL,
    `INSERT INTO schema_migrations(version, name, applied_at)
     VALUES (${RUNTIME_SCHEMA_PATCH_VERSION}, ${sqlText(RUNTIME_SCHEMA_PATCH_NAME)}, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(version) DO UPDATE SET name=excluded.name;`,
    `INSERT INTO metadata(key, value, updated_at)
     VALUES ('runtime_schema_patch', ${sqlText(String(RUNTIME_SCHEMA_PATCH_VERSION))}, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at;`,
    "COMMIT;",
    "PRAGMA foreign_keys=ON;",
  );
  return statements.join("\n");
}

export function migrateRuntimeSchema({
  rootDir,
  databasePath,
  apply = false,
  binary = "/usr/bin/sqlite3",
  requireIdle = true,
} = {}) {
  if (!fs.existsSync(binary)) throw new Error(`找不到 sqlite3：${binary}`);
  if (!fs.existsSync(databasePath)) throw new Error(`找不到数据库：${databasePath}`);
  const activeRuns = recentActiveRunState(rootDir).activeRuns;
  const plan = migrationPlan(binary, databasePath);
  const report = {
    mode: apply ? "apply" : "dry-run",
    databasePath,
    activeRuns,
    plan,
  };
  if (!apply) return report;
  if (requireIdle && activeRuns.length) {
    const error = new Error(`仍有 ${activeRuns.length} 个近期活动 Campaign；拒绝执行 Schema Migration。`);
    error.code = "ACTIVE_CAMPAIGN_BLOCKS_SCHEMA_MIGRATION";
    error.report = report;
    throw error;
  }
  const backupPath = backupSqliteDatabase({
    binary,
    rootDir,
    databasePath,
    prefix: "before-runtime-schema",
  });
  sqlite(binary, databasePath, migrationSql(plan), { json: false, readOnly: false });
  const quickCheck = sqlite(binary, databasePath, "PRAGMA quick_check;");
  const foreignKeyErrors = sqlite(binary, databasePath, "PRAGMA foreign_key_check;");
  if (quickCheck[0]?.quick_check !== "ok" || foreignKeyErrors.length) {
    const error = new Error(`Migration 验证失败；请使用备份恢复：${backupPath}`);
    error.code = "SCHEMA_MIGRATION_VERIFICATION_FAILED";
    error.report = { ...report, backupPath, quickCheck, foreignKeyErrors };
    throw error;
  }
  return {
    ...report,
    backupPath,
    verification: { quickCheck: "ok", foreignKeyErrors: 0 },
    appliedPlan: migrationPlan(binary, databasePath),
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
    console.log(JSON.stringify(migrateRuntimeSchema({
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
