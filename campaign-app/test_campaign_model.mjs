import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { calculateCampaignMetrics, decideMemberTransition, decideOutcomeAttribution } from "./domain/campaign-model.mjs";
import { createCampaignModelRepository } from "./lib/campaign-model-repository.mjs";
import { createCampaignModelService } from "./lib/campaign-model-service.mjs";
import { createLocalDatabaseService } from "./lib/local-database-service.mjs";
import { createSendEligibilityRepository } from "./lib/send-eligibility-repository.mjs";
import { createSendEligibilityService } from "./lib/send-eligibility-service.mjs";
import { createSqliteCli, findSqliteCli } from "./lib/sqlite-cli.mjs";
import { campaignRestartDecision } from "./campaign_core.mjs";
import { migrateSqliteNotionSync } from "../scripts/maintenance/migrate-sqlite-notion-sync.mjs";
import { migrateCustomerIdentity } from "../scripts/maintenance/migrate-customer-identity.mjs";
import { migrateSendEligibility } from "../scripts/maintenance/migrate-send-eligibility.mjs";
import { migrateSalesPipeline } from "../scripts/maintenance/migrate-sales-stage-followup.mjs";
import { migrateCampaignModel } from "../scripts/maintenance/migrate-campaign-model.mjs";

const binary = await findSqliteCli();
if (!binary) { console.log("⚠️ sqlite3 unavailable; skipped Campaign Model tests"); process.exit(0); }
const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-campaign-model-"));
const dataDir = path.join(rootDir, "campaign-data");
const local = createLocalDatabaseService({ dataDir });
await local.initialize();
migrateSqliteNotionSync({ rootDir, databasePath: local.databasePath, binary, apply: true, confirmation: "APPLY_SQLITE_NOTION_SYNC_V1" });
migrateCustomerIdentity({ rootDir, databasePath: local.databasePath, binary, apply: true, confirmation: "APPLY_CUSTOMER_IDENTITY_V1" });
migrateSendEligibility({ rootDir, databasePath: local.databasePath, binary, apply: true, confirmation: "APPLY_SEND_ELIGIBILITY_V1" });
migrateSalesPipeline({ rootDir, databasePath: local.databasePath, binary, apply: true, confirmation: "APPLY_SALES_PIPELINE_V1" });
const db = await createSqliteCli({ databasePath: local.databasePath, sqliteBinary: binary });
const at = "2026-08-08T00:00:00.000Z";
await db.exec(`INSERT INTO projects(project_code,project_name,active,created_at,updated_at) VALUES ('campaign08','Campaign 08',1,'${at}','${at}');
INSERT INTO devices(device_key,device_name,created_at,updated_at) VALUES ('device08','Device 08','${at}','${at}');
INSERT INTO whatsapp_connections(connection_key,instance_name,whatsapp_number,device_key,status,created_at,updated_at) VALUES ('device08::60118880000','wa_01','60118880000','device08','OPEN','${at}','${at}');
INSERT INTO contacts(contact_key,phone,display_name,created_at,updated_at) VALUES ('60128880001','60128880001','Campaign One','${at}','${at}'),('60128880002','60128880002','Campaign Two','${at}','${at}');
INSERT INTO project_leads(project_lead_key,contact_key,project_code,phone,name,status,sequence_status,created_at,updated_at) VALUES ('campaign08:60128880001','60128880001','campaign08','60128880001','Campaign One','NEW','ACTIVE','${at}','${at}'),('campaign08:60128880002','60128880002','campaign08','60128880002','Campaign Two','NEW','ACTIVE','${at}','${at}');
INSERT INTO campaign_runs(run_id,name,project_code,flow_topic,flow_no,mode,status,requested_count,sent_count,failed_count,started_at,payload_json) VALUES ('legacy-run','Legacy Run','campaign08','Flow 3',3,'LIVE','COMPLETED',1,1,0,'${at}','{}');
INSERT INTO send_jobs(id,run_id,project_lead_key,connection_key,flow_topic,status,sent_at,created_at,updated_at) VALUES ('legacy-send','legacy-run','campaign08:60128880001','device08::60118880000','Flow 3','SENT','${at}','${at}','${at}');
INSERT INTO campaign_memberships(membership_id,customer_id,project_lead_key,campaign_id,run_id,status,created_at,updated_at) VALUES ('legacy-member',(SELECT customer_id FROM project_leads WHERE project_lead_key='campaign08:60128880001'),'campaign08:60128880001','','legacy-run','COMPLETED','${at}','${at}');`);
const migrated = migrateCampaignModel({ rootDir, databasePath: local.databasePath, binary, apply: true, confirmation: "APPLY_CAMPAIGN_MODEL_V1" });
assert.equal(migrated.verification.quickCheck, "ok");
assert.equal(migrated.verification.foreignKeyErrors, 0);
assert.equal((await db.query("SELECT campaign_id AS campaignId,step_id AS stepId FROM campaign_runs WHERE run_id='legacy-run';"))[0].stepId, "legacy:campaign08:step:3");
assert.equal((await db.query("SELECT COUNT(*) AS count FROM campaign_steps WHERE campaign_id='legacy:campaign08';"))[0].count, 10);

