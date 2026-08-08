import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deliveryStatusRank, normalizeMessageDeliveryStatus } from "../../campaign-app/reply_intake.mjs";
import { backupSqliteDatabase, recentActiveRunState } from "./lib/sqlite-maintenance.mjs";
import {
  assertToolPrerequisites,
  classifyAllDuplicateGroups,
  integrityChecks,
  maintenanceArchiveDir,
  maskConnectionKey,
  pickCanonicalRow,
  sha256,
  sqliteExec,
  sqliteJson,
  sqlText,
  summariseDuplicateClasses,
  timestampSlug,
} from "./lib/customer-database-inspection.mjs";

export const MESSAGE_IDENTITY_CONFIRMATION = "APPLY_MESSAGE_IDENTITY_REPAIR_V1";

// WhatsApp 送达证据的字段组。合并时整组一起搬，避免出现 status=READ 但
// rank 还停在 SERVER_ACK 的半套状态。
const DELIVERY_KEYS = Object.freeze(["deliveryStatus", "deliveryStatusRank", "deliveryUpdatedAt", "deliveryObservedVia"]);
const ACK_TIMESTAMP_KEYS = Object.freeze(["serverAckAt", "deliveredAt", "readAt", "playedAt"]);

function isEmptyValue(value) {
  return value === undefined || value === null || value === "";
}

