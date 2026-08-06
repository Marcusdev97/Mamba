import crypto from "node:crypto";
import path from "node:path";
import { approvedHumanFields, assertReducedSyncPayload, stableCrmId } from "../domain/notion-crm-sync.mjs";
import { createSqliteCli, sqlValue } from "./sqlite-cli.mjs";

const REQUIRED_TABLES = Object.freeze([
  "crm_customer_profiles",
  "notion_entity_map",
  "sync_inbox",
  "sync_conflicts",
  "sync_audit_events",
  "sync_reconciliation_runs",
]);

function clean(value) {
  return String(value ?? "").trim();
}

function parseJson(value, fallback = {}) {
  try { return JSON.parse(value || ""); } catch { return fallback; }
}

function eventId(prefix, ...parts) {
  const digest = crypto.createHash("sha256").update(parts.map(clean).join("\u001f")).digest("hex").slice(0, 24);
  return `${prefix}_${digest}`;
}

function customerHumanValues(row = {}) {
  return approvedHumanFields("customers", {
    "Display Name": clean(row.displayName),
    Language: clean(row.language || "Other"),
    Owner: clean(row.owner),
    "Global Status": clean(row.globalStatus || (Number(row.stopFlag) ? "Stop" : "Active")),
    "Next Follow-up At": row.nextFollowUpAt || null,
    "Current Sales Stage": clean(row.currentSalesStage || "New"),
    "Main Objection": clean(row.mainObjection),
    Notes: clean(row.notes),
  });
}

function projectLeadHumanValues(row = {}) {
  const payload = parseJson(row.payloadJson, {});
  const crm = payload.crmHuman || {};
  return approvedHumanFields("projectLeads", {
    Project: crm.Project ?? row.projectCode ?? "",
    "Lead Source": crm["Lead Source"] ?? "",
    "Buying Purpose": crm["Buying Purpose"] ?? "Unknown",
    "Budget Min": crm["Budget Min"] ?? null,
    "Budget Max": crm["Budget Max"] ?? null,
    "Preferred Area": crm["Preferred Area"] ?? [],
    "Unit Preference": crm["Unit Preference"] ?? "",
    "Buying Timeline": crm["Buying Timeline"] ?? "Unknown",
    "Interest Level": crm["Interest Level"] ?? "Cold",
    "Project Stage": crm["Project Stage"] ?? row.status ?? "New",
    "Next Follow-up At": crm["Next Follow-up At"] ?? row.followUpAt ?? null,
    "Assigned Agent": crm["Assigned Agent"] ?? row.assignedSales ?? "",
    "Lost Reason": crm["Lost Reason"] ?? "",
  });
}

