import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { calculateCommission, decideStageTransition } from "./domain/sales-pipeline.mjs";
import { stableCrmId } from "./domain/notion-crm-sync.mjs";
import { createLocalDatabaseService } from "./lib/local-database-service.mjs";
import { createNotionCrmSyncEngine } from "./lib/notion-crm-sync-engine.mjs";
import { projectLeadProperties } from "./lib/notion-crm-project-lead-mapper.mjs";
import { createNotionCrmSyncRepository } from "./lib/notion-crm-sync-repository.mjs";
import { createSalesPipelineRepository } from "./lib/sales-pipeline-repository.mjs";
import { createSalesPipelineService } from "./lib/sales-pipeline-service.mjs";
import { createSendEligibilityRepository } from "./lib/send-eligibility-repository.mjs";
import { createSendEligibilityService } from "./lib/send-eligibility-service.mjs";
import { createSqliteCli, findSqliteCli } from "./lib/sqlite-cli.mjs";
import { migrateSqliteNotionSync } from "../scripts/maintenance/migrate-sqlite-notion-sync.mjs";
import { migrateCustomerIdentity } from "../scripts/maintenance/migrate-customer-identity.mjs";
import { migrateSendEligibility } from "../scripts/maintenance/migrate-send-eligibility.mjs";
import { migrateSalesPipeline } from "../scripts/maintenance/migrate-sales-stage-followup.mjs";

const binary = await findSqliteCli();
if (!binary) {
  console.log("⚠️ 这台机器没有 sqlite3，跳过 Sales Pipeline 测试。");
  process.exit(0);
}

let now = new Date("2026-08-08T10:00:00.000Z");
const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-sales-pipeline-"));
const dataDir = path.join(rootDir, "campaign-data");
const local = createLocalDatabaseService({ dataDir });
await local.initialize();
migrateSqliteNotionSync({ rootDir, databasePath: local.databasePath, binary, apply: true, confirmation: "APPLY_SQLITE_NOTION_SYNC_V1" });
migrateCustomerIdentity({ rootDir, databasePath: local.databasePath, binary, apply: true, confirmation: "APPLY_CUSTOMER_IDENTITY_V1" });
migrateSendEligibility({ rootDir, databasePath: local.databasePath, binary, apply: true, confirmation: "APPLY_SEND_ELIGIBILITY_V1" });
const migration = migrateSalesPipeline({ rootDir, databasePath: local.databasePath, binary, apply: true, confirmation: "APPLY_SALES_PIPELINE_V1" });
assert.equal(migration.verification.quickCheck, "ok");

const db = await createSqliteCli({ databasePath: local.databasePath, sqliteBinary: binary });
const at = now.toISOString();
await db.exec(`INSERT INTO projects(project_code,project_name,active,created_at,updated_at) VALUES ('pipeline','Pipeline',1,'${at}','${at}');
INSERT INTO devices(device_key,device_name,created_at,updated_at) VALUES ('device-07','Device 07','${at}','${at}');
INSERT INTO whatsapp_connections(connection_key,instance_name,whatsapp_number,device_key,status,created_at,updated_at)
VALUES ('device-07::60117770000','wa_01','60117770000','device-07','OPEN','${at}','${at}');
INSERT INTO contacts(contact_key,phone,display_name,created_at,updated_at) VALUES
  ('60127770001','60127770001','Sales One','${at}','${at}'),
  ('60127770002','60127770002','Imported Only','${at}','${at}'),
  ('60127770003','60127770003','Lost Candidate','${at}','${at}');
INSERT INTO project_leads(project_lead_key,contact_key,project_code,phone,name,sequence_status,status,created_at,updated_at) VALUES
  ('pipeline:60127770001','60127770001','pipeline','60127770001','Sales One','ACTIVE','NEW','${at}','${at}'),
  ('pipeline:60127770002','60127770002','pipeline','60127770002','Imported Only','ACTIVE','NEW','${at}','${at}'),
  ('pipeline:60127770003','60127770003','pipeline','60127770003','Lost Candidate','ACTIVE','NEW','${at}','${at}');
INSERT INTO conversations(id,contact_key,connection_key,customer_phone,last_message_at,created_at,updated_at)
VALUES ('conv-07','60127770001','device-07::60117770000','60127770001','${at}','${at}','${at}');`);

const repository = createSalesPipelineRepository({ dataDir, sqliteBinary: binary, clock: () => new Date(now) });
const sales = createSalesPipelineService({ repository, clock: () => new Date(now) });
assert.equal((await sales.schemaStatus()).ready, true);
const salesHtml = await fs.readFile(new URL("./sales.html", import.meta.url), "utf8");
assert.doesNotThrow(() => new vm.Script(salesHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1] || ""), "Sales Pipeline UI JavaScript must parse");

