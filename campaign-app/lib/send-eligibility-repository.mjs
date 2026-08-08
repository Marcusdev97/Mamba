import crypto from "node:crypto";
import path from "node:path";
import { createSqliteCli, sqlValue } from "./sqlite-cli.mjs";

const REQUIRED_TABLES = Object.freeze([
  "customers",
  "send_eligibility_decisions",
  "send_eligibility_locks",
  "global_suppressions",
  "customer_follow_up_tasks",
  "customer_state_events",
]);

function clean(value) {
  return String(value ?? "").trim();
}

function normalizePhone(value) {
  let digits = clean(value).replace(/\D/g, "");
  if (clean(value).startsWith("00")) digits = digits.slice(2);
  else if (digits.startsWith("0")) digits = `60${digits.slice(1)}`;
  return /^[1-9]\d{7,14}$/.test(digits) ? digits : "";
}

function digest(prefix, ...parts) {
  return `${prefix}_${crypto.createHash("sha256").update(parts.map(clean).join("\u001f")).digest("hex").slice(0, 28)}`;
}

function recipientKey({ customerId = "", phone = "" } = {}) {
  return customerId ? `customer:${customerId}` : digest("recipient", normalizePhone(phone));
}

function parseJson(value, fallback = {}) {
  try { return JSON.parse(value || ""); } catch { return fallback; }
}

