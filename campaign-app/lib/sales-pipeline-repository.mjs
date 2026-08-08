import crypto from "node:crypto";
import path from "node:path";
import { createSqliteCli, sqlValue } from "./sqlite-cli.mjs";

const REQUIRED_TABLES = Object.freeze([
  "customers",
  "project_leads",
  "sales_opportunities",
  "customer_follow_up_tasks",
  "sales_activities",
]);

const LEAD_FIELDS = new Set([
  "temperature", "buying_purpose", "budget_min", "budget_max", "preferred_area",
  "preferred_property_type", "room_requirement", "tenure_preference", "transport_requirement",
  "buying_timeline", "main_objection", "decision_maker", "loan_readiness",
  "current_property_ownership", "next_action", "next_follow_up_at", "assigned_agent",
  "lost_reason", "appointment_at", "viewing_completed_at", "loan_updated_at",
]);

function clean(value) {
  return String(value ?? "").trim();
}

function digest(prefix, ...parts) {
  return `${prefix}_${crypto.createHash("sha256").update(parts.map(clean).join("\u001f")).digest("hex").slice(0, 28)}`;
}

function parseJson(value, fallback = {}) {
  try { return JSON.parse(value || ""); } catch { return fallback; }
}

export function createSalesPipelineRepository({ dataDir, sqliteBinary = "", clock = () => new Date() } = {}) {
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
    const [migration] = await db.query("SELECT version FROM schema_migrations WHERE version=307 LIMIT 1;").catch(() => []);
    const missing = REQUIRED_TABLES.filter((table) => !present.has(table));
    return { ready: Boolean(migration) && missing.length === 0, migration: migration?.version || null, missing };
  }

  async function assertReady() {
    const status = await schemaStatus();
    if (status.ready) return status;
    const error = new Error(`Sales Pipeline schema 尚未就绪：${status.missing.join(", ") || "migration 307 未记录"}。`);
    error.code = "SALES_PIPELINE_SCHEMA_REQUIRED";
    error.retryable = false;
    error.schema = status;
    throw error;
  }

  async function resolveLead({ projectLeadKey = "", customerId = "", phone = "", projectCode = "" } = {}) {
    await assertReady();
    const db = await database();
    const normalizedPhone = clean(phone).replace(/\D/g, "");
    const [row] = await db.query(`
SELECT p.project_lead_key AS projectLeadKey,p.customer_id AS customerId,p.project_code AS projectCode,
  p.phone,p.name,c.display_name AS customerName,c.global_status AS globalStatus,
  p.sales_stage AS salesStage,p.temperature,p.buying_purpose AS buyingPurpose,
  p.budget_min AS budgetMin,p.budget_max AS budgetMax,p.preferred_area AS preferredArea,
  p.preferred_property_type AS preferredPropertyType,p.room_requirement AS roomRequirement,
  p.tenure_preference AS tenurePreference,p.transport_requirement AS transportRequirement,
  p.buying_timeline AS buyingTimeline,p.main_objection AS mainObjection,p.decision_maker AS decisionMaker,
  p.loan_readiness AS loanReadiness,p.current_property_ownership AS currentPropertyOwnership,
  p.next_action AS nextAction,p.next_follow_up_at AS nextFollowUpAt,p.assigned_agent AS assignedAgent,
  p.lost_reason AS lostReason,p.stage_changed_at AS stageChangedAt,
  p.last_meaningful_contact_at AS lastMeaningfulContactAt,p.snooze_until AS snoozeUntil,
  p.appointment_at AS appointmentAt,p.viewing_completed_at AS viewingCompletedAt,
  p.loan_updated_at AS loanUpdatedAt,p.updated_at AS updatedAt,
  o.opportunity_id AS opportunityId,o.stage AS opportunityStage,o.probability_percent AS probabilityPercent,
  o.property_value AS propertyValue,o.commission_rate_percent AS commissionRatePercent,
  o.gross_commission AS grossCommission,o.team_split_percent AS teamSplitPercent,
  o.expected_commission AS expectedCommission,o.actual_commission AS actualCommission,
  o.commission_status AS commissionStatus,o.expected_payment_date AS expectedPaymentDate,o.paid_at AS paidAt,
  o.target_close_date AS targetCloseDate,o.trigger_type AS opportunityTrigger
FROM project_leads p
JOIN customers c ON c.customer_id=p.customer_id
LEFT JOIN sales_opportunities o ON o.project_lead_key=p.project_lead_key
WHERE (${sqlValue(clean(projectLeadKey))}<>'' AND p.project_lead_key=${sqlValue(clean(projectLeadKey))})
   OR (${sqlValue(clean(projectLeadKey))}='' AND ${sqlValue(clean(customerId))}<>'' AND p.customer_id=${sqlValue(clean(customerId))}
       AND (${sqlValue(clean(projectCode).toLowerCase())}='' OR lower(p.project_code)=${sqlValue(clean(projectCode).toLowerCase())}))
   OR (${sqlValue(clean(projectLeadKey))}='' AND ${sqlValue(clean(customerId))}='' AND p.phone=${sqlValue(normalizedPhone)}
       AND (${sqlValue(clean(projectCode).toLowerCase())}='' OR lower(p.project_code)=${sqlValue(clean(projectCode).toLowerCase())}))
ORDER BY p.updated_at DESC LIMIT 1;`);
    return row || null;
  }

  async function listLeads({ q = "", stage = "", temperature = "", limit = 500 } = {}) {
    await assertReady();
    const db = await database();
    const query = clean(q).toLowerCase();
    const safeLimit = Math.max(1, Math.min(Number(limit) || 500, 1000));
    return db.query(`
SELECT p.project_lead_key AS projectLeadKey,p.customer_id AS customerId,p.project_code AS projectCode,
  COALESCE(NULLIF(p.name,''),c.display_name,'') AS name,p.phone,p.sales_stage AS salesStage,p.temperature,
  p.next_action AS nextAction,p.next_follow_up_at AS nextFollowUpAt,p.assigned_agent AS assignedAgent,
  p.main_objection AS mainObjection,p.buying_timeline AS buyingTimeline,p.updated_at AS updatedAt,
  o.opportunity_id AS opportunityId,o.expected_commission AS expectedCommission,o.actual_commission AS actualCommission,
  (SELECT COUNT(*) FROM customer_follow_up_tasks t WHERE t.project_lead_key=p.project_lead_key AND t.status IN ('OPEN','IN_PROGRESS','SNOOZED')) AS openTaskCount
FROM project_leads p JOIN customers c ON c.customer_id=p.customer_id
LEFT JOIN sales_opportunities o ON o.project_lead_key=p.project_lead_key
WHERE (${sqlValue(query)}='' OR lower(COALESCE(NULLIF(p.name,''),c.display_name,'')) LIKE '%'||${sqlValue(query)}||'%' OR p.phone LIKE '%'||${sqlValue(query)}||'%' OR lower(p.project_code) LIKE '%'||${sqlValue(query)}||'%')
  AND (${sqlValue(clean(stage).toUpperCase())}='' OR p.sales_stage=${sqlValue(clean(stage).toUpperCase())})
  AND (${sqlValue(clean(temperature).toUpperCase())}='' OR p.temperature=${sqlValue(clean(temperature).toUpperCase())})
ORDER BY CASE WHEN p.next_follow_up_at IS NULL THEN 1 ELSE 0 END,p.next_follow_up_at,p.updated_at DESC LIMIT ${safeLimit};`);
  }

  async function recordActivity({
    idempotencyKey,
    customerId,
    projectLeadKey = "",
    opportunityId = "",
    activityType,
    actorType = "SYSTEM",
    actorId = "",
    summary,
    reason = "",
    before = {},
    after = {},
    sourceEvent = "",
    occurredAt = clock().toISOString(),
  } = {}) {
    await assertReady();
    const db = await database();
    const key = clean(idempotencyKey) || digest("activity", customerId, projectLeadKey, activityType, sourceEvent, occurredAt);
    const activityId = digest("activity", key);
    await db.exec(`INSERT INTO sales_activities(
      activity_id,idempotency_key,customer_id,project_lead_key,opportunity_id,activity_type,
      actor_type,actor_id,summary,reason,before_json,after_json,source_event,occurred_at,created_at
    ) VALUES (
      ${sqlValue(activityId)},${sqlValue(key)},${sqlValue(customerId)},${sqlValue(projectLeadKey)},${sqlValue(opportunityId)},
      ${sqlValue(activityType)},${sqlValue(actorType)},${sqlValue(actorId)},${sqlValue(summary)},${sqlValue(reason)},
      ${sqlValue(JSON.stringify(before))},${sqlValue(JSON.stringify(after))},${sqlValue(sourceEvent)},${sqlValue(occurredAt)},${sqlValue(clock().toISOString())}
    ) ON CONFLICT(idempotency_key) DO NOTHING;`);
    return activityId;
  }

  async function queueProjectLeadSync(db, projectLeadKey, at, suffix) {
    const key = `LOCAL_TO_NOTION:crm_project_lead:${projectLeadKey}:${clean(suffix) || at}`;
    await db.exec(`INSERT INTO sync_jobs(idempotency_key,direction,entity_type,entity_id,status,attempt_count,available_at,last_error_code,last_error_message,payload_json,created_at,updated_at)
VALUES (${sqlValue(key)},'LOCAL_TO_NOTION','crm_project_lead',${sqlValue(projectLeadKey)},'PENDING',0,${sqlValue(at)},'','',${sqlValue(JSON.stringify({ source: "sales-pipeline" }))},${sqlValue(at)},${sqlValue(at)})
ON CONFLICT(idempotency_key) DO NOTHING;`);
  }

  async function applyStage({ lead, toStage, legacyStatus, temperature = null, lostReason = "", actorType = "AGENT", actorId = "", reason = "", sourceEvent = "" } = {}) {
    await assertReady();
    const db = await database();
    const at = clock().toISOString();
    const activityKey = sourceEvent ? `stage:${lead.projectLeadKey}:${sourceEvent}:${toStage}` : `stage:${lead.projectLeadKey}:${lead.salesStage}:${toStage}:${at}`;
    await db.exec(`BEGIN IMMEDIATE;
UPDATE project_leads SET sales_stage=${sqlValue(toStage)},status=${sqlValue(legacyStatus)},
  temperature=COALESCE(${sqlValue(temperature)},temperature),lost_reason=${sqlValue(lostReason)},
  stage_changed_at=${sqlValue(at)},updated_at=${sqlValue(at)} WHERE project_lead_key=${sqlValue(lead.projectLeadKey)};
UPDATE sales_opportunities SET stage=CASE WHEN ${sqlValue(toStage)} IN ('NEW','CONTACTED') THEN stage ELSE ${sqlValue(toStage)} END,
  lost_reason=${sqlValue(lostReason)},won_at=CASE WHEN ${sqlValue(toStage)}='WON' THEN ${sqlValue(at)} ELSE won_at END,
  lost_at=CASE WHEN ${sqlValue(toStage)}='LOST' THEN ${sqlValue(at)} ELSE lost_at END,updated_at=${sqlValue(at)}
WHERE project_lead_key=${sqlValue(lead.projectLeadKey)};
INSERT INTO sales_activities(activity_id,idempotency_key,customer_id,project_lead_key,opportunity_id,activity_type,actor_type,actor_id,summary,reason,before_json,after_json,source_event,occurred_at,created_at)
VALUES (${sqlValue(digest("activity", activityKey))},${sqlValue(activityKey)},${sqlValue(lead.customerId)},${sqlValue(lead.projectLeadKey)},${sqlValue(lead.opportunityId)},
  'STAGE_CHANGED',${sqlValue(actorType)},${sqlValue(actorId)},${sqlValue(`${lead.salesStage} → ${toStage}`)},${sqlValue(reason)},
  ${sqlValue(JSON.stringify({ salesStage: lead.salesStage }))},${sqlValue(JSON.stringify({ salesStage: toStage, lostReason }))},${sqlValue(sourceEvent)},${sqlValue(at)},${sqlValue(at)})
ON CONFLICT(idempotency_key) DO NOTHING;
COMMIT;`);
    await queueProjectLeadSync(db, lead.projectLeadKey, at, activityKey);
    return resolveLead({ projectLeadKey: lead.projectLeadKey });
  }

  async function updateLeadFields({ lead, fields = {}, actorType = "AGENT", actorId = "", reason = "", sourceEvent = "" } = {}) {
    await assertReady();
    const entries = Object.entries(fields).filter(([field]) => LEAD_FIELDS.has(field));
    if (!entries.length) return lead;
    const db = await database();
    const at = clock().toISOString();
    const assignments = entries.map(([field, value]) => `${field}=${sqlValue(value)}`);
    assignments.push(`updated_at=${sqlValue(at)}`);
    await db.exec(`UPDATE project_leads SET ${assignments.join(",")} WHERE project_lead_key=${sqlValue(lead.projectLeadKey)};`);
    const after = Object.fromEntries(entries);
    const key = sourceEvent ? `profile:${lead.projectLeadKey}:${sourceEvent}` : `profile:${lead.projectLeadKey}:${at}`;
    await recordActivity({
      idempotencyKey: key,
      customerId: lead.customerId,
      projectLeadKey: lead.projectLeadKey,
      opportunityId: lead.opportunityId,
      activityType: "PROFILE_UPDATED",
      actorType,
      actorId,
      summary: `Updated ${entries.map(([field]) => field).join(", ")}`,
      reason,
      after,
      sourceEvent,
      occurredAt: at,
    });
    await queueProjectLeadSync(db, lead.projectLeadKey, at, key);
    return resolveLead({ projectLeadKey: lead.projectLeadKey });
  }

  async function createOpportunity({ lead, triggerType, triggerEventId = "", probabilityPercent = 10 } = {}) {
    await assertReady();
    const db = await database();
    const at = clock().toISOString();
    const opportunityId = digest("opportunity", lead.projectLeadKey);
    const stage = ["NEW", "CONTACTED"].includes(lead.salesStage) ? "REPLIED" : lead.salesStage;
    const inserted = await db.query(`BEGIN IMMEDIATE;
INSERT OR IGNORE INTO sales_opportunities(
  opportunity_id,customer_id,project_lead_key,project_code,stage,probability_percent,trigger_type,trigger_event_id,created_at,updated_at
) VALUES (${sqlValue(opportunityId)},${sqlValue(lead.customerId)},${sqlValue(lead.projectLeadKey)},${sqlValue(lead.projectCode)},${sqlValue(stage)},${sqlValue(probabilityPercent)},${sqlValue(triggerType)},${sqlValue(triggerEventId)},${sqlValue(at)},${sqlValue(at)});
COMMIT;
SELECT changes() AS inserted;`);
    if (Number(inserted[0]?.inserted)) {
      await recordActivity({
        idempotencyKey: `opportunity-created:${opportunityId}`,
        customerId: lead.customerId,
        projectLeadKey: lead.projectLeadKey,
        opportunityId,
        activityType: "OPPORTUNITY_CREATED",
        summary: `Opportunity created from ${triggerType}`,
        sourceEvent: triggerEventId,
        occurredAt: at,
      });
    }
    return resolveLead({ projectLeadKey: lead.projectLeadKey });
  }

  async function updateCommission({ lead, calculation, commissionStatus, expectedPaymentDate = null, paidAt = null, actorId = "", reason = "" } = {}) {
    await assertReady();
    if (!lead.opportunityId) throw Object.assign(new Error("Commission requires a qualified sales opportunity."), { code: "OPPORTUNITY_REQUIRED" });
    const db = await database();
    const at = clock().toISOString();
    await db.exec(`UPDATE sales_opportunities SET
      property_value=${sqlValue(calculation.propertyValue)},commission_rate_percent=${sqlValue(calculation.commissionRatePercent)},
      gross_commission=${sqlValue(calculation.grossCommission)},team_split_percent=${sqlValue(calculation.teamSplitPercent)},
      probability_percent=${sqlValue(calculation.probabilityPercent)},expected_commission=${sqlValue(calculation.expectedCommission)},
      actual_commission=${sqlValue(calculation.actualCommission)},commission_status=${sqlValue(commissionStatus)},
      expected_payment_date=${sqlValue(expectedPaymentDate)},paid_at=${sqlValue(paidAt)},updated_at=${sqlValue(at)}
    WHERE opportunity_id=${sqlValue(lead.opportunityId)};`);
    await recordActivity({
      idempotencyKey: `commission:${lead.opportunityId}:${at}`,
      customerId: lead.customerId,
      projectLeadKey: lead.projectLeadKey,
      opportunityId: lead.opportunityId,
      activityType: "COMMISSION_UPDATED",
      actorType: "AGENT",
      actorId,
      summary: `Expected commission ${calculation.expectedCommission}; actual ${calculation.actualCommission ?? "pending"}`,
      reason,
      after: calculation,
      occurredAt: at,
    });
    return resolveLead({ projectLeadKey: lead.projectLeadKey });
  }

  async function upsertTask({
    idempotencyKey,
    lead,
    taskType,
    dueAt = null,
    priority = "MEDIUM",
    priorityScore = 0,
    reason = "",
    nextAction = "",
    source = "system",
    sourceEvent = "",
    createdBy = "System",
    owner = "",
    payload = {},
  } = {}) {
    await assertReady();
    const db = await database();
    const at = clock().toISOString();
    const key = clean(idempotencyKey);
    const taskId = digest("task", key);
    const [existingTask] = await db.query(`SELECT task_id AS taskId FROM customer_follow_up_tasks
      WHERE project_lead_key=${sqlValue(lead.projectLeadKey)} AND task_type=${sqlValue(taskType)}
        AND status IN ('OPEN','IN_PROGRESS','SNOOZED')
        AND (${sqlValue(clean(sourceEvent))}='' OR source_event=${sqlValue(clean(sourceEvent))} OR due_at=${sqlValue(dueAt)} OR ${sqlValue(taskType)}='REPLY_CUSTOMER')
      ORDER BY created_at LIMIT 1;`);
    if (existingTask) {
      await db.exec(`UPDATE customer_follow_up_tasks SET due_at=COALESCE(due_at,${sqlValue(dueAt)}),
        priority=${sqlValue(priority)},priority_score=${sqlValue(priorityScore)},updated_at=${sqlValue(at)}
        WHERE task_id=${sqlValue(existingTask.taskId)};`);
      return existingTask.taskId;
    }
    await db.exec(`INSERT INTO customer_follow_up_tasks(
      task_id,idempotency_key,customer_id,project_lead_key,opportunity_id,task_type,status,due_at,
      priority,priority_score,reason,next_action,source,source_event,created_by,owner,payload_json,created_at,updated_at
    ) VALUES (${sqlValue(taskId)},${sqlValue(key)},${sqlValue(lead.customerId)},${sqlValue(lead.projectLeadKey)},${sqlValue(lead.opportunityId)},
      ${sqlValue(taskType)},'OPEN',${sqlValue(dueAt)},${sqlValue(priority)},${sqlValue(priorityScore)},${sqlValue(reason)},${sqlValue(nextAction)},
      ${sqlValue(source)},${sqlValue(sourceEvent)},${sqlValue(createdBy)},${sqlValue(owner || lead.assignedAgent)},${sqlValue(JSON.stringify(payload))},${sqlValue(at)},${sqlValue(at)})
    ON CONFLICT(idempotency_key) DO UPDATE SET
      due_at=CASE WHEN customer_follow_up_tasks.status IN ('OPEN','IN_PROGRESS','SNOOZED') THEN excluded.due_at ELSE customer_follow_up_tasks.due_at END,
      priority=CASE WHEN customer_follow_up_tasks.status IN ('OPEN','IN_PROGRESS','SNOOZED') THEN excluded.priority ELSE customer_follow_up_tasks.priority END,
      priority_score=CASE WHEN customer_follow_up_tasks.status IN ('OPEN','IN_PROGRESS','SNOOZED') THEN excluded.priority_score ELSE customer_follow_up_tasks.priority_score END,
      updated_at=excluded.updated_at;`);
    return taskId;
  }

  async function completeTask({ taskId, outcome, completedBy = "operator" } = {}) {
    await assertReady();
    const db = await database();
    const [task] = await db.query(`SELECT task_id AS taskId,customer_id AS customerId,project_lead_key AS projectLeadKey,opportunity_id AS opportunityId,task_type AS taskType,status FROM customer_follow_up_tasks WHERE task_id=${sqlValue(taskId)} LIMIT 1;`);
    if (!task) return null;
    if (task.status === "COMPLETED") return { ...task, alreadyCompleted: true };
    const at = clock().toISOString();
    await db.exec(`UPDATE customer_follow_up_tasks SET status='COMPLETED',outcome=${sqlValue(outcome)},completed_at=${sqlValue(at)},completed_by=${sqlValue(completedBy)},updated_at=${sqlValue(at)} WHERE task_id=${sqlValue(taskId)};`);
    await recordActivity({
      idempotencyKey: `task-completed:${taskId}`,
      customerId: task.customerId,
      projectLeadKey: task.projectLeadKey,
      opportunityId: task.opportunityId,
      activityType: "TASK_COMPLETED",
      actorType: "AGENT",
      actorId: completedBy,
      summary: `${task.taskType} completed`,
      after: { outcome },
      occurredAt: at,
    });
    return { ...task, status: "COMPLETED", outcome, completedAt: at };
  }

  async function listTaskCandidates() {
    await assertReady();
    const db = await database();
    return db.query(`
SELECT p.project_lead_key AS projectLeadKey,p.customer_id AS customerId,p.project_code AS projectCode,p.phone,
  p.sales_stage AS salesStage,p.temperature,p.next_action AS nextAction,p.next_follow_up_at AS nextFollowUpAt,
  p.assigned_agent AS assignedAgent,p.last_meaningful_contact_at AS lastMeaningfulContactAt,p.snooze_until AS snoozeUntil,
  p.appointment_at AS appointmentAt,p.viewing_completed_at AS viewingCompletedAt,p.loan_updated_at AS loanUpdatedAt,
  p.stage_changed_at AS stageChangedAt,
  c.global_status AS globalStatus,o.opportunity_id AS opportunityId,o.expected_commission AS expectedCommission,
  (SELECT MAX(m.sent_at) FROM messages m WHERE m.customer_id=p.customer_id AND m.direction='inbound') AS lastInboundAt,
  (SELECT MAX(m.sent_at) FROM messages m WHERE m.customer_id=p.customer_id AND m.direction IN ('outbound','operator')) AS lastOutboundAt
FROM project_leads p JOIN customers c ON c.customer_id=p.customer_id
LEFT JOIN sales_opportunities o ON o.project_lead_key=p.project_lead_key
WHERE c.global_status NOT IN ('Stop','Invalid','Merged') AND p.sales_stage NOT IN ('WON','LOST');`);
  }

  async function listTasks({ status = "", customerId = "", projectLeadKey = "", dueBefore = "", limit = 1000 } = {}) {
    await assertReady();
    const db = await database();
    const safeLimit = Math.max(1, Math.min(Number(limit) || 1000, 5000));
    return db.query(`SELECT t.task_id AS taskId,t.customer_id AS customerId,t.project_lead_key AS projectLeadKey,t.opportunity_id AS opportunityId,
      t.task_type AS taskType,t.status,t.due_at AS dueAt,t.priority,t.priority_score AS priorityScore,t.reason,t.next_action AS nextAction,
      t.owner,t.outcome,t.created_at AS createdAt,t.updated_at AS updatedAt,t.completed_at AS completedAt,
      COALESCE(NULLIF(p.name,''),c.display_name,'') AS customerName,p.phone,p.project_code AS projectCode,p.sales_stage AS salesStage,p.temperature
    FROM customer_follow_up_tasks t JOIN customers c ON c.customer_id=t.customer_id
    LEFT JOIN project_leads p ON p.project_lead_key=t.project_lead_key
    WHERE (${sqlValue(clean(status).toUpperCase())}='' OR t.status=${sqlValue(clean(status).toUpperCase())})
      AND (${sqlValue(clean(customerId))}='' OR t.customer_id=${sqlValue(clean(customerId))})
      AND (${sqlValue(clean(projectLeadKey))}='' OR t.project_lead_key=${sqlValue(clean(projectLeadKey))})
      AND (${sqlValue(clean(dueBefore))}='' OR t.due_at<=${sqlValue(clean(dueBefore))})
    ORDER BY t.priority_score DESC,t.due_at,t.created_at LIMIT ${safeLimit};`);
  }

  async function listActivities({ customerId, projectLeadKey = "", limit = 300 } = {}) {
    await assertReady();
    const db = await database();
    const safeLimit = Math.max(1, Math.min(Number(limit) || 300, 1000));
    const rows = await db.query(`SELECT activity_id AS activityId,activity_type AS activityType,actor_type AS actorType,actor_id AS actorId,
      summary,reason,before_json AS beforeJson,after_json AS afterJson,source_event AS sourceEvent,occurred_at AS occurredAt
    FROM sales_activities WHERE customer_id=${sqlValue(customerId)}
      AND (${sqlValue(clean(projectLeadKey))}='' OR project_lead_key=${sqlValue(clean(projectLeadKey))})
    ORDER BY occurred_at DESC LIMIT ${safeLimit};`);
    return rows.map((row) => ({ ...row, before: parseJson(row.beforeJson), after: parseJson(row.afterJson) }));
  }

  return {
    databasePath,
    schemaStatus,
    assertReady,
    resolveLead,
    listLeads,
    applyStage,
    updateLeadFields,
    createOpportunity,
    updateCommission,
    recordActivity,
    upsertTask,
    completeTask,
    listTaskCandidates,
    listTasks,
    listActivities,
  };
}