const repository = createCampaignModelRepository({ dataDir, sqliteBinary: binary, clock: () => new Date(at) });
const service = createCampaignModelService({ repository, clock: () => new Date("2026-08-08T01:00:00.000Z") });
assert.equal((await service.schemaStatus()).ready, true);

// 1 + existing Flow mapping. Draft creation stores steps but never starts a run.
const draft = await service.saveDraft({
  name: "August Warm Follow-up", projectId: "campaign08", objective: "FOLLOW_UP_WARM_LEADS", channel: "WHATSAPP", owner: "Marcus",
  steps: [{ stepOrder: 1, flowLabel: "Flow 1", templateGroup: "Flow 1" }, { stepOrder: 2, flowLabel: "Flow 2", delayRule: { days: 3 }, templateGroup: "Flow 2" }],
  target: { replies: 10 }, stopPolicy: { reply: true, booking: true }, audience: { source: "warm_leads" },
});
assert.equal(draft.status, "DRAFT");
assert.equal(draft.steps.length, 2);
assert.equal(draft.runs.length, 0);

// 9 + 10. Same customer can join another campaign, but duplicate active membership in one Campaign is idempotently prevented.
assert.deepEqual(await service.enrollMembers({ campaignId: draft.campaignId, projectLeadIds: ["campaign08:60128880001"] }), { selected: 1, enrolled: 1 });
assert.deepEqual(await service.enrollMembers({ campaignId: draft.campaignId, projectLeadIds: ["campaign08:60128880001"] }), { selected: 1, enrolled: 0 });

// 2 + 3. TEST uses no LIVE member count; one Campaign supports multiple Runs.
const testRun = await service.createRun({ campaignId: draft.campaignId, stepId: draft.steps[0].campaignStepId, mode: "TEST", status: "TESTING" });
const liveRun = await service.createRun({ campaignId: draft.campaignId, stepId: draft.steps[0].campaignStepId, mode: "LIVE", status: "RUNNING" });
const secondRun = await service.createRun({ campaignId: draft.campaignId, stepId: draft.steps[1].campaignStepId, mode: "LIVE", status: "QUEUED" });
assert.equal(testRun.requestedCount, 0);
assert.equal(liveRun.requestedCount, 1);
assert.notEqual(liveRun.runId, secondRun.runId);

const [customer] = await db.query("SELECT customer_id AS customerId FROM project_leads WHERE project_lead_key='campaign08:60128880001';");
await service.recordSendConfirmed({ runId: liveRun.runId, customerId: customer.customerId, projectLeadId: "campaign08:60128880001", occurredAt: "2026-08-08T01:00:00.000Z" });
await db.exec(`INSERT INTO send_jobs(id,run_id,project_lead_key,connection_key,flow_topic,status,sent_at,created_at,updated_at) VALUES ('send08','${liveRun.runId}','campaign08:60128880001','device08::60118880000','Flow 1','SENT','2026-08-08T01:00:00.000Z','${at}','${at}');`);

// 4. Reply attribution and pause affect the explicitly relevant membership only.
const other = await service.saveDraft({ name: "Separate Campaign", projectId: "campaign08", objective: "INVITE_TO_SHOWROOM", channel: "WHATSAPP", steps: [{ stepOrder: 1, flowLabel: "Manual Invite" }] });
await service.enrollMembers({ campaignId: other.campaignId, projectLeadIds: ["campaign08:60128880001"] });
const reply = await service.recordReply({ runId: liveRun.runId, customerId: customer.customerId, sourceEvent: "reply08", occurredAt: "2026-08-08T02:00:00.000Z" });
assert.equal(reply.attributed, true);
assert.equal((await service.campaignDetail(draft.campaignId)).campaign.members[0].status, "PAUSED_REPLY");
assert.equal((await service.campaignDetail(other.campaignId)).campaign.members[0].status, "PENDING");

