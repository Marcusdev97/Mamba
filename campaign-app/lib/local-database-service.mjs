import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildSenderKey } from "./device-identity.mjs";

const SCHEMA_VERSION = 3;
const DEFAULT_SCHEMA_PATH = fileURLToPath(new URL("../../docs/mamba-schema.sql", import.meta.url));
const DEFAULT_SQLITE_CANDIDATES = [
  "/usr/bin/sqlite3",
  "/opt/homebrew/bin/sqlite3",
  "/usr/local/bin/sqlite3",
  "/opt/anaconda3/bin/sqlite3",
];

function sqlText(value) {
  return `'${String(value ?? "").replaceAll("'", "''")}'`;
}

function sqlNullable(value) {
  return value === null || value === undefined || value === "" ? "NULL" : sqlText(value);
}

function sqlNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : String(fallback);
}

function sqlBoolean(value) {
  return value === true || value === 1 || value === "1" ? "1" : "0";
}

function clean(value) {
  return String(value ?? "").trim();
}

function normalizePhone(value) {
  let digits = clean(value).replace(/\D/g, "");
  if (digits.startsWith("0")) digits = `60${digits.slice(1)}`;
  return /^\d{8,15}$/.test(digits) ? digits : "";
}

function slugCode(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function importId(date = new Date()) {
  return `import_${date.toISOString().replace(/[:.]/g, "-")}_${crypto.randomUUID().slice(0, 8)}`;
}

function cohortNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (Number.isFinite(number)) return Math.trunc(number);
  const match = String(value).match(/\d+/);
  return match ? Number(match[0]) : null;
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
    // 撞锁时等待而不是立刻抛 "database is locked"。
    // .timeout 是 sqlite3 dot-command,设置 busy_timeout 且不产生输出(不污染 -json)。
    const finalArgs = String(binary).includes("sqlite3")
      ? ["-cmd", ".timeout 10000", ...args]
      : args;
    const child = spawn(binary, finalArgs, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      const error = new Error(`SQLite command timeout after ${timeoutMs}ms`);
      error.code = "SQLITE_COMMAND_TIMEOUT";
      reject(error);
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

export function createLocalDatabaseService({
  dataDir,
  device = {},
  senderPolicy = {},
  sqliteBinary = "",
  schemaPath = DEFAULT_SCHEMA_PATH,
} = {}) {
  const databasePath = path.join(dataDir, "mamba.sqlite");
  let notionImportSource = null;

  async function driver() {
    const binary = await findSqliteBinary(sqliteBinary);
    return {
      available: Boolean(binary),
      binary,
      label: binary ? "macOS sqlite3" : "sqlite3 not found",
    };
  }

  async function databaseStat() {
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

  async function schemaVersion(binary) {
    const [row] = await queryJson(binary, "PRAGMA user_version;");
    return Number(row?.user_version || 0);
  }

  function configureNotionImport(source) {
    if (!source?.fetchRecords || !source?.scopeRecords) {
      throw new Error("Notion import source 必须提供 fetchRecords 和 scopeRecords。");
    }
    notionImportSource = source;
  }

  function projectCodeFor(record) {
    const resolved = notionImportSource?.resolveProjectCode?.(record?.project);
    return clean(record?.projectCode || resolved || slugCode(record?.project));
  }

  function normalizedImportRecord(record) {
    const phone = normalizePhone(record?.phone);
    const projectCode = projectCodeFor(record);
    return {
      notionPageId: clean(record?.id),
      phone,
      contactKey: phone,
      project: clean(record?.project),
      projectCode,
      projectLeadKey: projectCode && phone ? `${projectCode}:${phone}` : "",
      name: clean(record?.name),
      status: clean(record?.status),
      sequenceStatus: clean(record?.sequenceStatus),
      firstBlastAt: record?.firstBlastAt || null,
      lastBlastAt: record?.lastBlastAt || null,
      lastFlowSent: clean(record?.lastFlowSent),
      nextFlow: clean(record?.nextFlow),
      cohortDay: cohortNumber(record?.cohortDay),
      followUpDue: record?.followUpDue || null,
      followUpAt: record?.followUpAt || null,
      stopFlag: record?.stopFlag === true,
      stopReason: clean(record?.stopReason),
      replyCount: Math.max(0, Number(record?.replyCount || 0)),
      lastReplyAt: record?.lastReplyAt || null,
      lastReplyText: clean(record?.lastReplyText),
      aiCategory: clean(record?.aiCategory),
      aiSummary: clean(record?.aiSummary),
      priority: ["HIGH", "MED", "LOW"].includes(clean(record?.priority).toUpperCase())
        ? clean(record?.priority).toUpperCase()
        : "",
      assignedSales: clean(record?.assignedSales),
      salesNotes: clean(record?.salesNotes),
      appointmentDate: record?.appointmentDate || null,
      appointmentTime: clean(record?.appointmentTime),
      appointmentPlace: clean(record?.appointmentPlace),
      appointmentStatus: ["Pending", "Confirmed", "Done", "No Show"].includes(clean(record?.appointmentStatus))
        ? clean(record?.appointmentStatus)
        : "",
      senderInstance: clean(record?.senderInstance),
      assignedSenderKey: clean(record?.assignedSenderKey),
      lastSenderKey: clean(record?.lastSenderKey),
      lastSenderPhone: normalizePhone(record?.lastSenderPhone),
      lastSentByDevice: clean(record?.lastSentByDevice),
      campaignRunId: clean(record?.campaignRunId),
      nextAction: clean(record?.nextAction),
      replyCheckedAt: record?.replyCheckedAt || null,
      payload: record,
      sourceUpdatedAt: record?.sourceUpdatedAt || null,
    };
  }

  function rowChanged(row, record) {
    return clean(row?.phone) !== record.phone
      || clean(row?.projectCode) !== record.projectCode
      || clean(row?.name) !== record.name
      || clean(row?.status) !== record.status
      || clean(row?.sequenceStatus) !== record.sequenceStatus
      || clean(row?.lastFlowSent) !== record.lastFlowSent
      || clean(row?.nextFlow) !== record.nextFlow
      || clean(row?.lastBlastAt) !== clean(record.lastBlastAt)
      || clean(row?.followUpAt) !== clean(record.followUpAt)
      || clean(row?.sourceUpdatedAt) !== clean(record.sourceUpdatedAt);
  }

  async function requireV3Database() {
    const state = await initialize();
    const detected = await driver();
    if (!detected.available || state.health !== "ready" || state.schemaVersion !== SCHEMA_VERSION) {
      const error = new Error("SQLite v3 尚未准备好，无法运行本地数据操作。");
      error.code = "SQLITE_V3_NOT_READY";
      throw error;
    }
    return detected.binary;
  }

  async function previewNotionImport() {
    if (!notionImportSource) {
      const error = new Error("Notion → SQLite Dry Run service 尚未连接。请重启 Mamba。");
      error.code = "NOTION_IMPORT_SOURCE_NOT_CONFIGURED";
      throw error;
    }
    if (!senderPolicy?.configured || !normalizePhone(senderPolicy.expectedSenderPhone)) {
      const error = new Error("这台电脑尚未绑定真实 WhatsApp 号码。请先在 Settings 设置本机号码，再运行 Dry Run。");
      error.code = "LOCAL_DATABASE_SENDER_NOT_BOUND";
      throw error;
    }

    const binary = await requireV3Database();
    const fetchedAt = new Date().toISOString();
    let sourceRecords;
    try {
      sourceRecords = await notionImportSource.fetchRecords();
    } catch (error) {
      const wrapped = new Error(`读取 Notion Blast Leads 失败：${error.message}`);
      wrapped.code = "NOTION_IMPORT_FETCH_FAILED";
      throw wrapped;
    }

    const scoped = notionImportSource.scopeRecords(Array.isArray(sourceRecords) ? sourceRecords : []);
    const records = (scoped?.records || []).map(normalizedImportRecord);
    const invalid = records.filter((record) => !record.notionPageId || !record.phone || !record.projectCode);
    const valid = records.filter((record) => record.notionPageId && record.phone && record.projectCode);
    const pageIds = new Set();
    const leadKeys = new Set();
    const collisions = [];
    for (const record of valid) {
      if (pageIds.has(record.notionPageId) || leadKeys.has(record.projectLeadKey)) {
        collisions.push({
          notionPageId: record.notionPageId,
          phone: record.phone,
          project: record.project,
          projectLeadKey: record.projectLeadKey,
        });
      }
      pageIds.add(record.notionPageId);
      leadKeys.add(record.projectLeadKey);
    }

    const localRows = await queryJson(binary, `
SELECT notion_page_id AS notionPageId, phone, project_code AS projectCode, name, status,
       sequence_status AS sequenceStatus, last_flow_sent AS lastFlowSent, next_flow AS nextFlow,
       last_blast_at AS lastBlastAt, follow_up_at AS followUpAt, source_updated_at AS sourceUpdatedAt
FROM project_leads;
`);
    const localByPage = new Map(localRows.map((row) => [clean(row.notionPageId), row]));
    const localByKey = new Map(localRows.map((row) => [`${clean(row.projectCode)}:${normalizePhone(row.phone)}`, row]));
    let inserts = 0;
    let updates = 0;
    let unchanged = 0;
    for (const record of valid) {
      const existing = localByPage.get(record.notionPageId) || localByKey.get(record.projectLeadKey);
      if (!existing) inserts += 1;
      else if (rowChanged(existing, record)) updates += 1;
      else unchanged += 1;
    }
    const localOnly = localRows.filter((row) => {
      const pageId = clean(row.notionPageId);
      const key = `${clean(row.projectCode)}:${normalizePhone(row.phone)}`;
      return (!pageId || !pageIds.has(pageId)) && !leadKeys.has(key);
    }).length;
    const scopeCounts = scoped?.counts || {};
    const runId = importId();
    const safeToApply = invalid.length === 0 && collisions.length === 0 && valid.length > 0;
    const report = {
      runId,
      mode: "DRY_RUN",
      status: safeToApply ? "COMPLETED" : "PARTIAL",
      fetchedAt,
      sourceCount: Array.isArray(sourceRecords) ? sourceRecords.length : 0,
      scopedCount: records.length,
      inserts,
      updates,
      unchanged,
      localOnly,
      invalid: invalid.length,
      collisions: collisions.length,
      scope: {
        local: Number(scopeCounts.local ?? records.length),
        remote: Number(scopeCounts.remote || 0),
        legacy: Number(scopeCounts.legacy || 0),
        unassigned: Number(scopeCounts.unassigned || 0),
      },
      safeToApply,
      blockedReasons: [
        invalid.length ? `${invalid.length} 条缺少 Page ID、Phone 或有效 Project Code` : "",
        collisions.length ? `${collisions.length} 条本机候选资料发生重复` : "",
        !valid.length ? "这台电脑没有可导入的本机客户" : "",
      ].filter(Boolean),
      samples: { invalid: invalid.slice(0, 10), collisions: collisions.slice(0, 10) },
    };

    await runProcess(binary, ["-batch", databasePath], `
BEGIN IMMEDIATE;
INSERT INTO import_runs(
  id, source, mode, status, scanned_count, imported_count, skipped_count, failed_count,
  report_json, started_at, finished_at
) VALUES (
  ${sqlText(runId)}, 'notion:blast_leads', 'DRY_RUN', ${sqlText(report.status)},
  ${report.sourceCount}, 0, ${Math.max(0, report.sourceCount - report.scopedCount)},
  ${report.invalid + report.collisions}, ${sqlText(JSON.stringify(report))},
  ${sqlText(fetchedAt)}, ${sqlText(new Date().toISOString())}
);
COMMIT;
`);
    return report;
  }

  async function latestImportReport(binary, mode) {
    const [row] = await queryJson(binary, `
SELECT report_json AS reportJson FROM import_runs
WHERE source = 'notion:blast_leads' AND mode = ${sqlText(mode)}
ORDER BY started_at DESC LIMIT 1;
`);
    try {
      return row?.reportJson ? JSON.parse(row.reportJson) : null;
    } catch {
      return null;
    }
  }

  function validateImportCandidates(records) {
    const invalid = records.filter((record) => !record.notionPageId || !record.phone || !record.projectCode);
    const valid = records.filter((record) => record.notionPageId && record.phone && record.projectCode);
    const pageIds = new Set();
    const leadKeys = new Set();
    const collisions = [];
    for (const record of valid) {
      if (pageIds.has(record.notionPageId) || leadKeys.has(record.projectLeadKey)) {
        collisions.push({
          notionPageId: record.notionPageId,
          phone: record.phone,
          project: record.project,
          projectLeadKey: record.projectLeadKey,
        });
      }
      pageIds.add(record.notionPageId);
      leadKeys.add(record.projectLeadKey);
    }
    return { invalid, valid, collisions };
  }

  async function createBackup(binary) {
    const backupDir = path.join(dataDir, "backups");
    await fs.mkdir(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(backupDir, `mamba-before-notion-import-${stamp}.sqlite`);
    await runProcess(binary, ["-batch", databasePath], `.backup ${sqlText(backupPath)}\n`, 60000);
    return backupPath;
  }

  function importTransactionSql(records, report, { enableImport = true } = {}) {
    const now = report.finishedAt || new Date().toISOString();
    const expectedSenderKey = senderPolicy?.configured
      ? buildSenderKey(device?.id, senderPolicy.expectedSenderPhone)
      : "";
    const expectedSenderPhone = normalizePhone(senderPolicy?.expectedSenderPhone);
    const statements = ["PRAGMA foreign_keys = ON;", "BEGIN IMMEDIATE;"];
    for (const record of records) {
      const payloadJson = JSON.stringify(record.payload || {});
      const assignedSenderKey = expectedSenderKey || null;
      const lastSenderPhone = record.lastSenderPhone || expectedSenderPhone;
      const lastSenderKey = lastSenderPhone === expectedSenderPhone ? expectedSenderKey : null;
      const lastDevice = !record.lastSentByDevice || record.lastSentByDevice === clean(device?.id)
        ? (clean(device?.id) || null)
        : null;
      statements.push(`
INSERT INTO projects(project_code, project_name, aliases_json, active, created_at, updated_at)
VALUES (${sqlText(record.projectCode)}, ${sqlText(record.project || record.projectCode)}, '[]', 1, ${sqlText(now)}, ${sqlText(now)})
ON CONFLICT(project_code) DO UPDATE SET
  project_name=CASE WHEN excluded.project_name <> '' THEN excluded.project_name ELSE projects.project_name END,
  active=1, updated_at=excluded.updated_at;

INSERT INTO contacts(
  contact_key, phone, display_name, stop_flag, stop_reason, stop_at, reply_count,
  last_reply_text, last_reply_at, created_at, updated_at
) VALUES (
  ${sqlText(record.contactKey)}, ${sqlText(record.phone)}, ${sqlText(record.name)},
  ${sqlBoolean(record.stopFlag)}, ${sqlText(record.stopReason)},
  ${record.stopFlag ? sqlNullable(record.lastReplyAt || now) : "NULL"}, ${sqlNumber(record.replyCount)},
  ${sqlText(record.lastReplyText)}, ${sqlNullable(record.lastReplyAt)}, ${sqlText(now)}, ${sqlText(now)}
)
ON CONFLICT(contact_key) DO UPDATE SET
  phone=excluded.phone,
  display_name=CASE WHEN excluded.display_name <> '' THEN excluded.display_name ELSE contacts.display_name END,
  stop_flag=MAX(contacts.stop_flag, excluded.stop_flag),
  stop_reason=CASE WHEN excluded.stop_flag = 1 AND excluded.stop_reason <> '' THEN excluded.stop_reason ELSE contacts.stop_reason END,
  stop_at=CASE WHEN excluded.stop_flag = 1 THEN COALESCE(excluded.stop_at, contacts.stop_at) ELSE contacts.stop_at END,
  reply_count=MAX(contacts.reply_count, excluded.reply_count),
  last_reply_text=CASE
    WHEN COALESCE(excluded.last_reply_at, '') >= COALESCE(contacts.last_reply_at, '') AND excluded.last_reply_text <> ''
    THEN excluded.last_reply_text ELSE contacts.last_reply_text END,
  last_reply_at=CASE
    WHEN COALESCE(excluded.last_reply_at, '') >= COALESCE(contacts.last_reply_at, '')
    THEN excluded.last_reply_at ELSE contacts.last_reply_at END,
  updated_at=excluded.updated_at;

INSERT INTO project_leads(
  project_lead_key, notion_page_id, contact_key, project_code, phone, name,
  sequence_status, status, last_flow_sent, next_flow, cohort_day, follow_up_due,
  first_blast_at, last_blast_at, assigned_sender_key, last_sender_key,
  last_sender_phone, last_sent_by_device, campaign_run_id,
  ai_category, ai_summary, priority, follow_up_at, assigned_sales, sales_notes,
  appointment_date, appointment_time, appointment_place, appointment_status,
  payload_json, source_updated_at, created_at, updated_at
) VALUES (
  ${sqlText(record.projectLeadKey)}, ${sqlText(record.notionPageId)}, ${sqlText(record.contactKey)},
  ${sqlText(record.projectCode)}, ${sqlText(record.phone)}, ${sqlText(record.name)},
  ${sqlText(record.sequenceStatus)}, ${sqlText(record.status)}, ${sqlText(record.lastFlowSent)},
  ${sqlText(record.nextFlow)}, ${record.cohortDay === null ? "NULL" : sqlNumber(record.cohortDay)},
  ${sqlNullable(record.followUpDue)}, ${sqlNullable(record.firstBlastAt)}, ${sqlNullable(record.lastBlastAt)},
  ${sqlNullable(assignedSenderKey)}, ${sqlNullable(lastSenderKey)}, ${sqlText(lastSenderPhone)},
  ${sqlNullable(lastDevice)}, NULL,
  ${sqlText(record.aiCategory)}, ${sqlText(record.aiSummary)}, ${sqlText(record.priority)},
  ${sqlNullable(record.followUpAt)}, ${sqlText(record.assignedSales)}, ${sqlText(record.salesNotes)},
  ${sqlNullable(record.appointmentDate)}, ${sqlText(record.appointmentTime)},
  ${sqlText(record.appointmentPlace)}, ${sqlText(record.appointmentStatus)},
  ${sqlText(payloadJson)}, ${sqlNullable(record.sourceUpdatedAt)}, ${sqlText(now)}, ${sqlText(now)}
)
ON CONFLICT(project_lead_key) DO UPDATE SET
  notion_page_id=excluded.notion_page_id, contact_key=excluded.contact_key,
  project_code=excluded.project_code, phone=excluded.phone, name=excluded.name,
  sequence_status=excluded.sequence_status, status=excluded.status,
  last_flow_sent=excluded.last_flow_sent, next_flow=excluded.next_flow,
  cohort_day=excluded.cohort_day, follow_up_due=excluded.follow_up_due,
  first_blast_at=excluded.first_blast_at, last_blast_at=excluded.last_blast_at,
  assigned_sender_key=excluded.assigned_sender_key, last_sender_key=excluded.last_sender_key,
  last_sender_phone=excluded.last_sender_phone, last_sent_by_device=excluded.last_sent_by_device,
  ai_category=excluded.ai_category, ai_summary=excluded.ai_summary, priority=excluded.priority,
  follow_up_at=excluded.follow_up_at, assigned_sales=excluded.assigned_sales,
  sales_notes=excluded.sales_notes, appointment_date=excluded.appointment_date,
  appointment_time=excluded.appointment_time, appointment_place=excluded.appointment_place,
  appointment_status=excluded.appointment_status, payload_json=excluded.payload_json,
  source_updated_at=excluded.source_updated_at, updated_at=excluded.updated_at;
`);
    }
    if (enableImport) {
      statements.push(`
INSERT INTO metadata(key, value, updated_at) VALUES
  ('notion_import_enabled', 'true', ${sqlText(now)}),
  ('last_notion_apply_at', ${sqlText(now)}, ${sqlText(now)})
ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at;

INSERT INTO import_runs(
  id, source, mode, status, scanned_count, imported_count, skipped_count, failed_count,
  report_json, started_at, finished_at
) VALUES (
  ${sqlText(report.runId)}, 'notion:blast_leads', 'APPLY', 'COMPLETED',
  ${sqlNumber(report.sourceCount)}, ${sqlNumber(records.length)},
  ${sqlNumber(Math.max(0, report.sourceCount - records.length))}, 0,
  ${sqlText(JSON.stringify(report))}, ${sqlText(report.startedAt)}, ${sqlText(now)}
);
`);
    } else {
      statements.push(`
INSERT INTO metadata(key, value, updated_at) VALUES
  ('last_notion_refresh_at', ${sqlText(now)}, ${sqlText(now)})
ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at;
`);
    }
    statements.push("COMMIT;");
    return statements.join("\n");
  }

  async function applyNotionImport() {
    if (!notionImportSource) {
      const error = new Error("Notion → SQLite Apply service 尚未连接。请重启 Mamba。");
      error.code = "NOTION_IMPORT_SOURCE_NOT_CONFIGURED";
      throw error;
    }
    const binary = await requireV3Database();
    const latestDryRun = await latestImportReport(binary, "DRY_RUN");
    if (!latestDryRun?.safeToApply) {
      const error = new Error("最近一次 Dry Run 不是 PASS。请先重新运行 Dry Run，并处理所有无效或冲突资料。");
      error.code = "NOTION_IMPORT_DRY_RUN_REQUIRED";
      throw error;
    }
    const ageMs = Date.now() - new Date(latestDryRun.fetchedAt || 0).getTime();
    if (!Number.isFinite(ageMs) || ageMs > 24 * 60 * 60 * 1000) {
      const error = new Error("最近一次 Dry Run 已超过 24 小时。请先重新 Dry Run，避免把过期资料导入 SQLite。");
      error.code = "NOTION_IMPORT_DRY_RUN_EXPIRED";
      throw error;
    }

    const startedAt = new Date().toISOString();
    let sourceRecords;
    try {
      sourceRecords = await notionImportSource.fetchRecords();
    } catch (error) {
      const wrapped = new Error(`Apply 前重新读取 Notion 失败；SQLite 未修改：${error.message}`);
      wrapped.code = "NOTION_IMPORT_FETCH_FAILED";
      throw wrapped;
    }
    const scoped = notionImportSource.scopeRecords(Array.isArray(sourceRecords) ? sourceRecords : []);
    const candidates = (scoped?.records || []).map(normalizedImportRecord);
    const { invalid, valid, collisions } = validateImportCandidates(candidates);
    if (invalid.length || collisions.length || valid.length !== Number(latestDryRun.scopedCount || 0)) {
      const error = new Error(
        `Notion 资料在 Dry Run 后发生变化（当前本机 ${valid.length}，Dry Run ${latestDryRun.scopedCount || 0}，无效 ${invalid.length}，冲突 ${collisions.length}）。SQLite 未修改，请重新 Dry Run。`,
      );
      error.code = "NOTION_IMPORT_CHANGED_AFTER_DRY_RUN";
      throw error;
    }

    const backupPath = await createBackup(binary);
    const report = {
      runId: importId(),
      mode: "APPLY",
      status: "COMPLETED",
      startedAt,
      finishedAt: new Date().toISOString(),
      sourceCount: Array.isArray(sourceRecords) ? sourceRecords.length : 0,
      scopedCount: valid.length,
      imported: valid.length,
      invalid: 0,
      collisions: 0,
      backupPath,
      dryRunId: latestDryRun.runId,
      scope: scoped?.counts || {},
    };
    try {
      await runProcess(binary, ["-batch", databasePath], importTransactionSql(valid, report), 120000);
    } catch (error) {
      const wrapped = new Error(`SQLite 事务导入失败，整批已回滚；备份保留在 ${backupPath}。原始错误：${error.message}`);
      wrapped.code = "NOTION_IMPORT_TRANSACTION_FAILED";
      wrapped.backupPath = backupPath;
      throw wrapped;
    }
    const state = await snapshot();
    if (state.health !== "ready" || state.counts.projectLeads < valid.length) {
      const error = new Error(`导入后健康检查不通过（health=${state.health}, leads=${state.counts.projectLeads}）。请勿切换 Primary；备份：${backupPath}`);
      error.code = "NOTION_IMPORT_POSTCHECK_FAILED";
      error.backupPath = backupPath;
      throw error;
    }
    return { report, database: state };
  }

  async function syncNotionRecords(sourceRecords, { reason = "notion_refresh" } = {}) {
    const binary = await requireV3Database();
    const scoped = notionImportSource?.scopeRecords(Array.isArray(sourceRecords) ? sourceRecords : []) || { records: [] };
    const candidates = (scoped.records || []).map(normalizedImportRecord);
    const { invalid, valid, collisions } = validateImportCandidates(candidates);
    if (invalid.length || collisions.length) {
      const error = new Error(`SQLite refresh 已停止：无效 ${invalid.length}，冲突 ${collisions.length}。本机资料没有修改。`);
      error.code = "SQLITE_REFRESH_VALIDATION_FAILED";
      throw error;
    }
    const now = new Date().toISOString();
    const report = { runId: `refresh_${crypto.randomUUID()}`, startedAt: now, finishedAt: now, sourceCount: sourceRecords.length, reason };
    await runProcess(binary, ["-batch", databasePath], importTransactionSql(valid, report, { enableImport: false }), 120000);
    return readLeadCache();
  }

  async function readLeadCache() {
    const binary = await requireV3Database();
    const rows = await queryJson(binary, `
SELECT
  l.notion_page_id AS id, l.source_updated_at AS sourceUpdatedAt,
  p.project_name AS project, l.name, l.phone,
  l.first_blast_at AS firstBlastAt, l.last_blast_at AS lastBlastAt,
  l.last_flow_sent AS lastFlowSent, l.next_flow AS nextFlow, l.cohort_day AS cohortDay,
  l.sequence_status AS sequenceStatus, l.status, l.follow_up_at AS followUpAt,
  c.stop_flag AS stopFlag, c.stop_reason AS stopReason, c.reply_count AS replyCount,
  c.last_reply_at AS lastReplyAt, c.last_reply_text AS lastReplyText,
  l.ai_category AS aiCategory, l.ai_summary AS aiSummary, l.priority,
  l.assigned_sender_key AS assignedSenderKey, l.last_sender_key AS lastSenderKey,
  l.last_sender_phone AS lastSenderPhone, l.last_sent_by_device AS lastSentByDevice,
  l.campaign_run_id AS campaignRunId, l.assigned_sales AS assignedSales, l.sales_notes AS salesNotes,
  l.appointment_date AS appointmentDate, l.appointment_time AS appointmentTime,
  l.appointment_place AS appointmentPlace, l.appointment_status AS appointmentStatus,
  l.payload_json AS payloadJson
FROM project_leads l
JOIN contacts c ON c.contact_key = l.contact_key
JOIN projects p ON p.project_code = l.project_code
ORDER BY COALESCE(l.last_blast_at, l.first_blast_at, l.updated_at) DESC;
`);
    const records = rows.map((row) => {
      let payload = {};
      try { payload = row.payloadJson ? JSON.parse(row.payloadJson) : {}; } catch {}
      return {
        ...payload,
        ...row,
        stopFlag: Number(row.stopFlag || 0) === 1,
        replyCount: Number(row.replyCount || 0),
        payloadJson: undefined,
        url: row.id ? `https://www.notion.so/${String(row.id).replace(/-/g, "")}` : "",
      };
    });
    const [meta] = await queryJson(binary, `
SELECT COALESCE(
  (SELECT value FROM metadata WHERE key = 'last_notion_refresh_at'),
  (SELECT value FROM metadata WHERE key = 'last_notion_apply_at')
) AS syncedAt;
`);
    return { syncedAt: meta?.syncedAt || null, count: records.length, records, reused: true, source: "sqlite" };
  }

  async function setStorageMode(mode) {
    const normalized = clean(mode).toLowerCase();
    if (!["shadow", "primary"].includes(normalized)) {
      const error = new Error("SQLite mode 只支持 shadow 或 primary。");
      error.code = "SQLITE_STORAGE_MODE_INVALID";
      throw error;
    }
    const binary = await requireV3Database();
    if (normalized === "primary") {
      const latestApply = await latestImportReport(binary, "APPLY");
      const state = await snapshot();
      if (!latestApply || state.counts.projectLeads < 1 || state.health !== "ready") {
        const error = new Error("SQLite 尚未完成安全 Apply，不能切换为正式运行。请先完成 Dry Run PASS 和正式导入。");
        error.code = "SQLITE_PRIMARY_APPLY_REQUIRED";
        throw error;
      }
    }
    const now = new Date().toISOString();
    await runProcess(binary, ["-batch", databasePath], `
BEGIN IMMEDIATE;
INSERT INTO metadata(key, value, updated_at) VALUES ('storage_mode', ${sqlText(normalized)}, ${sqlText(now)})
ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at;
COMMIT;
`);
    return snapshot();
  }

  async function isPrimary() {
    const state = await snapshot();
    return state.health === "ready" && state.storageMode === "primary";
  }

  async function snapshot() {
    const detected = await driver();
    const stat = await databaseStat();
    const base = {
      engine: "SQLite",
      driver: detected.label,
      driverAvailable: detected.available,
      databasePath,
      initialized: Boolean(stat),
      schemaVersion: null,
      targetSchemaVersion: SCHEMA_VERSION,
      storageMode: "shadow",
      health: stat ? "checking" : "not_initialized",
      sizeBytes: stat?.size || 0,
      deviceId: clean(device?.id),
      expectedSenderPhone: senderPolicy?.configured ? normalizePhone(senderPolicy.expectedSenderPhone) : "",
      expectedSenderKey: senderPolicy?.configured ? buildSenderKey(device?.id, senderPolicy.expectedSenderPhone) : "",
      notionImport: {
        enabled: false,
        status: "ready_for_dry_run",
        message: "先 Dry Run 对账，再正式导入；导入完成后才可切换 SQLite Primary。",
        latestDryRun: null,
        latestApply: null,
      },
      syncWorker: { enabled: false, mode: "SHADOW", status: "IDLE", retryJobs: 0, failedJobs: 0 },
      counts: { customers: 0, projectLeads: 0, conversations: 0, messages: 0, operations: 0, pendingSyncJobs: 0 },
    };
    if (!stat || !detected.available) return base;

    try {
      const version = await schemaVersion(detected.binary);
      if (version !== SCHEMA_VERSION) {
        return {
          ...base,
          schemaVersion: version || null,
          health: "migration_required",
          errorCode: "SQLITE_V3_MIGRATION_REQUIRED",
          error: `检测到旧版 SQLite v${version || 1}。程序不会原地覆盖；请先运行 v2 → v3 Dry Run。`,
        };
      }
      const [row] = await queryJson(detected.binary, `
SELECT
  COALESCE((SELECT value FROM metadata WHERE key = 'storage_mode'), 'shadow') AS storageMode,
  COALESCE((SELECT value FROM metadata WHERE key = 'notion_import_enabled'), 'false') AS notionImportEnabled,
  (SELECT COUNT(*) FROM contacts) AS customers,
  (SELECT COUNT(*) FROM project_leads) AS projectLeads,
  (SELECT COUNT(*) FROM conversations) AS conversations,
  (SELECT COUNT(*) FROM messages) AS messages,
  (SELECT COUNT(*) FROM operations) AS operations,
  (SELECT COUNT(*) FROM sync_jobs WHERE status IN ('PENDING','RUNNING','RETRY')) AS pendingSyncJobs,
  (SELECT COUNT(*) FROM sync_jobs WHERE status = 'RETRY') AS retryJobs,
  (SELECT COUNT(*) FROM sync_jobs WHERE status = 'FAILED') AS failedJobs,
  COALESCE((SELECT enabled FROM sync_worker_state WHERE id = 'singleton'), 0) AS workerEnabled,
  COALESCE((SELECT mode FROM sync_worker_state WHERE id = 'singleton'), 'SHADOW') AS workerMode,
  COALESCE((SELECT status FROM sync_worker_state WHERE id = 'singleton'), 'IDLE') AS workerStatus;
`);
      const [latestImport] = await queryJson(detected.binary, `
SELECT report_json AS reportJson FROM import_runs
WHERE source = 'notion:blast_leads' AND mode = 'DRY_RUN'
ORDER BY started_at DESC LIMIT 1;
`);
      const [latestApplyRow] = await queryJson(detected.binary, `
SELECT report_json AS reportJson FROM import_runs
WHERE source = 'notion:blast_leads' AND mode = 'APPLY' AND status = 'COMPLETED'
ORDER BY started_at DESC LIMIT 1;
`);
      let latestDryRun = null;
      let latestApply = null;
      try { latestDryRun = latestImport?.reportJson ? JSON.parse(latestImport.reportJson) : null; } catch {}
      try { latestApply = latestApplyRow?.reportJson ? JSON.parse(latestApplyRow.reportJson) : null; } catch {}
      const [integrity] = await queryJson(detected.binary, "PRAGMA quick_check;");
      const foreignKeys = await queryJson(detected.binary, "PRAGMA foreign_key_check;");
      const healthy = integrity?.quick_check === "ok" && foreignKeys.length === 0;
      return {
        ...base,
        initialized: true,
        schemaVersion: version,
        storageMode: row?.storageMode || "shadow",
        health: healthy ? "ready" : "error",
        ...(healthy ? {} : { errorCode: "SQLITE_INTEGRITY_FAILED", error: "quick_check 或 foreign_key_check 未通过。" }),
        notionImport: {
          ...base.notionImport,
          enabled: row?.notionImportEnabled === "true",
          status: row?.storageMode === "primary"
            ? "primary"
            : latestApply
              ? "imported"
              : latestDryRun
                ? "dry_run_complete"
                : "ready_for_dry_run",
          latestDryRun,
          latestApply,
        },
        syncWorker: {
          enabled: Number(row?.workerEnabled || 0) === 1,
          mode: row?.workerMode || "SHADOW",
          status: row?.workerStatus || "IDLE",
          retryJobs: Number(row?.retryJobs || 0),
          failedJobs: Number(row?.failedJobs || 0),
        },
        counts: {
          customers: Number(row?.customers || 0),
          projectLeads: Number(row?.projectLeads || 0),
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
    const stat = await databaseStat();
    if (stat) {
      const version = await schemaVersion(detected.binary);
      if (version !== SCHEMA_VERSION) {
        const error = new Error(
          `检测到旧版 SQLite v${version || 1}。为避免破坏资料，Mamba 不会原地升级。先运行：node campaign-app/migrate_v2_to_v3.mjs --dry-run`,
        );
        error.code = "SQLITE_V3_MIGRATION_REQUIRED";
        throw error;
      }
    }

    let schema;
    try {
      schema = await fs.readFile(schemaPath, "utf8");
    } catch (error) {
      const wrapped = new Error(`找不到或无法读取 SQLite v3 schema：${schemaPath} (${error.message})`);
      wrapped.code = "SQLITE_V3_SCHEMA_MISSING";
      throw wrapped;
    }
    await runProcess(detected.binary, ["-batch", databasePath], schema, 60000);

    const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
    const deviceKey = clean(device?.id);
    const senderPhone = senderPolicy?.configured ? normalizePhone(senderPolicy.expectedSenderPhone) : "";
    const senderKey = buildSenderKey(deviceKey, senderPhone);
    const seedSql = `
PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;
${deviceKey ? `INSERT INTO devices(device_key, device_name, owner, hostname, last_online_at, created_at, updated_at)
VALUES (${sqlText(deviceKey)}, ${sqlText(device?.name)}, '', ${sqlText(device?.hostname)}, ${now}, ${now}, ${now})
ON CONFLICT(device_key) DO UPDATE SET device_name=excluded.device_name, hostname=excluded.hostname,
last_online_at=excluded.last_online_at, updated_at=excluded.updated_at;` : ""}
${senderKey ? `INSERT INTO whatsapp_connections(
  connection_key, instance_name, whatsapp_number, owner, team, device_key, status,
  last_health_check, last_seen_at, created_at, updated_at
) VALUES (${sqlText(senderKey)}, '', ${sqlText(senderPhone)}, '', '', ${sqlText(deviceKey)}, 'UNKNOWN',
  NULL, ${now}, ${now}, ${now})
ON CONFLICT(connection_key) DO UPDATE SET whatsapp_number=excluded.whatsapp_number,
device_key=excluded.device_key, last_seen_at=excluded.last_seen_at, updated_at=excluded.updated_at;` : ""}
INSERT INTO metadata(key, value, updated_at) VALUES ('notion_import_enabled', 'false', ${now})
ON CONFLICT(key) DO NOTHING;
INSERT INTO metadata(key, value, updated_at) VALUES
  ('expected_sender_phone', ${sqlText(senderPhone)}, ${now}),
  ('expected_sender_key', ${sqlText(senderKey)}, ${now})
ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at;
COMMIT;
`;
    await runProcess(detected.binary, ["-batch", databasePath], seedSql, 60000);
    const state = await snapshot();
    if (state.health !== "ready") {
      const error = new Error(`SQLite v3 初始化后健康检查失败：${state.error || state.health}`);
      error.code = state.errorCode || "SQLITE_V3_INITIALIZE_FAILED";
      throw error;
    }
    return state;
  }

  return {
    databasePath,
    driver,
    snapshot,
    initialize,
    configureNotionImport,
    previewNotionImport,
    applyNotionImport,
    syncNotionRecords,
    readLeadCache,
    setStorageMode,
    isPrimary,
  };
}
