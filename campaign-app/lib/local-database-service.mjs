import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildSenderKey } from "./device-identity.mjs";
import {
  RUNTIME_REQUIRED_COLUMNS,
  RUNTIME_SCHEMA_PATCH_VERSION,
} from "./v3-runtime-schema.mjs";

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

function leadGroupId() {
  return `group_${crypto.randomUUID()}`;
}

function cleanGroupName(value) {
  const name = clean(value).replace(/\s+/g, " ");
  if (!name) {
    const error = new Error("客户群名称不能为空。");
    error.code = "LEAD_GROUP_NAME_REQUIRED";
    throw error;
  }
  if (name.length > 80) {
    const error = new Error("客户群名称最多 80 个字。");
    error.code = "LEAD_GROUP_NAME_TOO_LONG";
    throw error;
  }
  return name;
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

  async function syncWhatsAppConnections(instances = []) {
    const deviceKey = clean(device?.id);
    if (!deviceKey) {
      const error = new Error("本机 Device ID 缺失，不能登记 WhatsApp 连接。");
      error.code = "WHATSAPP_CONNECTION_DEVICE_REQUIRED";
      throw error;
    }
    const connections = [...new Map((Array.isArray(instances) ? instances : []).map((item) => {
      const senderPhone = normalizePhone(item?.senderPhone || item?.owner || item?.number || item?.phone);
      const instanceName = clean(item?.instanceName || item?.name);
      const connectionKey = buildSenderKey(deviceKey, senderPhone);
      return connectionKey ? [connectionKey, { connectionKey, instanceName, senderPhone }] : null;
    }).filter(Boolean)).values()];
    if (!connections.length) return { upserted: 0, connections: [] };

    const binary = await requireV3Database();
    const now = new Date().toISOString();
    const statements = ["PRAGMA foreign_keys = ON;", "BEGIN IMMEDIATE;"];
    for (const connection of connections) {
      statements.push(`
INSERT INTO whatsapp_connections(
  connection_key, instance_name, whatsapp_number, owner, team, device_key, status,
  last_health_check, last_seen_at, created_at, updated_at
) VALUES (
  ${sqlText(connection.connectionKey)}, ${sqlText(connection.instanceName)}, ${sqlText(connection.senderPhone)},
  '', '', ${sqlText(deviceKey)}, 'OPEN', ${sqlText(now)}, ${sqlText(now)}, ${sqlText(now)}, ${sqlText(now)}
)
ON CONFLICT(connection_key) DO UPDATE SET
  instance_name=CASE WHEN excluded.instance_name<>'' THEN excluded.instance_name ELSE whatsapp_connections.instance_name END,
  whatsapp_number=excluded.whatsapp_number,
  device_key=excluded.device_key,
  status='OPEN',
  last_health_check=excluded.last_health_check,
  last_seen_at=excluded.last_seen_at,
  updated_at=excluded.updated_at;`);
    }
    statements.push("COMMIT;");
    await runProcess(binary, ["-batch", databasePath], statements.join("\n"), 60000);
    return { upserted: connections.length, connections };
  }

  function requireLeadGroupScope() {
    const deviceKey = clean(device?.id);
    const senderPhone = senderPolicy?.configured ? normalizePhone(senderPolicy.expectedSenderPhone) : "";
    if (!deviceKey || !senderPhone) {
      const error = new Error("这台电脑尚未绑定真实 WhatsApp 号码，不能建立或读取客户群。请先到 Settings 完成本机号码设置。");
      error.code = "LEAD_GROUP_DEVICE_SCOPE_REQUIRED";
      throw error;
    }
    return { deviceKey, senderPhone };
  }

  function readableGroupWriteError(error) {
    if (/idx_lead_groups_scope_name|UNIQUE constraint failed: lead_groups/i.test(String(error?.message || ""))) {
      const wrapped = new Error("这个项目已经有同名客户群。请换一个名字，或直接选择现有客户群。");
      wrapped.code = "LEAD_GROUP_NAME_EXISTS";
      return wrapped;
    }
    return error;
  }

  async function listLeadGroups({ projectCode = "" } = {}) {
    const binary = await requireV3Database();
    const { deviceKey, senderPhone } = requireLeadGroupScope();
    const projectFilter = clean(projectCode)
      ? `AND g.project_code = ${sqlText(clean(projectCode))}`
      : "";
    const rows = await queryJson(binary, `
SELECT g.group_id AS id, g.group_name AS name, g.project_code AS projectCode,
       g.source_type AS sourceType, g.source_name AS sourceName,
       g.device_key AS deviceId, g.sender_phone AS senderPhone,
       g.status, g.created_at AS createdAt, g.updated_at AS updatedAt,
       COUNT(m.member_id) AS memberCount
FROM lead_groups g
LEFT JOIN lead_group_members m ON m.group_id = g.group_id
WHERE g.device_key = ${sqlText(deviceKey)}
  AND g.sender_phone = ${sqlText(senderPhone)}
  AND g.status = 'ACTIVE'
  ${projectFilter}
GROUP BY g.group_id
ORDER BY g.updated_at DESC, g.created_at DESC;
`);
    return rows.map((row) => ({ ...row, memberCount: Number(row.memberCount || 0) }));
  }

  async function readLeadGroup({ groupId, projectCode = "" } = {}) {
    const binary = await requireV3Database();
    const { deviceKey, senderPhone } = requireLeadGroupScope();
    const id = clean(groupId);
    if (!id) {
      const error = new Error("请选择一个客户群。");
      error.code = "LEAD_GROUP_ID_REQUIRED";
      throw error;
    }
    const projectFilter = clean(projectCode)
      ? `AND project_code = ${sqlText(clean(projectCode))}`
      : "";
    const [group] = await queryJson(binary, `
SELECT group_id AS id, group_name AS name, project_code AS projectCode,
       source_type AS sourceType, source_name AS sourceName,
       device_key AS deviceId, sender_phone AS senderPhone,
       status, created_at AS createdAt, updated_at AS updatedAt
FROM lead_groups
WHERE group_id = ${sqlText(id)}
  AND device_key = ${sqlText(deviceKey)}
  AND sender_phone = ${sqlText(senderPhone)}
  AND status = 'ACTIVE'
  ${projectFilter}
LIMIT 1;
`);
    if (!group) {
      const error = new Error("找不到这个本机客户群，或它属于另一台电脑/另一个 WhatsApp 号码。");
      error.code = "LEAD_GROUP_NOT_LOCAL";
      throw error;
    }
    const members = await queryJson(binary, `
SELECT member_id AS id, name, phone, language, source_row AS sourceRow
FROM lead_group_members
WHERE group_id = ${sqlText(id)}
ORDER BY COALESCE(source_row, 2147483647), created_at, member_id;
`);
    return {
      ...group,
      memberCount: members.length,
      leads: members.map((member) => ({
        id: clean(member.id),
        name: clean(member.name) || "there",
        phone: normalizePhone(member.phone),
        ...(clean(member.language) ? { language: clean(member.language) } : {}),
        sourceRow: member.sourceRow === null || member.sourceRow === undefined ? null : Number(member.sourceRow),
      })).filter((member) => member.phone),
    };
  }

  async function createLeadGroup({ projectCode, projectName, name, sourceType = "file", sourceName = "", leads = [] } = {}) {
    const binary = await requireV3Database();
    const { deviceKey, senderPhone } = requireLeadGroupScope();
    const code = clean(projectCode);
    if (!code) {
      const error = new Error("客户群缺少 Project，无法保存。");
      error.code = "LEAD_GROUP_PROJECT_REQUIRED";
      throw error;
    }
    const groupName = cleanGroupName(name);
    const allowedSource = ["file", "manual", "database"].includes(clean(sourceType)) ? clean(sourceType) : "file";
    const seen = new Set();
    const normalized = [];
    for (const lead of Array.isArray(leads) ? leads : []) {
      const phone = normalizePhone(lead?.phone);
      if (!phone || seen.has(phone)) continue;
      seen.add(phone);
      normalized.push({
        id: clean(lead?.id) || `member_${crypto.randomUUID()}`,
        name: clean(lead?.name) || "there",
        phone,
        language: clean(lead?.language),
        sourceRow: Number.isFinite(Number(lead?.sourceRow)) ? Number(lead.sourceRow) : null,
      });
    }
    if (!normalized.length) {
      const error = new Error("客户群没有可用客户。请检查号码格式，或确认客户没有全部被重复/STOP 规则排除。");
      error.code = "LEAD_GROUP_EMPTY";
      throw error;
    }
    const id = leadGroupId();
    const now = new Date().toISOString();
    const statements = [
      "PRAGMA foreign_keys = ON;",
      "BEGIN IMMEDIATE;",
      `INSERT INTO projects(project_code, project_name, aliases_json, active, created_at, updated_at)
       VALUES (${sqlText(code)}, ${sqlText(clean(projectName) || code)}, '[]', 1, ${sqlText(now)}, ${sqlText(now)})
       ON CONFLICT(project_code) DO UPDATE SET
         project_name=CASE WHEN excluded.project_name <> '' THEN excluded.project_name ELSE projects.project_name END,
         active=1, updated_at=excluded.updated_at;`,
      `INSERT INTO lead_groups(
         group_id, project_code, group_name, source_type, source_name,
         device_key, sender_phone, status, created_at, updated_at
       ) VALUES (
         ${sqlText(id)}, ${sqlText(code)}, ${sqlText(groupName)}, ${sqlText(allowedSource)}, ${sqlText(clean(sourceName))},
         ${sqlText(deviceKey)}, ${sqlText(senderPhone)}, 'ACTIVE', ${sqlText(now)}, ${sqlText(now)}
       );`,
    ];
    for (const member of normalized) {
      statements.push(`INSERT INTO lead_group_members(
        group_id, member_id, phone, name, language, source_row, created_at, updated_at
      ) VALUES (
        ${sqlText(id)}, ${sqlText(member.id)}, ${sqlText(member.phone)}, ${sqlText(member.name)},
        ${sqlText(member.language)}, ${member.sourceRow === null ? "NULL" : sqlNumber(member.sourceRow)},
        ${sqlText(now)}, ${sqlText(now)}
      );`);
    }
    statements.push("COMMIT;");
    try {
      await runProcess(binary, ["-batch", databasePath], statements.join("\n"), 60000);
    } catch (error) {
      throw readableGroupWriteError(error);
    }
    return readLeadGroup({ groupId: id, projectCode: code });
  }

  async function renameLeadGroup({ groupId, projectCode = "", name } = {}) {
    const binary = await requireV3Database();
    const { deviceKey, senderPhone } = requireLeadGroupScope();
    const group = await readLeadGroup({ groupId, projectCode });
    const groupName = cleanGroupName(name);
    const now = new Date().toISOString();
    try {
      await runProcess(binary, ["-batch", databasePath], `
BEGIN IMMEDIATE;
UPDATE lead_groups SET group_name=${sqlText(groupName)}, updated_at=${sqlText(now)}
WHERE group_id=${sqlText(group.id)} AND device_key=${sqlText(deviceKey)} AND sender_phone=${sqlText(senderPhone)};
COMMIT;
`);
    } catch (error) {
      throw readableGroupWriteError(error);
    }
    return readLeadGroup({ groupId: group.id, projectCode: group.projectCode });
  }

  async function updateLeadGroupMembers({ groupId, projectCode = "", edits = [] } = {}) {
    const binary = await requireV3Database();
    const group = await readLeadGroup({ groupId, projectCode });
    const existing = new Set(group.leads.map((lead) => lead.id));
    const now = new Date().toISOString();
    const statements = ["BEGIN IMMEDIATE;"];
    let updated = 0;
    for (const edit of Array.isArray(edits) ? edits : []) {
      const id = clean(edit?.id);
      const name = clean(edit?.name);
      if (!id || !name || !existing.has(id)) continue;
      statements.push(`UPDATE lead_group_members SET name=${sqlText(name)}, updated_at=${sqlText(now)}
        WHERE group_id=${sqlText(group.id)} AND member_id=${sqlText(id)};`);
      updated += 1;
    }
    statements.push(`UPDATE lead_groups SET updated_at=${sqlText(now)} WHERE group_id=${sqlText(group.id)};`, "COMMIT;");
    await runProcess(binary, ["-batch", databasePath], statements.join("\n"), 60000);
    return { updated, group: await readLeadGroup({ groupId: group.id, projectCode: group.projectCode }) };
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
  sequence_status=CASE
    WHEN project_leads.campaign_run_id IS NOT NULL
      AND COALESCE(project_leads.last_blast_at,'') >= COALESCE(excluded.last_blast_at,'')
    THEN project_leads.sequence_status ELSE excluded.sequence_status END,
  status=excluded.status,
  last_flow_sent=CASE
    WHEN project_leads.campaign_run_id IS NOT NULL
      AND COALESCE(project_leads.last_blast_at,'') >= COALESCE(excluded.last_blast_at,'')
    THEN project_leads.last_flow_sent ELSE excluded.last_flow_sent END,
  next_flow=CASE
    WHEN project_leads.campaign_run_id IS NOT NULL
      AND COALESCE(project_leads.last_blast_at,'') >= COALESCE(excluded.last_blast_at,'')
    THEN project_leads.next_flow ELSE excluded.next_flow END,
  cohort_day=CASE
    WHEN project_leads.campaign_run_id IS NOT NULL
      AND COALESCE(project_leads.last_blast_at,'') >= COALESCE(excluded.last_blast_at,'')
    THEN project_leads.cohort_day ELSE excluded.cohort_day END,
  follow_up_due=CASE
    WHEN project_leads.campaign_run_id IS NOT NULL
      AND COALESCE(project_leads.last_blast_at,'') >= COALESCE(excluded.last_blast_at,'')
    THEN project_leads.follow_up_due ELSE excluded.follow_up_due END,
  first_blast_at=COALESCE(project_leads.first_blast_at, excluded.first_blast_at),
  last_blast_at=CASE
    WHEN COALESCE(project_leads.last_blast_at,'') >= COALESCE(excluded.last_blast_at,'')
    THEN project_leads.last_blast_at ELSE excluded.last_blast_at END,
  assigned_sender_key=CASE
    WHEN project_leads.campaign_run_id IS NOT NULL
      AND COALESCE(project_leads.last_blast_at,'') >= COALESCE(excluded.last_blast_at,'')
    THEN project_leads.assigned_sender_key ELSE excluded.assigned_sender_key END,
  last_sender_key=CASE
    WHEN project_leads.campaign_run_id IS NOT NULL
      AND COALESCE(project_leads.last_blast_at,'') >= COALESCE(excluded.last_blast_at,'')
    THEN project_leads.last_sender_key ELSE excluded.last_sender_key END,
  last_sender_phone=CASE
    WHEN project_leads.campaign_run_id IS NOT NULL
      AND COALESCE(project_leads.last_blast_at,'') >= COALESCE(excluded.last_blast_at,'')
    THEN project_leads.last_sender_phone ELSE excluded.last_sender_phone END,
  last_sent_by_device=CASE
    WHEN project_leads.campaign_run_id IS NOT NULL
      AND COALESCE(project_leads.last_blast_at,'') >= COALESCE(excluded.last_blast_at,'')
    THEN project_leads.last_sent_by_device ELSE excluded.last_sent_by_device END,
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
  l.notion_page_id AS id, l.source_updated_at AS sourceUpdatedAt, l.updated_at AS localUpdatedAt,
  p.project_name AS project, l.project_code AS projectCode, l.name, l.phone,
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

  // Campaign/回复的事实先写本机，再让 Notion 当异步镜像。
  //
  // project_leads 以前只是 Notion snapshot；run 中途 STOP 或 Notion timeout 时，
  // 已经收到讯息的人仍停在旧 Next Flow。下面三支 mutation 是 local-first 的热路径：
  //   · recordCampaignFlowProgress — 以实际 sentAt 推进 Flow
  //   · setLeadFlowState           — 人工批量改 Flow
  //   · recordLeadReply            — Refresh/Tracker 扫到回复先落地
  // 全部用单一 SQLite transaction，页面关掉也不会留下半批状态。
  async function recordCampaignFlowProgress({
    runId,
    projectCode,
    projectName = "",
    flowLabel,
    nextFlow,
    cohortDay,
    sequenceStatus = "Running",
    mode = "LIVE",
    runStatus = "PARTIAL",
    deviceId = "",
    startedAt = null,
    finishedAt = null,
    requestedCount = null,
    failedCount = 0,
    assignments = [],
    notionSyncJob = null,
  } = {}) {
    const id = clean(runId);
    const code = clean(projectCode);
    const sentFlow = clean(flowLabel);
    const checkpointDeviceKey = clean(deviceId || device?.id);
    if (!id || !code || !sentFlow || clean(mode).toUpperCase() !== "LIVE") {
      return { recorded: 0, skipped: Array.isArray(assignments) ? assignments.length : 0, reason: "not_live_flow_run" };
    }
    const rows = (Array.isArray(assignments) ? assignments : []).map((item) => {
      const phone = normalizePhone(item?.phone);
      const sentAt = item?.sentAt || item?.part2SentAt || item?.part1SentAt || null;
      if (!phone || !sentAt || !Number.isFinite(new Date(sentAt).getTime())) return null;
      return {
        phone,
        name: clean(item?.name),
        sentAt: new Date(sentAt).toISOString(),
        dueDate: item?.dueDate || null,
        senderKey: clean(item?.senderKey) || buildSenderKey(checkpointDeviceKey, item?.senderPhone),
        senderPhone: normalizePhone(item?.senderPhone),
        instanceName: clean(item?.instanceName),
        part1SentAt: item?.part1SentAt || null,
        part2SentAt: item?.part2SentAt || null,
      };
    }).filter(Boolean);
    const binary = await requireV3Database();
    const now = new Date().toISOString();
    const allowedRunStatus = ["QUEUED", "RUNNING", "PARTIAL", "COMPLETED", "FAILED", "STOPPED"].includes(clean(runStatus).toUpperCase())
      ? clean(runStatus).toUpperCase()
      : "PARTIAL";
    const senderSet = [...new Set(rows.map((row) => row.instanceName).filter(Boolean))].join(",");
    const totalRequested = Number.isFinite(Number(requestedCount))
      ? Math.max(rows.length, Math.trunc(Number(requestedCount)))
      : Math.max(rows.length, Array.isArray(assignments) ? assignments.length : 0);
    const totalFailed = Number.isFinite(Number(failedCount))
      ? Math.max(0, Math.trunc(Number(failedCount)))
      : 0;
    const runPayload = JSON.stringify({ source: "run-json", localFirst: true, flowLabel: sentFlow });
    const statements = ["PRAGMA foreign_keys = ON;", "BEGIN IMMEDIATE;", `
${checkpointDeviceKey ? `INSERT INTO devices(
  device_key, device_name, owner, hostname, last_online_at, created_at, updated_at
) VALUES (
  ${sqlText(checkpointDeviceKey)}, ${sqlText(device?.name)}, '', ${sqlText(device?.hostname)},
  ${sqlText(now)}, ${sqlText(now)}, ${sqlText(now)}
)
ON CONFLICT(device_key) DO UPDATE SET
  device_name=CASE WHEN excluded.device_name<>'' THEN excluded.device_name ELSE devices.device_name END,
  hostname=CASE WHEN excluded.hostname<>'' THEN excluded.hostname ELSE devices.hostname END,
  last_online_at=excluded.last_online_at,
  updated_at=excluded.updated_at;` : ""}

INSERT INTO projects(project_code, project_name, aliases_json, active, created_at, updated_at)
VALUES (${sqlText(code)}, ${sqlText(projectName || code)}, '[]', 1, ${sqlText(now)}, ${sqlText(now)})
ON CONFLICT(project_code) DO UPDATE SET
  project_name=CASE WHEN excluded.project_name<>'' THEN excluded.project_name ELSE projects.project_name END,
  active=1, updated_at=excluded.updated_at;

INSERT INTO campaign_runs(
  run_id, notion_page_id, name, project_code, flow_topic, flow_no, sender_set, mode,
  status, requested_count, sent_count, failed_count, device_key, started_at,
  finished_at, payload_json
) VALUES (
  ${sqlText(id)}, NULL, ${sqlText(`${projectName || code} · ${sentFlow}`)}, ${sqlText(code)},
  ${sqlText(sentFlow)}, NULL, ${sqlText(senderSet)}, 'LIVE', ${sqlText(allowedRunStatus)},
  ${sqlNumber(totalRequested)}, ${sqlNumber(rows.length)}, ${sqlNumber(totalFailed)},
  ${sqlNullable(checkpointDeviceKey)}, ${sqlText(startedAt || rows[0]?.sentAt || now)},
  ${sqlNullable(finishedAt)}, ${sqlText(runPayload)}
)
ON CONFLICT(run_id) DO UPDATE SET
  status=excluded.status,
  requested_count=MAX(campaign_runs.requested_count, excluded.requested_count),
  sent_count=MAX(campaign_runs.sent_count, excluded.sent_count),
  failed_count=MAX(campaign_runs.failed_count, excluded.failed_count),
  finished_at=COALESCE(excluded.finished_at, campaign_runs.finished_at),
  payload_json=excluded.payload_json;`];

    const senderConnections = [...new Map(rows.map((row) => (
      row.senderKey && row.senderPhone
        ? [row.senderKey, {
          connectionKey: row.senderKey,
          instanceName: row.instanceName,
          senderPhone: row.senderPhone,
        }]
        : null
    )).filter(Boolean)).values()];
    for (const connection of senderConnections) {
      statements.push(`
INSERT INTO whatsapp_connections(
  connection_key, instance_name, whatsapp_number, owner, team, device_key, status,
  last_health_check, last_seen_at, created_at, updated_at
) VALUES (
  ${sqlText(connection.connectionKey)}, ${sqlText(connection.instanceName)}, ${sqlText(connection.senderPhone)},
  '', '', ${sqlNullable(checkpointDeviceKey)}, 'OPEN', ${sqlText(now)}, ${sqlText(now)}, ${sqlText(now)}, ${sqlText(now)}
)
ON CONFLICT(connection_key) DO UPDATE SET
  instance_name=CASE WHEN excluded.instance_name<>'' THEN excluded.instance_name ELSE whatsapp_connections.instance_name END,
  whatsapp_number=excluded.whatsapp_number,
  device_key=COALESCE(excluded.device_key, whatsapp_connections.device_key),
  status='OPEN',
  last_health_check=excluded.last_health_check,
  last_seen_at=excluded.last_seen_at,
  updated_at=excluded.updated_at;`);
    }

    for (const row of rows) {
      const leadKey = `${code}:${row.phone}`;
      // sentAt 是硬证据。旧 run 重放时不能把已经走得更远的客户倒退。
      statements.push(`
INSERT INTO contacts(
  contact_key, phone, display_name, stop_flag, stop_reason, reply_count,
  last_reply_text, created_at, updated_at
) VALUES (
  ${sqlText(row.phone)}, ${sqlText(row.phone)}, ${sqlText(row.name)}, 0, '', 0, '', ${sqlText(now)}, ${sqlText(now)}
)
ON CONFLICT(contact_key) DO UPDATE SET
  display_name=CASE WHEN contacts.display_name='' AND excluded.display_name<>'' THEN excluded.display_name ELSE contacts.display_name END,
  updated_at=excluded.updated_at;

INSERT INTO project_leads(
  project_lead_key, notion_page_id, contact_key, project_code, phone, name,
  sequence_status, status, last_flow_sent, next_flow, cohort_day, follow_up_due,
  first_blast_at, last_blast_at, assigned_sender_key, last_sender_key,
  last_sender_phone, last_sent_by_device, campaign_run_id,
  payload_json, source_updated_at, created_at, updated_at
) VALUES (
  ${sqlText(leadKey)}, NULL, ${sqlText(row.phone)}, ${sqlText(code)}, ${sqlText(row.phone)}, ${sqlText(row.name)},
  ${sqlText(sequenceStatus)}, 'Blasted', ${sqlText(sentFlow)}, ${sqlText(nextFlow)},
  ${cohortNumber(cohortDay) === null ? "NULL" : sqlNumber(cohortNumber(cohortDay))}, ${sqlNullable(row.dueDate)},
  ${sqlNullable(row.part1SentAt || row.sentAt)}, ${sqlText(row.sentAt)},
  ${sqlNullable(row.senderKey)}, ${sqlNullable(row.senderKey)}, ${sqlText(row.senderPhone)},
  ${sqlNullable(checkpointDeviceKey)}, ${sqlText(id)}, ${sqlText(JSON.stringify({ source: "campaign-checkpoint", localFirst: true }))},
  NULL, ${sqlText(now)}, ${sqlText(now)}
)
ON CONFLICT(project_lead_key) DO UPDATE SET
  name=CASE WHEN project_leads.name='' AND excluded.name<>'' THEN excluded.name ELSE project_leads.name END,
  sequence_status=CASE WHEN COALESCE(project_leads.last_blast_at,'')<=excluded.last_blast_at OR project_leads.campaign_run_id=excluded.campaign_run_id THEN excluded.sequence_status ELSE project_leads.sequence_status END,
  status=CASE WHEN project_leads.status='' THEN excluded.status ELSE project_leads.status END,
  last_flow_sent=CASE WHEN COALESCE(project_leads.last_blast_at,'')<=excluded.last_blast_at OR project_leads.campaign_run_id=excluded.campaign_run_id THEN excluded.last_flow_sent ELSE project_leads.last_flow_sent END,
  next_flow=CASE WHEN COALESCE(project_leads.last_blast_at,'')<=excluded.last_blast_at OR project_leads.campaign_run_id=excluded.campaign_run_id THEN excluded.next_flow ELSE project_leads.next_flow END,
  cohort_day=CASE WHEN COALESCE(project_leads.last_blast_at,'')<=excluded.last_blast_at OR project_leads.campaign_run_id=excluded.campaign_run_id THEN excluded.cohort_day ELSE project_leads.cohort_day END,
  follow_up_due=CASE WHEN COALESCE(project_leads.last_blast_at,'')<=excluded.last_blast_at OR project_leads.campaign_run_id=excluded.campaign_run_id THEN excluded.follow_up_due ELSE project_leads.follow_up_due END,
  first_blast_at=COALESCE(project_leads.first_blast_at, excluded.first_blast_at),
  last_blast_at=CASE WHEN COALESCE(project_leads.last_blast_at,'')<=excluded.last_blast_at OR project_leads.campaign_run_id=excluded.campaign_run_id THEN excluded.last_blast_at ELSE project_leads.last_blast_at END,
  assigned_sender_key=CASE WHEN COALESCE(project_leads.last_blast_at,'')<=excluded.last_blast_at OR project_leads.campaign_run_id=excluded.campaign_run_id THEN COALESCE(excluded.assigned_sender_key, project_leads.assigned_sender_key) ELSE project_leads.assigned_sender_key END,
  last_sender_key=CASE WHEN COALESCE(project_leads.last_blast_at,'')<=excluded.last_blast_at OR project_leads.campaign_run_id=excluded.campaign_run_id THEN COALESCE(excluded.last_sender_key, project_leads.last_sender_key) ELSE project_leads.last_sender_key END,
  last_sender_phone=CASE WHEN (COALESCE(project_leads.last_blast_at,'')<=excluded.last_blast_at OR project_leads.campaign_run_id=excluded.campaign_run_id) AND excluded.last_sender_phone<>'' THEN excluded.last_sender_phone ELSE project_leads.last_sender_phone END,
  last_sent_by_device=CASE WHEN COALESCE(project_leads.last_blast_at,'')<=excluded.last_blast_at OR project_leads.campaign_run_id=excluded.campaign_run_id THEN COALESCE(excluded.last_sent_by_device, project_leads.last_sent_by_device) ELSE project_leads.last_sent_by_device END,
  campaign_run_id=CASE WHEN COALESCE(project_leads.last_blast_at,'')<=excluded.last_blast_at OR project_leads.campaign_run_id=excluded.campaign_run_id THEN excluded.campaign_run_id ELSE project_leads.campaign_run_id END,
  payload_json=CASE WHEN COALESCE(project_leads.last_blast_at,'')<=excluded.last_blast_at OR project_leads.campaign_run_id=excluded.campaign_run_id THEN excluded.payload_json ELSE project_leads.payload_json END,
  updated_at=excluded.updated_at;

INSERT INTO send_jobs(
  id, run_id, project_lead_key, connection_key, flow_topic, part_no, template_key,
  status, scheduled_at, sent_at, error_code, error_message, created_at, updated_at
)
SELECT ${sqlText(`${id}:${row.phone}:1`)}, ${sqlText(id)}, project_lead_key,
       ${sqlNullable(row.senderKey)}, ${sqlText(sentFlow)}, 1, NULL, 'SENT', NULL,
       ${sqlNullable(row.part1SentAt || row.sentAt)}, '', '', ${sqlText(now)}, ${sqlText(now)}
FROM project_leads WHERE project_lead_key=${sqlText(leadKey)}
ON CONFLICT(id) DO UPDATE SET status='SENT', sent_at=excluded.sent_at, updated_at=excluded.updated_at;`);
      if (row.part2SentAt) {
        statements.push(`
INSERT INTO send_jobs(
  id, run_id, project_lead_key, connection_key, flow_topic, part_no, template_key,
  status, scheduled_at, sent_at, error_code, error_message, created_at, updated_at
)
SELECT ${sqlText(`${id}:${row.phone}:2`)}, ${sqlText(id)}, project_lead_key,
       ${sqlNullable(row.senderKey)}, ${sqlText(sentFlow)}, 2, NULL, 'SENT', NULL,
       ${sqlText(row.part2SentAt)}, '', '', ${sqlText(now)}, ${sqlText(now)}
FROM project_leads WHERE project_lead_key=${sqlText(leadKey)}
ON CONFLICT(id) DO UPDATE SET status='SENT', sent_at=excluded.sent_at, updated_at=excluded.updated_at;`);
      }
    }
    if (rows.length && notionSyncJob?.idempotencyKey && notionSyncJob?.entityType && notionSyncJob?.entityId) {
      const availableAt = notionSyncJob.availableAt || now;
      const payloadJson = JSON.stringify(notionSyncJob.payload || {});
      statements.push(`
INSERT INTO sync_jobs(
  idempotency_key, direction, entity_type, entity_id, status, attempt_count,
  available_at, last_error_code, last_error_message, payload_json, created_at, updated_at
) VALUES (
  ${sqlText(notionSyncJob.idempotencyKey)}, 'LOCAL_TO_NOTION', ${sqlText(notionSyncJob.entityType)},
  ${sqlText(notionSyncJob.entityId)}, 'PENDING', 0, ${sqlText(availableAt)}, '', '',
  ${sqlText(payloadJson)}, ${sqlText(now)}, ${sqlText(now)}
)
ON CONFLICT(idempotency_key) DO UPDATE SET
  payload_json=excluded.payload_json,
  status=CASE WHEN sync_jobs.status IN ('COMPLETED','FAILED') THEN 'PENDING' ELSE sync_jobs.status END,
  attempt_count=CASE WHEN sync_jobs.status IN ('COMPLETED','FAILED') THEN 0 ELSE sync_jobs.attempt_count END,
  available_at=CASE WHEN sync_jobs.status IN ('COMPLETED','FAILED') THEN excluded.available_at ELSE sync_jobs.available_at END,
  last_error_code=CASE WHEN sync_jobs.status IN ('COMPLETED','FAILED') THEN '' ELSE sync_jobs.last_error_code END,
  last_error_message=CASE WHEN sync_jobs.status IN ('COMPLETED','FAILED') THEN '' ELSE sync_jobs.last_error_message END,
  updated_at=excluded.updated_at;`);
    }
    statements.push("COMMIT;");
    await runProcess(binary, ["-batch", databasePath], statements.join("\n"), 120000);
    if (!rows.length) {
      return {
        recorded: 0,
        advanced: 0,
        skipped: Array.isArray(assignments) ? assignments.length : 0,
        runId: id,
        flowLabel: sentFlow,
        nextFlow,
      };
    }
    const phoneList = rows.map((row) => sqlText(row.phone)).join(",");
    const [result] = await queryJson(binary, `
SELECT COUNT(*) AS accounted,
       SUM(CASE WHEN campaign_run_id=${sqlText(id)} THEN 1 ELSE 0 END) AS advanced
FROM project_leads
WHERE project_code=${sqlText(code)} AND phone IN (${phoneList});`);
    const recorded = Number(result?.accounted || 0);
    return {
      recorded,
      advanced: Number(result?.advanced || 0),
      skipped: Math.max(0, rows.length - recorded),
      runId: id,
      flowLabel: sentFlow,
      nextFlow,
    };
  }

  // Refresh Campaign 只是一轮重新联系，不是客户 Flow 的下一步。
  // 所以这里只更新发送证据与 sender ownership，绝不改 Next Flow、
  // Last Flow Sent、Follow Up Due 或 Sequence Status。
  async function recordRefreshCampaignProgress({
    runId,
    projectCode,
    projectName = "",
    mode = "LIVE",
    runStatus = "PARTIAL",
    deviceId = "",
    startedAt = null,
    finishedAt = null,
    requestedCount = null,
    failedCount = 0,
    assignments = [],
    notionSyncJob = null,
  } = {}) {
    const id = clean(runId);
    const code = clean(projectCode);
    const checkpointDeviceKey = clean(deviceId || device?.id);
    if (!id || !code || clean(mode).toUpperCase() !== "LIVE") {
      return { recorded: 0, skipped: Array.isArray(assignments) ? assignments.length : 0, reason: "not_live_refresh_run" };
    }
    const rows = (Array.isArray(assignments) ? assignments : []).map((item) => {
      const phone = normalizePhone(item?.phone);
      const sentAt = item?.sentAt || item?.part2SentAt || item?.part1SentAt || null;
      if (!phone || !sentAt || !Number.isFinite(new Date(sentAt).getTime())) return null;
      return {
        phone,
        name: clean(item?.name),
        sentAt: new Date(sentAt).toISOString(),
        senderKey: clean(item?.senderKey) || buildSenderKey(checkpointDeviceKey, item?.senderPhone),
        senderPhone: normalizePhone(item?.senderPhone),
        instanceName: clean(item?.instanceName),
        part1SentAt: item?.part1SentAt || null,
        part2SentAt: item?.part2SentAt || null,
      };
    }).filter(Boolean);
    const binary = await requireV3Database();
    const now = new Date().toISOString();
    const allowedRunStatus = ["QUEUED", "RUNNING", "PARTIAL", "COMPLETED", "FAILED", "STOPPED"].includes(clean(runStatus).toUpperCase())
      ? clean(runStatus).toUpperCase()
      : "PARTIAL";
    const senderSet = [...new Set(rows.map((row) => row.instanceName).filter(Boolean))].join(",");
    const totalRequested = Number.isFinite(Number(requestedCount))
      ? Math.max(rows.length, Math.trunc(Number(requestedCount)))
      : Math.max(rows.length, Array.isArray(assignments) ? assignments.length : 0);
    const totalFailed = Number.isFinite(Number(failedCount)) ? Math.max(0, Math.trunc(Number(failedCount))) : 0;
    const statements = ["PRAGMA foreign_keys = ON;", "BEGIN IMMEDIATE;", `
INSERT INTO projects(project_code, project_name, aliases_json, active, created_at, updated_at)
VALUES (${sqlText(code)}, ${sqlText(projectName || code)}, '[]', 1, ${sqlText(now)}, ${sqlText(now)})
ON CONFLICT(project_code) DO UPDATE SET
  project_name=CASE WHEN excluded.project_name<>'' THEN excluded.project_name ELSE projects.project_name END,
  active=1, updated_at=excluded.updated_at;

INSERT INTO campaign_runs(
  run_id, notion_page_id, name, project_code, flow_topic, flow_no, sender_set, mode,
  status, requested_count, sent_count, failed_count, device_key, started_at,
  finished_at, payload_json
) VALUES (
  ${sqlText(id)}, NULL, ${sqlText(`${projectName || code} · Refresh`)}, ${sqlText(code)},
  'Refresh - Reconnect', NULL, ${sqlText(senderSet)}, 'LIVE', ${sqlText(allowedRunStatus)},
  ${sqlNumber(totalRequested)}, ${sqlNumber(rows.length)}, ${sqlNumber(totalFailed)},
  ${sqlNullable(checkpointDeviceKey)}, ${sqlText(startedAt || rows[0]?.sentAt || now)},
  ${sqlNullable(finishedAt)}, ${sqlText(JSON.stringify({ source: "refresh-campaign", localFirst: true, campaignType: "RECYCLE" }))}
)
ON CONFLICT(run_id) DO UPDATE SET
  status=excluded.status,
  requested_count=MAX(campaign_runs.requested_count, excluded.requested_count),
  sent_count=MAX(campaign_runs.sent_count, excluded.sent_count),
  failed_count=MAX(campaign_runs.failed_count, excluded.failed_count),
  finished_at=COALESCE(excluded.finished_at, campaign_runs.finished_at),
  payload_json=excluded.payload_json;`];

    for (const row of rows) {
      const leadKey = `${code}:${row.phone}`;
      statements.push(`
UPDATE project_leads SET
  name=CASE WHEN name='' AND ${sqlText(row.name)}<>'' THEN ${sqlText(row.name)} ELSE name END,
  last_blast_at=CASE WHEN COALESCE(last_blast_at,'')<=${sqlText(row.sentAt)} THEN ${sqlText(row.sentAt)} ELSE last_blast_at END,
  assigned_sender_key=CASE WHEN COALESCE(last_blast_at,'')<=${sqlText(row.sentAt)} THEN COALESCE(${sqlNullable(row.senderKey)},assigned_sender_key) ELSE assigned_sender_key END,
  last_sender_key=CASE WHEN COALESCE(last_blast_at,'')<=${sqlText(row.sentAt)} THEN COALESCE(${sqlNullable(row.senderKey)},last_sender_key) ELSE last_sender_key END,
  last_sender_phone=CASE WHEN COALESCE(last_blast_at,'')<=${sqlText(row.sentAt)} AND ${sqlText(row.senderPhone)}<>'' THEN ${sqlText(row.senderPhone)} ELSE last_sender_phone END,
  last_sent_by_device=CASE WHEN COALESCE(last_blast_at,'')<=${sqlText(row.sentAt)} THEN COALESCE(${sqlNullable(checkpointDeviceKey)},last_sent_by_device) ELSE last_sent_by_device END,
  campaign_run_id=CASE WHEN COALESCE(last_blast_at,'')<=${sqlText(row.sentAt)} THEN ${sqlText(id)} ELSE campaign_run_id END,
  updated_at=${sqlText(now)}
WHERE project_lead_key=${sqlText(leadKey)};

INSERT INTO send_jobs(
  id, run_id, project_lead_key, connection_key, flow_topic, part_no, template_key,
  status, scheduled_at, sent_at, error_code, error_message, created_at, updated_at
)
SELECT ${sqlText(`${id}:${row.phone}:1`)}, ${sqlText(id)}, project_lead_key,
       ${sqlNullable(row.senderKey)}, 'Refresh - Reconnect', 1, NULL, 'SENT', NULL,
       ${sqlNullable(row.part1SentAt || row.sentAt)}, '', '', ${sqlText(now)}, ${sqlText(now)}
FROM project_leads WHERE project_lead_key=${sqlText(leadKey)}
ON CONFLICT(id) DO UPDATE SET status='SENT', sent_at=excluded.sent_at, updated_at=excluded.updated_at;`);
      if (row.part2SentAt) {
        statements.push(`
INSERT INTO send_jobs(
  id, run_id, project_lead_key, connection_key, flow_topic, part_no, template_key,
  status, scheduled_at, sent_at, error_code, error_message, created_at, updated_at
)
SELECT ${sqlText(`${id}:${row.phone}:2`)}, ${sqlText(id)}, project_lead_key,
       ${sqlNullable(row.senderKey)}, 'Refresh - Reconnect', 2, NULL, 'SENT', NULL,
       ${sqlText(row.part2SentAt)}, '', '', ${sqlText(now)}, ${sqlText(now)}
FROM project_leads WHERE project_lead_key=${sqlText(leadKey)}
ON CONFLICT(id) DO UPDATE SET status='SENT', sent_at=excluded.sent_at, updated_at=excluded.updated_at;`);
      }
    }
    if (rows.length && notionSyncJob?.idempotencyKey && notionSyncJob?.entityType && notionSyncJob?.entityId) {
      statements.push(`
INSERT INTO sync_jobs(
  idempotency_key, direction, entity_type, entity_id, status, attempt_count,
  available_at, last_error_code, last_error_message, payload_json, created_at, updated_at
) VALUES (
  ${sqlText(notionSyncJob.idempotencyKey)}, 'LOCAL_TO_NOTION', ${sqlText(notionSyncJob.entityType)},
  ${sqlText(notionSyncJob.entityId)}, 'PENDING', 0, ${sqlText(notionSyncJob.availableAt || now)}, '', '',
  ${sqlText(JSON.stringify(notionSyncJob.payload || {}))}, ${sqlText(now)}, ${sqlText(now)}
)
ON CONFLICT(idempotency_key) DO UPDATE SET
  payload_json=excluded.payload_json,
  status=CASE WHEN sync_jobs.status IN ('COMPLETED','FAILED') THEN 'PENDING' ELSE sync_jobs.status END,
  attempt_count=CASE WHEN sync_jobs.status IN ('COMPLETED','FAILED') THEN 0 ELSE sync_jobs.attempt_count END,
  available_at=CASE WHEN sync_jobs.status IN ('COMPLETED','FAILED') THEN excluded.available_at ELSE sync_jobs.available_at END,
  last_error_code=CASE WHEN sync_jobs.status IN ('COMPLETED','FAILED') THEN '' ELSE sync_jobs.last_error_code END,
  last_error_message=CASE WHEN sync_jobs.status IN ('COMPLETED','FAILED') THEN '' ELSE sync_jobs.last_error_message END,
  updated_at=excluded.updated_at;`);
    }
    statements.push("COMMIT;");
    await runProcess(binary, ["-batch", databasePath], statements.join("\n"), 120000);
    if (!rows.length) return { recorded: 0, skipped: 0, runId: id, campaignType: "RECYCLE" };
    const phoneList = rows.map((row) => sqlText(row.phone)).join(",");
    const [result] = await queryJson(binary, `
SELECT COUNT(*) AS recorded FROM project_leads
WHERE project_code=${sqlText(code)} AND phone IN (${phoneList}) AND campaign_run_id=${sqlText(id)};`);
    const recorded = Number(result?.recorded || 0);
    return {
      recorded,
      skipped: Math.max(0, rows.length - recorded),
      runId: id,
      campaignType: "RECYCLE",
    };
  }

  async function setLeadFlowState({ targets = [], nextFlow, lastFlowSent = "", cohortDay = null, followUpDue = null } = {}) {
    const normalized = (Array.isArray(targets) ? targets : []).map((target) => ({
      pageId: clean(target?.pageId).replace(/-/g, ""),
      phone: normalizePhone(target?.phone),
      projectCode: clean(target?.projectCode),
    })).filter((target) => target.pageId || (target.phone && target.projectCode));
    if (!normalized.length || !clean(nextFlow)) return { updated: 0, requested: normalized.length };
    const binary = await requireV3Database();
    const now = new Date().toISOString();
    const statements = ["BEGIN IMMEDIATE;"];
    for (const target of normalized) {
      const where = target.pageId
        ? `replace(notion_page_id,'-','')=${sqlText(target.pageId)}`
        : `project_code=${sqlText(target.projectCode)} AND phone=${sqlText(target.phone)}`;
      statements.push(`UPDATE project_leads SET
        sequence_status='Running', next_flow=${sqlText(nextFlow)},
        last_flow_sent=CASE WHEN ${sqlText(lastFlowSent)}<>'' THEN ${sqlText(lastFlowSent)} ELSE last_flow_sent END,
        cohort_day=${cohortNumber(cohortDay) === null ? "NULL" : sqlNumber(cohortNumber(cohortDay))},
        follow_up_due=${sqlNullable(followUpDue)}, updated_at=${sqlText(now)}
        WHERE ${where};`);
    }
    statements.push("COMMIT;");
    await runProcess(binary, ["-batch", databasePath], statements.join("\n"), 120000);
    const clauses = normalized.map((target) => target.pageId
      ? `replace(notion_page_id,'-','')=${sqlText(target.pageId)}`
      : `(project_code=${sqlText(target.projectCode)} AND phone=${sqlText(target.phone)})`);
    const [result] = await queryJson(binary, `SELECT COUNT(*) AS updated FROM project_leads WHERE next_flow=${sqlText(nextFlow)} AND (${clauses.join(" OR ")});`);
    return { updated: Number(result?.updated || 0), requested: normalized.length };
  }

  async function recordLeadReply({ pageId = "", phone, reply = {}, at, text = "" } = {}) {
    const normalizedPhone = normalizePhone(phone);
    const notionPageId = clean(pageId).replace(/-/g, "");
    const replyAt = Number.isFinite(new Date(at || "").getTime()) ? new Date(at).toISOString() : new Date().toISOString();
    if (!normalizedPhone) return { updated: 0, reason: "invalid_phone" };
    const binary = await requireV3Database();
    const now = new Date().toISOString();
    const summary = `[${clean(reply.signal)}] ${clean(reply.route)} · 建议:${clean(reply.suggestedReply)}`.slice(0, 1900);
    const stop = reply.stopFlag === true;
    const leadWhere = notionPageId
      ? `replace(notion_page_id,'-','')=${sqlText(notionPageId)}`
      : `phone=${sqlText(normalizedPhone)}`;
    await runProcess(binary, ["-batch", databasePath], `
BEGIN IMMEDIATE;
UPDATE contacts SET
  stop_flag=MAX(stop_flag, ${sqlBoolean(stop)}),
  stop_reason=CASE WHEN ${sqlBoolean(stop)}=1 THEN ${sqlText(`Auto: ${clean(reply.route)}`)} ELSE stop_reason END,
  stop_at=CASE WHEN ${sqlBoolean(stop)}=1 THEN COALESCE(stop_at, ${sqlText(replyAt)}) ELSE stop_at END,
  reply_count=reply_count+CASE WHEN COALESCE(last_reply_at,'')<${sqlText(replyAt)} THEN 1 ELSE 0 END,
  last_reply_text=CASE WHEN COALESCE(last_reply_at,'')<=${sqlText(replyAt)} THEN ${sqlText(text)} ELSE last_reply_text END,
  last_reply_at=CASE WHEN COALESCE(last_reply_at,'')<=${sqlText(replyAt)} THEN ${sqlText(replyAt)} ELSE last_reply_at END,
  updated_at=${sqlText(now)}
WHERE contact_key=${sqlText(normalizedPhone)};
UPDATE project_leads SET
  status=CASE WHEN ${sqlText(clean(reply.status))}<>'' THEN ${sqlText(clean(reply.status))} ELSE status END,
  sequence_status=CASE WHEN ${sqlText(clean(reply.sequenceStatus))}<>'' THEN ${sqlText(clean(reply.sequenceStatus))} ELSE sequence_status END,
  ai_category=CASE WHEN ${sqlText(clean(reply.aiCategory))}<>'' THEN ${sqlText(clean(reply.aiCategory))} ELSE ai_category END,
  ai_summary=${sqlText(summary)}, updated_at=${sqlText(now)}
WHERE ${leadWhere};
COMMIT;`, 120000);
    const [result] = await queryJson(binary, `SELECT COUNT(*) AS updated FROM project_leads WHERE ${leadWhere};`);
    return { updated: Number(result?.updated || 0), phone: normalizedPhone, at: replyAt };
  }

  async function recordConversationDisposition({
    pageId = "",
    phone = "",
    projectCode = "",
    status = "",
    sequenceStatus = "",
    aiCategory = "",
    followUpAt = null,
    stopFlag = false,
    stopReason = "",
    updatedAt = "",
  } = {}) {
    const notionPageId = clean(pageId).replace(/-/g, "");
    const normalizedPhone = normalizePhone(phone);
    const normalizedProjectCode = clean(projectCode);
    if (!notionPageId && !normalizedPhone) return { updated: 0, reason: "missing_identity" };
    const binary = await requireV3Database();
    const now = Number.isFinite(new Date(updatedAt || "").getTime())
      ? new Date(updatedAt).toISOString()
      : new Date().toISOString();
    const leadWhere = notionPageId
      ? `replace(notion_page_id,'-','')=${sqlText(notionPageId)}`
      : normalizedProjectCode
        ? `project_code=${sqlText(normalizedProjectCode)} AND phone=${sqlText(normalizedPhone)}`
        : `phone=${sqlText(normalizedPhone)}`;
    const contactWhere = notionPageId
      ? `contact_key IN (SELECT contact_key FROM project_leads WHERE replace(notion_page_id,'-','')=${sqlText(notionPageId)})`
      : `contact_key=${sqlText(normalizedPhone)}`;

    await runProcess(binary, ["-batch", databasePath], `
BEGIN IMMEDIATE;
UPDATE contacts SET
  stop_flag=MAX(stop_flag, ${sqlBoolean(stopFlag)}),
  stop_reason=CASE
    WHEN ${sqlBoolean(stopFlag)}=1 AND ${sqlText(clean(stopReason))}<>'' THEN ${sqlText(clean(stopReason))}
    ELSE stop_reason END,
  stop_at=CASE WHEN ${sqlBoolean(stopFlag)}=1 THEN COALESCE(stop_at, ${sqlText(now)}) ELSE stop_at END,
  updated_at=${sqlText(now)}
WHERE ${contactWhere};
UPDATE project_leads SET
  status=CASE WHEN ${sqlText(clean(status))}<>'' THEN ${sqlText(clean(status))} ELSE status END,
  sequence_status=CASE
    WHEN ${sqlText(clean(sequenceStatus))}<>'' THEN ${sqlText(clean(sequenceStatus))}
    ELSE sequence_status END,
  ai_category=CASE WHEN ${sqlText(clean(aiCategory))}<>'' THEN ${sqlText(clean(aiCategory))} ELSE ai_category END,
  follow_up_at=${sqlNullable(followUpAt)},
  updated_at=${sqlText(now)}
WHERE ${leadWhere};
COMMIT;`, 120000);
    const [result] = await queryJson(binary, `SELECT COUNT(*) AS updated FROM project_leads WHERE ${leadWhere};`);
    return { updated: Number(result?.updated || 0), phone: normalizedPhone, at: now };
  }

  async function setupManualLead({
    phone,
    name = "",
    leadType,
    projectCode = "",
    projectName = "",
    instanceName,
    note = "",
  } = {}) {
    const normalizedPhone = normalizePhone(phone);
    const type = clean(leadType).toUpperCase();
    const code = clean(projectCode || slugCode(projectName));
    const instance = clean(instanceName);
    if (!normalizedPhone) {
      const error = new Error("客户电话号码格式不正确。");
      error.code = "MANUAL_LEAD_PHONE_INVALID";
      throw error;
    }
    if (!["BLAST", "RECYCLE", "ADS", "OWN"].includes(type)) {
      const error = new Error("客户类型只支持 Blasting、Recycle、Ads 或 Others。");
      error.code = "MANUAL_LEAD_TYPE_INVALID";
      throw error;
    }
    if (type === "BLAST" && !code) {
      const error = new Error("Blasting Lead 必须选择 Project。");
      error.code = "MANUAL_LEAD_PROJECT_REQUIRED";
      throw error;
    }
    if (!instance) {
      const error = new Error("缺少 WhatsApp connection。");
      error.code = "MANUAL_LEAD_INSTANCE_REQUIRED";
      throw error;
    }

    const binary = await requireV3Database();
    const [connection] = await queryJson(binary, `
SELECT connection_key AS connectionKey
FROM whatsapp_connections
WHERE instance_name=${sqlText(instance)}
  AND device_key=${sqlText(clean(device?.id))}
LIMIT 1;`);
    if (!connection?.connectionKey) {
      const error = new Error("找不到这个 WhatsApp connection 的本机绑定。请到 Settings 刷新 Phone Health。");
      error.code = "MANUAL_LEAD_CONNECTION_NOT_BOUND";
      throw error;
    }

    const now = new Date().toISOString();
    const displayName = clean(name) || normalizedPhone;
    const senderKey = clean(connection.connectionKey);
    const scope = type === "BLAST" ? code : "general";
    const originKey = `${type.toLowerCase()}:${scope}:${normalizedPhone}`;
    const payload = JSON.stringify({
      source: "manual_chat",
      note: clean(note),
      assignedSenderKey: senderKey,
      instanceName: instance,
    });
    const statements = [
      "PRAGMA foreign_keys = ON;",
      "BEGIN IMMEDIATE;",
      `INSERT INTO contacts(
        contact_key, phone, display_name, stop_flag, stop_reason, stop_at, reply_count,
        last_reply_text, last_reply_at, created_at, updated_at
      ) VALUES (
        ${sqlText(normalizedPhone)}, ${sqlText(normalizedPhone)}, ${sqlText(displayName)},
        0, '', NULL, 0, '', NULL, ${sqlText(now)}, ${sqlText(now)}
      )
      ON CONFLICT(contact_key) DO UPDATE SET
        display_name=CASE WHEN ${sqlText(clean(name))}<>'' THEN ${sqlText(clean(name))} ELSE contacts.display_name END,
        updated_at=${sqlText(now)};`,
    ];

    if (type === "BLAST") {
      statements.push(
        `INSERT INTO projects(project_code, project_name, aliases_json, active, created_at, updated_at)
         VALUES (${sqlText(code)}, ${sqlText(clean(projectName) || code)}, '[]', 1, ${sqlText(now)}, ${sqlText(now)})
         ON CONFLICT(project_code) DO UPDATE SET
           project_name=CASE WHEN excluded.project_name<>'' THEN excluded.project_name ELSE projects.project_name END,
           active=1, updated_at=excluded.updated_at;`,
        `INSERT INTO project_leads(
          project_lead_key, notion_page_id, contact_key, project_code, phone, name,
          sequence_status, status, last_flow_sent, next_flow, cohort_day, follow_up_due,
          first_blast_at, last_blast_at, assigned_sender_key, last_sender_key,
          last_sender_phone, last_sent_by_device, campaign_run_id,
          ai_category, ai_summary, priority, follow_up_at, assigned_sales, sales_notes,
          appointment_date, appointment_time, appointment_place, appointment_status,
          payload_json, source_updated_at, created_at, updated_at
        ) VALUES (
          ${sqlText(`${code}:${normalizedPhone}`)}, NULL, ${sqlText(normalizedPhone)}, ${sqlText(code)},
          ${sqlText(normalizedPhone)}, ${sqlText(displayName)}, 'Human Takeover', 'Warm', '', '', NULL, NULL,
          NULL, NULL, ${sqlText(senderKey)}, NULL, '', NULL, NULL, 'Warm', '', 'MED', ${sqlText(now)}, '', ${sqlText(clean(note))},
          NULL, '', '', '', ${sqlText(payload)}, NULL, ${sqlText(now)}, ${sqlText(now)}
        )
        ON CONFLICT(project_lead_key) DO UPDATE SET
          name=CASE WHEN ${sqlText(clean(name))}<>'' THEN ${sqlText(clean(name))} ELSE project_leads.name END,
          assigned_sender_key=COALESCE(project_leads.assigned_sender_key, excluded.assigned_sender_key),
          sales_notes=CASE WHEN ${sqlText(clean(note))}<>'' THEN ${sqlText(clean(note))} ELSE project_leads.sales_notes END,
          follow_up_at=COALESCE(project_leads.follow_up_at, excluded.follow_up_at),
          updated_at=excluded.updated_at;`,
      );
    } else if (type === "ADS") {
      statements.push(`INSERT INTO ads_leads(
        ad_lead_key, notion_page_id, contact_key, phone, name, source_code,
        lead_received_at, last_touch_at, payload_json, created_at, updated_at
      ) VALUES (
        ${sqlText(`ads:${normalizedPhone}`)}, NULL, ${sqlText(normalizedPhone)}, ${sqlText(normalizedPhone)},
        ${sqlText(displayName)}, 'manual_chat', ${sqlText(now)}, ${sqlText(now)}, ${sqlText(payload)},
        ${sqlText(now)}, ${sqlText(now)}
      )
      ON CONFLICT(ad_lead_key) DO UPDATE SET
        name=CASE WHEN ${sqlText(clean(name))}<>'' THEN ${sqlText(clean(name))} ELSE ads_leads.name END,
        last_touch_at=excluded.last_touch_at, payload_json=excluded.payload_json, updated_at=excluded.updated_at;`);
    } else if (type === "RECYCLE") {
      statements.push(`INSERT INTO recycle_leads(
        recycle_lead_key, notion_page_id, contact_key, phone, name, source_batch,
        payload_json, created_at, updated_at
      ) VALUES (
        ${sqlText(`recycle:${normalizedPhone}`)}, NULL, ${sqlText(normalizedPhone)}, ${sqlText(normalizedPhone)},
        ${sqlText(displayName)}, 'manual_chat', ${sqlText(payload)}, ${sqlText(now)}, ${sqlText(now)}
      )
      ON CONFLICT(recycle_lead_key) DO UPDATE SET
        name=CASE WHEN ${sqlText(clean(name))}<>'' THEN ${sqlText(clean(name))} ELSE recycle_leads.name END,
        payload_json=excluded.payload_json, updated_at=excluded.updated_at;`);
    } else {
      statements.push(`INSERT INTO own_leads(
        own_lead_key, contact_key, phone, name, assigned_sender_key, note, created_at, updated_at
      ) VALUES (
        ${sqlText(`own:${clean(device?.id)}:${normalizedPhone}`)}, ${sqlText(normalizedPhone)},
        ${sqlText(normalizedPhone)}, ${sqlText(displayName)}, ${sqlText(senderKey)}, ${sqlText(clean(note))},
        ${sqlText(now)}, ${sqlText(now)}
      )
      ON CONFLICT(own_lead_key) DO UPDATE SET
        name=CASE WHEN ${sqlText(clean(name))}<>'' THEN ${sqlText(clean(name))} ELSE own_leads.name END,
        assigned_sender_key=excluded.assigned_sender_key, note=excluded.note, updated_at=excluded.updated_at;`);
    }

    statements.push(
      `INSERT INTO lead_origins(
        origin_key, contact_key, lead_type, project_code, assigned_sender_key,
        notion_page_id, notion_sync_status, notion_sync_error, note, created_at, updated_at
      ) VALUES (
        ${sqlText(originKey)}, ${sqlText(normalizedPhone)}, ${sqlText(type)}, ${sqlText(type === "BLAST" ? code : "")},
        ${sqlText(senderKey)}, NULL, ${sqlText(type === "OWN" ? "LOCAL_ONLY" : "PENDING")}, '',
        ${sqlText(clean(note))}, ${sqlText(now)}, ${sqlText(now)}
      )
      ON CONFLICT(origin_key) DO UPDATE SET
        assigned_sender_key=excluded.assigned_sender_key,
        notion_sync_status=CASE WHEN excluded.lead_type='OWN' THEN 'LOCAL_ONLY' ELSE 'PENDING' END,
        notion_sync_error='', note=excluded.note, updated_at=excluded.updated_at;`,
      "COMMIT;",
    );
    await runProcess(binary, ["-batch", databasePath], statements.join("\n"), 120000);
    return {
      originKey,
      phone: normalizedPhone,
      name: displayName,
      leadType: type,
      projectCode: type === "BLAST" ? code : "",
      projectName: type === "BLAST" ? clean(projectName) : "",
      instanceName: instance,
      assignedSenderKey: senderKey,
      notionSyncStatus: type === "OWN" ? "LOCAL_ONLY" : "PENDING",
      createdAt: now,
    };
  }

  async function markManualLeadNotionSync({ originKey, status, notionPageId = "", error = "" } = {}) {
    const key = clean(originKey);
    const normalizedStatus = clean(status).toUpperCase();
    if (!key || !["PENDING", "SYNCED", "FAILED"].includes(normalizedStatus)) {
      throw new Error("Manual lead Notion sync update is invalid.");
    }
    const binary = await requireV3Database();
    const now = new Date().toISOString();
    await runProcess(binary, ["-batch", databasePath], `
BEGIN IMMEDIATE;
UPDATE lead_origins SET
  notion_page_id=CASE WHEN ${sqlText(clean(notionPageId))}<>'' THEN ${sqlText(clean(notionPageId))} ELSE notion_page_id END,
  notion_sync_status=${sqlText(normalizedStatus)},
  notion_sync_error=${sqlText(clean(error).slice(0, 1000))},
  updated_at=${sqlText(now)}
WHERE origin_key=${sqlText(key)};
COMMIT;`, 60000);
    return { originKey: key, status: normalizedStatus, notionPageId: clean(notionPageId), updatedAt: now };
  }

  async function recordPermissionEvent({
    phone,
    category = "PROPERTY_MARKETING",
    action = "GRANTED",
    sourceType,
    sourceReference = "",
    evidence = {},
    occurredAt = null,
    expiresAt = null,
    recordedBy = "operator",
  } = {}) {
    const contactKey = normalizePhone(phone);
    const normalizedCategory = clean(category).toUpperCase();
    const normalizedAction = clean(action).toUpperCase();
    const normalizedSource = clean(sourceType).toUpperCase();
    if (!contactKey) {
      const error = new Error("Consent 电话号码格式不正确。");
      error.code = "CONSENT_PHONE_INVALID";
      throw error;
    }
    if (!/^[A-Z][A-Z0-9_]{2,60}$/.test(normalizedCategory)) {
      const error = new Error("Consent category 格式不正确。");
      error.code = "CONSENT_CATEGORY_INVALID";
      throw error;
    }
    if (!new Set(["GRANTED", "REVOKED"]).has(normalizedAction)) {
      const error = new Error("Consent action 只支持 GRANTED 或 REVOKED。");
      error.code = "CONSENT_ACTION_INVALID";
      throw error;
    }
    if (!/^[A-Z][A-Z0-9_]{2,60}$/.test(normalizedSource)) {
      const error = new Error("必须记录客户同意来源，例如 FACEBOOK_AD、WEB_FORM 或 PHONE_CALL。");
      error.code = "CONSENT_SOURCE_REQUIRED";
      throw error;
    }
    const occurred = new Date(occurredAt || Date.now());
    const expiry = expiresAt ? new Date(expiresAt) : null;
    if (!Number.isFinite(occurred.getTime()) || (expiry && !Number.isFinite(expiry.getTime()))) {
      const error = new Error("Consent 时间格式不正确。");
      error.code = "CONSENT_TIME_INVALID";
      throw error;
    }
    const binary = await requireV3Database();
    const recordedAt = new Date().toISOString();
    const eventId = `permission_${crypto.randomUUID()}`;
    const evidenceJson = JSON.stringify(evidence && typeof evidence === "object" ? evidence : {});
    await runProcess(binary, ["-batch", databasePath], `
BEGIN IMMEDIATE;
INSERT INTO contacts(
  contact_key, phone, display_name, stop_flag, stop_reason, stop_at, reply_count,
  last_reply_text, last_reply_at, created_at, updated_at
) VALUES (
  ${sqlText(contactKey)}, ${sqlText(contactKey)}, ${sqlText(contactKey)}, 0, '', NULL, 0, '', NULL,
  ${sqlText(recordedAt)}, ${sqlText(recordedAt)}
)
ON CONFLICT(contact_key) DO UPDATE SET updated_at=excluded.updated_at;
INSERT INTO contact_permission_events(
  event_id, contact_key, category, action, source_type, source_reference,
  evidence_json, occurred_at, expires_at, recorded_by, recorded_at
) VALUES (
  ${sqlText(eventId)}, ${sqlText(contactKey)}, ${sqlText(normalizedCategory)}, ${sqlText(normalizedAction)},
  ${sqlText(normalizedSource)}, ${sqlText(clean(sourceReference).slice(0, 500))},
  ${sqlText(evidenceJson)}, ${sqlText(occurred.toISOString())}, ${sqlNullable(expiry?.toISOString())},
  ${sqlText(clean(recordedBy).slice(0, 120))}, ${sqlText(recordedAt)}
);
COMMIT;`, 60000);
    return {
      eventId,
      phone: contactKey,
      category: normalizedCategory,
      action: normalizedAction,
      sourceType: normalizedSource,
      sourceReference: clean(sourceReference).slice(0, 500),
      occurredAt: occurred.toISOString(),
      expiresAt: expiry?.toISOString() || null,
      recordedBy: clean(recordedBy).slice(0, 120),
      recordedAt,
    };
  }

  async function permissionEventsForPhones(phones = [], { category = "" } = {}) {
    const keys = [...new Set((phones || []).map(normalizePhone).filter(Boolean))];
    if (!keys.length) return new Map();
    const binary = await requireV3Database();
    const conditions = [`contact_key IN (${keys.map(sqlText).join(",")})`];
    const normalizedCategory = clean(category).toUpperCase();
    if (normalizedCategory) conditions.push(`category=${sqlText(normalizedCategory)}`);
    const rows = await queryJson(binary, `
SELECT event_id AS eventId, contact_key AS phone, category, action,
       source_type AS sourceType, source_reference AS sourceReference,
       evidence_json AS evidenceJson, occurred_at AS occurredAt, expires_at AS expiresAt,
       recorded_by AS recordedBy, recorded_at AS recordedAt
FROM contact_permission_events
WHERE ${conditions.join(" AND ")}
ORDER BY occurred_at DESC, recorded_at DESC;`);
    const byPhone = new Map(keys.map((phone) => [phone, []]));
    for (const row of rows) {
      try { row.evidence = JSON.parse(row.evidenceJson || "{}"); } catch { row.evidence = {}; }
      delete row.evidenceJson;
      byPhone.get(row.phone)?.push(row);
    }
    return byPhone;
  }

  async function senderSafetyStates(instanceNames = []) {
    const names = [...new Set((instanceNames || []).map(clean).filter(Boolean))];
    const binary = await requireV3Database();
    const where = names.length ? `WHERE instance_name IN (${names.map(sqlText).join(",")})` : "";
    const rows = await queryJson(binary, `
SELECT instance_name AS instanceName, state, reason_code AS reasonCode, reason,
       metrics_json AS metricsJson, paused_at AS pausedAt, resumed_at AS resumedAt, updated_at AS updatedAt
FROM sender_safety_state ${where}
ORDER BY instance_name;`);
    return new Map(rows.map((row) => {
      try { row.metrics = JSON.parse(row.metricsJson || "{}"); } catch { row.metrics = {}; }
      delete row.metricsJson;
      return [row.instanceName, row];
    }));
  }

  async function setSenderSafetyState({ instanceName, state, reasonCode = "", reason = "", metrics = {} } = {}) {
    const instance = clean(instanceName);
    const normalizedState = clean(state).toUpperCase();
    if (!instance || !new Set(["HEALTHY", "WARNING", "PAUSED"]).has(normalizedState)) {
      const error = new Error("Sender safety state 格式不正确。");
      error.code = "SENDER_SAFETY_STATE_INVALID";
      throw error;
    }
    const binary = await requireV3Database();
    const now = new Date().toISOString();
    await runProcess(binary, ["-batch", databasePath], `
INSERT INTO sender_safety_state(
  instance_name, state, reason_code, reason, metrics_json, paused_at, resumed_at, updated_at
) VALUES (
  ${sqlText(instance)}, ${sqlText(normalizedState)}, ${sqlText(clean(reasonCode).slice(0, 120))},
  ${sqlText(clean(reason).slice(0, 1000))}, ${sqlText(JSON.stringify(metrics || {}))},
  ${normalizedState === "PAUSED" ? sqlText(now) : "NULL"},
  ${normalizedState === "HEALTHY" ? sqlText(now) : "NULL"}, ${sqlText(now)}
)
ON CONFLICT(instance_name) DO UPDATE SET
  state=excluded.state, reason_code=excluded.reason_code, reason=excluded.reason,
  metrics_json=excluded.metrics_json,
  paused_at=CASE WHEN excluded.state='PAUSED' THEN COALESCE(sender_safety_state.paused_at, excluded.paused_at) ELSE sender_safety_state.paused_at END,
  resumed_at=CASE WHEN excluded.state='HEALTHY' THEN excluded.resumed_at ELSE sender_safety_state.resumed_at END,
  updated_at=excluded.updated_at;`, 60000);
    return (await senderSafetyStates([instance])).get(instance);
  }

  async function recordCampaignSafetyChecks(checks = []) {
    const rows = (Array.isArray(checks) ? checks : []).filter((item) => clean(item?.checkId));
    if (!rows.length) return { recorded: 0 };
    const binary = await requireV3Database();
    const statements = ["BEGIN IMMEDIATE;"];
    for (const item of rows) {
      statements.push(`INSERT INTO campaign_safety_checks(
        check_id, scope_id, contact_key, instance_name, check_type, outcome, code, details_json, checked_at
      ) VALUES (
        ${sqlText(clean(item.checkId))}, ${sqlText(clean(item.scopeId))}, ${sqlText(normalizePhone(item.phone))},
        ${sqlText(clean(item.instanceName))}, ${sqlText(clean(item.checkType))}, ${sqlText(clean(item.outcome).toUpperCase())},
        ${sqlText(clean(item.code))}, ${sqlText(JSON.stringify(item.details || {}))},
        ${sqlText(item.checkedAt || new Date().toISOString())}
      ) ON CONFLICT(check_id) DO UPDATE SET
        outcome=excluded.outcome, code=excluded.code, details_json=excluded.details_json, checked_at=excluded.checked_at;`);
    }
    statements.push("COMMIT;");
    await runProcess(binary, ["-batch", databasePath], statements.join("\n"), 60000);
    return { recorded: rows.length };
  }

  async function campaignSafetyCounts() {
    const binary = await requireV3Database();
    const [row] = await queryJson(binary, `
SELECT
  (SELECT COUNT(*) FROM contact_permission_events) AS permissionEvents,
  (SELECT COUNT(DISTINCT contact_key) FROM contact_permission_events) AS permissionContacts,
  (SELECT COUNT(*) FROM sender_safety_state WHERE state='PAUSED') AS pausedSenders,
  (SELECT COUNT(*) FROM campaign_safety_checks WHERE outcome='BLOCK') AS blockedChecks;`);
    return {
      permissionEvents: Number(row?.permissionEvents || 0),
      permissionContacts: Number(row?.permissionContacts || 0),
      pausedSenders: Number(row?.pausedSenders || 0),
      blockedChecks: Number(row?.blockedChecks || 0),
    };
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
      const [patch] = await queryJson(detected.binary, `
SELECT version FROM schema_migrations WHERE version=${sqlNumber(RUNTIME_SCHEMA_PATCH_VERSION)} LIMIT 1;`);
      const runtimeTables = Object.keys(RUNTIME_REQUIRED_COLUMNS);
      const existingTables = new Set((await queryJson(detected.binary, `
SELECT name FROM sqlite_master
WHERE type='table' AND name IN (${runtimeTables.map(sqlText).join(",")});`)).map((row) => row.name));
      if (!patch || runtimeTables.some((table) => !existingTables.has(table))) {
        const error = new Error(
          "SQLite v3 尚未完成 Runtime Schema Migration。请在没有 LIVE Campaign 时先运行："
          + "node scripts/maintenance/migrate-v3-runtime-schema.mjs --dry-run",
        );
        error.code = "SQLITE_V3_RUNTIME_MIGRATION_REQUIRED";
        throw error;
      }
      for (const [table, requiredColumns] of Object.entries(RUNTIME_REQUIRED_COLUMNS)) {
        const columns = new Set(
          (await queryJson(detected.binary, `PRAGMA table_info(${table});`)).map((row) => row.name),
        );
        const missing = requiredColumns.filter((column) => !columns.has(column));
        if (missing.length) {
          const error = new Error(
            `SQLite v3 Runtime Schema 不完整：${table} 缺少 ${missing.join(", ")}。`
            + " 请先运行 maintenance migration dry-run。",
          );
          error.code = "SQLITE_V3_RUNTIME_SCHEMA_INCOMPLETE";
          throw error;
        }
      }
    } else {
      let schema;
      try {
        schema = await fs.readFile(schemaPath, "utf8");
      } catch (error) {
        const wrapped = new Error(`找不到或无法读取 SQLite v3 schema：${schemaPath} (${error.message})`);
        wrapped.code = "SQLITE_V3_SCHEMA_MISSING";
        throw wrapped;
      }
      // Only a brand-new database may execute the full CREATE schema. Existing
      // production databases must pass an explicit, backed-up migration first.
      await runProcess(detected.binary, ["-batch", databasePath], schema, 60000);
    }

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
    syncWhatsAppConnections,
    recordCampaignFlowProgress,
    recordRefreshCampaignProgress,
    setLeadFlowState,
    recordLeadReply,
    recordConversationDisposition,
    setupManualLead,
    markManualLeadNotionSync,
    recordPermissionEvent,
    permissionEventsForPhones,
    senderSafetyStates,
    setSenderSafetyState,
    recordCampaignSafetyChecks,
    campaignSafetyCounts,
    listLeadGroups,
    readLeadGroup,
    createLeadGroup,
    renameLeadGroup,
    updateLeadGroupMembers,
    setStorageMode,
    isPrimary,
  };
}
