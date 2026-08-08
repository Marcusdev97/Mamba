import crypto from "node:crypto";
import path from "node:path";
import {
  assertNoNameOnlyMerge,
  identityId,
  identityKey,
  messageIdentityEvidence,
  newCustomerId,
} from "../domain/customer-identity.mjs";
import { createSqliteCli, sqlValue } from "./sqlite-cli.mjs";

const REQUIRED_TABLES = Object.freeze([
  "customers",
  "customer_identities",
  "identity_conflicts",
  "identity_unresolved_events",
  "customer_merge_events",
  "identity_backfill_state",
]);

function clean(value) {
  return String(value ?? "").trim();
}

function parseJson(value, fallback) {
  try { return JSON.parse(value || ""); } catch { return fallback; }
}

function digest(prefix, ...parts) {
  return `${prefix}_${crypto.createHash("sha256").update(parts.map(clean).join("\u001f")).digest("hex").slice(0, 24)}`;
}

function sqlList(values) {
  return values.length ? values.map(sqlValue).join(",") : "NULL";
}

export function createCustomerIdentityRepository({ dataDir, sqliteBinary = "", clock = () => new Date() } = {}) {
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
    const [migration] = await db.query("SELECT version FROM schema_migrations WHERE version=305 LIMIT 1;").catch(() => []);
    const missing = REQUIRED_TABLES.filter((table) => !present.has(table));
    return { ready: Boolean(migration) && missing.length === 0, migration: migration?.version || null, missing };
  }

  async function assertReady() {
    const status = await schemaStatus();
    if (status.ready) return status;
    const error = new Error(`Customer Identity schema 尚未就绪：${status.missing.join(", ") || "migration 305 未记录"}。`);
    error.code = "CUSTOMER_IDENTITY_SCHEMA_REQUIRED";
    error.retryable = false;
    error.schema = status;
    throw error;
  }

  function observationForRow(row) {
    return messageIdentityEvidence({
      phone: row.phone || row.contactKey,
      contactKey: row.contactKey,
      remoteJid: row.remoteJid,
      lid: row.lid,
      importId: row.importId,
      notionPageId: row.notionPageId,
    });
  }

  async function resolveRows(rows = [], { source = "message", createIfMissing = true } = {}) {
    const status = await schemaStatus();
    if (!status.ready) return { rows: rows.map((row) => ({ ...row, customerId: null })), conflicts: [], legacy: true };
    const db = await database();
    const now = clock().toISOString();
    const prepared = rows.map((row) => ({ row, observations: observationForRow(row) }));
    const keys = [...new Set(prepared.flatMap((item) => item.observations.map((identity) => identityKey(identity.type, identity.value))).filter(Boolean))];
    const existing = new Map();
    if (keys.length) {
      const clauses = keys.map((key) => {
        const split = key.indexOf(":");
        return `(identity_type=${sqlValue(key.slice(0, split))} AND identity_value=${sqlValue(key.slice(split + 1))})`;
      });
      for (const row of await db.query(`SELECT identity_type AS type,identity_value AS value,customer_id AS customerId,confidence,status FROM customer_identities WHERE status='ACTIVE' AND (${clauses.join(" OR ")});`)) {
        existing.set(identityKey(row.type, row.value), row);
      }
    }

    const customerStatements = [];
    const identityStatements = [];
    const conflictStatements = [];
    const unresolvedStatements = [];
    const resolvedRows = [];
    const conflicts = [];

    for (const item of prepared) {
      const candidates = [...new Set(item.observations.map((identity) => existing.get(identityKey(identity.type, identity.value))?.customerId).filter(Boolean))];
      if (candidates.length > 1) {
        const conflictId = digest("identity_conflict", ...candidates.sort(), ...item.observations.map((identity) => identityKey(identity.type, identity.value)).sort());
        const [priorDecision] = await db.query(`SELECT status,resolution,resolved_customer_id AS resolvedCustomerId FROM identity_conflicts WHERE conflict_id=${sqlValue(conflictId)} LIMIT 1;`);
        // KEEP_EXISTING is an explicit operator decision: on replay, place the event
        // on that customer without moving any of the contradictory aliases.
        if (priorDecision?.status === "RESOLVED" && priorDecision.resolution === "KEEP_EXISTING" && priorDecision.resolvedCustomerId) {
          resolvedRows.push({ ...item.row, customerId: priorDecision.resolvedCustomerId, identityResolution: "KEEP_EXISTING" });
          continue;
        }
        if (priorDecision?.status === "DISMISSED") {
          conflicts.push({ conflictId, customerIds: candidates, externalMessageId: clean(item.row.externalMessageId || item.row.id), dismissed: true });
          resolvedRows.push({ ...item.row, customerId: null, identityConflict: conflictId });
          continue;
        }
        const contested = item.observations.find((identity) => identity.type === "WHATSAPP_LID" && existing.has(identityKey(identity.type, identity.value)))
          || item.observations.find((identity) => existing.has(identityKey(identity.type, identity.value)))
          || item.observations[0];
        const existingCustomerId = existing.get(identityKey(contested?.type, contested?.value))?.customerId || candidates[0];
        const candidateCustomerId = candidates.find((customerId) => customerId !== existingCustomerId) || candidates[1];
        const evidence = {
          identities: item.observations.map(({ type, value, confidence }) => ({ type, value, confidence })),
          externalMessageId: clean(item.row.externalMessageId || item.row.id),
          observedAt: item.row.sentAt || now,
          source,
        };
        conflictStatements.push(`INSERT INTO identity_conflicts(conflict_id,identity_type,identity_value,existing_customer_id,candidate_customer_id,connection_key,evidence_json,status,first_seen_at,last_seen_at)
          VALUES (${sqlValue(conflictId)},${sqlValue(contested?.type || "LEGACY_CONTACT_KEY")},${sqlValue(contested?.value || item.row.contactKey)},${sqlValue(existingCustomerId)},${sqlValue(candidateCustomerId)},${sqlValue(item.row.connectionKey)},${sqlValue(JSON.stringify(evidence))},'OPEN',${sqlValue(now)},${sqlValue(now)})
          ON CONFLICT(identity_type,identity_value,existing_customer_id,candidate_customer_id) DO UPDATE SET last_seen_at=excluded.last_seen_at,evidence_json=excluded.evidence_json,status='OPEN';`);
        const unresolvedSubject = clean(item.row.externalMessageId || item.row.id)
          || item.observations.map((identity) => identityKey(identity.type, identity.value)).sort().join("|");
        const unresolvedKey = `identity:${clean(item.row.connectionKey)}:${unresolvedSubject}`;
        unresolvedStatements.push(`INSERT INTO identity_unresolved_events(event_id,idempotency_key,external_message_id,connection_key,remote_jid,evidence_json,conflict_id,status,first_seen_at,last_seen_at)
          VALUES (${sqlValue(digest("unresolved", unresolvedKey))},${sqlValue(unresolvedKey)},${sqlValue(item.row.externalMessageId || item.row.id)},${sqlValue(item.row.connectionKey)},${sqlValue(item.row.remoteJid)},${sqlValue(JSON.stringify(evidence))},${sqlValue(conflictId)},'PENDING',${sqlValue(now)},${sqlValue(now)})
          ON CONFLICT(idempotency_key) DO UPDATE SET last_seen_at=excluded.last_seen_at,conflict_id=excluded.conflict_id;`);
        conflicts.push({ conflictId, customerIds: candidates, externalMessageId: clean(item.row.externalMessageId || item.row.id) });
        resolvedRows.push({ ...item.row, customerId: null, identityConflict: conflictId });
        continue;
      }

      let customerId = candidates[0] || "";
      if (!customerId && createIfMissing) {
        assertNoNameOnlyMerge({ identities: item.observations, name: item.row.name });
        customerId = newCustomerId();
        const phone = item.observations.find((identity) => identity.type === "PHONE_E164")?.value || null;
        customerStatements.push(`INSERT INTO customers(customer_id,display_name,primary_phone,global_status,created_at,updated_at)
          VALUES (${sqlValue(customerId)},${sqlValue(clean(item.row.name))},${sqlValue(phone)},'Active',${sqlValue(now)},${sqlValue(now)});`);
      }
      if (!customerId) {
        resolvedRows.push({ ...item.row, customerId: null });
        continue;
      }

      customerStatements.push(`UPDATE customers SET display_name=CASE WHEN display_name='' AND ${sqlValue(clean(item.row.name))}<>'' THEN ${sqlValue(clean(item.row.name))} ELSE display_name END,updated_at=${sqlValue(now)} WHERE customer_id=${sqlValue(customerId)};`);
      for (const identity of item.observations) {
        const key = identityKey(identity.type, identity.value);
        if (!key) continue;
        identityStatements.push(`INSERT INTO customer_identities(identity_id,customer_id,identity_type,identity_value,connection_key,confidence,source,status,first_seen_at,last_seen_at,verified_at)
          VALUES (${sqlValue(identityId(identity.type, identity.value))},${sqlValue(customerId)},${sqlValue(identity.type)},${sqlValue(identity.value)},${sqlValue(item.row.connectionKey)},${Number(identity.confidence || 0)},${sqlValue(source)},'ACTIVE',${sqlValue(now)},${sqlValue(now)},${identity.confidence >= 90 ? sqlValue(now) : "NULL"})
          ON CONFLICT(identity_type,identity_value) DO UPDATE SET last_seen_at=excluded.last_seen_at,
            connection_key=COALESCE(excluded.connection_key,customer_identities.connection_key),
            confidence=MAX(customer_identities.confidence,excluded.confidence),
            verified_at=COALESCE(customer_identities.verified_at,excluded.verified_at)
          WHERE customer_identities.customer_id=excluded.customer_id;`);
        existing.set(key, { customerId, confidence: identity.confidence, status: "ACTIVE" });
      }
      resolvedRows.push({ ...item.row, customerId });
    }

    const statements = [...customerStatements, ...identityStatements, ...conflictStatements, ...unresolvedStatements];
    if (statements.length) await db.exec(`BEGIN IMMEDIATE;\n${statements.join("\n")}\nCOMMIT;`);
    return { rows: resolvedRows, conflicts, legacy: false };
  }

  async function observeLidPhone({ lid, phone, connectionKey = null, source = "live", externalMessageId = "", observedAt = null } = {}) {
    const row = {
      id: externalMessageId || digest("lid_observation", lid, phone, observedAt || clock().toISOString()),
      externalMessageId,
      contactKey: phone,
      phone,
      lid,
      remoteJid: `${clean(lid).replace(/\D/g, "")}@lid`,
      connectionKey,
      sentAt: observedAt || clock().toISOString(),
    };
    const result = await resolveRows([row], { source, createIfMissing: true });
    return { customerId: result.rows[0]?.customerId || null, conflict: result.conflicts[0] || null };
  }

  async function customerDetail(customerId) {
    await assertReady();
    const db = await database();
    const [customer] = await db.query(`SELECT customer_id AS customerId,display_name AS displayName,primary_phone AS primaryPhone,global_status AS globalStatus,merged_into_customer_id AS mergedIntoCustomerId,row_version AS rowVersion,created_at AS createdAt,updated_at AS updatedAt FROM customers WHERE customer_id=${sqlValue(customerId)} LIMIT 1;`);
    if (!customer) return null;
    const [identities, conversations, merges] = await Promise.all([
      db.query(`SELECT identity_id AS identityId,identity_type AS identityType,identity_value AS identityValue,connection_key AS connectionKey,confidence,source,status,first_seen_at AS firstSeenAt,last_seen_at AS lastSeenAt,verified_at AS verifiedAt FROM customer_identities WHERE customer_id=${sqlValue(customerId)} ORDER BY confidence DESC,last_seen_at DESC;`),
      db.query(`SELECT v.id AS conversationId,v.connection_key AS connectionKey,w.whatsapp_number AS whatsappNumber,v.last_message_at AS lastMessageAt FROM conversations v LEFT JOIN whatsapp_connections w ON w.connection_key=v.connection_key WHERE v.customer_id=${sqlValue(customerId)} ORDER BY v.last_message_at DESC;`),
      db.query(`SELECT merge_id AS mergeId,surviving_customer_id AS survivingCustomerId,duplicate_customer_id AS duplicateCustomerId,status,reason,created_by AS createdBy,created_at AS createdAt,reversed_at AS reversedAt FROM customer_merge_events WHERE surviving_customer_id=${sqlValue(customerId)} OR duplicate_customer_id=${sqlValue(customerId)} ORDER BY created_at DESC;`),
    ]);
    return { ...customer, identities, conversations, merges };
  }

  async function listCustomers({ limit = 100, query = "" } = {}) {
    await assertReady();
    const db = await database();
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
    const q = clean(query);
    const filter = q ? `WHERE c.customer_id LIKE ${sqlValue(`%${q}%`)} OR c.display_name LIKE ${sqlValue(`%${q}%`)} OR c.primary_phone LIKE ${sqlValue(`%${q.replace(/\D/g, "")}%`)}` : "";
    return db.query(`SELECT c.customer_id AS customerId,c.display_name AS displayName,c.primary_phone AS primaryPhone,c.global_status AS globalStatus,c.updated_at AS updatedAt,(SELECT COUNT(*) FROM customer_identities i WHERE i.customer_id=c.customer_id AND i.status='ACTIVE') AS identityCount FROM customers c ${filter} ORDER BY c.updated_at DESC LIMIT ${safeLimit};`);
  }

  async function listConflicts({ limit = 100, status = "OPEN" } = {}) {
    await assertReady();
    const db = await database();
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
    return db.query(`SELECT conflict_id AS conflictId,identity_type AS identityType,identity_value AS identityValue,existing_customer_id AS existingCustomerId,candidate_customer_id AS candidateCustomerId,connection_key AS connectionKey,evidence_json AS evidenceJson,status,resolution,first_seen_at AS firstSeenAt,last_seen_at AS lastSeenAt,resolved_at AS resolvedAt,resolved_by AS resolvedBy FROM identity_conflicts WHERE status=${sqlValue(status)} ORDER BY last_seen_at DESC LIMIT ${safeLimit};`).then((rows) => rows.map((row) => ({ ...row, evidence: parseJson(row.evidenceJson, {}) })));
  }

  async function resolveConflict(conflictId, { action, resolvedCustomerId = "", resolvedBy = "operator" } = {}) {
    await assertReady();
    const allowed = new Set(["KEEP_EXISTING", "MOVE_IDENTITY", "DISMISS"]);
    if (!allowed.has(action)) throw Object.assign(new Error("不支持的 identity conflict resolution。"), { code: "IDENTITY_CONFLICT_RESOLUTION_INVALID" });
    if (action === "MOVE_IDENTITY") {
      const active = await activeCampaigns();
      if (active.length) throw Object.assign(new Error("仍有活动 Campaign，禁止移动 customer identity。"), { code: "ACTIVE_CAMPAIGN_BLOCKS_IDENTITY_MOVE", activeCampaigns: active });
    }
    const db = await database();
    const [conflict] = await db.query(`SELECT * FROM identity_conflicts WHERE conflict_id=${sqlValue(conflictId)} LIMIT 1;`);
    if (!conflict) return null;
    if (action === "MOVE_IDENTITY" && ["PHONE_E164", "LEGACY_CONTACT_KEY"].includes(conflict.identity_type)) {
      throw Object.assign(new Error("Phone/contact key 不能单独移动；请使用 audited customer merge，避免留下不一致的 contact。"), { code: "IDENTITY_CONFLICT_MOVE_REQUIRES_CUSTOMER_MERGE" });
    }
    const selected = action === "KEEP_EXISTING" ? conflict.existing_customer_id : clean(resolvedCustomerId);
    if (action === "MOVE_IDENTITY" && !selected) throw Object.assign(new Error("MOVE_IDENTITY 需要 resolvedCustomerId。"), { code: "IDENTITY_CONFLICT_CUSTOMER_REQUIRED" });
    if (selected) {
      const [target] = await db.query(`SELECT customer_id FROM customers WHERE customer_id=${sqlValue(selected)} LIMIT 1;`);
      if (!target) throw Object.assign(new Error("指定的 customer_id 不存在。"), { code: "IDENTITY_CONFLICT_CUSTOMER_NOT_FOUND" });
    }
    const now = clock().toISOString();
    const move = action === "MOVE_IDENTITY" ? `UPDATE customer_identities SET customer_id=${sqlValue(selected)},status='ACTIVE',last_seen_at=${sqlValue(now)} WHERE identity_type=${sqlValue(conflict.identity_type)} AND identity_value=${sqlValue(conflict.identity_value)};` : "";
    await db.exec(`BEGIN IMMEDIATE;
${move}
UPDATE identity_conflicts SET status=${sqlValue(action === "DISMISS" ? "DISMISSED" : "RESOLVED")},resolution=${sqlValue(action)},resolved_customer_id=${sqlValue(selected || null)},resolved_at=${sqlValue(now)},resolved_by=${sqlValue(clean(resolvedBy))} WHERE conflict_id=${sqlValue(conflictId)};
UPDATE identity_unresolved_events SET status=${sqlValue(action === "DISMISS" ? "DISMISSED" : "RESOLVED")},resolved_at=${sqlValue(now)} WHERE conflict_id=${sqlValue(conflictId)};
COMMIT;`);
    return { conflictId, action, resolvedCustomerId: selected || null };
  }

  async function activeCampaigns() {
    const db = await database();
    return db.query("SELECT run_id AS runId,status,mode,started_at AS startedAt FROM campaign_runs WHERE status IN ('RUNNING','SENDING','QUEUED_BATCH') ORDER BY started_at DESC;");
  }

  async function mergePlan({ survivingCustomerId, duplicateCustomerId } = {}) {
    await assertReady();
    if (!survivingCustomerId || !duplicateCustomerId || survivingCustomerId === duplicateCustomerId) throw Object.assign(new Error("Merge 需要两个不同 customer_id。"), { code: "CUSTOMER_MERGE_IDS_INVALID" });
    const db = await database();
    const customers = await db.query(`SELECT customer_id AS customerId,global_status AS globalStatus,merged_into_customer_id AS mergedIntoCustomerId FROM customers WHERE customer_id IN (${sqlList([survivingCustomerId, duplicateCustomerId])});`);
    if (customers.length !== 2) throw Object.assign(new Error("Merge customer 不完整或不存在。"), { code: "CUSTOMER_MERGE_CUSTOMER_NOT_FOUND" });
    const [contacts, conversations, messages, projectLeads, identities] = await Promise.all([
      db.query(`SELECT contact_key AS id FROM contacts WHERE customer_id=${sqlValue(duplicateCustomerId)};`),
      db.query(`SELECT id FROM conversations WHERE customer_id=${sqlValue(duplicateCustomerId)};`),
      db.query(`SELECT row_id AS id FROM messages WHERE customer_id=${sqlValue(duplicateCustomerId)};`),
      db.query(`SELECT project_lead_key AS id FROM project_leads WHERE customer_id=${sqlValue(duplicateCustomerId)};`),
      db.query(`SELECT identity_id AS id FROM customer_identities WHERE customer_id=${sqlValue(duplicateCustomerId)};`),
    ]);
    const duplicate = customers.find((item) => item.customerId === duplicateCustomerId);
    const survivor = customers.find((item) => item.customerId === survivingCustomerId);
    if (duplicate.mergedIntoCustomerId || duplicate.globalStatus === "Merged" || survivor.mergedIntoCustomerId || survivor.globalStatus === "Merged") {
      throw Object.assign(new Error("已合并的 customer 不能直接再次 merge；请先还原原 merge。"), { code: "CUSTOMER_MERGE_CHAIN_FORBIDDEN" });
    }
    return {
      survivingCustomerId,
      duplicateCustomerId,
      snapshot: {
        duplicateStatus: duplicate.globalStatus,
        duplicateMergedInto: duplicate.mergedIntoCustomerId,
        contacts: contacts.map((row) => row.id),
        conversations: conversations.map((row) => row.id),
        messages: messages.map((row) => Number(row.id)),
        projectLeads: projectLeads.map((row) => row.id),
        identities: identities.map((row) => row.id),
      },
      counts: { contacts: contacts.length, conversations: conversations.length, messages: messages.length, projectLeads: projectLeads.length, identities: identities.length },
    };
  }

  async function applyMerge({ survivingCustomerId, duplicateCustomerId, confirmation = "", reason = "", createdBy = "operator" } = {}) {
    const plan = await mergePlan({ survivingCustomerId, duplicateCustomerId });
    if (confirmation !== "MERGE_CUSTOMER_IDENTITIES") throw Object.assign(new Error("Merge 需要确认 token MERGE_CUSTOMER_IDENTITIES。"), { code: "CUSTOMER_MERGE_CONFIRMATION_REQUIRED", plan });
    const active = await activeCampaigns();
    if (active.length) throw Object.assign(new Error("仍有活动 Campaign，禁止移动 customer identity。"), { code: "ACTIVE_CAMPAIGN_BLOCKS_CUSTOMER_MERGE", activeCampaigns: active });
    const db = await database();
    const now = clock().toISOString();
    const mergeId = digest("customer_merge", survivingCustomerId, duplicateCustomerId, now);
    const updateIds = (table, column, ids) => ids.length ? `UPDATE ${table} SET customer_id=${sqlValue(survivingCustomerId)} WHERE ${column} IN (${sqlList(ids)});` : "";
    await db.exec(`BEGIN IMMEDIATE;
${updateIds("contacts", "contact_key", plan.snapshot.contacts)}
${updateIds("conversations", "id", plan.snapshot.conversations)}
${updateIds("messages", "row_id", plan.snapshot.messages)}
${updateIds("project_leads", "project_lead_key", plan.snapshot.projectLeads)}
${plan.snapshot.identities.length ? `UPDATE customer_identities SET customer_id=${sqlValue(survivingCustomerId)} WHERE identity_id IN (${sqlList(plan.snapshot.identities)});` : ""}
UPDATE customers SET global_status='Merged',merged_into_customer_id=${sqlValue(survivingCustomerId)},updated_at=${sqlValue(now)} WHERE customer_id=${sqlValue(duplicateCustomerId)};
INSERT INTO customer_merge_events(merge_id,surviving_customer_id,duplicate_customer_id,status,snapshot_json,moved_counts_json,reason,created_by,created_at)
VALUES (${sqlValue(mergeId)},${sqlValue(survivingCustomerId)},${sqlValue(duplicateCustomerId)},'APPLIED',${sqlValue(JSON.stringify(plan.snapshot))},${sqlValue(JSON.stringify(plan.counts))},${sqlValue(clean(reason))},${sqlValue(clean(createdBy))},${sqlValue(now)});
COMMIT;`);
    return { mergeId, ...plan };
  }

  async function reverseMerge(mergeId, { confirmation = "", reversedBy = "operator" } = {}) {
    await assertReady();
    if (confirmation !== "REVERSE_CUSTOMER_MERGE") throw Object.assign(new Error("Reverse 需要确认 token REVERSE_CUSTOMER_MERGE。"), { code: "CUSTOMER_MERGE_REVERSE_CONFIRMATION_REQUIRED" });
    const active = await activeCampaigns();
    if (active.length) throw Object.assign(new Error("仍有活动 Campaign，禁止还原 customer merge。"), { code: "ACTIVE_CAMPAIGN_BLOCKS_CUSTOMER_MERGE", activeCampaigns: active });
    const db = await database();
    const [event] = await db.query(`SELECT * FROM customer_merge_events WHERE merge_id=${sqlValue(mergeId)} AND status='APPLIED' LIMIT 1;`);
    if (!event) return null;
    const snapshot = parseJson(event.snapshot_json, {});
    const duplicate = event.duplicate_customer_id;
    const survivor = event.surviving_customer_id;
    const now = clock().toISOString();
    const expected = {
      contacts: snapshot.contacts || [], conversations: snapshot.conversations || [], messages: snapshot.messages || [],
      projectLeads: snapshot.projectLeads || [], identities: snapshot.identities || [],
    };
    const countOwned = async (table, column, ids) => {
      if (!ids.length) return 0;
      const [row] = await db.query(`SELECT COUNT(*) AS count FROM ${table} WHERE customer_id=${sqlValue(survivor)} AND ${column} IN (${sqlList(ids)});`);
      return Number(row?.count || 0);
    };
    const owned = {
      contacts: await countOwned("contacts", "contact_key", expected.contacts),
      conversations: await countOwned("conversations", "id", expected.conversations),
      messages: await countOwned("messages", "row_id", expected.messages),
      projectLeads: await countOwned("project_leads", "project_lead_key", expected.projectLeads),
      identities: await countOwned("customer_identities", "identity_id", expected.identities),
    };
    const drift = Object.keys(expected).filter((key) => owned[key] !== expected[key].length);
    if (drift.length) throw Object.assign(new Error(`Merge snapshot 已发生后续变化，禁止部分还原：${drift.join(", ")}。`), { code: "CUSTOMER_MERGE_REVERSE_DRIFT", drift, expected, owned });
    const updateIds = (table, column, ids) => Array.isArray(ids) && ids.length ? `UPDATE ${table} SET customer_id=${sqlValue(duplicate)} WHERE customer_id=${sqlValue(survivor)} AND ${column} IN (${sqlList(ids)});` : "";
    await db.exec(`BEGIN IMMEDIATE;
${updateIds("contacts", "contact_key", snapshot.contacts)}
${updateIds("conversations", "id", snapshot.conversations)}
${updateIds("messages", "row_id", snapshot.messages)}
${updateIds("project_leads", "project_lead_key", snapshot.projectLeads)}
${Array.isArray(snapshot.identities) && snapshot.identities.length ? `UPDATE customer_identities SET customer_id=${sqlValue(duplicate)} WHERE customer_id=${sqlValue(survivor)} AND identity_id IN (${sqlList(snapshot.identities)});` : ""}
UPDATE customers SET global_status=${sqlValue(snapshot.duplicateStatus || "Active")},merged_into_customer_id=${sqlValue(snapshot.duplicateMergedInto || null)},updated_at=${sqlValue(now)} WHERE customer_id=${sqlValue(duplicate)};
UPDATE customer_merge_events SET status='REVERSED',reversed_at=${sqlValue(now)},reason=reason || ${sqlValue(`Reversed by ${clean(reversedBy)}`)} WHERE merge_id=${sqlValue(mergeId)};
COMMIT;`);
    return { mergeId, status: "REVERSED", duplicateCustomerId: duplicate };
  }

  async function saveBackfillState(sourceKey, state) {
    await assertReady();
    const db = await database();
    const now = clock().toISOString();
    await db.exec(`INSERT INTO identity_backfill_state(source_key,status,cursor_json,processed_count,unresolved_count,started_at,updated_at,completed_at,error_code,error_message)
      VALUES (${sqlValue(sourceKey)},${sqlValue(state.status || "RUNNING")},${sqlValue(JSON.stringify(state.cursor || {}))},${Number(state.processedCount || 0)},${Number(state.unresolvedCount || 0)},${sqlValue(state.startedAt || now)},${sqlValue(now)},${sqlValue(state.completedAt || null)},${sqlValue(state.errorCode || "")},${sqlValue(clean(state.errorMessage).slice(0, 500))})
      ON CONFLICT(source_key) DO UPDATE SET status=excluded.status,cursor_json=excluded.cursor_json,processed_count=excluded.processed_count,unresolved_count=excluded.unresolved_count,updated_at=excluded.updated_at,completed_at=excluded.completed_at,error_code=excluded.error_code,error_message=excluded.error_message;`);
  }

  async function loadBackfillState(sourceKey) {
    await assertReady();
    const db = await database();
    const [row] = await db.query(`SELECT source_key AS sourceKey,status,cursor_json AS cursorJson,processed_count AS processedCount,unresolved_count AS unresolvedCount,started_at AS startedAt,updated_at AS updatedAt,completed_at AS completedAt,error_code AS errorCode,error_message AS errorMessage FROM identity_backfill_state WHERE source_key=${sqlValue(sourceKey)} LIMIT 1;`);
    return row ? { ...row, cursor: parseJson(row.cursorJson, {}) } : null;
  }

  return {
    databasePath,
    schemaStatus,
    assertReady,
    resolveRows,
    observeLidPhone,
    customerDetail,
    listCustomers,
    listConflicts,
    resolveConflict,
    activeCampaigns,
    mergePlan,
    applyMerge,
    reverseMerge,
    saveBackfillState,
    loadBackfillState,
  };
}