// 1. First confirmed outbound moves NEW → CONTACTED and records activity.
let lead = await sales.recordOutbound({ projectLeadKey: "pipeline:60127770001", sourceEvent: "out-07-1", occurredAt: at });
assert.equal(lead.salesStage, "CONTACTED");

// Imported numbers do not become opportunities until qualified intent exists.
assert.equal((await sales.customerDetail({ projectLeadKey: "pipeline:60127770002" })).lead.opportunityId, null);

// Step 06 reply propagation remains compatible after the task table upgrade
// and projects the same meaningful reply into the sales pipeline.
const observedEligibility = createSendEligibilityService({
  repository: createSendEligibilityRepository({ dataDir, sqliteBinary: binary, clock: () => new Date(now) }),
  clock: () => new Date(now),
  activityObserver: {
    onMeaningfulReply: ({ input, result }) => sales.recordInbound({
      customerId: result.customerId,
      phone: input.phone,
      projectCode: "pipeline",
      sourceEvent: input.idempotencyKey,
      category: input.category,
      occurredAt: now.toISOString(),
    }),
  },
});
await observedEligibility.propagateReply({ phone: "60127770002", projectCode: "pipeline", category: "INTERESTED", idempotencyKey: "in-07-observed" });
const observed = await sales.customerDetail({ projectLeadKey: "pipeline:60127770002" });
assert.equal(observed.lead.salesStage, "REPLIED");
assert.ok(observed.lead.opportunityId);
assert.ok(observed.tasks.some((task) => task.taskType === "REPLY_CUSTOMER"));
await assert.rejects(
  () => sales.updateLead({ projectLeadKey: "pipeline:60127770001", fields: { temperature: "STOP" } }),
  (error) => error.code === "USE_GLOBAL_STOP_WORKFLOW",
);
await observedEligibility.propagateStop({ phone: "60127770002", reasonCode: "AGENT_MANUAL_STOP", reason: "Requested no contact", idempotencyKey: "stop-07-observed" });
assert.equal((await sales.customerDetail({ projectLeadKey: "pipeline:60127770002" })).lead.temperature, "STOP");

// 2. Meaningful inbound moves CONTACTED → REPLIED, pauses are handled by Step 06,
// and the sales layer creates exactly one qualified-intent opportunity.
now = new Date("2026-08-08T10:05:00.000Z");
lead = await sales.recordInbound({ projectLeadKey: "pipeline:60127770001", sourceEvent: "in-07-1", category: "QUESTION", occurredAt: now.toISOString() });
assert.equal(lead.salesStage, "REPLIED");
assert.ok(lead.opportunityId);
await db.exec(`INSERT INTO messages(id,conversation_id,connection_key,external_message_id,idempotency_key,direction,text,message_type,source,flow_topic,sent_at,payload_json,created_at,customer_id)
VALUES ('in-07-1','conv-07','device-07::60117770000','in-07-1','test:in-07-1','inbound','budget question','text','test','', '${now.toISOString()}','{}','${now.toISOString()}',(SELECT customer_id FROM contacts WHERE phone='60127770001'));`);

// Reply threshold creates a due task. Completing it requires and records outcome.
now = new Date("2026-08-08T10:21:00.000Z");
await sales.refreshTasks();
let detail = await sales.customerDetail({ projectLeadKey: "pipeline:60127770001" });
const replyTask = detail.tasks.find((task) => task.taskType === "REPLY_CUSTOMER");
assert.ok(replyTask);
await assert.rejects(() => sales.completeTask({ taskId: replyTask.taskId, outcome: "" }), (error) => error.code === "TASK_OUTCOME_REQUIRED");
await sales.completeTask({ taskId: replyTask.taskId, outcome: "Sent requested price range", completedBy: "Marcus" });
detail = await sales.customerDetail({ projectLeadKey: "pipeline:60127770001" });
assert.ok(detail.activities.some((activity) => activity.activityType === "TASK_COMPLETED"));

// 4–5. Snooze and appointment reminders create tasks at their exact evidence time.
const snoozeAt = "2026-08-08T11:00:00.000Z";
await db.exec(`UPDATE project_leads SET snooze_until='${snoozeAt}',appointment_at='2026-08-09T08:00:00.000Z' WHERE project_lead_key='pipeline:60127770001';`);
now = new Date("2026-08-08T11:00:00.000Z");
await sales.refreshTasks();
detail = await sales.customerDetail({ projectLeadKey: "pipeline:60127770001" });
assert.equal(detail.tasks.find((task) => task.taskType === "SNOOZE_DUE")?.dueAt, snoozeAt);
assert.ok(detail.tasks.some((task) => task.taskType === "CONFIRM_APPOINTMENT"));