export function createNotionCrmSyncRepository({
  dataDir,
  sqliteBinary = "",
  clock = () => new Date(),
} = {}) {
  const databasePath = path.join(dataDir, "mamba.sqlite");
  let databasePromise = null;

  function database() {
    if (!databasePromise) databasePromise = createSqliteCli({ databasePath, sqliteBinary }).catch((error) => {
      databasePromise = null;
      throw error;
    });
    return databasePromise;
  }

  async function schemaStatus() {
    const db = await database();
    const rows = await db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${REQUIRED_TABLES.map(sqlValue).join(",")});`);
    const present = new Set(rows.map((row) => row.name));
    const [migration] = await db.query("SELECT version FROM schema_migrations WHERE version=304 LIMIT 1;").catch(() => []);
    const missing = REQUIRED_TABLES.filter((table) => !present.has(table));
    return { ready: Boolean(migration) && missing.length === 0, migration: migration?.version || null, missing };
  }

  async function assertSchemaReady() {
    const status = await schemaStatus();
    if (!status.ready) {
      const error = new Error(`SQLite ↔ Notion sync schema 尚未就绪：${status.missing.join(", ") || "migration 304 未记录"}。`);
      error.code = "SQLITE_NOTION_SYNC_SCHEMA_REQUIRED";
      error.retryable = false;
      error.schema = status;
      throw error;
    }
    return status;
  }

  async function loadCustomer(contactKey) {
    await assertSchemaReady();
    const db = await database();
    const [row] = await db.query(`
SELECT c.contact_key AS contactKey, c.phone, c.display_name AS displayName, c.stop_flag AS stopFlag,
       c.last_reply_at AS lastReplyAt, c.updated_at AS updatedAt, c.row_version AS contactVersion,
       p.language, p.owner, p.global_status AS globalStatus, p.next_follow_up_at AS nextFollowUpAt,
       p.current_sales_stage AS currentSalesStage, p.main_objection AS mainObjection, p.notes,
       COALESCE(p.row_version, 0) AS profileVersion,
       (SELECT MAX(COALESCE(m.sent_at, m.created_at)) FROM conversations v JOIN messages m ON m.conversation_id=v.id WHERE v.contact_key=c.contact_key) AS lastContactAt
FROM contacts c LEFT JOIN crm_customer_profiles p ON p.contact_key=c.contact_key
WHERE c.contact_key=${sqlValue(contactKey)} LIMIT 1;`);
    if (!row) return null;
    return {
      ...row,
      customerId: stableCrmId("CUS", row.contactKey),
      rowVersion: Number(row.contactVersion || 0) + Number(row.profileVersion || 0),
      humanValues: customerHumanValues(row),
    };
  }

  async function loadProjectLead(projectLeadKey) {
    await assertSchemaReady();
    const db = await database();
    const [row] = await db.query(`
SELECT project_lead_key AS projectLeadKey, contact_key AS contactKey, project_code AS projectCode,
       p.phone, p.name, p.status, p.sequence_status AS sequenceStatus, p.last_flow_sent AS lastFlowSent,
       p.next_flow AS nextFlow, p.last_blast_at AS lastContactAt, p.follow_up_at AS followUpAt,
       p.assigned_sales AS assignedSales, p.payload_json AS payloadJson, p.updated_at AS updatedAt,
       p.row_version AS rowVersion, c.stop_flag AS stopFlag
FROM project_leads p JOIN contacts c ON c.contact_key=p.contact_key
WHERE project_lead_key=${sqlValue(projectLeadKey)} LIMIT 1;`);
    if (!row) return null;
    return {
      ...row,
      projectLeadId: stableCrmId("PLEAD", row.projectLeadKey),
      humanValues: projectLeadHumanValues(row),
    };
  }

  async function findEntityByStableId(entityType, stableId) {
    await assertSchemaReady();
    const db = await database();
    const mapped = await mappingByStableId(entityType, stableId);
    if (mapped) return mapped.sqliteEntityId;
    if (entityType === "crm_customer") {
      const rows = await db.query("SELECT contact_key AS entityId FROM contacts;");
      return rows.find((row) => stableCrmId("CUS", row.entityId) === stableId)?.entityId || "";
    }
    if (entityType === "crm_project_lead") {
      const rows = await db.query("SELECT project_lead_key AS entityId FROM project_leads;");
      return rows.find((row) => stableCrmId("PLEAD", row.entityId) === stableId)?.entityId || "";
    }
    return "";
  }

  async function mapping(entityType, sqliteEntityId) {
    await assertSchemaReady();
    const db = await database();
    const [row] = await db.query(`
SELECT entity_type AS entityType, sqlite_entity_id AS sqliteEntityId, stable_notion_id AS stableNotionId,
       notion_page_id AS notionPageId, notion_database_id AS notionDatabaseId,
       last_sqlite_version AS lastSqliteVersion, last_sqlite_snapshot_json AS lastSqliteSnapshotJson,
       last_notion_edited_at AS lastNotionEditedAt, last_synced_at AS lastSyncedAt, sync_status AS syncStatus
FROM notion_entity_map WHERE entity_type=${sqlValue(entityType)} AND sqlite_entity_id=${sqlValue(sqliteEntityId)} LIMIT 1;`);
    return row ? { ...row, lastSqliteSnapshot: parseJson(row.lastSqliteSnapshotJson, {}) } : null;
  }

  async function mappingByStableId(entityType, stableId) {
    await assertSchemaReady();
    const db = await database();
    const [row] = await db.query(`
SELECT entity_type AS entityType, sqlite_entity_id AS sqliteEntityId, stable_notion_id AS stableNotionId,
       notion_page_id AS notionPageId, notion_database_id AS notionDatabaseId,
       last_sqlite_version AS lastSqliteVersion, last_sqlite_snapshot_json AS lastSqliteSnapshotJson,
       last_notion_edited_at AS lastNotionEditedAt, last_synced_at AS lastSyncedAt, sync_status AS syncStatus
FROM notion_entity_map WHERE entity_type=${sqlValue(entityType)} AND stable_notion_id=${sqlValue(stableId)} LIMIT 1;`);
    return row ? { ...row, lastSqliteSnapshot: parseJson(row.lastSqliteSnapshotJson, {}) } : null;
  }

  async function upsertMapping({ entityType, sqliteEntityId, stableNotionId, notionPageId, notionDatabaseId, sqliteVersion = 0, sqliteSnapshot = {}, notionEditedAt = null, syncedAt = null, syncStatus = "SYNCED" }) {
    await assertSchemaReady();
    assertReducedSyncPayload(sqliteSnapshot);
    const db = await database();
    const at = syncedAt || clock().toISOString();
    await db.exec(`
INSERT INTO notion_entity_map(entity_type, sqlite_entity_id, stable_notion_id, notion_page_id, notion_database_id,
  last_sqlite_version, last_sqlite_snapshot_json, last_notion_edited_at, last_synced_at, sync_status)
VALUES (${sqlValue(entityType)},${sqlValue(sqliteEntityId)},${sqlValue(stableNotionId)},${sqlValue(notionPageId)},${sqlValue(notionDatabaseId)},
  ${Number(sqliteVersion || 0)},${sqlValue(JSON.stringify(sqliteSnapshot))},${sqlValue(notionEditedAt)},${sqlValue(at)},${sqlValue(syncStatus)})
ON CONFLICT(entity_type, sqlite_entity_id) DO UPDATE SET
  stable_notion_id=excluded.stable_notion_id, notion_page_id=excluded.notion_page_id,
  notion_database_id=excluded.notion_database_id, last_sqlite_version=excluded.last_sqlite_version,
  last_sqlite_snapshot_json=excluded.last_sqlite_snapshot_json,
  last_notion_edited_at=excluded.last_notion_edited_at, last_synced_at=excluded.last_synced_at,
  sync_status=excluded.sync_status;`);
  }

  async function receiveInbox({ notionPageId, notionDatabaseId, entityType, stableId, notionEditedAt, payload }) {
    await assertSchemaReady();
    assertReducedSyncPayload(payload);
    const db = await database();
    const idempotencyKey = `NOTION_TO_LOCAL:${entityType}:${notionPageId}:${notionEditedAt}`;
    const inboxId = eventId("inbox", idempotencyKey);
    const [existing] = await db.query(`SELECT inbox_id AS inboxId,status,entity_id AS entityId FROM sync_inbox WHERE idempotency_key=${sqlValue(idempotencyKey)};`);
    if (existing) return { ...existing, duplicate: true };
    const entityId = await findEntityByStableId(entityType, stableId);
    const at = clock().toISOString();
    await db.exec(`
INSERT INTO sync_inbox(inbox_id,idempotency_key,notion_page_id,notion_database_id,entity_type,entity_id,
  notion_edited_at,payload_json,status,received_at)
VALUES (${sqlValue(inboxId)},${sqlValue(idempotencyKey)},${sqlValue(notionPageId)},${sqlValue(notionDatabaseId)},
  ${sqlValue(entityType)},${sqlValue(entityId)},${sqlValue(notionEditedAt)},${sqlValue(JSON.stringify({ stableId, ...payload }))},'PENDING',${sqlValue(at)})
ON CONFLICT(idempotency_key) DO NOTHING;`);
    const [row] = await db.query(`SELECT inbox_id AS inboxId,status,entity_id AS entityId FROM sync_inbox WHERE idempotency_key=${sqlValue(idempotencyKey)};`);
    return { ...row, duplicate: false };
  }

  async function dueInbox({ limit = 50 } = {}) {
    await assertSchemaReady();
    const db = await database();
    const rows = await db.query(`
SELECT inbox_id AS inboxId, notion_page_id AS notionPageId, notion_database_id AS notionDatabaseId,
       entity_type AS entityType, entity_id AS entityId, notion_edited_at AS notionEditedAt,
       payload_json AS payloadJson, received_at AS receivedAt
FROM sync_inbox WHERE status='PENDING' ORDER BY received_at LIMIT ${Math.max(1, Math.min(Number(limit) || 50, 500))};`);
    return rows.map((row) => ({ ...row, payload: parseJson(row.payloadJson, {}) }));
  }

  async function markInbox(inboxId, status, { conflictId = null, errorCode = "", errorMessage = "" } = {}) {
    const db = await database();
    const at = clock().toISOString();
    await db.exec(`UPDATE sync_inbox SET status=${sqlValue(status)}, conflict_id=${sqlValue(conflictId)},
      error_code=${sqlValue(errorCode)}, error_message=${sqlValue(clean(errorMessage).slice(0, 500))},
      applied_at=${["APPLIED","CONFLICT","FAILED","CANCELLED"].includes(status) ? sqlValue(at) : "NULL"}
      WHERE inbox_id=${sqlValue(inboxId)};`);
  }

  async function createConflicts({ inbox, entityId, conflicts }) {
    const db = await database();
    const detectedAt = clock().toISOString();
    const ids = [];
    for (const conflict of conflicts) {
      const conflictId = eventId("conflict", inbox.inboxId, conflict.field);
      ids.push(conflictId);
      await db.exec(`
INSERT INTO sync_conflicts(conflict_id,inbox_id,entity_type,entity_id,field_name,base_value_json,sqlite_value_json,notion_value_json,detected_at)
VALUES (${sqlValue(conflictId)},${sqlValue(inbox.inboxId)},${sqlValue(inbox.entityType)},${sqlValue(entityId)},${sqlValue(conflict.field)},
  ${sqlValue(JSON.stringify(conflict.baseValue ?? null))},${sqlValue(JSON.stringify(conflict.sqliteValue ?? null))},${sqlValue(JSON.stringify(conflict.notionValue ?? null))},${sqlValue(detectedAt)})
ON CONFLICT(inbox_id,field_name) DO NOTHING;`);
    }
    return ids;
  }

  async function applyCustomerHumanFields({ inbox, entityId, values, snapshot, syncStatus = "SYNCED" }) {
    const current = await loadCustomer(entityId);
    if (!current) throw Object.assign(new Error("Customer mapping 找不到本机 contact。"), { code: "SYNC_LOCAL_ENTITY_NOT_FOUND", retryable: false });
    const merged = { ...current.humanValues, ...approvedHumanFields("customers", values) };
    const db = await database();
    const at = clock().toISOString();
    const changedFields = Object.keys(values);
    await db.exec(`
BEGIN IMMEDIATE;
UPDATE contacts SET display_name=${sqlValue(merged["Display Name"])}, updated_at=${sqlValue(at)} WHERE contact_key=${sqlValue(entityId)};
INSERT INTO crm_customer_profiles(contact_key,language,owner,global_status,next_follow_up_at,current_sales_stage,main_objection,notes,updated_at)
VALUES (${sqlValue(entityId)},${sqlValue(merged.Language)},${sqlValue(merged.Owner)},${sqlValue(merged["Global Status"])},
  ${sqlValue(merged["Next Follow-up At"])},${sqlValue(merged["Current Sales Stage"])},${sqlValue(merged["Main Objection"])},${sqlValue(merged.Notes)},${sqlValue(at)})
ON CONFLICT(contact_key) DO UPDATE SET language=excluded.language,owner=excluded.owner,global_status=excluded.global_status,
  next_follow_up_at=excluded.next_follow_up_at,current_sales_stage=excluded.current_sales_stage,
  main_objection=excluded.main_objection,notes=excluded.notes,updated_at=excluded.updated_at;
INSERT INTO sync_audit_events(event_id,direction,entity_type,entity_id,operation,changed_fields_json,detail_json,created_at)
VALUES (${sqlValue(eventId("audit", inbox.inboxId, "apply"))},'NOTION_TO_LOCAL','crm_customer',${sqlValue(entityId)},'APPLY_HUMAN_FIELDS',
  ${sqlValue(JSON.stringify(changedFields))},${sqlValue(JSON.stringify({ inboxId: inbox.inboxId }))},${sqlValue(at)})
ON CONFLICT(event_id) DO NOTHING;
COMMIT;`);
    const refreshed = await loadCustomer(entityId);
    await upsertMapping({
      entityType: "crm_customer", sqliteEntityId: entityId, stableNotionId: inbox.payload.stableId,
      notionPageId: inbox.notionPageId, notionDatabaseId: inbox.notionDatabaseId,
      sqliteVersion: refreshed.rowVersion, sqliteSnapshot: snapshot,
      notionEditedAt: inbox.notionEditedAt, syncedAt: at,
      syncStatus,
    });
    return refreshed;
  }

  async function applyProjectLeadHumanFields({ inbox, entityId, values, snapshot, syncStatus = "SYNCED" }) {
    const current = await loadProjectLead(entityId);
    if (!current) throw Object.assign(new Error("Project Lead mapping 找不到本机 row。"), { code: "SYNC_LOCAL_ENTITY_NOT_FOUND", retryable: false });
    const approved = approvedHumanFields("projectLeads", values);
    const mergedHuman = { ...current.humanValues, ...approved };
    const payload = parseJson(current.payloadJson, {});
    payload.crmHuman = mergedHuman;
    assertReducedSyncPayload(payload);
    const at = clock().toISOString();
    const db = await database();
    await db.exec(`
BEGIN IMMEDIATE;
UPDATE project_leads SET
  status=${sqlValue(mergedHuman["Project Stage"] || current.status)},
  follow_up_at=${sqlValue(mergedHuman["Next Follow-up At"])},
  assigned_sales=${sqlValue(mergedHuman["Assigned Agent"])},
  payload_json=${sqlValue(JSON.stringify(payload))}, updated_at=${sqlValue(at)}
WHERE project_lead_key=${sqlValue(entityId)};
INSERT INTO sync_audit_events(event_id,direction,entity_type,entity_id,operation,changed_fields_json,detail_json,created_at)
VALUES (${sqlValue(eventId("audit", inbox.inboxId, "apply"))},'NOTION_TO_LOCAL','crm_project_lead',${sqlValue(entityId)},'APPLY_HUMAN_FIELDS',
  ${sqlValue(JSON.stringify(Object.keys(approved)))},${sqlValue(JSON.stringify({ inboxId: inbox.inboxId }))},${sqlValue(at)})
ON CONFLICT(event_id) DO NOTHING;
COMMIT;`);
    const refreshed = await loadProjectLead(entityId);
    await upsertMapping({
      entityType: "crm_project_lead", sqliteEntityId: entityId, stableNotionId: inbox.payload.stableId,
      notionPageId: inbox.notionPageId, notionDatabaseId: inbox.notionDatabaseId,
      sqliteVersion: refreshed.rowVersion, sqliteSnapshot: snapshot,
      notionEditedAt: inbox.notionEditedAt, syncedAt: at,
      syncStatus,
    });
    return refreshed;
  }

  async function recordPush({ entityType, entityId, changedFields = [], idempotencyKey = "" }) {
    const db = await database();
    const at = clock().toISOString();
    await db.exec(`INSERT INTO sync_audit_events(event_id,direction,entity_type,entity_id,operation,changed_fields_json,detail_json,created_at)
VALUES (${sqlValue(eventId("audit", idempotencyKey || `${entityType}:${entityId}`))},'LOCAL_TO_NOTION',${sqlValue(entityType)},${sqlValue(entityId)},'UPSERT',
${sqlValue(JSON.stringify(changedFields))},'{}',${sqlValue(at)})
ON CONFLICT(event_id) DO NOTHING;`);
    await db.exec(`UPDATE sync_worker_state SET last_push_at=${sqlValue(at)},updated_at=${sqlValue(at)} WHERE id='singleton';`);
  }

  async function setWorkerPaused(paused, reason = "") {
    await assertSchemaReady();
    const db = await database();
    const at = clock().toISOString();
    await db.exec(`UPDATE sync_worker_state SET enabled=${paused ? 0 : 1},status=${sqlValue(paused ? "PAUSED" : "IDLE")},
      paused_reason=${sqlValue(paused ? clean(reason) : "")},updated_at=${sqlValue(at)} WHERE id='singleton';`);
    return workerHealth();
  }

  async function workerHealth() {
    await assertSchemaReady();
    const db = await database();
    const [state] = await db.query(`SELECT enabled,mode,status,last_started_at AS lastStartedAt,last_finished_at AS lastFinishedAt,
      last_push_at AS lastPushAt,last_pull_at AS lastPullAt,last_reconciled_at AS lastReconciledAt,paused_reason AS pausedReason,
      last_error_code AS lastErrorCode,last_error_message AS lastErrorMessage FROM sync_worker_state WHERE id='singleton';`);
    const [counts] = await db.query(`SELECT
      (SELECT COUNT(*) FROM sync_jobs WHERE direction='LOCAL_TO_NOTION' AND status IN ('PENDING','RUNNING','RETRY')) AS pendingPush,
      (SELECT COUNT(*) FROM sync_inbox WHERE status IN ('PENDING','PROCESSING')) AS pendingPull,
      (SELECT COUNT(*) FROM sync_conflicts WHERE resolution='PENDING') AS conflicts,
      (SELECT COUNT(*) FROM sync_jobs WHERE status='FAILED') + (SELECT COUNT(*) FROM sync_inbox WHERE status='FAILED') AS failed;`);
    return { ...state, ...counts };
  }

  async function markWorkerRun({ status, errorCode = "", errorMessage = "", started = false, finished = false } = {}) {
    await assertSchemaReady();
    const db = await database();
    const at = clock().toISOString();
    await db.exec(`UPDATE sync_worker_state SET status=${sqlValue(status || "IDLE")},
      last_started_at=CASE WHEN ${started ? 1 : 0}=1 THEN ${sqlValue(at)} ELSE last_started_at END,
      last_finished_at=CASE WHEN ${finished ? 1 : 0}=1 THEN ${sqlValue(at)} ELSE last_finished_at END,
      last_error_code=${sqlValue(clean(errorCode))},last_error_message=${sqlValue(clean(errorMessage).slice(0, 500))},updated_at=${sqlValue(at)}
      WHERE id='singleton';`);
  }

  async function markPullCompleted() {
    await assertSchemaReady();
    const db = await database();
    const at = clock().toISOString();
    await db.exec(`UPDATE sync_worker_state SET last_pull_at=${sqlValue(at)},updated_at=${sqlValue(at)} WHERE id='singleton';`);
    return at;
  }

  async function listMappings({ entityType = "", limit = 1000 } = {}) {
    await assertSchemaReady();
    const db = await database();
    const safeLimit = Math.max(1, Math.min(Number(limit) || 1000, 5000));
    const filter = entityType ? `WHERE entity_type=${sqlValue(entityType)}` : "";
    return db.query(`SELECT entity_type AS entityType,sqlite_entity_id AS sqliteEntityId,stable_notion_id AS stableNotionId,
      notion_page_id AS notionPageId,notion_database_id AS notionDatabaseId,sync_status AS syncStatus,
      last_sqlite_version AS lastSqliteVersion,last_notion_edited_at AS lastNotionEditedAt,last_synced_at AS lastSyncedAt
      FROM notion_entity_map ${filter} ORDER BY entity_type,sqlite_entity_id LIMIT ${safeLimit};`);
  }

  async function enqueueDirtyEntities() {
    await assertSchemaReady();
    const db = await database();
    const at = clock().toISOString();
    await db.exec(`
INSERT INTO sync_jobs(idempotency_key,direction,entity_type,entity_id,status,attempt_count,available_at,payload_json,created_at,updated_at)
SELECT 'LOCAL_TO_NOTION:crm_customer:' || c.contact_key || ':' || (c.row_version + COALESCE(p.row_version,0)),
  'LOCAL_TO_NOTION','crm_customer',c.contact_key,'PENDING',0,${sqlValue(at)},'{}',${sqlValue(at)},${sqlValue(at)}
FROM contacts c LEFT JOIN crm_customer_profiles p ON p.contact_key=c.contact_key
LEFT JOIN notion_entity_map m ON m.entity_type='crm_customer' AND m.sqlite_entity_id=c.contact_key
WHERE m.sqlite_entity_id IS NULL OR m.last_sqlite_version < (c.row_version + COALESCE(p.row_version,0))
ON CONFLICT(idempotency_key) DO NOTHING;
INSERT INTO sync_jobs(idempotency_key,direction,entity_type,entity_id,status,attempt_count,available_at,payload_json,created_at,updated_at)
SELECT 'LOCAL_TO_NOTION:crm_project_lead:' || p.project_lead_key || ':' || p.row_version,
  'LOCAL_TO_NOTION','crm_project_lead',p.project_lead_key,'PENDING',0,${sqlValue(at)},'{}',${sqlValue(at)},${sqlValue(at)}
FROM project_leads p
LEFT JOIN notion_entity_map m ON m.entity_type='crm_project_lead' AND m.sqlite_entity_id=p.project_lead_key
WHERE m.sqlite_entity_id IS NULL OR m.last_sqlite_version < p.row_version
ON CONFLICT(idempotency_key) DO NOTHING;`);
    const [count] = await db.query(`SELECT COUNT(*) AS pending FROM sync_jobs WHERE entity_type IN ('crm_customer','crm_project_lead') AND status IN ('PENDING','RETRY','RUNNING');`);
    return { pending: Number(count?.pending || 0) };
  }

  async function resolveConflict(conflictId, { resolution, value = null, resolvedBy = "operator" } = {}) {
    await assertSchemaReady();
    const allowed = new Set(["USE_SQLITE", "USE_NOTION", "CUSTOM", "CANCELLED"]);
    if (!allowed.has(resolution)) throw Object.assign(new Error("不支持的冲突处理方式。"), { code: "SYNC_CONFLICT_RESOLUTION_INVALID", retryable: false });
    assertReducedSyncPayload({ value });
    const db = await database();
    const at = clock().toISOString();
    await db.exec(`UPDATE sync_conflicts SET resolution=${sqlValue(resolution)},resolved_value_json=${sqlValue(JSON.stringify(value))},
      resolved_by=${sqlValue(clean(resolvedBy).slice(0, 100))},resolved_at=${sqlValue(at)}
      WHERE conflict_id=${sqlValue(conflictId)} AND resolution='PENDING';`);
    const [row] = await db.query(`SELECT conflict_id AS conflictId,resolution,resolved_at AS resolvedAt FROM sync_conflicts WHERE conflict_id=${sqlValue(conflictId)};`);
    return row || null;
  }

  async function conflictDetail(conflictId) {
    await assertSchemaReady();
    const db = await database();
    const [row] = await db.query(`SELECT c.conflict_id AS conflictId,c.inbox_id AS inboxId,c.entity_type AS entityType,
      c.entity_id AS entityId,c.field_name AS fieldName,c.base_value_json AS baseValueJson,
      c.sqlite_value_json AS sqliteValueJson,c.notion_value_json AS notionValueJson,c.resolution,
      i.notion_page_id AS notionPageId,i.notion_database_id AS notionDatabaseId,i.notion_edited_at AS notionEditedAt,
      i.payload_json AS payloadJson
      FROM sync_conflicts c LEFT JOIN sync_inbox i ON i.inbox_id=c.inbox_id
      WHERE c.conflict_id=${sqlValue(conflictId)} LIMIT 1;`);
    if (!row) return null;
    return {
      ...row,
      baseValue: parseJson(row.baseValueJson, null),
      sqliteValue: parseJson(row.sqliteValueJson, null),
      notionValue: parseJson(row.notionValueJson, null),
      payload: parseJson(row.payloadJson, {}),
    };
  }

  async function finalizeConflictState(detail) {
    await assertSchemaReady();
    const db = await database();
    const at = clock().toISOString();
    const [entityOpen] = await db.query(`SELECT COUNT(*) AS count FROM sync_conflicts WHERE entity_type=${sqlValue(detail.entityType)} AND entity_id=${sqlValue(detail.entityId)} AND resolution='PENDING';`);
    const [inboxOpen] = await db.query(`SELECT COUNT(*) AS count FROM sync_conflicts WHERE inbox_id=${sqlValue(detail.inboxId)} AND resolution='PENDING';`);
    const syncStatus = Number(entityOpen?.count || 0) ? "CONFLICT" : "PENDING";
    await db.exec(`UPDATE notion_entity_map SET sync_status=${sqlValue(syncStatus)} WHERE entity_type=${sqlValue(detail.entityType)} AND sqlite_entity_id=${sqlValue(detail.entityId)};
      UPDATE sync_inbox SET status=${sqlValue(Number(inboxOpen?.count || 0) ? "CONFLICT" : "APPLIED")},applied_at=${sqlValue(at)} WHERE inbox_id=${sqlValue(detail.inboxId)};`);
    if (syncStatus === "PENDING") await enqueueDirtyEntities();
    return { syncStatus, openEntityConflicts: Number(entityOpen?.count || 0), openInboxConflicts: Number(inboxOpen?.count || 0) };
  }

  async function queueSnapshot({ limit = 50 } = {}) {
    await assertSchemaReady();
    const db = await database();
    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 500));
    const [outbox, inbox, conflicts] = await Promise.all([
      db.query(`SELECT id AS jobId,idempotency_key AS idempotencyKey,entity_type AS entityType,entity_id AS entityId,status,attempt_count AS attemptCount,available_at AS availableAt,last_error_code AS errorCode,last_error_message AS errorMessage FROM sync_jobs ORDER BY updated_at DESC LIMIT ${safeLimit};`),
      db.query(`SELECT inbox_id AS inboxId,entity_type AS entityType,entity_id AS entityId,status,notion_edited_at AS notionEditedAt,error_code AS errorCode,error_message AS errorMessage FROM sync_inbox ORDER BY received_at DESC LIMIT ${safeLimit};`),
      db.query(`SELECT conflict_id AS conflictId,entity_type AS entityType,entity_id AS entityId,field_name AS fieldName,resolution,detected_at AS detectedAt FROM sync_conflicts ORDER BY detected_at DESC LIMIT ${safeLimit};`),
    ]);
    return { outbox, inbox, conflicts };
  }

  async function reconciliationLocalState() {
    await assertSchemaReady();
    const db = await database();
    const [counts] = await db.query(`SELECT
      (SELECT COUNT(*) FROM contacts) AS customers,
      (SELECT COUNT(*) FROM project_leads) AS projectLeads,
      (SELECT COUNT(*) FROM notion_entity_map) AS mappings,
      (SELECT COUNT(*) FROM notion_entity_map WHERE sync_status='ARCHIVED') AS archivedPages,
      (SELECT COUNT(*) FROM sync_jobs WHERE status='FAILED') AS failedOutbox,
      (SELECT COUNT(*) FROM sync_inbox WHERE status='FAILED') AS failedInbox,
      (SELECT COUNT(*) FROM sync_conflicts WHERE resolution='PENDING') AS conflicts,
      (SELECT COUNT(*) FROM sync_jobs WHERE status='RUNNING' AND updated_at < datetime('now','-15 minutes')) AS stuckOutbox;`);
    return counts;
  }

  async function recordReconciliation({ runId, mode, status, report, startedAt, finishedAt }) {
    const db = await database();
    assertReducedSyncPayload(report);
    await db.exec(`INSERT INTO sync_reconciliation_runs(run_id,mode,status,report_json,started_at,finished_at)
      VALUES (${sqlValue(runId)},${sqlValue(mode)},${sqlValue(status)},${sqlValue(JSON.stringify(report))},${sqlValue(startedAt)},${sqlValue(finishedAt)})
      ON CONFLICT(run_id) DO UPDATE SET status=excluded.status,report_json=excluded.report_json,finished_at=excluded.finished_at;`);
    if (status === "COMPLETED") {
      await db.exec(`UPDATE sync_worker_state SET last_reconciled_at=${sqlValue(finishedAt)},updated_at=${sqlValue(finishedAt)} WHERE id='singleton';`);
    }
  }

  return {
    schemaStatus,
    assertSchemaReady,
    loadCustomer,
    loadProjectLead,
    findEntityByStableId,
    mapping,
    mappingByStableId,
    upsertMapping,
    receiveInbox,
    dueInbox,
    markInbox,
    createConflicts,
    applyCustomerHumanFields,
    applyProjectLeadHumanFields,
    recordPush,
    setWorkerPaused,
    workerHealth,
    markWorkerRun,
    markPullCompleted,
    listMappings,
    enqueueDirtyEntities,
    resolveConflict,
    conflictDetail,
    finalizeConflictState,
    queueSnapshot,
    reconciliationLocalState,
    recordReconciliation,
  };
}