export function createSendEligibilityRepository({ dataDir, sqliteBinary = "", clock = () => new Date() } = {}) {
  const databasePath = path.join(dataDir, "mamba.sqlite");
  let databasePromise = null;

  function database() {
    if (!databasePromise) databasePromise = createSqliteCli({ databasePath, sqliteBinary }).catch((error) => {
      databasePromise = null;
      throw error;
    });
    return databasePromise;
  }

  async function membershipTable() {
    const db = await database();
    const rows = await db.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('campaign_members','campaign_memberships');");
    return rows.some((row) => row.name === "campaign_members") ? "campaign_members" : rows.some((row) => row.name === "campaign_memberships") ? "campaign_memberships" : "";
  }

  async function schemaStatus() {
    const db = await database();
    const rows = await db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${REQUIRED_TABLES.map(sqlValue).join(",")});`);
    const present = new Set(rows.map((row) => row.name));
    const memberTable = await membershipTable();
    const [migration] = await db.query("SELECT version FROM schema_migrations WHERE version=306 LIMIT 1;").catch(() => []);
    const missing = REQUIRED_TABLES.filter((table) => !present.has(table));
    if (!memberTable) missing.push("campaign_members|campaign_memberships");
    return { ready: Boolean(migration) && missing.length === 0, migration: migration?.version || null, membershipTable: memberTable, missing };
  }

  async function assertReady() {
    const status = await schemaStatus();
    if (status.ready) return status;
    const error = new Error(`Send Eligibility schema 尚未就绪：${status.missing.join(", ") || "migration 306 未记录"}。`);
    error.code = "SEND_ELIGIBILITY_SCHEMA_REQUIRED";
    error.retryable = false;
    error.schema = status;
    throw error;
  }

  async function loadContext({
    phone,
    customerId = "",
    projectCode = "",
    runId = "",
    campaignId = "",
    connectionKey = "",
    instanceName = "",
    flowTopic = "",
    resendCooldownDays = 0,
    ignoreLockToken = "",
  } = {}) {
    await assertReady();
    const db = await database();
    const normalizedPhone = normalizePhone(phone);
    const cutoff = Number(resendCooldownDays) > 0
      ? new Date(clock().getTime() - Number(resendCooldownDays) * 86400000).toISOString()
      : "";
    const project = clean(projectCode).toLowerCase();
    const rowId = clean(customerId);
    const key = recipientKey({ customerId: rowId, phone: normalizedPhone });
    const memberTable = await membershipTable();
    const memberStatusSql = memberTable === "campaign_members"
      ? `(SELECT status FROM campaign_members cm
          WHERE cm.customer_id=(SELECT customer_id FROM selected_customer)
            AND ((${sqlValue(clean(campaignId))}<>'' AND cm.campaign_id=${sqlValue(clean(campaignId))})
              OR (${sqlValue(clean(runId))}<>'' AND cm.campaign_id=(SELECT campaign_id FROM campaign_runs WHERE run_id=${sqlValue(clean(runId))})))
          ORDER BY cm.updated_at DESC LIMIT 1)`
      : `(SELECT status FROM campaign_memberships cm
          WHERE (${sqlValue(runId)}<>'' AND cm.run_id=${sqlValue(runId)})
            AND (cm.customer_id=(SELECT customer_id FROM selected_customer) OR cm.membership_id=${sqlValue(digest("member", runId || campaignId, key))})
          ORDER BY cm.updated_at DESC LIMIT 1)`;
    const [row] = await db.query(`
WITH selected_customer AS (
  SELECT c.* FROM customers c
  WHERE (${sqlValue(rowId)}<>'' AND c.customer_id=${sqlValue(rowId)})
     OR (${sqlValue(rowId)}='' AND c.primary_phone=${sqlValue(normalizedPhone)})
     OR (${sqlValue(rowId)}='' AND EXISTS(
       SELECT 1 FROM customer_identities i
       WHERE i.customer_id=c.customer_id AND i.identity_type='PHONE_E164'
         AND i.identity_value=${sqlValue(normalizedPhone)} AND i.status='ACTIVE'
     ))
  ORDER BY CASE WHEN c.primary_phone=${sqlValue(normalizedPhone)} THEN 0 ELSE 1 END
  LIMIT 1
), selected_lead AS (
  SELECT p.* FROM project_leads p
  LEFT JOIN projects pr ON pr.project_code=p.project_code
  WHERE p.customer_id=(SELECT customer_id FROM selected_customer)
    AND (${sqlValue(project)}='' OR lower(p.project_code)=${sqlValue(project)} OR lower(pr.project_name)=${sqlValue(project)})
  ORDER BY p.updated_at DESC LIMIT 1
), selected_connection AS (
  SELECT w.* FROM whatsapp_connections w
  WHERE (${sqlValue(connectionKey)}<>'' AND w.connection_key=${sqlValue(connectionKey)})
     OR (${sqlValue(connectionKey)}='' AND ${sqlValue(instanceName)}<>'' AND w.instance_name=${sqlValue(instanceName)})
  ORDER BY w.updated_at DESC LIMIT 1
)
SELECT
  (SELECT customer_id FROM selected_customer) AS customerId,
  (SELECT global_status FROM selected_customer) AS globalStatus,
  (SELECT merged_into_customer_id FROM selected_customer) AS mergedIntoCustomerId,
  (SELECT project_lead_key FROM selected_lead) AS projectLeadKey,
  (SELECT status FROM selected_lead) AS leadStatus,
  (SELECT sequence_status FROM selected_lead) AS sequenceStatus,
  (SELECT snooze_until FROM selected_lead) AS snoozeUntil,
  (SELECT appointment_status FROM selected_lead) AS appointmentStatus,
  (SELECT customer_id FROM selected_customer) IS NOT NULL AS identityValid,
  EXISTS(SELECT 1 FROM contacts ct WHERE ct.customer_id=(SELECT customer_id FROM selected_customer) AND ct.stop_flag=1) AS contactStop,
  EXISTS(SELECT 1 FROM global_suppressions gs WHERE gs.status='ACTIVE' AND (
    gs.customer_id=(SELECT customer_id FROM selected_customer) OR (gs.phone<>'' AND gs.phone=${sqlValue(normalizedPhone)})
  )) AS globallySuppressed,
  ${memberStatusSql} AS memberStatus,
  (SELECT connection_key FROM selected_connection) AS resolvedConnectionKey,
  (SELECT status FROM selected_connection) AS connectionStatus,
  (EXISTS(SELECT 1 FROM send_eligibility_locks l
    WHERE l.recipient_key=${sqlValue(key)} AND l.state='ACTIVE' AND l.expires_at>${sqlValue(clock().toISOString())}
      AND l.lock_token<>${sqlValue(clean(ignoreLockToken))})
   OR EXISTS(SELECT 1 FROM send_jobs sj JOIN project_leads pending_lead ON pending_lead.project_lead_key=sj.project_lead_key
     WHERE pending_lead.customer_id=(SELECT customer_id FROM selected_customer)
       AND sj.status IN ('PENDING','SENDING')
       AND (${sqlValue(clean(runId))}='' OR sj.run_id<>${sqlValue(clean(runId))}))) AS duplicatePending,
  (SELECT expires_at FROM send_eligibility_locks l
    WHERE l.recipient_key=${sqlValue(key)} AND l.state='ACTIVE' ORDER BY acquired_at DESC LIMIT 1) AS lockExpiresAt,
  (SELECT MAX(m.sent_at) FROM messages m WHERE m.customer_id=(SELECT customer_id FROM selected_customer) AND m.direction='inbound') AS lastInboundAt,
  (SELECT MAX(m.sent_at) FROM messages m WHERE m.customer_id=(SELECT customer_id FROM selected_customer) AND m.direction IN ('outbound','operator')) AS lastOutboundAt,
  CASE WHEN ${sqlValue(cutoff)}<>'' AND ${sqlValue(clean(flowTopic))}<>'' THEN EXISTS(
    SELECT 1 FROM messages m WHERE m.customer_id=(SELECT customer_id FROM selected_customer)
      AND m.direction IN ('outbound','operator') AND m.flow_topic=${sqlValue(clean(flowTopic))} AND m.sent_at>=${sqlValue(cutoff)}
  ) ELSE 0 END AS recentFlowAlreadySent;
`);
    const lastInboundMs = new Date(row?.lastInboundAt || "").getTime();
    const lastOutboundMs = new Date(row?.lastOutboundAt || "").getTime();
    return {
      recipientKey: key,
      normalizedPhone,
      customer: {
        customerId: row?.customerId || null,
        globalStatus: row?.globalStatus || (row?.contactStop ? "Stop" : "Active"),
        mergedIntoCustomerId: row?.mergedIntoCustomerId || null,
        identityValid: rowId || normalizedPhone ? Boolean(row?.identityValid) : false,
        phoneValid: Boolean(normalizedPhone),
        stopFlag: Boolean(row?.contactStop),
        isSuppressed: Boolean(row?.globallySuppressed),
        duplicatePending: Boolean(row?.duplicatePending),
        lockExpiresAt: row?.lockExpiresAt || null,
        recentFlowAlreadySent: Boolean(row?.recentFlowAlreadySent),
        resendEligibleAt: null,
      },
      projectLead: {
        projectLeadKey: row?.projectLeadKey || null,
        status: row?.leadStatus || "",
        sequenceStatus: row?.sequenceStatus || "",
        snoozeUntil: row?.snoozeUntil || null,
        appointmentStatus: row?.appointmentStatus || "",
        requiresHandoff: Number.isFinite(lastInboundMs) && (!Number.isFinite(lastOutboundMs) || lastInboundMs > lastOutboundMs),
      },
      campaignMember: {
        status: row?.memberStatus || "PENDING",
        duplicatePending: Boolean(row?.duplicatePending),
        lockExpiresAt: row?.lockExpiresAt || null,
      },
      connection: {
        connectionKey: row?.resolvedConnectionKey || clean(connectionKey),
        available: clean(row?.connectionStatus).toUpperCase() === "OPEN",
        status: row?.connectionStatus || "",
      },
    };
  }

  async function ensureMembership({ recipientKey: key, customerId, projectLeadKey, campaignId = "", runId = "" } = {}) {
    if (!runId && !campaignId) return null;
    await assertReady();
    const db = await database();
    const now = clock().toISOString();
    const membershipId = digest("member", runId || campaignId, key);
    const table = await membershipTable();
    if (table === "campaign_members") {
      const [explicitCampaign] = clean(campaignId) ? await db.query(`SELECT campaign_id AS campaignId FROM campaigns WHERE campaign_id=${sqlValue(clean(campaignId))} LIMIT 1;`) : [];
      const resolvedCampaignId = explicitCampaign?.campaignId || (await db.query(`SELECT campaign_id AS campaignId FROM campaign_runs WHERE run_id=${sqlValue(clean(runId))} LIMIT 1;`))[0]?.campaignId || "";
      if (!resolvedCampaignId || !customerId) return null;
      const canonicalId = digest("campaign_member", resolvedCampaignId, customerId);
      await db.exec(`INSERT INTO campaign_members(campaign_member_id,campaign_id,customer_id,project_lead_id,status,joined_at,created_at,updated_at)
        VALUES (${sqlValue(canonicalId)},${sqlValue(resolvedCampaignId)},${sqlValue(customerId)},${sqlValue(projectLeadKey)},'PENDING',${sqlValue(now)},${sqlValue(now)},${sqlValue(now)})
        ON CONFLICT(campaign_member_id) DO UPDATE SET project_lead_id=COALESCE(campaign_members.project_lead_id,excluded.project_lead_id),updated_at=excluded.updated_at;`);
      return canonicalId;
    }
    await db.exec(`INSERT INTO campaign_memberships(membership_id,customer_id,project_lead_key,campaign_id,run_id,status,created_at,updated_at)
      VALUES (${sqlValue(membershipId)},${sqlValue(customerId)},${sqlValue(projectLeadKey)},${sqlValue(campaignId)},${sqlValue(runId)},'PENDING',${sqlValue(now)},${sqlValue(now)})
      ON CONFLICT(membership_id) DO UPDATE SET
        customer_id=COALESCE(campaign_memberships.customer_id,excluded.customer_id),
        project_lead_key=COALESCE(campaign_memberships.project_lead_key,excluded.project_lead_key),
        updated_at=excluded.updated_at;`);
    return membershipId;
  }

  async function recordDecision({ decision, context, campaign = {}, requestedAction, evaluatedAt = clock().toISOString() } = {}) {
    await assertReady();
    const db = await database();
    const decisionId = `decision_${crypto.randomUUID()}`;
    const state = {
      customer: {
        globalStatus: context.customer.globalStatus,
        identityValid: context.customer.identityValid,
        phoneValid: context.customer.phoneValid,
        isSuppressed: context.customer.isSuppressed,
      },
      projectLead: {
        status: context.projectLead.status,
        sequenceStatus: context.projectLead.sequenceStatus,
        snoozeUntil: context.projectLead.snoozeUntil,
        appointmentStatus: context.projectLead.appointmentStatus,
        requiresHandoff: context.projectLead.requiresHandoff,
      },
      campaignMember: context.campaignMember,
      connection: { available: context.connection.available, status: context.connection.status },
    };
    await db.exec(`INSERT INTO send_eligibility_decisions(
      decision_id,customer_id,project_lead_key,campaign_id,run_id,requested_action,allowed,reason_code,reason,retry_at,required_action,evaluated_state_json,evaluated_at
    ) VALUES (
      ${sqlValue(decisionId)},${sqlValue(context.customer.customerId)},${sqlValue(context.projectLead.projectLeadKey)},
      ${sqlValue(campaign.campaignId || campaign.id)},${sqlValue(campaign.runId)},${sqlValue(requestedAction)},${sqlValue(decision.allowed)},
      ${sqlValue(decision.reason_code)},${sqlValue(decision.reason)},${sqlValue(decision.retry_at)},${sqlValue(decision.required_action)},
      ${sqlValue(JSON.stringify(state))},${sqlValue(evaluatedAt)}
    );`);
    return decisionId;
  }

  async function recordBlockedOutcome({ context, campaign = {}, reasonCode } = {}) {
    const status = ({
      GLOBAL_STOP: "EXIT_STOP",
      CUSTOMER_REPLIED: "PAUSED_REPLY",
      SNOOZED: "PAUSED_SNOOZE",
      APPOINTMENT_EXISTS: "EXIT_APPOINTMENT",
      CUSTOMER_CONVERTED: "EXIT_BOOKED",
    })[clean(reasonCode)];
    if (!status || (!campaign.runId && !campaign.campaignId && !campaign.id)) return false;
    await assertReady();
    const db = await database();
    const now = clock().toISOString();
    const membershipId = digest("member", campaign.runId || campaign.campaignId || campaign.id, context.recipientKey);
    const exited = status.startsWith("EXIT_") ? now : null;
    const table = await membershipTable();
    if (table === "campaign_members") {
      const requestedCampaignId = clean(campaign.campaignId || campaign.id);
      const [explicitCampaign] = requestedCampaignId ? await db.query(`SELECT campaign_id AS campaignId FROM campaigns WHERE campaign_id=${sqlValue(requestedCampaignId)} LIMIT 1;`) : [];
      const resolvedCampaignId = explicitCampaign?.campaignId || (await db.query(`SELECT campaign_id AS campaignId FROM campaign_runs WHERE run_id=${sqlValue(clean(campaign.runId))} LIMIT 1;`))[0]?.campaignId || "";
      await db.exec(`UPDATE campaign_members SET status=${sqlValue(status)},exit_reason=${sqlValue(reasonCode)},updated_at=${sqlValue(now)},exited_at=${sqlValue(exited)},paused_at=CASE WHEN ${sqlValue(status)} LIKE 'PAUSED_%' THEN ${sqlValue(now)} ELSE paused_at END WHERE campaign_id=${sqlValue(resolvedCampaignId)} AND customer_id=${sqlValue(context.customer.customerId)} AND status IN ('PENDING','ACTIVE','PAUSED_REPLY','PAUSED_SNOOZE');`);
    } else await db.exec(`UPDATE campaign_memberships SET status=${sqlValue(status)},reason_code=${sqlValue(reasonCode)},updated_at=${sqlValue(now)},exited_at=${sqlValue(exited)} WHERE membership_id=${sqlValue(membershipId)};`);
    return true;
  }

  async function acquireLock({ context, campaign = {}, jobId = "", ttlMs = 120000 } = {}) {
    await assertReady();
    const db = await database();
    const acquiredAt = clock().toISOString();
    const expiresAt = new Date(clock().getTime() + Math.max(10000, Number(ttlMs) || 120000)).toISOString();
    const token = crypto.randomUUID();
    const lockId = `lock_${crypto.randomUUID()}`;
    const rows = await db.query(`BEGIN IMMEDIATE;
UPDATE send_eligibility_locks SET state='EXPIRED',released_at=${sqlValue(acquiredAt)}
WHERE state='ACTIVE' AND expires_at<=${sqlValue(acquiredAt)};
INSERT OR IGNORE INTO send_eligibility_locks(lock_id,recipient_key,customer_id,connection_key,campaign_id,run_id,job_id,lock_token,state,acquired_at,expires_at)
VALUES (${sqlValue(lockId)},${sqlValue(context.recipientKey)},${sqlValue(context.customer.customerId)},${sqlValue(context.connection.connectionKey)},${sqlValue(campaign.campaignId || campaign.id)},${sqlValue(campaign.runId)},${sqlValue(jobId)},${sqlValue(token)},'ACTIVE',${sqlValue(acquiredAt)},${sqlValue(expiresAt)});
COMMIT;
SELECT lock_id AS lockId,lock_token AS token,expires_at AS expiresAt FROM send_eligibility_locks WHERE lock_token=${sqlValue(token)} AND state='ACTIVE';`);
    return rows[0] || null;
  }

  async function releaseLock(token) {
    if (!token) return false;
    await assertReady();
    const db = await database();
    const releasedAt = clock().toISOString();
    await db.exec(`UPDATE send_eligibility_locks SET state='RELEASED',released_at=${sqlValue(releasedAt)} WHERE lock_token=${sqlValue(token)} AND state='ACTIVE';`);
    return true;
  }

  async function propagateStop({ phone, customerId = "", source = "operator", reasonCode = "GLOBAL_STOP", reason = "", idempotencyKey = "" } = {}) {
    await assertReady();
    const db = await database();
    const normalizedPhone = normalizePhone(phone);
    const now = clock().toISOString();
    const context = await loadContext({ phone: normalizedPhone, customerId });
    const resolvedCustomerId = context.customer.customerId;
    if (!resolvedCustomerId) {
      const error = new Error("STOP 无法对应到稳定 customer_id；已拒绝部分写入。");
      error.code = "STOP_CUSTOMER_IDENTITY_REQUIRED";
      throw error;
    }
    const eventKey = clean(idempotencyKey) || digest("stop", resolvedCustomerId, source, reasonCode, now.slice(0, 16));
    const suppressionId = digest("suppression", resolvedCustomerId);
    const eventId = digest("state_event", eventKey);
    const syncCustomerKey = `eligibility-stop:crm_customer:${resolvedCustomerId}`;
    const [salesSchema] = await db.query("SELECT version FROM schema_migrations WHERE version=307 LIMIT 1;").catch(() => []);
    const salesStopUpdate = salesSchema
      ? `UPDATE project_leads SET temperature='STOP',updated_at=${sqlValue(now)} WHERE customer_id=${sqlValue(resolvedCustomerId)};`
      : "";
    const memberTable = await membershipTable();
    const stopMemberships = memberTable === "campaign_members"
      ? `UPDATE campaign_members SET status='EXIT_STOP',exit_reason=${sqlValue(reasonCode)},exited_at=${sqlValue(now)},updated_at=${sqlValue(now)} WHERE customer_id=${sqlValue(resolvedCustomerId)} AND status IN ('PENDING','ACTIVE','PAUSED_REPLY','PAUSED_SNOOZE');`
      : `UPDATE campaign_memberships SET status='EXIT_STOP',reason_code=${sqlValue(reasonCode)},exited_at=${sqlValue(now)},updated_at=${sqlValue(now)} WHERE customer_id=${sqlValue(resolvedCustomerId)} AND status IN ('PENDING','ACTIVE','PAUSED_REPLY','PAUSED_SNOOZE');`;
    await db.exec(`BEGIN IMMEDIATE;
UPDATE customers SET global_status='Stop',updated_at=${sqlValue(now)} WHERE customer_id=${sqlValue(resolvedCustomerId)};
UPDATE contacts SET stop_flag=1,stop_reason=${sqlValue(reason || reasonCode)},stop_at=COALESCE(stop_at,${sqlValue(now)}),updated_at=${sqlValue(now)} WHERE customer_id=${sqlValue(resolvedCustomerId)};
UPDATE project_leads SET status='STOP',sequence_status='EXITED',updated_at=${sqlValue(now)} WHERE customer_id=${sqlValue(resolvedCustomerId)} AND upper(status) NOT IN ('WON','LOST');
${salesStopUpdate}
${stopMemberships}
UPDATE send_jobs SET status='CANCELLED',error_code='GLOBAL_STOP',error_message='Cancelled by global STOP',updated_at=${sqlValue(now)}
WHERE status='PENDING' AND project_lead_key IN (SELECT project_lead_key FROM project_leads WHERE customer_id=${sqlValue(resolvedCustomerId)});
INSERT INTO global_suppressions(suppression_id,customer_id,phone,reason_code,source,status,created_at,updated_at)
VALUES (${sqlValue(suppressionId)},${sqlValue(resolvedCustomerId)},${sqlValue(normalizedPhone)},${sqlValue(reasonCode)},${sqlValue(source)},'ACTIVE',${sqlValue(now)},${sqlValue(now)})
ON CONFLICT(customer_id) WHERE customer_id IS NOT NULL AND status='ACTIVE' DO UPDATE SET reason_code=excluded.reason_code,source=excluded.source,updated_at=excluded.updated_at;
INSERT OR IGNORE INTO customer_state_events(event_id,idempotency_key,customer_id,event_type,source,reason_code,detail_json,created_at)
VALUES (${sqlValue(eventId)},${sqlValue(eventKey)},${sqlValue(resolvedCustomerId)},'GLOBAL_STOP',${sqlValue(source)},${sqlValue(reasonCode)},${sqlValue(JSON.stringify({ reason: clean(reason) }))},${sqlValue(now)});
UPDATE crm_customer_profiles SET global_status='Stop',updated_at=${sqlValue(now)} WHERE customer_id=${sqlValue(resolvedCustomerId)};
INSERT INTO sync_jobs(idempotency_key,direction,entity_type,entity_id,status,attempt_count,available_at,last_error_code,last_error_message,payload_json,created_at,updated_at)
VALUES (${sqlValue(syncCustomerKey)},'LOCAL_TO_NOTION','crm_customer',${sqlValue(resolvedCustomerId)},'PENDING',0,${sqlValue(now)},'','',${sqlValue(JSON.stringify({ source: "send-eligibility-stop", reasonCode }))},${sqlValue(now)},${sqlValue(now)})
ON CONFLICT(idempotency_key) DO NOTHING;
COMMIT;`);
    return { customerId: resolvedCustomerId, stopped: true, at: now };
  }

  async function propagateReply({ phone, customerId = "", source = "inbound", category = "OTHER", idempotencyKey = "", text = "" } = {}) {
    await assertReady();
    const db = await database();
    const context = await loadContext({ phone, customerId });
    const resolvedCustomerId = context.customer.customerId;
    if (!resolvedCustomerId) return { updated: 0, reason: "customer_not_resolved" };
    const now = clock().toISOString();
    const eventKey = clean(idempotencyKey) || digest("reply", resolvedCustomerId, source, category, now.slice(0, 16));
    const eventId = digest("state_event", eventKey);
    const taskKey = `reply-handoff:${eventKey}`;
    const [salesSchema] = await db.query("SELECT version FROM schema_migrations WHERE version=307 LIMIT 1;").catch(() => []);
    const replyTaskType = salesSchema ? "REPLY_CUSTOMER" : "REPLY_HANDOFF";
    const memberTable = await membershipTable();
    const replyMembership = memberTable === "campaign_members"
      ? `UPDATE campaign_members SET status='PAUSED_REPLY',exit_reason='CUSTOMER_REPLIED',paused_at=${sqlValue(now)},updated_at=${sqlValue(now)}
WHERE campaign_member_id=(SELECT m.campaign_member_id FROM campaign_members m
  LEFT JOIN campaign_runs r ON r.campaign_id=m.campaign_id
  LEFT JOIN send_jobs sj ON sj.run_id=r.run_id AND sj.project_lead_key=m.project_lead_id AND sj.status='SENT'
  WHERE m.customer_id=${sqlValue(resolvedCustomerId)} AND m.status IN ('PENDING','ACTIVE','PAUSED_SNOOZE')
  ORDER BY COALESCE(sj.sent_at,m.last_activity_at,m.joined_at) DESC LIMIT 1);`
      : `UPDATE campaign_memberships SET status='PAUSED_REPLY',reason_code='CUSTOMER_REPLIED',updated_at=${sqlValue(now)} WHERE customer_id=${sqlValue(resolvedCustomerId)} AND status IN ('PENDING','ACTIVE','PAUSED_SNOOZE');`;
    const replySendJobs = memberTable === "campaign_members"
      ? `UPDATE send_jobs SET status='CANCELLED',error_code='CUSTOMER_REPLIED',error_message='Future step cancelled after inbound reply',updated_at=${sqlValue(now)}
WHERE status='PENDING' AND run_id IN (SELECT r.run_id FROM campaign_runs r JOIN campaign_members m ON m.campaign_id=r.campaign_id WHERE m.customer_id=${sqlValue(resolvedCustomerId)} AND m.status='PAUSED_REPLY' AND m.updated_at=${sqlValue(now)});`
      : `UPDATE send_jobs SET status='CANCELLED',error_code='CUSTOMER_REPLIED',error_message='Future step cancelled after inbound reply',updated_at=${sqlValue(now)} WHERE status='PENDING' AND project_lead_key IN (SELECT project_lead_key FROM project_leads WHERE customer_id=${sqlValue(resolvedCustomerId)});`;
    await db.exec(`BEGIN IMMEDIATE;
UPDATE project_leads SET
  status=CASE WHEN upper(status) IN ('BOOKING','SPA','WON','LOST','STOP') THEN status ELSE 'REPLIED' END,
  sequence_status=CASE WHEN upper(sequence_status)='EXITED' THEN sequence_status ELSE 'PAUSED_REPLY' END,
  updated_at=${sqlValue(now)}
WHERE customer_id=${sqlValue(resolvedCustomerId)};
${replyMembership}
${replySendJobs}
INSERT OR IGNORE INTO customer_follow_up_tasks(task_id,idempotency_key,customer_id,project_lead_key,task_type,status,source,payload_json,created_at,updated_at)
VALUES (${sqlValue(digest("task", taskKey))},${sqlValue(taskKey)},${sqlValue(resolvedCustomerId)},${sqlValue(context.projectLead.projectLeadKey)},${sqlValue(replyTaskType)},'OPEN',${sqlValue(source)},${sqlValue(JSON.stringify({ category: clean(category), textPreview: clean(text).slice(0, 120) }))},${sqlValue(now)},${sqlValue(now)});
INSERT OR IGNORE INTO customer_state_events(event_id,idempotency_key,customer_id,project_lead_key,event_type,source,reason_code,detail_json,created_at)
VALUES (${sqlValue(eventId)},${sqlValue(eventKey)},${sqlValue(resolvedCustomerId)},${sqlValue(context.projectLead.projectLeadKey)},'CUSTOMER_REPLY',${sqlValue(source)},${sqlValue(clean(category) || "OTHER")},${sqlValue(JSON.stringify({ textPreview: clean(text).slice(0, 120) }))},${sqlValue(now)});
COMMIT;`);
    return { updated: 1, customerId: resolvedCustomerId, at: now };
  }

  async function snooze({ phone, customerId = "", until, source = "operator" } = {}) {
    await assertReady();
    const dueAt = new Date(until || "");
    if (!Number.isFinite(dueAt.getTime()) || dueAt.getTime() <= clock().getTime()) {
      const error = new Error("Snooze Until 必须是未来时间。");
      error.code = "SNOOZE_UNTIL_INVALID";
      throw error;
    }
    const context = await loadContext({ phone, customerId });
    if (!context.customer.customerId) throw Object.assign(new Error("找不到稳定 customer_id。"), { code: "SNOOZE_CUSTOMER_REQUIRED" });
    const db = await database();
    const now = clock().toISOString();
    const due = dueAt.toISOString();
    const taskKey = `snooze-due:${context.customer.customerId}:${due}`;
    const memberTable = await membershipTable();
    const snoozeMemberships = memberTable === "campaign_members"
      ? `UPDATE campaign_members SET status='PAUSED_SNOOZE',exit_reason='SNOOZED',paused_at=${sqlValue(now)},updated_at=${sqlValue(now)} WHERE customer_id=${sqlValue(context.customer.customerId)} AND project_lead_id=${sqlValue(context.projectLead.projectLeadKey)} AND status IN ('PENDING','ACTIVE','PAUSED_REPLY');`
      : `UPDATE campaign_memberships SET status='PAUSED_SNOOZE',reason_code='SNOOZED',updated_at=${sqlValue(now)} WHERE customer_id=${sqlValue(context.customer.customerId)} AND status IN ('PENDING','ACTIVE','PAUSED_REPLY');`;
    await db.exec(`BEGIN IMMEDIATE;
UPDATE project_leads SET status='SNOOZED',sequence_status='PAUSED_SNOOZE',snooze_until=${sqlValue(due)},updated_at=${sqlValue(now)} WHERE customer_id=${sqlValue(context.customer.customerId)};
${snoozeMemberships}
INSERT OR IGNORE INTO customer_follow_up_tasks(task_id,idempotency_key,customer_id,project_lead_key,task_type,status,due_at,source,created_at,updated_at)
VALUES (${sqlValue(digest("task", taskKey))},${sqlValue(taskKey)},${sqlValue(context.customer.customerId)},${sqlValue(context.projectLead.projectLeadKey)},'SNOOZE_DUE','OPEN',${sqlValue(due)},${sqlValue(source)},${sqlValue(now)},${sqlValue(now)});
COMMIT;`);
    return { customerId: context.customer.customerId, snoozeUntil: due };
  }

  async function listDecisions({ runId = "", limit = 1000 } = {}) {
    await assertReady();
    const db = await database();
    const safeLimit = Math.max(1, Math.min(Number(limit) || 1000, 5000));
    const where = clean(runId) ? `WHERE run_id=${sqlValue(clean(runId))}` : "";
    return db.query(`SELECT decision_id AS decisionId,customer_id AS customerId,project_lead_key AS projectLeadKey,campaign_id AS campaignId,run_id AS runId,requested_action AS requestedAction,allowed,reason_code AS reasonCode,reason,retry_at AS retryAt,required_action AS requiredAction,evaluated_state_json AS evaluatedStateJson,evaluated_at AS evaluatedAt FROM send_eligibility_decisions ${where} ORDER BY evaluated_at DESC LIMIT ${safeLimit};`).then((rows) => rows.map((row) => ({ ...row, allowed: Boolean(row.allowed), evaluatedState: parseJson(row.evaluatedStateJson) })));
  }

  return {
    databasePath,
    schemaStatus,
    assertReady,
    loadContext,
    ensureMembership,
    recordDecision,
    recordBlockedOutcome,
    acquireLock,
    releaseLock,
    propagateStop,
    propagateReply,
    snooze,
    listDecisions,
  };
}