function parsePayload(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function earliestTimestamp(values) {
  const parsed = values
    .filter((value) => !isEmptyValue(value))
    .map((value) => ({ value, time: Date.parse(value) }))
    .filter((item) => Number.isFinite(item.time))
    .sort((left, right) => left.time - right.time);
  return parsed[0]?.value ?? values.find((value) => !isEmptyValue(value)) ?? null;
}

/**
 * Delivery 证据只能升级，不能降级：READ 一旦被观察到，就不允许因为另一条
 * history row 只记录了 SERVER_ACK 而被改回去。同 rank 时取时间较新的证据。
 */
function bestDeliveryEvidence(payloads) {
  let best = null;
  for (const payload of payloads) {
    const status = normalizeMessageDeliveryStatus(payload.deliveryStatus);
    if (!status) continue;
    const rank = deliveryStatusRank(status);
    const observedAt = Date.parse(payload.deliveryUpdatedAt || "") || 0;
    if (!best || rank > best.rank || (rank === best.rank && observedAt > best.observedAt)) {
      best = { rank, observedAt, payload };
    }
  }
  return best;
}

/**
 * 合并一个 duplicate group，返回 canonical row 的最终字段。
 * 纯函数，不接触数据库，方便对每一条合并规则单独测试。
 */
export function mergeDuplicateGroup(rows, resolvedText = null) {
  const canonical = pickCanonicalRow(rows);
  const others = rows.filter((row) => row.rowId !== canonical.rowId);
  const payloads = rows.map((row) => parsePayload(row.payloadJson));
  const canonicalPayload = parsePayload(canonical.payloadJson);

  // 低权威来源先铺底，canonical 最后覆盖：history 补上 remoteJid／lid／media 证据，
  // 但空值不得抹掉 Campaign 的 runId、template 或发送结果。
  const merged = {};
  for (const row of [...others, canonical]) {
    const payload = parsePayload(row.payloadJson);
    for (const [key, value] of Object.entries(payload)) {
      if (isEmptyValue(value)) continue;
      merged[key] = value;
    }
  }
  for (const [key, value] of Object.entries(canonicalPayload)) {
    if (!isEmptyValue(value)) merged[key] = value;
  }

  const delivery = bestDeliveryEvidence(payloads);
  for (const key of DELIVERY_KEYS) delete merged[key];
  if (delivery) {
    for (const key of DELIVERY_KEYS) {
      if (!isEmptyValue(delivery.payload[key])) merged[key] = delivery.payload[key];
    }
  }
  for (const key of ACK_TIMESTAMP_KEYS) {
    const earliest = earliestTimestamp(payloads.map((payload) => payload[key]));
    if (!isEmptyValue(earliest)) merged[key] = earliest;
  }

  const textTypeRows = rows.filter((row) => row.messageType === "text").length;
  const nonTextTypes = [...new Set(rows.map((row) => row.messageType).filter((type) => type !== "text"))];
  const messageType = textTypeRows === 1 && nonTextTypes.length === 1 ? nonTextTypes[0] : canonical.messageType;

  return {
    canonicalRowId: canonical.rowId,
    removedRowIds: others.map((row) => row.rowId),
    fields: {
      // 正文取客户实际收到的那一版；canonical row 只决定身份与 Campaign 元数据。
      text: resolvedText ?? canonical.text,
      messageType,
      source: canonical.source,
      sentAt: canonical.sentAt || earliestTimestamp(others.map((row) => row.sentAt)),
      createdAt: earliestTimestamp(rows.map((row) => row.createdAt)) || canonical.createdAt,
      flowTopic: canonical.flowTopic || others.map((row) => row.flowTopic).find((value) => !isEmptyValue(value)) || "",
      templateKey: canonical.templateKey || others.map((row) => row.templateKey).find((value) => !isEmptyValue(value)) || null,
      payloadJson: JSON.stringify(merged),
    },
  };
}

function loadGroupRows(binary, databasePath) {
  const rows = sqliteJson(binary, databasePath, `
WITH duplicated AS (
  SELECT connection_key, external_message_id
  FROM messages
  WHERE connection_key IS NOT NULL AND connection_key <> ''
    AND external_message_id IS NOT NULL AND external_message_id <> ''
  GROUP BY connection_key, external_message_id
  HAVING COUNT(*) > 1
)
SELECT m.row_id AS rowId, m.id, m.conversation_id AS conversationId, m.connection_key AS connectionKey,
       m.external_message_id AS externalMessageId, m.idempotency_key AS idempotencyKey, m.direction,
       m.text, m.message_type AS messageType, m.source, m.flow_topic AS flowTopic,
       m.template_key AS templateKey, m.sent_at AS sentAt, m.payload_json AS payloadJson,
       m.created_at AS createdAt
FROM messages m
JOIN duplicated d
  ON d.connection_key = m.connection_key
 AND d.external_message_id = m.external_message_id
ORDER BY m.connection_key, m.external_message_id, m.row_id;`);
  const grouped = new Map();
  for (const row of rows) {
    const key = `${row.connectionKey}\u0000${row.externalMessageId}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  return grouped;
}

export function planDuplicateMessageRepair({ rootDir, databasePath, binary = "/usr/bin/sqlite3" } = {}) {
  assertToolPrerequisites(binary, databasePath);
  const classified = classifyAllDuplicateGroups(binary, databasePath);
  const classifiedByKey = new Map(classified.map((group) => [`${group.connectionKey}\u0000${group.externalMessageId}`, group]));
  const grouped = loadGroupRows(binary, databasePath);

  const merges = [];
  const conflicts = [];
  for (const [key, rows] of grouped) {
    const group = classifiedByKey.get(key);
    if (!group) continue;
    if (!group.autoMergeable) {
      conflicts.push({
        connectionKey: maskConnectionKey(group.connectionKey),
        externalMessageId: group.externalMessageId,
        sourcePair: group.sourcePair,
        direction: group.direction,
        rowIds: rows.map((row) => row.rowId),
        secondsApart: group.secondsApart,
        // hash 让人工可以确认两边内容是否真的不同，同时不输出客户文字。
        textHashes: [...new Set(rows.map((row) => sha256(row.text ?? "").slice(0, 16)))],
        conflicts: group.conflicts,
      });
      continue;
    }
    merges.push({ ...mergeDuplicateGroup(rows, group.resolvedText), group, rows });
  }

  return {
    databasePath,
    totals: {
      duplicateGroups: classified.length,
      mergeableGroups: merges.length,
      rowsToRemove: merges.reduce((total, merge) => total + merge.removedRowIds.length, 0),
      conflictGroups: conflicts.length,
      mediaTypeUpgrades: classified.filter((group) => group.upgrades.includes("MEDIA_TYPE_UPGRADE")).length,
    },
    classes: summariseDuplicateClasses(classified),
    conflicts,
    merges,
  };
}

function publicPlan(plan) {
  return {
    databasePath: plan.databasePath,
    totals: plan.totals,
    classes: plan.classes,
    conflicts: plan.conflicts,
    // merge 明细只输出 row ID，不输出文字、号码或 payload。
    merges: plan.merges.map((merge) => ({
      canonicalRowId: merge.canonicalRowId,
      removedRowIds: merge.removedRowIds,
      sourcePair: merge.group.sourcePair,
      direction: merge.group.direction,
      upgrades: merge.group.upgrades,
      secondsApart: merge.group.secondsApart,
    })),
  };
}

/**
 * 被移除的 row 原样写进 runtime archive（`campaign-data/` 已在 .gitignore 内）。
 * 报告只给 hash 与 row ID，archive 才是可以完整还原的证据；两者不可互换。
 */
function writeArchive({ rootDir, plan, stamp }) {
  const archiveDir = path.join(maintenanceArchiveDir(rootDir), "message-identity", stamp);
  fs.mkdirSync(archiveDir, { recursive: true });
  const removedPath = path.join(archiveDir, "removed-rows.jsonl");
  const conflictPath = path.join(archiveDir, "conflicts.jsonl");
  const manifestPath = path.join(archiveDir, "manifest.json");

  const removedLines = [];
  for (const merge of plan.merges) {
    for (const row of merge.rows) {
      if (row.rowId === merge.canonicalRowId) continue;
      removedLines.push(JSON.stringify({ canonicalRowId: merge.canonicalRowId, row }));
    }
  }
  fs.writeFileSync(removedPath, removedLines.length ? `${removedLines.join("\n")}\n` : "");
  fs.writeFileSync(conflictPath, plan.conflicts.length ? `${plan.conflicts.map((item) => JSON.stringify(item)).join("\n")}\n` : "");

  const manifest = {
    tool: "repair-duplicate-message-identity",
    version: 1,
    createdAt: new Date().toISOString(),
    databasePath: plan.databasePath,
    totals: plan.totals,
    removedRowsDigest: sha256(removedLines.join("\n")),
    conflictsDigest: sha256(plan.conflicts.map((item) => JSON.stringify(item)).join("\n")),
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { archiveDir, removedPath, conflictPath, manifestPath, manifest };
}

function applyMerges(binary, databasePath, merges) {
  if (!merges.length) return 0;
  const statements = ["PRAGMA foreign_keys=ON;", "BEGIN IMMEDIATE;"];
  for (const merge of merges) {
    const { fields } = merge;
    statements.push(`UPDATE messages SET
  text=${sqlText(fields.text)},
  message_type=${sqlText(fields.messageType)},
  sent_at=${fields.sentAt === null ? "NULL" : sqlText(fields.sentAt)},
  created_at=${sqlText(fields.createdAt)},
  flow_topic=${sqlText(fields.flowTopic)},
  template_key=${fields.templateKey === null ? "NULL" : sqlText(fields.templateKey)},
  payload_json=${sqlText(fields.payloadJson)}
WHERE row_id=${Number(merge.canonicalRowId)};`);
    statements.push(`DELETE FROM messages WHERE row_id IN (${merge.removedRowIds.map((id) => Number(id)).join(",")});`);
  }
  statements.push("COMMIT;");
  sqliteExec(binary, databasePath, statements.join("\n"));
  return merges.length;
}

export function repairDuplicateMessageIdentity({
  rootDir,
  databasePath,
  apply = false,
  confirmation = "",
  binary = "/usr/bin/sqlite3",
} = {}) {
  const plan = planDuplicateMessageRepair({ rootDir, databasePath, binary });
  const activeRuns = recentActiveRunState(rootDir).activeRuns;
  const report = {
    mode: apply ? "apply" : "dry-run",
    activeRuns,
    plan: publicPlan(plan),
  };
  if (!apply) return report;

  if (confirmation !== MESSAGE_IDENTITY_CONFIRMATION) {
    const error = new Error(`Apply 需要 --confirm ${MESSAGE_IDENTITY_CONFIRMATION}。`);
    error.code = "MESSAGE_IDENTITY_CONFIRMATION_REQUIRED";
    error.report = report;
    throw error;
  }
  // 正在跑的 Campaign 会继续写 messages；此时合并会丢掉刚写入的发送证据。
  if (activeRuns.length) {
    const error = new Error(`仍有 ${activeRuns.length} 个活动 Campaign；拒绝合并 message identity。`);
    error.code = "ACTIVE_CAMPAIGN_BLOCKS_MESSAGE_IDENTITY_REPAIR";
    error.report = report;
    throw error;
  }

  const stamp = timestampSlug();
  const beforeCount = Number(sqliteJson(binary, databasePath, "SELECT COUNT(*) AS count FROM messages;")[0]?.count || 0);
  const archive = writeArchive({ rootDir, plan, stamp });
  const backupPath = backupSqliteDatabase({ binary, rootDir, databasePath, prefix: "before-message-identity-repair" });
  const merged = applyMerges(binary, databasePath, plan.merges);

  const afterCount = Number(sqliteJson(binary, databasePath, "SELECT COUNT(*) AS count FROM messages;")[0]?.count || 0);
  const integrity = integrityChecks(binary, databasePath);
  const remaining = planDuplicateMessageRepair({ rootDir, databasePath, binary });
  const verification = {
    ...integrity,
    messagesBefore: beforeCount,
    messagesAfter: afterCount,
    removed: beforeCount - afterCount,
    expectedRemoved: plan.totals.rowsToRemove,
    remainingMergeableGroups: remaining.totals.mergeableGroups,
    remainingConflictGroups: remaining.totals.conflictGroups,
  };
  const failures = [];
  if (integrity.quickCheck !== "ok") failures.push("quick_check");
  if (integrity.foreignKeyViolations) failures.push("foreign_key_check");
  if (verification.removed !== verification.expectedRemoved) failures.push("row_count_mismatch");
  if (verification.remainingMergeableGroups !== 0) failures.push("mergeable_groups_remaining");
  if (failures.length) {
    const error = new Error(`合并验证失败（${failures.join(", ")}）；请使用备份恢复：${backupPath}`);
    error.code = "MESSAGE_IDENTITY_REPAIR_VERIFICATION_FAILED";
    error.report = { ...report, backupPath, archiveDir: archive.archiveDir, verification };
    throw error;
  }
  return {
    ...report,
    backupPath,
    archive: { dir: archive.archiveDir, manifest: archive.manifestPath },
    merged,
    verification,
  };
}

function parseArgs(argv) {
  const args = { apply: false, confirmation: "", root: "", db: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--dry-run") args.apply = false;
    else if (arg === "--confirm") args.confirmation = argv[index += 1] || "";
    else if (arg.startsWith("--confirm=")) args.confirmation = arg.slice("--confirm=".length);
    else if (arg === "--root") args.root = argv[index += 1] || "";
    else if (arg.startsWith("--root=")) args.root = arg.slice("--root=".length);
    else if (arg === "--db") args.db = argv[index += 1] || "";
    else if (arg.startsWith("--db=")) args.db = arg.slice("--db=".length);
    else throw new Error(`不支持的参数：${arg}`);
  }
  return args;
}

/**
 * 5,000 组以上的 merge 明细放在终端没人读得完，但审阅时又必须能逐条查。
 * 因此完整计划一律写进 archive 文件，stdout 只留摘要与少量样本。
 */
function writePlanFile(rootDir, report) {
  const dir = path.join(maintenanceArchiveDir(rootDir), "message-identity");
  fs.mkdirSync(dir, { recursive: true });
  const planPath = path.join(dir, `${report.mode}-plan-${timestampSlug()}.json`);
  fs.writeFileSync(planPath, `${JSON.stringify(report, null, 2)}\n`);
  return planPath;
}

function summariseReport(report) {
  return {
    ...report,
    plan: {
      ...report.plan,
      merges: undefined,
      mergeSample: report.plan.merges.slice(0, 5),
      conflicts: report.plan.conflicts,
    },
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const rootDir = path.resolve(args.root || defaultRoot);
  const databasePath = path.resolve(args.db || path.join(rootDir, "campaign-data", "mamba.sqlite"));
  try {
    const report = repairDuplicateMessageIdentity({
      rootDir,
      databasePath,
      apply: args.apply,
      confirmation: args.confirmation,
    });
    const planPath = writePlanFile(rootDir, report);
    console.log(JSON.stringify(summariseReport(report), null, 2));
    console.log(`\n完整计划：${planPath}`);
  } catch (error) {
    if (error.report) console.error(JSON.stringify(error.report, null, 2));
    console.error(`[${error.code || "MESSAGE_IDENTITY_REPAIR_FAILED"}] ${error.message}`);
    process.exitCode = 1;
  }
}
