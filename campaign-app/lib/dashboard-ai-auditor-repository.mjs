import crypto from "node:crypto";
import path from "node:path";
import { createSqliteCli, sqlValue } from "./sqlite-cli.mjs";

const REQUIRED_TABLES = ["customers", "project_leads", "messages", "customer_follow_up_tasks", "campaigns", "campaign_members", "campaign_outcomes", "lead_audit_analyses", "lead_audit_events"];
const clean = (value) => String(value ?? "").trim();
const id = (prefix, ...parts) => `${prefix}_${crypto.createHash("sha256").update(parts.map(clean).join("\u001f")).digest("hex").slice(0, 28)}`;
const parse = (value, fallback) => { try { return JSON.parse(value || ""); } catch { return fallback; } };

export function createDashboardAiAuditorRepository({ dataDir, sqliteBinary = "", clock = () => new Date() } = {}) {
  const databasePath = path.join(dataDir, "mamba.sqlite");
  let dbPromise;
  const database = () => dbPromise ||= createSqliteCli({ databasePath, sqliteBinary });

  async function schemaStatus() {
    const db = await database();
    const rows = await db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${REQUIRED_TABLES.map(sqlValue).join(",")});`);
    const present = new Set(rows.map((row) => row.name));
    const [migration] = await db.query("SELECT version FROM schema_migrations WHERE version=309 LIMIT 1;").catch(() => []);
    const missing = REQUIRED_TABLES.filter((table) => !present.has(table));
    return { ready: Boolean(migration) && !missing.length, migration: migration?.version || null, missing };
  }

  async function assertReady() {
    const status = await schemaStatus();
    if (status.ready) return;
    throw Object.assign(new Error(`Dashboard AI Auditor schema 尚未就绪：${status.missing.join(", ") || "migration 309 未记录"}。`), { code: "DASHBOARD_AI_SCHEMA_REQUIRED", schema: status });
  }

  async function health() {
    await assertReady();
    const db = await database();
    const [row] = await db.query(`SELECT
      (SELECT MAX(created_at) FROM messages) AS lastSqliteActivityAt,
      (SELECT MAX(updated_at) FROM project_leads) AS lastLeadUpdatedAt,
      (SELECT last_finished_at FROM sync_worker_state WHERE id='singleton') AS lastNotionSyncAt,
      (SELECT status FROM sync_worker_state WHERE id='singleton') AS syncStatus,
      (SELECT COUNT(*) FROM sync_jobs WHERE status IN ('PENDING','RUNNING','RETRY')) AS pendingSync,
      (SELECT COUNT(*) FROM sync_jobs WHERE status='FAILED') AS failedSync,
      (SELECT COUNT(*) FROM identity_conflicts WHERE status='OPEN') AS identityConflicts,
      (SELECT COUNT(*) FROM project_leads WHERE temperature='STOP') AS stoppedLeads;`);
    return { ...row, source: "SQLITE_ONLY", healthy: Number(row.failedSync) === 0 && Number(row.identityConflicts) === 0 };
  }

  function filtersSql(filters = {}, alias = "p") {
    const conditions = [];
    if (clean(filters.dateFrom)) conditions.push(`${alias}.updated_at>=${sqlValue(clean(filters.dateFrom))}`);
    if (clean(filters.dateTo)) conditions.push(`${alias}.updated_at<${sqlValue(clean(filters.dateTo))}`);
    if (clean(filters.project)) conditions.push(`${alias}.project_code=${sqlValue(clean(filters.project))}`);
    if (clean(filters.agent)) conditions.push(`${alias}.assigned_agent=${sqlValue(clean(filters.agent))}`);
    if (clean(filters.source)) conditions.push(`EXISTS(SELECT 1 FROM lead_origins lo JOIN contacts lc ON lc.contact_key=lo.contact_key WHERE lc.phone=${alias}.phone AND lo.lead_type=${sqlValue(clean(filters.source).toUpperCase())})`);
    if (clean(filters.campaign)) conditions.push(`EXISTS(SELECT 1 FROM campaign_members cm WHERE cm.project_lead_id=${alias}.project_lead_key AND cm.campaign_id=${sqlValue(clean(filters.campaign))})`);
    return conditions.length ? ` AND ${conditions.join(" AND ")}` : "";
  }

  async function actions({ now = clock(), filters = {} } = {}) {
    await assertReady();
    const db = await database();
    const nowIso = now.toISOString();
    const today = nowIso.slice(0, 10);
    const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString().slice(0, 10);
    const rows = await db.query(`SELECT t.task_id AS taskId,t.task_type AS taskType,t.due_at AS dueAt,t.priority,t.priority_score AS priorityScore,
      t.reason,t.next_action AS nextAction,t.owner,p.project_lead_key AS projectLeadKey,p.customer_id AS customerId,p.project_code AS projectCode,
      COALESCE(NULLIF(p.name,''),c.display_name,'Customer') AS customerName,p.sales_stage AS salesStage,p.temperature,
      p.last_meaningful_contact_at AS lastContactAt,p.assigned_agent AS assignedAgent,
      CASE WHEN t.task_type IN ('CONFIRM_APPOINTMENT','CHECK_BOOKING','UPDATE_SPA','TRANSACTION') THEN 'CALL' ELSE 'WHATSAPP' END AS recommendedChannel
    FROM customer_follow_up_tasks t JOIN project_leads p ON p.project_lead_key=t.project_lead_key JOIN customers c ON c.customer_id=p.customer_id
    WHERE t.status IN ('OPEN','IN_PROGRESS') AND c.global_status NOT IN ('STOP','MERGED','INVALID') AND p.temperature<>'STOP'${filtersSql(filters)}
    ORDER BY t.priority_score DESC,CASE WHEN t.due_at IS NULL THEN 1 ELSE 0 END,t.due_at LIMIT 1000;`);
    const buckets = { waitingForReply: [], dueToday: [], overdue: [], warmOver7Days: [], appointmentConfirmation: [], bookingSpaAction: [] };
    for (const row of rows) {
      const dueDate = clean(row.dueAt).slice(0, 10);
      if (row.taskType === "REPLY_CUSTOMER") buckets.waitingForReply.push(row);
      if (dueDate >= today && dueDate < tomorrow) buckets.dueToday.push(row);
      if (row.dueAt && row.dueAt < nowIso) buckets.overdue.push(row);
      if (row.taskType === "WARM_LEAD_FOLLOW_UP") buckets.warmOver7Days.push(row);
      if (row.taskType === "CONFIRM_APPOINTMENT") buckets.appointmentConfirmation.push(row);
      if (["CHECK_BOOKING", "UPDATE_SPA", "TRANSACTION"].includes(row.taskType)) buckets.bookingSpaAction.push(row);
    }
    return { generatedAt: nowIso, buckets, counts: Object.fromEntries(Object.entries(buckets).map(([key, value]) => [key, value.length])), actions: rows };
  }

  async function funnel(filters = {}) {
    await assertReady();
    const db = await database();
    const rows = await db.query(`SELECT sales_stage AS stage,COUNT(*) AS count FROM project_leads p JOIN customers c ON c.customer_id=p.customer_id
      WHERE c.global_status NOT IN ('STOP','MERGED','INVALID') AND p.temperature<>'STOP'${filtersSql(filters)} GROUP BY sales_stage;`);
    const map = Object.fromEntries(rows.map((row) => [row.stage, Number(row.count)]));
    return ["NEW", "CONTACTED", "REPLIED", "QUALIFIED", "WARM", "APPOINTMENT", "VIEWED", "LOAN_PROCESSING", "BOOKING", "SPA_SIGNED", "WON", "LOST"].map((stage) => ({ stage, count: map[stage] || 0 }));
  }

  async function campaignPerformance(filters = {}) {
    await assertReady();
    const db = await database();
    return db.query(`SELECT c.campaign_id AS campaignId,c.name,c.project_id AS projectId,c.status,
      COUNT(DISTINCT cm.campaign_member_id) AS members,
      SUM(CASE WHEN co.outcome_type='REPLY' THEN 1 ELSE 0 END) AS replies,
      SUM(CASE WHEN co.outcome_type='APPOINTMENT' THEN 1 ELSE 0 END) AS appointments,
      SUM(CASE WHEN co.outcome_type IN ('BOOKING','SPA') THEN 1 ELSE 0 END) AS conversions,
      COALESCE(SUM(CASE WHEN co.outcome_type='COMMISSION' THEN co.value ELSE 0 END),0) AS attributedCommission
    FROM campaigns c LEFT JOIN campaign_members cm ON cm.campaign_id=c.campaign_id LEFT JOIN campaign_outcomes co ON co.campaign_member_id=cm.campaign_member_id
    WHERE (${sqlValue(clean(filters.project))}='' OR c.project_id=${sqlValue(clean(filters.project))}) AND (${sqlValue(clean(filters.campaign))}='' OR c.campaign_id=${sqlValue(clean(filters.campaign))})
    GROUP BY c.campaign_id ORDER BY c.updated_at DESC LIMIT 200;`);
  }

  async function opportunities(filters = {}) {
    await assertReady();
    const db = await database();
    return db.query(`SELECT o.opportunity_id AS opportunityId,o.project_lead_key AS projectLeadKey,o.project_code AS projectCode,
      COALESCE(NULLIF(p.name,''),c.display_name,'Customer') AS customerName,o.stage,o.probability_percent AS humanProbability,
      o.expected_commission AS expectedCommission,o.target_close_date AS targetCloseDate,p.temperature,p.assigned_agent AS assignedAgent,
      (SELECT a.score FROM lead_audit_analyses a WHERE a.project_lead_key=p.project_lead_key AND a.status='COMPLETED' ORDER BY a.created_at DESC LIMIT 1) AS aiScore,
      (SELECT a.interest_level FROM lead_audit_analyses a WHERE a.project_lead_key=p.project_lead_key AND a.status='COMPLETED' ORDER BY a.created_at DESC LIMIT 1) AS aiInterest
    FROM sales_opportunities o JOIN project_leads p ON p.project_lead_key=o.project_lead_key JOIN customers c ON c.customer_id=o.customer_id
    WHERE o.stage NOT IN ('WON','LOST') AND c.global_status NOT IN ('STOP','MERGED','INVALID') AND p.temperature<>'STOP'${filtersSql(filters)}
    ORDER BY COALESCE(aiScore,o.probability_percent) DESC,o.expected_commission DESC LIMIT 500;`);
  }

  async function candidates({ now = clock(), limit = 100 } = {}) {
    await assertReady();
    const db = await database();
    const cutoff = new Date(now.getTime() - 7 * 86400000).toISOString();
    return db.query(`SELECT p.project_lead_key AS projectLeadKey,p.customer_id AS customerId,p.project_code AS projectCode,p.sales_stage AS salesStage,
      p.temperature,p.next_follow_up_at AS dueAt,p.last_meaningful_contact_at AS lastMeaningfulContactAt,c.global_status AS globalStatus,
      COALESCE(NULLIF(p.name,''),c.display_name,'Customer') AS customerName
    FROM project_leads p JOIN customers c ON c.customer_id=p.customer_id
    WHERE c.global_status NOT IN ('STOP','MERGED','INVALID') AND p.temperature<>'STOP'
      AND (p.next_follow_up_at<=${sqlValue(now.toISOString())} OR p.temperature IN ('HOT','WARM') OR (p.sales_stage NOT IN ('NEW','CONTACTED','LOST','WON') AND COALESCE(p.last_meaningful_contact_at,p.updated_at)<${sqlValue(cutoff)}))
    ORDER BY CASE p.temperature WHEN 'HOT' THEN 0 WHEN 'WARM' THEN 1 ELSE 2 END,p.next_follow_up_at LIMIT ${Math.min(500, Math.max(1, Number(limit) || 100))};`);
  }

  async function buildInput(projectLeadKey) {
    await assertReady();
    const db = await database();
    const [lead] = await db.query(`SELECT p.project_lead_key AS projectLeadKey,p.customer_id AS customerId,p.project_code AS projectCode,p.sales_stage AS salesStage,p.temperature,
      p.buying_purpose AS buyingPurpose,p.budget_min AS budgetMin,p.budget_max AS budgetMax,p.buying_timeline AS buyingTimeline,p.main_objection AS mainObjection,
      p.next_action AS nextAction,p.next_follow_up_at AS nextFollowUpAt,p.last_meaningful_contact_at AS lastMeaningfulContactAt,c.global_status AS globalStatus
      FROM project_leads p JOIN customers c ON c.customer_id=p.customer_id WHERE p.project_lead_key=${sqlValue(clean(projectLeadKey))} LIMIT 1;`);
    if (!lead) throw Object.assign(new Error("Project lead not found."), { code: "PROJECT_LEAD_NOT_FOUND" });
    const messages = await db.query(`SELECT id,direction,text,sent_at AS sentAt FROM messages WHERE customer_id=${sqlValue(lead.customerId)} ORDER BY COALESCE(sent_at,created_at) DESC LIMIT 12;`);
    const tasks = await db.query(`SELECT task_type AS taskType,due_at AS dueAt,priority,reason,next_action AS nextAction FROM customer_follow_up_tasks WHERE project_lead_key=${sqlValue(lead.projectLeadKey)} AND status IN ('OPEN','IN_PROGRESS') ORDER BY priority_score DESC LIMIT 10;`);
    return { lead, recentMessages: messages.reverse(), openTasks: tasks, lastMessageId: messages.at(-1)?.id || "" };
  }

  async function cached(cacheKey) {
    await assertReady();
    const db = await database();
    const [row] = await db.query(`SELECT * FROM lead_audit_analyses WHERE cache_key=${sqlValue(cacheKey)} AND status='COMPLETED' LIMIT 1;`);
    if (!row) return null;
    const at = clock().toISOString();
    await db.exec(`INSERT INTO lead_audit_events(event_id,analysis_id,event_type,detail_json,created_at) VALUES(${sqlValue(`audit_event_${crypto.randomUUID()}`)},${sqlValue(row.analysis_id)},'CACHE_HIT','{}',${sqlValue(at)});`);
    return { ...parse(row.output_json, {}), analysisId: row.analysis_id, cached: true };
  }

  async function saveAnalysis({ cacheKey, customerId, projectLeadKey, lastMessageId, analysisVersion, inputFingerprint, output, provider = "rules", model = "", usage = {} }) {
    await assertReady();
    const db = await database();
    const at = clock().toISOString();
    const analysisId = id("analysis", cacheKey);
    await db.exec(`BEGIN IMMEDIATE;
      INSERT INTO lead_audit_analyses(analysis_id,cache_key,customer_id,project_lead_key,conversation_last_message_id,analysis_version,input_fingerprint,status,interest_level,score,closing_probability,forgotten_followup,recommended_action,recommended_due_at,reasons_json,risk_flags_json,confidence,output_json,provider,model,input_tokens,output_tokens,estimated_cost,created_at,updated_at)
      VALUES(${sqlValue(analysisId)},${sqlValue(cacheKey)},${sqlValue(customerId)},${sqlValue(projectLeadKey)},${sqlValue(lastMessageId)},${sqlValue(analysisVersion)},${sqlValue(inputFingerprint)},'COMPLETED',${sqlValue(output.interest_level)},${sqlValue(output.score)},${sqlValue(output.closing_probability)},${sqlValue(output.forgotten_followup)},${sqlValue(output.recommended_action)},${sqlValue(output.recommended_due_at)},${sqlValue(JSON.stringify(output.reasons))},${sqlValue(JSON.stringify(output.risk_flags))},${sqlValue(output.confidence)},${sqlValue(JSON.stringify(output))},${sqlValue(provider)},${sqlValue(model)},${sqlValue(Number(usage.inputTokens)||0)},${sqlValue(Number(usage.outputTokens)||0)},${sqlValue(Number(usage.estimatedCost)||0)},${sqlValue(at)},${sqlValue(at)})
      ON CONFLICT(cache_key) DO UPDATE SET status='COMPLETED',interest_level=excluded.interest_level,score=excluded.score,closing_probability=excluded.closing_probability,forgotten_followup=excluded.forgotten_followup,recommended_action=excluded.recommended_action,recommended_due_at=excluded.recommended_due_at,reasons_json=excluded.reasons_json,risk_flags_json=excluded.risk_flags_json,confidence=excluded.confidence,output_json=excluded.output_json,provider=excluded.provider,model=excluded.model,input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,estimated_cost=excluded.estimated_cost,error_code='',error_message='',updated_at=excluded.updated_at;
      INSERT INTO lead_audit_events(event_id,analysis_id,event_type,detail_json,created_at) VALUES(${sqlValue(`audit_event_${crypto.randomUUID()}`)},${sqlValue(analysisId)},'ANALYSED',${sqlValue(JSON.stringify({ provider, model }))},${sqlValue(at)});
      COMMIT;`);
    return { ...output, analysisId, cached: false };
  }

  async function saveFailure({ cacheKey, customerId, projectLeadKey, lastMessageId, analysisVersion, inputFingerprint, error }) {
    await assertReady();
    const db = await database(); const at = clock().toISOString(); const analysisId = id("analysis", cacheKey);
    await db.exec(`BEGIN IMMEDIATE;
      INSERT INTO lead_audit_analyses(analysis_id,cache_key,customer_id,project_lead_key,conversation_last_message_id,analysis_version,input_fingerprint,status,error_code,error_message,created_at,updated_at)
      VALUES(${sqlValue(analysisId)},${sqlValue(cacheKey)},${sqlValue(customerId)},${sqlValue(projectLeadKey)},${sqlValue(lastMessageId)},${sqlValue(analysisVersion)},${sqlValue(inputFingerprint)},'FAILED',${sqlValue(error.code || "AI_AUDIT_FAILED")},${sqlValue(clean(error.message).slice(0,500))},${sqlValue(at)},${sqlValue(at)})
      ON CONFLICT(cache_key) DO UPDATE SET status='FAILED',error_code=excluded.error_code,error_message=excluded.error_message,updated_at=excluded.updated_at;
      INSERT INTO lead_audit_events(event_id,analysis_id,event_type,detail_json,created_at) VALUES(${sqlValue(`audit_event_${crypto.randomUUID()}`)},${sqlValue(analysisId)},'FAILED',${sqlValue(JSON.stringify({ code: error.code || "AI_AUDIT_FAILED" }))},${sqlValue(at)});
      COMMIT;`);
    return analysisId;
  }

  async function feedback({ analysisId, humanDecision, correction = {}, actionTaken = "", outcome = "", wasUseful = null, classificationCorrect = null }) {
    await assertReady(); const db = await database(); const at = clock().toISOString();
    if (!["ACCEPTED", "CORRECTED", "REJECTED"].includes(clean(humanDecision).toUpperCase())) throw Object.assign(new Error("humanDecision is invalid."), { code: "AI_AUDIT_FEEDBACK_INVALID" });
    await db.exec(`BEGIN IMMEDIATE; UPDATE lead_audit_analyses SET human_decision=${sqlValue(clean(humanDecision).toUpperCase())},human_correction_json=${sqlValue(JSON.stringify(correction))},action_taken=${sqlValue(actionTaken)},outcome=${sqlValue(outcome)},was_useful=${sqlValue(wasUseful)},classification_correct=${sqlValue(classificationCorrect)},feedback_at=${sqlValue(at)},updated_at=${sqlValue(at)} WHERE analysis_id=${sqlValue(clean(analysisId))};
      INSERT INTO lead_audit_events(event_id,analysis_id,event_type,detail_json,created_at) VALUES(${sqlValue(`audit_event_${crypto.randomUUID()}`)},${sqlValue(analysisId)},'HUMAN_FEEDBACK',${sqlValue(JSON.stringify({ humanDecision, actionTaken, outcome }))},${sqlValue(at)}); COMMIT;`);
    return { analysisId, recordedAt: at };
  }

  async function quality() {
    await assertReady(); const db = await database();
    const [row] = await db.query(`SELECT COUNT(*) AS analysed,SUM(CASE WHEN human_decision<>'' THEN 1 ELSE 0 END) AS reviewed,SUM(CASE WHEN human_decision='ACCEPTED' THEN 1 ELSE 0 END) AS accepted,SUM(CASE WHEN was_useful=1 THEN 1 ELSE 0 END) AS useful,SUM(CASE WHEN classification_correct=1 THEN 1 ELSE 0 END) AS correct,AVG(confidence) AS averageConfidence FROM lead_audit_analyses WHERE status='COMPLETED';`);
    const reviewed = Number(row.reviewed) || 0;
    return { ...row, analysed: Number(row.analysed)||0, reviewed, acceptanceRate: reviewed ? Number(row.accepted)/reviewed : null, usefulRate: reviewed ? Number(row.useful)/reviewed : null, classificationAccuracy: reviewed ? Number(row.correct)/reviewed : null };
  }

  return { schemaStatus, health, actions, funnel, campaignPerformance, opportunities, candidates, buildInput, cached, saveAnalysis, saveFailure, feedback, quality };
}
