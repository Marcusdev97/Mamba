import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const SCHEMA_VERSION = 1;
const DEFAULT_SQLITE_CANDIDATES = [
  "/usr/bin/sqlite3",
  "/opt/homebrew/bin/sqlite3",
  "/usr/local/bin/sqlite3",
  "/opt/anaconda3/bin/sqlite3",
];

function sqlText(value) {
  return `'${String(value ?? "").replaceAll("'", "''")}'`;
}

async function executable(filePath) {
  try {
    await fs.access(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findSqliteBinary(preferred) {
  const candidates = [preferred, process.env.MAMBA_SQLITE3_PATH, ...DEFAULT_SQLITE_CANDIDATES].filter(Boolean);
  for (const candidate of [...new Set(candidates)]) {
    if (path.isAbsolute(candidate) && await executable(candidate)) return candidate;
  }
  return "";
}

function runProcess(binary, args, input = "", timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`SQLite command timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString("utf8").trim();
      const errorOutput = Buffer.concat(stderr).toString("utf8").trim();
      if (code === 0) resolve(output);
      else reject(new Error(errorOutput || `sqlite3 exited with code ${code}`));
    });
    child.stdin.end(input);
  });
}

function schemaSql({ device, senderPolicy }) {
  const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
  const deviceId = String(device?.id || "").trim();
  const senderPhone = senderPolicy?.configured ? String(senderPolicy.expectedSenderPhone || "").trim() : "";
  return `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
BEGIN IMMEDIATE;

CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  hostname TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sender_accounts (
  sender_phone TEXT PRIMARY KEY,
  device_id TEXT NOT NULL UNIQUE,
  connection_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'BOUND',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  notion_page_id TEXT UNIQUE,
  device_id TEXT NOT NULL,
  sender_phone TEXT NOT NULL,
  phone TEXT NOT NULL,
  project TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  sequence_status TEXT NOT NULL DEFAULT '',
  last_reply_text TEXT NOT NULL DEFAULT '',
  last_reply_at TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  source_updated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (device_id, sender_phone, phone, project),
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE RESTRICT,
  FOREIGN KEY (sender_phone) REFERENCES sender_accounts(sender_phone) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_customers_device_sender ON customers(device_id, sender_phone);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
CREATE INDEX IF NOT EXISTS idx_customers_project ON customers(project);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  customer_id TEXT,
  device_id TEXT NOT NULL,
  sender_phone TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  project TEXT NOT NULL DEFAULT '',
  last_message_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (device_id, sender_phone, customer_phone, project),
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE RESTRICT,
  FOREIGN KEY (sender_phone) REFERENCES sender_accounts(sender_phone) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound','operator','system')),
  text TEXT NOT NULL DEFAULT '',
  message_type TEXT NOT NULL DEFAULT 'text',
  source TEXT NOT NULL DEFAULT 'evolution',
  sent_at TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_time ON messages(conversation_id, sent_at);

CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  device_id TEXT NOT NULL,
  sender_phone TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('PREVIEW','RUNNING','PARTIAL','COMPLETED','FAILED','ROLLED_BACK')),
  requested_count INTEGER NOT NULL DEFAULT 0,
  succeeded_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  finished_at TEXT,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS ownership_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL,
  customer_id TEXT,
  notion_page_id TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','APPLIED','FAILED','ROLLED_BACK','SKIPPED_CHANGED')),
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  retry_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE (operation_id, notion_page_id),
  FOREIGN KEY (operation_id) REFERENCES operations(id) ON DELETE CASCADE,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_ownership_changes_retry ON ownership_changes(operation_id, status, retry_count);

CREATE TABLE IF NOT EXISTS sync_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL UNIQUE,
  direction TEXT NOT NULL CHECK (direction IN ('NOTION_TO_LOCAL','LOCAL_TO_NOTION')),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  operation_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING','RUNNING','RETRY','COMPLETED','FAILED')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  last_error_code TEXT NOT NULL DEFAULT '',
  last_error_message TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (operation_id) REFERENCES operations(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_jobs_queue ON sync_jobs(status, available_at);

CREATE TABLE IF NOT EXISTS import_runs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('DRY_RUN','APPLY')),
  status TEXT NOT NULL CHECK (status IN ('RUNNING','PARTIAL','COMPLETED','FAILED')),
  scanned_count INTEGER NOT NULL DEFAULT 0,
  imported_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  report_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  finished_at TEXT
);

INSERT INTO schema_migrations(version, name, applied_at)
VALUES (${SCHEMA_VERSION}, 'initial-local-database-shell', ${now})
ON CONFLICT(version) DO NOTHING;

INSERT INTO metadata(key, value, updated_at) VALUES
  ('schema_version', '${SCHEMA_VERSION}', ${now}),
  ('notion_import_enabled', 'false', ${now}),
  ('storage_mode', 'shadow', ${now})
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;

${deviceId ? `INSERT INTO devices(id, name, hostname, created_at, updated_at)
VALUES (${sqlText(deviceId)}, ${sqlText(device?.name)}, ${sqlText(device?.hostname)}, ${now}, ${now})
ON CONFLICT(id) DO UPDATE SET name = excluded.name, hostname = excluded.hostname, updated_at = excluded.updated_at;` : ""}

${deviceId && senderPhone ? `UPDATE sender_accounts
SET sender_phone = ${sqlText(senderPhone)}, status = 'BOUND', updated_at = ${now}
WHERE device_id = ${sqlText(deviceId)};

INSERT INTO sender_accounts(sender_phone, device_id, connection_name, status, created_at, updated_at)
SELECT ${sqlText(senderPhone)}, ${sqlText(deviceId)}, '', 'BOUND', ${now}, ${now}
WHERE NOT EXISTS (SELECT 1 FROM sender_accounts WHERE device_id = ${sqlText(deviceId)});` : ""}

PRAGMA user_version = ${SCHEMA_VERSION};
COMMIT;
`;
}

export function createLocalDatabaseService({ dataDir, device = {}, senderPolicy = {}, sqliteBinary = "" } = {}) {
  const databasePath = path.join(dataDir, "mamba.sqlite");

  async function driver() {
    const binary = await findSqliteBinary(sqliteBinary);
    return {
      available: Boolean(binary),
      binary,
      label: binary ? "macOS sqlite3" : "sqlite3 not found",
    };
  }

  async function databaseExists() {
    try {
      const stat = await fs.stat(databasePath);
      return stat.isFile() ? stat : null;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async function queryJson(binary, sql) {
    const output = await runProcess(binary, ["-batch", "-json", databasePath], sql);
    return output ? JSON.parse(output) : [];
  }

  async function snapshot() {
    const detected = await driver();
    const stat = await databaseExists();
    const base = {
      engine: "SQLite",
      driver: detected.label,
      driverAvailable: detected.available,
      databasePath,
      initialized: Boolean(stat),
      schemaVersion: null,
      storageMode: "shadow",
      health: stat ? "checking" : "not_initialized",
      sizeBytes: stat?.size || 0,
      deviceId: String(device?.id || ""),
      expectedSenderPhone: senderPolicy?.configured ? String(senderPolicy.expectedSenderPhone || "") : "",
      notionImport: {
        enabled: false,
        status: "not_built",
        message: "Notion → SQLite 导入尚未启用；今天不会读取或修改 Notion 客户资料。",
      },
      counts: { customers: 0, conversations: 0, messages: 0, operations: 0, pendingSyncJobs: 0 },
    };
    if (!stat || !detected.available) return base;
    try {
      const [row] = await queryJson(detected.binary, `
SELECT
  COALESCE((SELECT value FROM metadata WHERE key = 'schema_version'), '') AS schemaVersion,
  COALESCE((SELECT value FROM metadata WHERE key = 'storage_mode'), 'shadow') AS storageMode,
  COALESCE((SELECT value FROM metadata WHERE key = 'notion_import_enabled'), 'false') AS notionImportEnabled,
  (SELECT COUNT(*) FROM customers) AS customers,
  (SELECT COUNT(*) FROM conversations) AS conversations,
  (SELECT COUNT(*) FROM messages) AS messages,
  (SELECT COUNT(*) FROM operations) AS operations,
  (SELECT COUNT(*) FROM sync_jobs WHERE status IN ('PENDING','RUNNING','RETRY')) AS pendingSyncJobs;
`);
      const [integrity] = await queryJson(detected.binary, "PRAGMA quick_check;");
      return {
        ...base,
        initialized: true,
        schemaVersion: Number(row?.schemaVersion || 0) || null,
        storageMode: row?.storageMode || "shadow",
        health: integrity?.quick_check === "ok" ? "ready" : "error",
        notionImport: {
          ...base.notionImport,
          enabled: row?.notionImportEnabled === "true",
          status: row?.notionImportEnabled === "true" ? "enabled" : "not_built",
        },
        counts: {
          customers: Number(row?.customers || 0),
          conversations: Number(row?.conversations || 0),
          messages: Number(row?.messages || 0),
          operations: Number(row?.operations || 0),
          pendingSyncJobs: Number(row?.pendingSyncJobs || 0),
        },
      };
    } catch (error) {
      return { ...base, initialized: true, health: "error", errorCode: "SQLITE_HEALTH_CHECK_FAILED", error: error.message };
    }
  }

  async function initialize() {
    const detected = await driver();
    if (!detected.available) {
      const error = new Error("找不到 sqlite3。macOS 正常应提供 /usr/bin/sqlite3；请先确认系统工具完整。");
      error.code = "SQLITE_DRIVER_NOT_FOUND";
      throw error;
    }
    await fs.mkdir(dataDir, { recursive: true });
    await runProcess(detected.binary, ["-batch", databasePath], schemaSql({ device, senderPolicy }), 60000);
    const state = await snapshot();
    if (state.health !== "ready") {
      const error = new Error(`SQLite 初始化后健康检查失败：${state.error || state.health}`);
      error.code = state.errorCode || "SQLITE_INITIALIZE_FAILED";
      throw error;
    }
    return state;
  }

  return { databasePath, driver, snapshot, initialize };
}
