import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { clean, sqlText } from "./sqlite-maintenance.mjs";

// 所有 rebuild 工具共用同一套只读检查，避免 audit、repair、verify 三个脚本
// 各自写一份定义不同的“重复”或“孤儿”，导致 cutover 验收对不上。

export const REBUILD_MIGRATIONS = Object.freeze([
  { version: 304, name: "sqlite-notion-sync", file: "304-sqlite-notion-sync.sql" },
  { version: 305, name: "stable-customer-identity", file: "305-customer-identity.sql" },
  { version: 306, name: "send-eligibility", file: "306-send-eligibility.sql" },
  { version: 307, name: "sales-stage-followup", file: "307-sales-stage-followup.sql" },
  { version: 308, name: "campaign-model", file: "308-campaign-model.sql" },
  { version: 309, name: "dashboard-ai-auditor", file: "309-dashboard-ai-auditor.sql" },
  { version: 310, name: "ai-change-tracking", file: "310-ai-change-tracking.sql" },
]);

// 业务来源比 Evolution history 的 `phone` 标签更权威：blast/manual 携带 Campaign
// 与人工发送证据，history 只是事后补回来的 provider 记录。
const SOURCE_AUTHORITY = Object.freeze({ blast: 3, manual: 2, evolution: 1, phone: 0 });

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/**
 * connection_key 是 `device::我们自己的发送号码`。报告要能让人定位到具体 sender，
 * 但不该把完整号码写进会被复制、贴到 Notion 或转发的文件里，所以只保留末 4 位。
 */
export function maskConnectionKey(value) {
  const raw = String(value ?? "");
  if (!raw) return "(none)";
  const [device = "", number = ""] = raw.split("::");
  const shortDevice = device.length > 14 ? `${device.slice(0, 14)}…` : device;
  return number ? `${shortDevice}::…${number.slice(-4)}` : shortDevice;
}