// The central inbound workflow chooses the membership with the latest send
// evidence, leaving another valid Campaign for the same customer untouched.
const untouched = await service.saveDraft({ name: "Untouched Campaign", projectId: "campaign08", objective: "CALL_LIST_ONLY", channel: "CALL", steps: [{ stepOrder: 1, flowLabel: "Call" }] });
await service.enrollMembers({ campaignId: untouched.campaignId, projectLeadIds: ["campaign08:60128880001"] });
const otherRun = await service.createRun({ campaignId: other.campaignId, stepId: other.steps[0].campaignStepId, mode: "LIVE", status: "RUNNING" });
await service.recordSendConfirmed({ runId: otherRun.runId, customerId: customer.customerId, projectLeadId: "campaign08:60128880001", occurredAt: "2026-08-08T03:30:00.000Z" });
await db.exec(`INSERT INTO send_jobs(id,run_id,project_lead_key,connection_key,flow_topic,status,sent_at,created_at,updated_at) VALUES ('send08-other','${otherRun.runId}','campaign08:60128880001','device08::60118880000','Manual Invite','SENT','2026-08-08T03:30:00.000Z','${at}','${at}');`);
const eligibility = createSendEligibilityService({ repository: createSendEligibilityRepository({ dataDir, sqliteBinary: binary, clock: () => new Date("2026-08-08T04:00:00.000Z") }) });
await eligibility.propagateReply({ customerId: customer.customerId, phone: "60128880001", projectCode: "campaign08", category: "QUESTION", source: "test08", idempotencyKey: "reply08-central" });
assert.equal((await service.campaignDetail(other.campaignId)).campaign.members[0].status, "PAUSED_REPLY");
assert.equal((await service.campaignDetail(untouched.campaignId)).campaign.members[0].status, "PENDING");
const legacyNamedCampaignCheck = await eligibility.check({ recipient: { customerId: customer.customerId, phone: "60128880001" }, projectLead: { projectCode: "campaign08" }, campaign: { campaignId: "campaign08", runId: otherRun.runId, mode: "LIVE" }, connection: { connectionKey: "device08::60118880000", available: true }, requestedAction: "FLOW_SEQUENCE" });
assert.equal(legacyNamedCampaignCheck.reason_code, "CUSTOMER_REPLIED");

// Attribution requires prior activity and a bounded window; a human override remains auditable.
assert.equal(decideOutcomeAttribution({ memberStatus: "ACTIVE", activityAt: "2026-01-01", outcomeAt: "2026-03-01", attributionWindowDays: 30 }).code, "ATTRIBUTION_WINDOW_EXPIRED");
await service.recordOutcome({ campaignId: draft.campaignId, customerId: customer.customerId, outcomeType: "WARM", sourceEvent: "warm08", occurredAt: "2026-08-08T03:00:00.000Z" });
await service.recordOutcome({ campaignId: draft.campaignId, customerId: customer.customerId, outcomeType: "COMMISSION", value: 5000, sourceEvent: "commission08", occurredAt: "2026-08-08T04:00:00.000Z" });
await db.exec(`INSERT INTO conversations(id,contact_key,connection_key,customer_phone,last_message_at,created_at,updated_at,customer_id) VALUES ('conv08','60128880001','device08::60118880000','60128880001','2026-08-08T04:00:00.000Z','${at}','${at}','${customer.customerId}');
INSERT INTO messages(id,conversation_id,connection_key,external_message_id,idempotency_key,direction,text,message_type,source,flow_topic,sent_at,payload_json,created_at,customer_id) VALUES ('msg08','conv08','device08::60118880000','msg08','campaign08:msg08','outbound','hello','text','campaign','Flow 1','2026-08-08T01:00:00.000Z','{"runId":"${liveRun.runId}","deliveryStatus":"DELIVERY_ACK"}','${at}','${customer.customerId}');`);

// 6. Booking exits only the chosen project marketing membership.
const detail = await service.campaignDetail(other.campaignId);
await service.transitionMember({ campaignMemberId: detail.campaign.members[0].campaignMemberId, event: "BOOKING", reason: "Booking received" });
assert.equal((await service.campaignDetail(other.campaignId)).campaign.members[0].status, "EXIT_BOOKED");

// 5. Global STOP uses central eligibility and exits every remaining membership.
await eligibility.propagateStop({ customerId: customer.customerId, phone: "60128880001", reasonCode: "REQUESTED_STOP", source: "test08", idempotencyKey: "stop08" });
assert.equal((await db.query(`SELECT COUNT(*) AS count FROM campaign_members WHERE customer_id='${customer.customerId}' AND status='EXIT_STOP';`))[0].count >= 1, true);

// 8. Metrics are derived from member, send-job and attributed outcome facts.
const metrics = await service.metrics(draft.campaignId);
assert.equal(metrics.members, 1);
assert.equal(metrics.sent, 1);
assert.equal(metrics.delivered, 1);
assert.equal(metrics.replied, 1);
assert.equal(metrics.warm, 1);
assert.equal(metrics.actualCommission, 5000);
assert.equal(calculateCampaignMetrics({ members: 2, replied: 1, actualCommission: 1000 }).replyRate, 50);

// 7. Existing restart evidence still refuses duplicate/ambiguous resend.
const restart = campaignRestartDecision({ assignments: [{ id: "done", status: "SENT", part1: { status: "SENT", sentAt: at } }, { id: "unknown", status: "SENDING_PART1", part1: null }] });
assert.equal(restart.action, "CONFIRM");
assert.equal(decideMemberTransition({ from: "ACTIVE", event: "REPLY" }).to, "PAUSED_REPLY");

await fs.rm(rootDir, { recursive: true, force: true });
console.log("✅ Campaign draft, legacy Flow mapping, membership, multi-run, attribution, metrics, STOP and restart tests passed");