// 6 + 8. Backward transitions need a correction reason; Lost always needs Lost Reason.
await sales.transitionStage({ projectLeadKey: "pipeline:60127770001", toStage: "WARM", source: "human", reason: "Agent qualified needs" });
await assert.rejects(() => sales.transitionStage({ projectLeadKey: "pipeline:60127770001", toStage: "QUALIFIED", source: "human" }), (error) => error.code === "STAGE_BACKWARD_REASON_REQUIRED");
await sales.transitionStage({ projectLeadKey: "pipeline:60127770001", toStage: "QUALIFIED", source: "human", reason: "Corrected premature stage", allowBackward: true });
await assert.rejects(() => sales.transitionStage({ projectLeadKey: "pipeline:60127770003", toStage: "LOST", source: "human" }), (error) => error.code === "LOST_REASON_REQUIRED");
const lost = await sales.transitionStage({ projectLeadKey: "pipeline:60127770003", toStage: "LOST", source: "human", lostReason: "Timing", reason: "Customer postponed indefinitely" });
assert.equal(lost.lostReason, "Timing");

// 9. Commission calculation stores every input and the traceable formula.
lead = await sales.updateCommission({
  projectLeadKey: "pipeline:60127770001",
  propertyValue: 500000,
  commissionRatePercent: 3,
  teamSplitPercent: 50,
  probabilityPercent: 40,
  actualCommission: 0,
  commissionStatus: "EXPECTED",
  reason: "Agent estimate",
});
assert.equal(lead.grossCommission, 15000);
assert.equal(lead.expectedCommission, 3000);
assert.equal(calculateCommission({ propertyValue: 500000, commissionRatePercent: 3, teamSplitPercent: 50, probabilityPercent: 40 }).formula.includes("probability"), true);

// 10. A forward Notion human edit is applied through the controlled inbox; a
// backward edit without a correction reason becomes a conflict instead of overwriting SQLite.
const syncRepository = createNotionCrmSyncRepository({ dataDir, sqliteBinary: binary, clock: () => new Date(now) });
const engine = createNotionCrmSyncEngine({ notion: async () => ({ id: "patched", last_edited_time: now.toISOString() }), repository: syncRepository, databaseIds: { projectLeads: "db-project-leads", customers: "db-customers" }, clock: () => new Date(now) });
let localLead = await syncRepository.loadProjectLead("pipeline:60127770001");
const stableId = stableCrmId("PLEAD", localLead.projectLeadKey);
let properties = projectLeadProperties(localLead, stableId);
properties["Project Stage"] = { select: { name: "Appointment" } };
properties.Temperature = { select: { name: "Hot" } };
properties["Stage Change Reason"] = { rich_text: [{ plain_text: "Appointment agreed" }] };
await engine.receivePage("crm_project_lead", { id: "notion-page-07", last_edited_time: "2026-08-08T11:01:00.000Z", properties });
assert.equal((await engine.processInbox()).applied, 1);
localLead = await syncRepository.loadProjectLead("pipeline:60127770001");
assert.equal(localLead.salesStage, "APPOINTMENT");
assert.equal(localLead.temperature, "HOT");

properties = projectLeadProperties(localLead, stableId);
properties["Project Stage"] = { select: { name: "Qualified" } };
properties["Stage Change Reason"] = { rich_text: [] };
await engine.receivePage("crm_project_lead", { id: "notion-page-07", last_edited_time: "2026-08-08T11:02:00.000Z", properties });
assert.equal((await engine.processInbox()).conflicts, 1);
assert.equal((await syncRepository.loadProjectLead("pipeline:60127770001")).salesStage, "APPOINTMENT");

// 7. Won mirrors the legacy status consumed by central Send Eligibility.
await sales.transitionStage({ projectLeadKey: "pipeline:60127770001", toStage: "WON", source: "human", reason: "Sale completed" });
const eligibility = createSendEligibilityService({ repository: createSendEligibilityRepository({ dataDir, sqliteBinary: binary, clock: () => new Date(now) }), clock: () => new Date(now) });
const blocked = await eligibility.check({
  recipient: { phone: "60127770001" },
  projectLead: { projectCode: "pipeline" },
  campaign: { campaignId: "campaign-07", runId: "run-07", projectId: "pipeline", mode: "LIVE" },
  connection: { instanceName: "wa_01", available: true },
  requestedAction: "FLOW_SEQUENCE",
});
assert.equal(blocked.reason_code, "CUSTOMER_CONVERTED");

assert.equal(decideStageTransition({ from: "QUALIFIED", to: "WARM", source: "system" }).code, "HUMAN_CONFIRMATION_REQUIRED");
await fs.rm(rootDir, { recursive: true, force: true });
console.log("✅ Sales stage, opportunity, follow-up triggers, task outcome, commission and safe Notion edit tests passed");