export function sqliteJson(binary, databasePath, sql, { readOnly = true } = {}) {
  const output = execFileSync(binary, [
    ...(readOnly ? ["-readonly"] : []),
    "-batch",
    "-json",
    databasePath,
    sql,
  ], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return clean(output) ? JSON.parse(output) : [];
}

/**
 * SQL 走 stdin：schema 文件以 `--` 注释开头，作为 argv 传会被 sqlite3 当成选项。
 * `-bail` 是必需的——batch 模式下 sqlite3 遇错会继续执行剩下的语句并以 0 退出，
 * migration 失败就会被静默吞掉。
 */
export function sqliteExec(binary, databasePath, sql) {
  return execFileSync(binary, ["-batch", "-bail", databasePath], {
    input: sql,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

export function assertToolPrerequisites(binary, databasePath) {
  if (!fs.existsSync(binary)) throw new Error(`找不到 sqlite3：${binary}`);
  if (!fs.existsSync(databasePath)) throw new Error(`找不到数据库：${databasePath}`);
}

export function tableNames(binary, databasePath) {
  return new Set(sqliteJson(binary, databasePath, "SELECT name FROM sqlite_master WHERE type='table';").map((row) => row.name));
}

export function columnNames(binary, databasePath, table) {
  return new Set(sqliteJson(binary, databasePath, `PRAGMA table_info(${table});`).map((row) => row.name));
}

export function appliedMigrations(binary, databasePath) {
  return sqliteJson(binary, databasePath, "SELECT version,name,checksum,applied_at AS appliedAt FROM schema_migrations ORDER BY version;")
    .map((row) => ({ ...row, version: Number(row.version) }));
}

export function migrationFileChecksums(rootDir) {
  const dir = path.join(rootDir, "campaign-app", "migrations");
  return REBUILD_MIGRATIONS.map((migration) => {
    const filePath = path.join(dir, migration.file);
    const exists = fs.existsSync(filePath);
    return {
      ...migration,
      path: path.relative(rootDir, filePath),
      exists,
      checksum: exists ? sha256(fs.readFileSync(filePath, "utf8")) : null,
    };
  });
}

/**
 * Message identity 是 connection-scoped：同一个 provider message ID 出现在不同 sender
 * 上可以是两条真实消息，所以永远以 (connection_key, external_message_id) 分组。
 */
export function duplicateMessageGroups(binary, databasePath) {
  return sqliteJson(binary, databasePath, `
WITH duplicated AS (
  SELECT connection_key, external_message_id
  FROM messages
  WHERE connection_key IS NOT NULL AND connection_key <> ''
    AND external_message_id IS NOT NULL AND external_message_id <> ''
  GROUP BY connection_key, external_message_id
  HAVING COUNT(*) > 1
)
SELECT
  m.connection_key AS connectionKey,
  m.external_message_id AS externalMessageId,
  COUNT(*) AS rowCount,
  COUNT(DISTINCT m.direction) AS directionVariants,
  COUNT(DISTINCT m.conversation_id) AS conversationVariants,
  COUNT(DISTINCT m.text) AS textVariants,
  COUNT(DISTINCT m.message_type) AS messageTypeVariants,
  SUM(CASE WHEN m.message_type = 'text' THEN 1 ELSE 0 END) AS textTypeRows,
  COUNT(DISTINCT CASE WHEN m.message_type <> 'text' THEN m.message_type END) AS nonTextTypeVariants,
  MAX(CASE WHEN m.message_type <> 'text' THEN m.message_type END) AS nonTextType,
  MIN(m.message_type) AS messageType,
  MIN(m.direction) AS direction,
  (SELECT group_concat(source, '+') FROM (
     SELECT DISTINCT source FROM messages inner_message
     WHERE inner_message.connection_key = m.connection_key
       AND inner_message.external_message_id = m.external_message_id
     ORDER BY source)) AS sourcePair,
  MIN(m.sent_at) AS earliestSentAt,
  MAX(m.sent_at) AS latestSentAt
FROM messages m
JOIN duplicated d
  ON d.connection_key = m.connection_key
 AND d.external_message_id = m.external_message_id
GROUP BY m.connection_key, m.external_message_id
ORDER BY m.connection_key, m.external_message_id;`);
}

// 未渲染的模板变量，例如 [Phone_Number]、[reply]。
const PLACEHOLDER_TOKEN = /\[[A-Za-z][A-Za-z0-9_ ]*\]/g;

function hasPlaceholder(text) {
  return new RegExp(PLACEHOLDER_TOKEN.source).test(String(text ?? ""));
}

function isPlaceholderOnly(text) {
  return /^\[[A-Za-z][A-Za-z0-9_ ]*\]$/.test(String(text ?? "").trim());
}

/**
 * 模板骨架必须在另一版里按顺序原样出现，才能认定它们是同一条消息的两种记录。
 * 只要有一段对不上，就说明内容真的不同，不允许自动挑一边。
 */
function templateMatchesRendered(template, rendered) {
  const segments = String(template).split(new RegExp(PLACEHOLDER_TOKEN.source)).filter(Boolean);
  if (!segments.length) return false;
  let cursor = 0;
  for (const segment of segments) {
    const found = rendered.indexOf(segment, cursor);
    if (found < 0) return false;
    cursor = found + segment.length;
  }
  return true;
}

/**
 * 文字不一致时，只在两种「一边是占位符」的情况下可以自动判定，因为两边都不是
 * 无条件权威：
 *
 * 1. `PLACEHOLDER_ONLY_TEXT` — 一边整条就是 `[reply]` 之类的占位符，等于没记内容。
 * 2. `UNRENDERED_TEMPLATE_TEXT` — 一边是变量替换前的模板（含 `[Phone_Number]`），
 *    另一边是客户实际收到的渲染结果。
 *
 * 第 2 种和「业务来源优先」方向相反：模板通常在 `blast` 行，渲染结果在 history 行。
 * 正文要取客户真正收到的那一版，Campaign 元数据仍然取 canonical row。
 * 其余任何文字差异一律留给人工。
 */
export function resolveTextMismatch(texts) {
  const distinct = [...new Set(texts.map((text) => String(text ?? "")))];
  if (distinct.length !== 2) return null;

  const placeholderOnly = distinct.filter(isPlaceholderOnly);
  if (placeholderOnly.length === 1) {
    const resolved = distinct.find((text) => text !== placeholderOnly[0]);
    if (!isPlaceholderOnly(resolved)) return { text: resolved, rule: "PLACEHOLDER_ONLY_TEXT" };
  }

  const withPlaceholder = distinct.filter(hasPlaceholder);
  const withoutPlaceholder = distinct.filter((text) => !hasPlaceholder(text));
  if (withPlaceholder.length === 1 && withoutPlaceholder.length === 1
    && templateMatchesRendered(withPlaceholder[0], withoutPlaceholder[0])) {
    return { text: withoutPlaceholder[0], rule: "UNRENDERED_TEMPLATE_TEXT" };
  }
  return null;
}

/**
 * 取出文字不一致的 group 的原始文字。只有这类 group 才需要读正文，
 * 数量很少；正文只用于判定，不进入任何报告。
 */
export function textMismatchGroupTexts(binary, databasePath) {
  const rows = sqliteJson(binary, databasePath, `
WITH mismatched AS (
  SELECT connection_key, external_message_id
  FROM messages
  WHERE connection_key IS NOT NULL AND connection_key <> ''
    AND external_message_id IS NOT NULL AND external_message_id <> ''
  GROUP BY connection_key, external_message_id
  HAVING COUNT(*) > 1 AND COUNT(DISTINCT text) > 1
)
SELECT m.connection_key AS connectionKey, m.external_message_id AS externalMessageId, m.text
FROM messages m
JOIN mismatched d
  ON d.connection_key = m.connection_key
 AND d.external_message_id = m.external_message_id;`);
  const grouped = new Map();
  for (const row of rows) {
    const key = `${row.connectionKey} ${row.externalMessageId}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row.text);
  }
  return grouped;
}

/**
 * 只有内容、方向、会话一致的 group 才允许自动合并；其余进入 conflict 等人工判断，
 * display name 或 last-write-wins 都不能当作证据。
 *
 * message_type 是唯一的例外。早期 ingest 在媒体尚未解析时会把消息记成 `text`，
 * 之后 Evolution history 补回同一条消息时才带上真实类型与 mediaKind／mime 证据。
 * 因此「恰好一条 text ＋ 恰好一种非 text 类型」是可判定的证据升级，不是冲突；
 * 出现两种以上非 text 类型才代表真的对不上。
 */
export function classifyDuplicateGroup(group, resolvedText = null) {
  const conflicts = [];
  const upgrades = [];
  if (Number(group.directionVariants) > 1) conflicts.push("DIRECTION_MISMATCH");
  if (Number(group.conversationVariants) > 1) conflicts.push("CONVERSATION_MISMATCH");
  if (Number(group.textVariants) > 1) {
    if (resolvedText) upgrades.push(resolvedText.rule);
    else conflicts.push("TEXT_MISMATCH");
  }
  if (Number(group.messageTypeVariants) > 1) {
    if (Number(group.textTypeRows) === 1 && Number(group.nonTextTypeVariants) === 1) {
      upgrades.push("MEDIA_TYPE_UPGRADE");
    } else {
      conflicts.push("MESSAGE_TYPE_CONFLICT");
    }
  }
  return {
    connectionKey: group.connectionKey,
    externalMessageId: group.externalMessageId,
    rowCount: Number(group.rowCount),
    direction: group.direction,
    sourcePair: group.sourcePair,
    resolvedMessageType: group.nonTextType || group.messageType,
    secondsApart: secondsBetween(group.earliestSentAt, group.latestSentAt),
    conflicts,
    upgrades,
    autoMergeable: conflicts.length === 0,
  };
}

/**
 * audit 与 repair 必须得到完全一致的分类，否则审计说「可以自动合并」而 repair
 * 说「需要人工」，cutover 验收就永远对不上。两边都只走这一个入口。
 */
export function classifyAllDuplicateGroups(binary, databasePath) {
  const texts = textMismatchGroupTexts(binary, databasePath);
  return duplicateMessageGroups(binary, databasePath).map((group) => {
    const key = `${group.connectionKey} ${group.externalMessageId}`;
    const resolved = texts.has(key) ? resolveTextMismatch(texts.get(key)) : null;
    return { ...classifyDuplicateGroup(group, resolved), resolvedText: resolved?.text ?? null };
  });
}

function secondsBetween(from, to) {
  const start = Date.parse(from || "");
  const end = Date.parse(to || "");
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.round(Math.abs(end - start) / 1000);
}

export function summariseDuplicateClasses(classified) {
  const buckets = new Map();
  for (const group of classified) {
    const key = `${group.direction}|${group.sourcePair}`;
    const bucket = buckets.get(key) || {
      direction: group.direction,
      sourcePair: group.sourcePair,
      groups: 0,
      extraRows: 0,
      autoMergeable: 0,
      conflicted: 0,
      conflictCodes: {},
      upgradeCodes: {},
    };
    bucket.groups += 1;
    bucket.extraRows += group.rowCount - 1;
    if (group.autoMergeable) bucket.autoMergeable += 1;
    else bucket.conflicted += 1;
    for (const code of group.conflicts) bucket.conflictCodes[code] = (bucket.conflictCodes[code] || 0) + 1;
    for (const code of group.upgrades) bucket.upgradeCodes[code] = (bucket.upgradeCodes[code] || 0) + 1;
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort((left, right) => right.groups - left.groups);
}

/**
 * canonical row = 业务来源最高、其次 provider 时间最早、最后 row_id 最小。
 * 排序必须完全确定，否则同一次 repair 重跑会选到不同 canonical row。
 */
export function pickCanonicalRow(rows) {
  return [...rows].sort((left, right) => {
    const authority = (SOURCE_AUTHORITY[right.source] ?? 0) - (SOURCE_AUTHORITY[left.source] ?? 0);
    if (authority !== 0) return authority;
    const leftSent = Date.parse(left.sentAt || "") || Number.MAX_SAFE_INTEGER;
    const rightSent = Date.parse(right.sentAt || "") || Number.MAX_SAFE_INTEGER;
    if (leftSent !== rightSent) return leftSent - rightSent;
    return Number(left.rowId) - Number(right.rowId);
  })[0];
}

export function orphanCounts(binary, databasePath) {
  const [row] = sqliteJson(binary, databasePath, `
SELECT
  (SELECT COUNT(*) FROM messages m LEFT JOIN conversations c ON c.id = m.conversation_id WHERE c.id IS NULL) AS messagesWithoutConversation,
  (SELECT COUNT(*) FROM messages m WHERE m.connection_key IS NOT NULL AND m.connection_key <> ''
     AND NOT EXISTS (SELECT 1 FROM whatsapp_connections w WHERE w.connection_key = m.connection_key)) AS messagesWithUnknownConnection,
  (SELECT COUNT(*) FROM messages WHERE external_message_id IS NULL OR external_message_id = '') AS messagesWithoutExternalId,
  (SELECT COUNT(*) FROM messages WHERE connection_key IS NULL OR connection_key = '') AS messagesWithoutConnection,
  (SELECT COUNT(*) FROM conversations c LEFT JOIN contacts ct ON ct.contact_key = c.contact_key WHERE ct.contact_key IS NULL) AS conversationsWithoutContact,
  (SELECT COUNT(*) FROM conversations c WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)) AS conversationsWithoutMessages,
  (SELECT COUNT(*) FROM project_leads l LEFT JOIN contacts ct ON ct.contact_key = l.contact_key WHERE ct.contact_key IS NULL) AS leadsWithoutContact,
  (SELECT COUNT(*) FROM project_leads l LEFT JOIN projects p ON p.project_code = l.project_code WHERE p.project_code IS NULL) AS leadsWithoutProject,
  (SELECT COUNT(*) FROM send_jobs j LEFT JOIN campaign_runs r ON r.run_id = j.run_id WHERE r.run_id IS NULL) AS sendJobsWithoutRun,
  (SELECT COUNT(*) FROM send_jobs j LEFT JOIN project_leads l ON l.project_lead_key = j.project_lead_key WHERE l.project_lead_key IS NULL) AS sendJobsWithoutLead,
  (SELECT COUNT(*) FROM contacts ct WHERE NOT EXISTS (SELECT 1 FROM project_leads l WHERE l.contact_key = ct.contact_key)
     AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.contact_key = ct.contact_key)) AS contactsWithoutLeadOrConversation;`);
  return row || {};
}

/**
 * Identity 冲突用来判断 migration 305 能不能安全回填 customer_id。
 * 这里只统计数量，不输出电话号码或姓名。
 */
export function identityConflictCounts(binary, databasePath) {
  const [row] = sqliteJson(binary, databasePath, `
SELECT
  (SELECT COUNT(*) FROM (SELECT phone FROM lid_map GROUP BY phone HAVING COUNT(DISTINCT lid) > 1)) AS phonesWithMultipleLids,
  (SELECT COUNT(*) FROM lid_map WHERE phone NOT IN (SELECT contact_key FROM contacts)) AS lidsWithoutContact,
  (SELECT COUNT(*) FROM lid_map WHERE confidence < 80) AS lowConfidenceLids,
  (SELECT COUNT(*) FROM project_leads l JOIN contacts ct ON ct.contact_key = l.contact_key WHERE l.phone <> ct.phone) AS leadPhoneMismatch,
  (SELECT COUNT(*) FROM contacts WHERE phone <> contact_key) AS contactKeyPhoneMismatch,
  (SELECT COUNT(*) FROM contacts WHERE phone GLOB '*[^0-9]*') AS contactsWithNonNumericPhone,
  (SELECT COUNT(*) FROM (SELECT contact_key FROM conversations GROUP BY contact_key HAVING COUNT(DISTINCT connection_key) > 1)) AS contactsAcrossMultipleConnections;`);
  return row || {};
}

/**
 * STOP／suppression／consent 的 digest 用来验证 cutover 之后许可状态没有被
 * 悄悄放宽。digest 对整批排序后的集合做一次 hash，不逐个号码输出 hash。
 */
export function permissionEvidence(binary, databasePath) {
  const [counts] = sqliteJson(binary, databasePath, `
SELECT
  (SELECT COUNT(*) FROM contacts WHERE stop_flag = 1) AS stoppedContacts,
  (SELECT COUNT(*) FROM contact_permission_events) AS permissionEvents,
  (SELECT COUNT(DISTINCT contact_key) FROM contact_permission_events) AS contactsWithPermissionEvents;`);
  const byCategory = sqliteJson(binary, databasePath, `
SELECT category, action, COUNT(*) AS events, COUNT(DISTINCT contact_key) AS contacts
FROM contact_permission_events
GROUP BY category, action
ORDER BY category, action;`);
  const stopDigest = digestOfColumn(binary, databasePath, "SELECT contact_key FROM contacts WHERE stop_flag = 1 ORDER BY contact_key;", "contact_key");
  const grantDigest = digestOfColumn(binary, databasePath, `
SELECT contact_key || '|' || category || '|' || action || '|' || occurred_at AS token
FROM contact_permission_events ORDER BY token;`, "token");
  return { ...counts, byCategory, stopDigest, permissionEventDigest: grantDigest };
}

export function digestOfColumn(binary, databasePath, sql, column) {
  const rows = sqliteJson(binary, databasePath, sql);
  return { rows: rows.length, digest: sha256(rows.map((row) => String(row[column] ?? "")).join("\n")) };
}

export function campaignEvidence(binary, databasePath) {
  const runsByStatus = sqliteJson(binary, databasePath, "SELECT status, mode, COUNT(*) AS runs FROM campaign_runs GROUP BY status, mode ORDER BY status, mode;");
  const jobsByStatus = sqliteJson(binary, databasePath, "SELECT status, COUNT(*) AS jobs FROM send_jobs GROUP BY status ORDER BY status;");
  const [totals] = sqliteJson(binary, databasePath, `
SELECT
  (SELECT COALESCE(SUM(requested_count),0) FROM campaign_runs) AS requested,
  (SELECT COALESCE(SUM(sent_count),0) FROM campaign_runs) AS sent,
  (SELECT COALESCE(SUM(failed_count),0) FROM campaign_runs) AS failed,
  (SELECT COUNT(*) FROM campaign_runs WHERE status IN ('QUEUED','RUNNING','PARTIAL')) AS nonTerminalRuns,
  (SELECT COUNT(*) FROM send_jobs WHERE status IN ('PENDING','SENDING')) AS openSendJobs;`);
  return { runsByStatus, jobsByStatus, totals: totals || {} };
}

export function messageVolumeByConnection(binary, databasePath) {
  return sqliteJson(binary, databasePath, `
SELECT COALESCE(NULLIF(connection_key, ''), '(none)') AS connectionKey,
       direction,
       COUNT(*) AS messages
FROM messages
GROUP BY connectionKey, direction
ORDER BY connectionKey, direction;`).map((row) => ({ ...row, connectionKey: maskConnectionKey(row.connectionKey) }));
}

export function integrityChecks(binary, databasePath) {
  const quick = sqliteJson(binary, databasePath, "PRAGMA quick_check;");
  const foreignKeys = sqliteJson(binary, databasePath, "PRAGMA foreign_key_check;");
  const byTable = {};
  for (const row of foreignKeys) byTable[row.table] = (byTable[row.table] || 0) + 1;
  return {
    quickCheck: quick[0]?.quick_check || "unknown",
    foreignKeyViolations: foreignKeys.length,
    foreignKeyViolationsByTable: byTable,
  };
}

export function notionMappingEvidence(binary, databasePath) {
  const [row] = sqliteJson(binary, databasePath, `
SELECT
  (SELECT COUNT(*) FROM project_leads WHERE notion_page_id IS NOT NULL AND notion_page_id <> '') AS leadsWithNotionPage,
  (SELECT COUNT(*) FROM project_leads WHERE notion_page_id IS NULL OR notion_page_id = '') AS leadsWithoutNotionPage,
  (SELECT COUNT(*) FROM campaign_runs WHERE notion_page_id IS NOT NULL AND notion_page_id <> '') AS runsWithNotionPage,
  (SELECT COUNT(*) FROM sync_jobs WHERE status IN ('PENDING','RUNNING','RETRY')) AS openSyncJobs,
  (SELECT COUNT(*) FROM sync_jobs WHERE status = 'FAILED') AS failedSyncJobs;`);
  return row || {};
}

export function rowCounts(binary, databasePath, tables) {
  const present = tableNames(binary, databasePath);
  const selects = tables
    .filter((table) => present.has(table))
    .map((table) => `(SELECT COUNT(*) FROM ${table}) AS ${table}`);
  if (!selects.length) return {};
  return sqliteJson(binary, databasePath, `SELECT ${selects.join(", ")};`)[0] || {};
}

export function writeReportFiles({ outputDir, baseName, report, markdown }) {
  fs.mkdirSync(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, `${baseName}.json`);
  const markdownPath = path.join(outputDir, `${baseName}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  if (markdown) fs.writeFileSync(markdownPath, markdown);
  return { jsonPath, markdownPath: markdown ? markdownPath : null };
}

/**
 * 建一份和生产库同源的空数据库：`docs/mamba-schema.sql` 是 base schema（含 3／301／302
 * 的 schema_migrations 记录），303 之后每一版都来自 `campaign-app/migrations/`。
 * 测试 fixture 与 rebuild 目标库共用同一条安装路径，避免两边 schema 漂移。
 */
export function installBaseSchema({ binary = "/usr/bin/sqlite3", rootDir, databasePath, throughVersion = 303 } = {}) {
  if (fs.existsSync(databasePath)) throw new Error(`目标数据库已存在，拒绝覆盖：${databasePath}`);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const installed = [];
  sqliteExec(binary, databasePath, fs.readFileSync(path.join(rootDir, "docs", "mamba-schema.sql"), "utf8"));
  installed.push({ version: 302, name: "base-schema", source: "docs/mamba-schema.sql" });

  const core = [{ version: 303, name: "sqlite-core-stability", file: "303-sqlite-core-stability.sql" }, ...REBUILD_MIGRATIONS];
  for (const migration of core) {
    if (migration.version > throughVersion) break;
    const migrationPath = path.join(rootDir, "campaign-app", "migrations", migration.file);
    const sql = fs.readFileSync(migrationPath, "utf8");
    const appliedAt = new Date().toISOString();
    sqliteExec(binary, databasePath, `PRAGMA foreign_keys=ON;
BEGIN IMMEDIATE;
${sql}
INSERT INTO schema_migrations(version,name,checksum,applied_at,duration_ms,result)
VALUES (${migration.version},${sqlText(migration.name)},${sqlText(sha256(sql))},${sqlText(appliedAt)},0,'APPLIED');
COMMIT;`);
    installed.push({ version: migration.version, name: migration.name, source: `campaign-app/migrations/${migration.file}`, checksum: sha256(sql) });
  }
  return installed;
}

export function maintenanceArchiveDir(rootDir) {
  return path.join(rootDir, "campaign-data", "maintenance-archive");
}

export function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

export { sqlText, clean };
