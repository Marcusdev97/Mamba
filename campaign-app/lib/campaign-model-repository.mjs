import crypto from "node:crypto";
import path from "node:path";
import { createSqliteCli, sqlValue } from "./sqlite-cli.mjs";
import { calculateCampaignMetrics, decideOutcomeAttribution } from "../domain/campaign-model.mjs";

const REQUIRED_TABLES = Object.freeze(["campaigns", "campaign_members", "campaign_steps", "campaign_runs", "send_jobs", "campaign_outcomes"]);

function clean(value) { return String(value ?? "").trim(); }
function id(prefix, ...parts) {
  const source = parts.map(clean).filter(Boolean).join("\u001f") || crypto.randomUUID();
  return `${prefix}_${crypto.createHash("sha256").update(source).digest("hex").slice(0, 28)}`;
}
function parse(value, fallback = {}) { try { return JSON.parse(value || ""); } catch { return fallback; } }

export function createCampaignModelRepository({ dataDir, sqliteBinary = "", clock = () => new Date() } = {}) {
  const databasePath = path.join(dataDir, "mamba.sqlite");
  let databasePromise;
  const database = () => databasePromise ||= createSqliteCli({ databasePath, sqliteBinary }).catch((error) => { databasePromise = null; throw error; });

  async function schemaStatus() {
    const db = await database();
    const rows = await db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${REQUIRED_TABLES.map(sqlValue).join(",")});`);
    const present = new Set(rows.map((row) => row.name));
    const [migration] = await db.query("SELECT version FROM schema_migrations WHERE version=308 LIMIT 1;").catch(() => []);
    const missing = REQUIRED_TABLES.filter((table) => !present.has(table));
    return { ready: Boolean(migration) && !missing.length, migration: migration?.version || null, missing };
  }

  async function assertReady() {
    const status = await schemaStatus();
    if (status.ready) return status;
    throw Object.assign(new Error(`Campaign Model schema 尚未就绪：${status.missing.join(", ") || "migration 308 未记录"}。`), { code: "CAMPAIGN_MODEL_SCHEMA_REQUIRED", schema: status });
  }

  async function saveCampaign({ campaignId = "", name, objective, projectId, channel, owner = "", status = "DRAFT", startAt = null, endAt = null, target = {}, stopPolicy = {}, audience = {}, attributionWindowDays = 30, steps = [] } = {}) {
    await assertReady();
    const db = await database();
    const at = clock().toISOString();
    const key = clean(campaignId) || id("campaign", name, projectId, at);
    const statements = [`INSERT INTO campaigns(campaign_id,name,objective,project_id,channel,owner,status,start_at,end_at,target_json,stop_policy_json,audience_json,attribution_window_days,created_at,updated_at)
VALUES (${sqlValue(key)},${sqlValue(name)},${sqlValue(objective)},${sqlValue(projectId)},${sqlValue(channel)},${sqlValue(owner)},${sqlValue(status)},${sqlValue(startAt)},${sqlValue(endAt)},${sqlValue(JSON.stringify(target))},${sqlValue(JSON.stringify(stopPolicy))},${sqlValue(JSON.stringify(audience))},${Number(attributionWindowDays)},${sqlValue(at)},${sqlValue(at)})
ON CONFLICT(campaign_id) DO UPDATE SET name=excluded.name,objective=excluded.objective,project_id=excluded.project_id,channel=excluded.channel,owner=excluded.owner,status=excluded.status,start_at=excluded.start_at,end_at=excluded.end_at,target_json=excluded.target_json,stop_policy_json=excluded.stop_policy_json,audience_json=excluded.audience_json,attribution_window_days=excluded.attribution_window_days,updated_at=excluded.updated_at;`];
    for (const step of steps) {
      const stepId = clean(step.campaignStepId) || id("campaign_step", key, step.stepOrder);
      statements.push(`INSERT INTO campaign_steps(campaign_step_id,campaign_id,step_order,flow_label,delay_rule,template_group,channel,requires_human,active,created_at,updated_at)
VALUES (${sqlValue(stepId)},${sqlValue(key)},${Number(step.stepOrder)},${sqlValue(step.flowLabel)},${sqlValue(JSON.stringify(step.delayRule || {}))},${sqlValue(step.templateGroup || "")},${sqlValue(step.channel || channel)},${sqlValue(Boolean(step.requiresHuman))},${sqlValue(step.active !== false)},${sqlValue(at)},${sqlValue(at)})
ON CONFLICT(campaign_id,step_order) DO UPDATE SET flow_label=excluded.flow_label,delay_rule=excluded.delay_rule,template_group=excluded.template_group,channel=excluded.channel,requires_human=excluded.requires_human,active=excluded.active,updated_at=excluded.updated_at;`);
    }
    await db.exec(`BEGIN IMMEDIATE;\n${statements.join("\n")}\nCOMMIT;`);
    return getCampaign(key);
  }

  async function listCampaigns({ status = "", limit = 200 } = {}) {
    await assertReady();
    const db = await database();
    return db.query(`SELECT c.campaign_id AS campaignId,c.name,c.objective,c.project_id AS projectId,c.channel,c.owner,c.status,c.start_at AS startAt,c.end_at AS endAt,c.updated_at AS updatedAt,
      (SELECT COUNT(*) FROM campaign_members m WHERE m.campaign_id=c.campaign_id) AS memberCount,
      (SELECT COUNT(*) FROM campaign_runs r WHERE r.campaign_id=c.campaign_id) AS runCount
      FROM campaigns c WHERE (${sqlValue(clean(status).toUpperCase())}='' OR c.status=${sqlValue(clean(status).toUpperCase())}) ORDER BY c.updated_at DESC LIMIT ${Math.max(1, Math.min(Number(limit) || 200, 1000))};`);
  }

  async function getCampaign(campaignId) {
    await assertReady();
    const db = await database();
    const [campaign] = await db.query(`SELECT campaign_id AS campaignId,name,objective,project_id AS projectId,channel,owner,status,start_at AS startAt,end_at AS endAt,target_json AS targetJson,stop_policy_json AS stopPolicyJson,audience_json AS audienceJson,attribution_window_days AS attributionWindowDays,created_at AS createdAt,updated_at AS updatedAt FROM campaigns WHERE campaign_id=${sqlValue(clean(campaignId))} LIMIT 1;`);
    if (!campaign) return null;
    const [steps, members, runs] = await Promise.all([
      db.query(`SELECT campaign_step_id AS campaignStepId,step_order AS stepOrder,flow_label AS flowLabel,delay_rule AS delayRuleJson,template_group AS templateGroup,channel,requires_human AS requiresHuman,active FROM campaign_steps WHERE campaign_id=${sqlValue(campaign.campaignId)} ORDER BY step_order;`),
      db.query(`SELECT m.campaign_member_id AS campaignMemberId,m.customer_id AS customerId,m.project_lead_id AS projectLeadId,m.status,m.current_step_id AS currentStepId,m.joined_at AS joinedAt,m.paused_at AS pausedAt,m.exited_at AS exitedAt,m.exit_reason AS exitReason,m.last_activity_at AS lastActivityAt,COALESCE(NULLIF(p.name,''),c.display_name,'') AS customerName,p.phone FROM campaign_members m JOIN customers c ON c.customer_id=m.customer_id LEFT JOIN project_leads p ON p.project_lead_key=m.project_lead_id WHERE m.campaign_id=${sqlValue(campaign.campaignId)} ORDER BY m.updated_at DESC;`),
      db.query(`SELECT run_id AS runId,step_id AS stepId,mode,connection_id AS connectionId,device_id AS deviceId,started_at AS startedAt,finished_at AS finishedAt,status,summary_json AS summaryJson,requested_count AS requestedCount,sent_count AS sentCount,failed_count AS failedCount FROM campaign_runs WHERE campaign_id=${sqlValue(campaign.campaignId)} ORDER BY COALESCE(started_at,'') DESC;`),
    ]);
    return { ...campaign, target: parse(campaign.targetJson), stopPolicy: parse(campaign.stopPolicyJson), audience: parse(campaign.audienceJson), steps: steps.map((step) => ({ ...step, delayRule: parse(step.delayRuleJson), requiresHuman: Boolean(step.requiresHuman), active: Boolean(step.active) })), members, runs: runs.map((run) => ({ ...run, summary: parse(run.summaryJson) })) };
  }

  async function enrollMembers({ campaignId, projectLeadIds = [] } = {}) {
    await assertReady();
    const db = await database();
    const at = clock().toISOString();
    let enrolled = 0;
    for (const projectLeadId of [...new Set(projectLeadIds.map(clean).filter(Boolean))]) {
      const [lead] = await db.query(`SELECT project_lead_key AS projectLeadId,customer_id AS customerId FROM project_leads WHERE project_lead_key=${sqlValue(projectLeadId)} LIMIT 1;`);
      if (!lead?.customerId) continue;
      const memberId = id("campaign_member", campaignId, lead.customerId);
      const result = await db.query(`INSERT OR IGNORE INTO campaign_members(campaign_member_id,campaign_id,customer_id,project_lead_id,status,joined_at,created_at,updated_at)
VALUES (${sqlValue(memberId)},${sqlValue(campaignId)},${sqlValue(lead.customerId)},${sqlValue(lead.projectLeadId)},'PENDING',${sqlValue(at)},${sqlValue(at)},${sqlValue(at)});
SELECT changes() AS inserted;`);
      enrolled += Number(result[0]?.inserted || 0);
    }
    return { selected: projectLeadIds.length, enrolled };
  }

  async function createRun({ runId = "", campaignId, stepId = null, mode, connectionId = "", deviceId = "", status, startedAt = null } = {}) {
    await assertReady();
    const db = await database();
    const campaign = await getCampaign(campaignId);
    if (!campaign) return null;
    const key = clean(runId) || id("run", campaignId, stepId, mode, clock().toISOString(), crypto.randomUUID());
    const memberCount = mode === "LIVE" ? campaign.members.filter((member) => ["PENDING", "ACTIVE"].includes(member.status)).length : 0;
    await db.exec(`INSERT INTO campaign_runs(run_id,campaign_id,step_id,name,project_code,flow_topic,flow_no,sender_set,mode,connection_id,device_id,status,requested_count,sent_count,failed_count,started_at,summary_json,payload_json)
VALUES (${sqlValue(key)},${sqlValue(campaignId)},${sqlValue(stepId)},${sqlValue(campaign.name)},${sqlValue(campaign.projectId)},${sqlValue(campaign.steps.find((step) => step.campaignStepId === stepId)?.flowLabel || "")},${sqlValue(campaign.steps.find((step) => step.campaignStepId === stepId)?.stepOrder)},'',${sqlValue(mode)},${sqlValue(connectionId)},${sqlValue(deviceId)},${sqlValue(status)},${memberCount},0,0,${sqlValue(startedAt)},'{}','{}');`);
    const campaignStatus = status === "TESTING" ? "TESTING" : status === "QUEUED" ? "SCHEDULED" : status === "RUNNING" ? "ACTIVE" : "";
    if (campaignStatus) await db.exec(`UPDATE campaigns SET status=${sqlValue(campaignStatus)},updated_at=${sqlValue(clock().toISOString())} WHERE campaign_id=${sqlValue(campaignId)};`);
    return { runId: key, campaignId, stepId, mode, status, requestedCount: memberCount };
  }

  async function updateMember({ campaignMemberId, status, currentStepId = null, reason = "", occurredAt = clock().toISOString() } = {}) {
    await assertReady();
    const db = await database();
    const pausedAt = status.startsWith("PAUSED_") ? occurredAt : null;
    const exitedAt = ["COMPLETED", "EXIT_STOP", "EXIT_APPOINTMENT", "EXIT_BOOKED", "FAILED"].includes(status) ? occurredAt : null;
    await db.exec(`UPDATE campaign_members SET status=${sqlValue(status)},current_step_id=COALESCE(${sqlValue(currentStepId)},current_step_id),paused_at=${sqlValue(pausedAt)},exited_at=${sqlValue(exitedAt)},exit_reason=${sqlValue(reason)},updated_at=${sqlValue(occurredAt)} WHERE campaign_member_id=${sqlValue(campaignMemberId)};`);
    const [row] = await db.query(`SELECT campaign_member_id AS campaignMemberId,campaign_id AS campaignId,customer_id AS customerId,project_lead_id AS projectLeadId,status,current_step_id AS currentStepId,joined_at AS joinedAt,paused_at AS pausedAt,exited_at AS exitedAt,exit_reason AS exitReason,last_activity_at AS lastActivityAt FROM campaign_members WHERE campaign_member_id=${sqlValue(campaignMemberId)};`);
    return row || null;
  }

  async function getMember(campaignMemberId) {
    await assertReady();
    const db = await database();
    const [row] = await db.query(`SELECT campaign_member_id AS campaignMemberId,campaign_id AS campaignId,customer_id AS customerId,project_lead_id AS projectLeadId,status,current_step_id AS currentStepId,joined_at AS joinedAt,paused_at AS pausedAt,exited_at AS exitedAt,exit_reason AS exitReason,last_activity_at AS lastActivityAt FROM campaign_members WHERE campaign_member_id=${sqlValue(clean(campaignMemberId))} LIMIT 1;`);
    return row || null;
  }

  async function recordSendConfirmed({ runId, customerId = "", projectLeadId = "", occurredAt = clock().toISOString() } = {}) {
    await assertReady();
    const db = await database();
    const [run] = await db.query(`SELECT campaign_id AS campaignId,step_id AS stepId,mode FROM campaign_runs WHERE run_id=${sqlValue(clean(runId))} LIMIT 1;`);
    if (!run || run.mode === "TEST") return { recorded: false, reason: run ? "test_run_has_no_live_members" : "run_not_found" };
    const [member] = await db.query(`SELECT campaign_member_id AS campaignMemberId FROM campaign_members WHERE campaign_id=${sqlValue(run.campaignId)} AND (${sqlValue(clean(customerId))}<>'' AND customer_id=${sqlValue(clean(customerId))} OR ${sqlValue(clean(customerId))}='' AND project_lead_id=${sqlValue(clean(projectLeadId))}) AND status IN ('PENDING','ACTIVE') LIMIT 1;`);
    if (!member) return { recorded: false, reason: "active_member_not_found" };
    await db.exec(`UPDATE campaign_members SET status='ACTIVE',current_step_id=COALESCE(${sqlValue(run.stepId)},current_step_id),last_activity_at=${sqlValue(occurredAt)},updated_at=${sqlValue(occurredAt)} WHERE campaign_member_id=${sqlValue(member.campaignMemberId)};`);
    return { recorded: true, campaignMemberId: member.campaignMemberId, campaignId: run.campaignId };
  }

  async function recordLegacyCheckpoint({ runId, projectCode, phone, flowLabel = "Flow 1", occurredAt = clock().toISOString() } = {}) {
    await assertReady();
    const db = await database();
    const [run] = await db.query(`SELECT run_id AS runId,campaign_id AS campaignId,step_id AS stepId,project_code AS projectCode,flow_no AS flowNo FROM campaign_runs WHERE run_id=${sqlValue(clean(runId))} LIMIT 1;`);
    if (!run) return { recorded: false, reason: "run_not_found" };
    let campaignId = run.campaignId;
    let stepId = run.stepId;
    if (!campaignId) {
      const code = clean(projectCode || run.projectCode);
      campaignId = `legacy:${code}`;
      const parsedFlow = Number(run.flowNo || clean(flowLabel).match(/\b(10|[1-9])\b/)?.[1] || 1);
      stepId = `${campaignId}:step:${parsedFlow}`;
      await db.exec(`BEGIN IMMEDIATE;
INSERT INTO campaigns(campaign_id,name,objective,project_id,channel,owner,status,start_at,target_json,stop_policy_json,audience_json,created_at,updated_at)
VALUES (${sqlValue(campaignId)},${sqlValue(`Legacy Flow Sequence · ${code}`)},'REACTIVATE_OLD_LEADS',${sqlValue(code)},'WHATSAPP','Legacy adapter','ACTIVE',${sqlValue(occurredAt)},'{}','{}','{"source":"legacy_flow"}',${sqlValue(occurredAt)},${sqlValue(occurredAt)})
ON CONFLICT(campaign_id) DO UPDATE SET updated_at=excluded.updated_at;
INSERT INTO campaign_steps(campaign_step_id,campaign_id,step_order,flow_label,delay_rule,template_group,channel,requires_human,active,created_at,updated_at)
VALUES (${sqlValue(stepId)},${sqlValue(campaignId)},${parsedFlow},${sqlValue(clean(flowLabel) || `Flow ${parsedFlow}`)},'{"source":"legacy_flow"}',${sqlValue(clean(flowLabel) || `Flow ${parsedFlow}`)},'WHATSAPP',0,1,${sqlValue(occurredAt)},${sqlValue(occurredAt)})
ON CONFLICT(campaign_id,step_order) DO UPDATE SET flow_label=excluded.flow_label,updated_at=excluded.updated_at;
UPDATE campaign_runs SET campaign_id=${sqlValue(campaignId)},step_id=${sqlValue(stepId)} WHERE run_id=${sqlValue(run.runId)};
COMMIT;`);
    }
    const normalizedPhone = clean(phone).replace(/\D/g, "");
    const [lead] = await db.query(`SELECT project_lead_key AS projectLeadId,customer_id AS customerId FROM project_leads WHERE project_code=${sqlValue(clean(projectCode || run.projectCode))} AND phone=${sqlValue(normalizedPhone)} ORDER BY updated_at DESC LIMIT 1;`);
    if (!lead?.customerId) return { recorded: false, reason: "project_lead_not_found" };
    const memberId = id("campaign_member", campaignId, lead.customerId);
    await db.exec(`INSERT INTO campaign_members(campaign_member_id,campaign_id,customer_id,project_lead_id,status,current_step_id,joined_at,last_activity_at,created_at,updated_at)
VALUES (${sqlValue(memberId)},${sqlValue(campaignId)},${sqlValue(lead.customerId)},${sqlValue(lead.projectLeadId)},'ACTIVE',${sqlValue(stepId)},${sqlValue(occurredAt)},${sqlValue(occurredAt)},${sqlValue(occurredAt)},${sqlValue(occurredAt)})
ON CONFLICT(campaign_member_id) DO UPDATE SET status=CASE WHEN campaign_members.status IN ('PENDING','ACTIVE') THEN 'ACTIVE' ELSE campaign_members.status END,current_step_id=excluded.current_step_id,last_activity_at=excluded.last_activity_at,updated_at=excluded.updated_at;`);
    return { recorded: true, campaignId, campaignMemberId: memberId, stepId };
  }

  async function findAttributableMember({ campaignId = "", runId = "", customerId = "", projectLeadId = "" } = {}) {
    const db = await database();
    const [row] = await db.query(`SELECT m.campaign_member_id AS campaignMemberId,m.campaign_id AS campaignId,m.customer_id AS customerId,m.project_lead_id AS projectLeadId,m.status,m.last_activity_at AS lastActivityAt,c.attribution_window_days AS attributionWindowDays
FROM campaign_members m JOIN campaigns c ON c.campaign_id=m.campaign_id
WHERE (${sqlValue(clean(campaignId))}='' OR m.campaign_id=${sqlValue(clean(campaignId))})
  AND (${sqlValue(clean(runId))}='' OR m.campaign_id=(SELECT campaign_id FROM campaign_runs WHERE run_id=${sqlValue(clean(runId))}))
  AND ((${sqlValue(clean(customerId))}<>'' AND m.customer_id=${sqlValue(clean(customerId))}) OR (${sqlValue(clean(customerId))}='' AND m.project_lead_id=${sqlValue(clean(projectLeadId))}))
ORDER BY CASE WHEN m.status IN ('PENDING','ACTIVE','PAUSED_REPLY','PAUSED_SNOOZE') THEN 0 ELSE 1 END,COALESCE(m.last_activity_at,m.joined_at) DESC LIMIT 1;`);
    return row || null;
  }

  async function recordOutcome({ campaignId = "", runId = "", campaignMemberId = "", customerId = "", projectLeadId = "", outcomeType, value = null, occurredAt, humanOverride = false, sourceEvent = "" } = {}) {
    await assertReady();
    const db = await database();
    let member;
    if (campaignMemberId) [member] = await db.query(`SELECT m.campaign_member_id AS campaignMemberId,m.campaign_id AS campaignId,m.customer_id AS customerId,m.project_lead_id AS projectLeadId,m.status,m.last_activity_at AS lastActivityAt,c.attribution_window_days AS attributionWindowDays FROM campaign_members m JOIN campaigns c ON c.campaign_id=m.campaign_id WHERE m.campaign_member_id=${sqlValue(campaignMemberId)} LIMIT 1;`);
    else member = await findAttributableMember({ campaignId, runId, customerId, projectLeadId });
    if (!member) return { attributed: false, code: "CAMPAIGN_MEMBER_NOT_FOUND" };
    const decision = decideOutcomeAttribution({ memberStatus: member.status, activityAt: member.lastActivityAt, outcomeAt: occurredAt, attributionWindowDays: member.attributionWindowDays, humanOverride });
    if (!decision.attributed) return decision;
    const key = clean(sourceEvent) ? `campaign-outcome:${member.campaignId}:${outcomeType}:${sourceEvent}` : `campaign-outcome:${member.campaignId}:${member.campaignMemberId}:${outcomeType}:${occurredAt}`;
    const outcomeId = id("campaign_outcome", key);
    await db.exec(`INSERT INTO campaign_outcomes(outcome_id,idempotency_key,campaign_id,campaign_member_id,customer_id,outcome_type,value,occurred_at,attribution_method,source_event,created_at)
VALUES (${sqlValue(outcomeId)},${sqlValue(key)},${sqlValue(member.campaignId)},${sqlValue(member.campaignMemberId)},${sqlValue(member.customerId)},${sqlValue(outcomeType)},${sqlValue(value)},${sqlValue(occurredAt)},${sqlValue(decision.method)},${sqlValue(sourceEvent)},${sqlValue(clock().toISOString())}) ON CONFLICT(idempotency_key) DO NOTHING;`);
    return { ...decision, outcomeId, campaignId: member.campaignId, campaignMemberId: member.campaignMemberId };
  }

  async function metrics(campaignId) {
    await assertReady();
    const db = await database();
    const [row] = await db.query(`SELECT
  (SELECT COUNT(*) FROM campaign_members m WHERE m.campaign_id=${sqlValue(campaignId)}) AS members,
  (SELECT COUNT(DISTINCT COALESCE(d.customer_id,d.project_lead_key)) FROM send_eligibility_decisions d WHERE d.campaign_id=${sqlValue(campaignId)} AND d.allowed=1) AS eligible,
  (SELECT COUNT(DISTINCT sj.project_lead_key) FROM send_jobs sj JOIN campaign_runs r ON r.run_id=sj.run_id WHERE r.campaign_id=${sqlValue(campaignId)} AND sj.status='SENT') AS sent,
  (SELECT COUNT(DISTINCT m.customer_id) FROM messages m WHERE json_extract(m.payload_json,'$.runId') IN (SELECT run_id FROM campaign_runs WHERE campaign_id=${sqlValue(campaignId)}) AND m.direction IN ('outbound','operator') AND json_extract(m.payload_json,'$.deliveryStatus') IN ('DELIVERY_ACK','READ','PLAYED')) AS delivered,
  COUNT(DISTINCT CASE WHEN o.outcome_type='REPLY' THEN o.campaign_member_id END) AS replied,
  COUNT(DISTINCT CASE WHEN o.outcome_type='WARM' THEN o.campaign_member_id END) AS warm,
  COUNT(DISTINCT CASE WHEN o.outcome_type='APPOINTMENT' THEN o.campaign_member_id END) AS appointments,
  COUNT(DISTINCT CASE WHEN o.outcome_type='VIEWING' THEN o.campaign_member_id END) AS viewings,
  COUNT(DISTINCT CASE WHEN o.outcome_type='BOOKING' THEN o.campaign_member_id END) AS bookings,
  COUNT(DISTINCT CASE WHEN o.outcome_type='SPA' THEN o.campaign_member_id END) AS spa,
  COALESCE(SUM(CASE WHEN o.outcome_type='COMMISSION' THEN o.value ELSE 0 END),0) AS actualCommission,
  COALESCE((SELECT SUM(so.expected_commission) FROM sales_opportunities so JOIN campaign_members m ON m.project_lead_id=so.project_lead_key WHERE m.campaign_id=${sqlValue(campaignId)}),0) AS expectedCommission,
  (SELECT COUNT(*) FROM campaign_members m WHERE m.campaign_id=${sqlValue(campaignId)} AND m.status='EXIT_STOP') AS stop,
  (SELECT COUNT(*) FROM send_jobs sj JOIN campaign_runs r ON r.run_id=sj.run_id WHERE r.campaign_id=${sqlValue(campaignId)} AND sj.error_code='INVALID_NUMBER') AS invalid,
  (SELECT COUNT(*) FROM send_jobs sj JOIN campaign_runs r ON r.run_id=sj.run_id WHERE r.campaign_id=${sqlValue(campaignId)} AND sj.status='FAILED') AS failures
FROM campaign_outcomes o WHERE o.campaign_id=${sqlValue(campaignId)};`);
    return calculateCampaignMetrics(row || {});
  }

  return { databasePath, schemaStatus, assertReady, saveCampaign, listCampaigns, getCampaign, enrollMembers, createRun, getMember, updateMember, recordSendConfirmed, recordLegacyCheckpoint, findAttributableMember, recordOutcome, metrics };
}
