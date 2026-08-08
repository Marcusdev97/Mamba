import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { decideSendEligibility, SEND_ACTIONS } from "./domain/send-eligibility.mjs";
import { createLocalDatabaseService } from "./lib/local-database-service.mjs";
import { createSendEligibilityRepository } from "./lib/send-eligibility-repository.mjs";
import { createSendEligibilityService } from "./lib/send-eligibility-service.mjs";
import { createSqliteCli, findSqliteCli } from "./lib/sqlite-cli.mjs";
import { migrateSqliteNotionSync } from "../scripts/maintenance/migrate-sqlite-notion-sync.mjs";
import { migrateCustomerIdentity } from "../scripts/maintenance/migrate-customer-identity.mjs";
import { migrateSendEligibility } from "../scripts/maintenance/migrate-send-eligibility.mjs";

const binary = await findSqliteCli();
if (!binary) {
  console.log("⚠️ 这台机器没有 sqlite3，跳过 Send Eligibility 测试。");
  process.exit(0);
}

const now = new Date("2026-08-08T10:00:00.000Z");
const campaign = {
  campaignId: "campaign-06",
  runId: "run-06",
  projectId: "eligibility",
  mode: "LIVE",
  flowTopic: "Flow 2 - Layout",
  resendCooldownDays: 0,
  startAt: "2026-08-08T00:00:00.000Z",
  endAt: "2026-08-09T00:00:00.000Z",
};
const connection = { instanceName: "wa_01", available: true };

function domain(input = {}) {
  return decideSendEligibility({
    customer: { globalStatus: "ACTIVE", identityValid: true, phoneValid: true, ...(input.customer || {}) },
    projectLead: input.projectLead || {},
    campaignMember: input.campaignMember || {},
    campaign: { startAt: campaign.startAt, endAt: campaign.endAt, ...(input.campaign || {}) },
    connection: { available: true, ...(input.connection || {}) },
    now,
    requestedAction: input.requestedAction || SEND_ACTIONS.FLOW_SEQUENCE,
  });
}

// 1–3. STOP is higher priority than flow number or retry intent.
assert.equal(domain({ customer: { globalStatus: "STOP" }, requestedAction: SEND_ACTIONS.FLOW_1 }).reason_code, "GLOBAL_STOP");
assert.equal(domain({ customer: { globalStatus: "STOP" }, requestedAction: SEND_ACTIONS.FLOW_SEQUENCE }).allowed, false);
assert.equal(domain({ customer: { globalStatus: "STOP" }, requestedAction: SEND_ACTIONS.RETRY_FAILED_SEND }).reason_code, "GLOBAL_STOP");

// 4–7. Reply, snooze, appointment, and booking use one ordered rule set.
assert.equal(domain({ projectLead: { requiresHandoff: true } }).reason_code, "CUSTOMER_REPLIED");
assert.equal(domain({ projectLead: { status: "SNOOZED", snoozeUntil: "2026-08-09T10:00:00.000Z" } }).reason_code, "SNOOZED");
assert.equal(domain({ projectLead: { status: "SNOOZED", snoozeUntil: "2026-08-07T10:00:00.000Z" } }).allowed, true);
assert.equal(domain({ projectLead: { status: "APPOINTMENT" } }).reason_code, "APPOINTMENT_EXISTS");
assert.equal(domain({ projectLead: { status: "BOOKING" } }).reason_code, "CUSTOMER_CONVERTED");

// 9–11. Recovery cannot bypass the rules; AI proposals never send; invalid is blocked.
assert.equal(domain({ projectLead: { requiresHandoff: true }, requestedAction: SEND_ACTIONS.RESTART_RECOVERY }).allowed, false);
assert.equal(domain({ requestedAction: SEND_ACTIONS.AI_PROPOSED_SEND }).reason_code, "AI_APPROVAL_REQUIRED");
assert.equal(domain({ customer: { phoneValid: false } }).reason_code, "INVALID_NUMBER");
assert.equal(domain({ customer: { globalStatus: "STOP", phoneValid: false } }).reason_code, "GLOBAL_STOP", "STOP must win the priority order");

const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-send-eligibility-"));
const dataDir = path.join(rootDir, "campaign-data");
const local = createLocalDatabaseService({ dataDir });
await local.initialize();
migrateSqliteNotionSync({ rootDir, databasePath: local.databasePath, binary, apply: true, confirmation: "APPLY_SQLITE_NOTION_SYNC_V1" });
migrateCustomerIdentity({ rootDir, databasePath: local.databasePath, binary, apply: true, confirmation: "APPLY_CUSTOMER_IDENTITY_V1" });
const migration = migrateSendEligibility({ rootDir, databasePath: local.databasePath, binary, apply: true, confirmation: "APPLY_SEND_ELIGIBILITY_V1" });
assert.equal(migration.verification.quickCheck, "ok");

const db = await createSqliteCli({ databasePath: local.databasePath, sqliteBinary: binary });
const at = now.toISOString();
await db.exec(`INSERT INTO projects(project_code,project_name,active,created_at,updated_at) VALUES ('eligibility','Eligibility',1,'${at}','${at}');
INSERT INTO devices(device_key,device_name,created_at,updated_at) VALUES ('device-06','Device 06','${at}','${at}');
INSERT INTO whatsapp_connections(connection_key,instance_name,whatsapp_number,device_key,status,created_at,updated_at) VALUES
  ('device-06::60111111111','wa_01','60111111111','device-06','OPEN','${at}','${at}'),
  ('device-06::60222222222','wa_02','60222222222','device-06','OPEN','${at}','${at}');
INSERT INTO contacts(contact_key,phone,display_name,created_at,updated_at) VALUES
  ('60120000001','60120000001','Eligibility One','${at}','${at}'),
  ('60120000002','60120000002','Eligibility Two','${at}','${at}');
INSERT INTO project_leads(project_lead_key,contact_key,project_code,phone,name,sequence_status,status,created_at,updated_at) VALUES
  ('eligibility:60120000001','60120000001','eligibility','60120000001','Eligibility One','ACTIVE','NEW','${at}','${at}'),
  ('eligibility:60120000002','60120000002','eligibility','60120000002','Eligibility Two','ACTIVE','NEW','${at}','${at}');
INSERT INTO campaign_runs(run_id,project_code,mode,status,started_at) VALUES ('run-06','eligibility','LIVE','QUEUED','${at}');
INSERT INTO send_jobs(id,run_id,project_lead_key,connection_key,flow_topic,status,created_at,updated_at) VALUES
  ('future-1','run-06','eligibility:60120000001','device-06::60111111111','Flow 3','PENDING','${at}','${at}');`);

const repository = createSendEligibilityRepository({ dataDir, sqliteBinary: binary, clock: () => new Date(now) });
const eligibility = createSendEligibilityService({ repository, clock: () => new Date(now) });
assert.equal((await eligibility.schemaStatus()).ready, true);

const optionsFor = (phone, extra = {}) => ({
  recipient: { phone },
  projectLead: { projectCode: "eligibility", ...(extra.projectLead || {}) },
  campaign: { ...campaign, ...(extra.campaign || {}) },
  connection: { ...connection, ...(extra.connection || {}) },
  requestedAction: extra.requestedAction || SEND_ACTIONS.FLOW_SEQUENCE,
  jobId: extra.jobId || `job:${phone}`,
});

// 12. Every allowed and blocked evaluation is audited.
const allowed = await eligibility.check(optionsFor("60120000001"));
assert.equal(allowed.allowed, true);
assert.ok(allowed.decision_id);

// 4. A meaningful reply pauses memberships, cancels future jobs, and opens a task.
await eligibility.propagateReply({ phone: "60120000001", category: "QUESTION", source: "test", idempotencyKey: "reply-06-1", text: "How much?" });
const replyDecision = await eligibility.check(optionsFor("60120000001"));
assert.equal(replyDecision.reason_code, "CUSTOMER_REPLIED");
assert.equal((await db.query("SELECT status FROM campaign_memberships WHERE customer_id=(SELECT customer_id FROM customers WHERE primary_phone='60120000001') LIMIT 1;"))[0].status, "PAUSED_REPLY");
assert.equal((await db.query("SELECT status FROM send_jobs WHERE id='future-1';"))[0].status, "CANCELLED");
assert.equal((await db.query("SELECT COUNT(*) AS count FROM customer_follow_up_tasks WHERE task_type='REPLY_HANDOFF' AND status='OPEN';"))[0].count, 1);

// 5. Snooze persists the due task and blocks only before the confirmed time.
await eligibility.snooze({ phone: "60120000002", until: "2026-08-09T10:00:00.000Z", source: "test" });
assert.equal((await eligibility.check(optionsFor("60120000002"))).reason_code, "SNOOZED");
assert.equal((await db.query("SELECT COUNT(*) AS count FROM customer_follow_up_tasks WHERE task_type='SNOOZE_DUE';"))[0].count, 1);
await db.exec("UPDATE project_leads SET status='NEW',sequence_status='ACTIVE',snooze_until=NULL WHERE phone='60120000002'; UPDATE campaign_memberships SET status='PENDING',reason_code='' WHERE customer_id=(SELECT customer_id FROM customers WHERE primary_phone='60120000002');");

// 7. Booking is a project exit, not a generic failure.
await db.exec("UPDATE project_leads SET status='BOOKING' WHERE phone='60120000002';");
const booking = await eligibility.check(optionsFor("60120000002"));
assert.equal(booking.reason_code, "CUSTOMER_CONVERTED");
assert.equal((await db.query("SELECT status FROM campaign_memberships WHERE customer_id=(SELECT customer_id FROM customers WHERE primary_phone='60120000002') LIMIT 1;"))[0].status, "EXIT_BOOKED");
await db.exec("UPDATE project_leads SET status='NEW' WHERE phone='60120000002'; UPDATE campaign_memberships SET status='PENDING',reason_code='',exited_at=NULL WHERE customer_id=(SELECT customer_id FROM customers WHERE primary_phone='60120000002');");

// 8 + multi-number gate. wa_02 cannot acquire the same customer's lock while wa_01 owns it.
let releaseFirst;
let firstAcquired;
const acquired = new Promise((resolve) => { firstAcquired = resolve; });
const hold = new Promise((resolve) => { releaseFirst = resolve; });
const firstSend = eligibility.withSendLock(optionsFor("60120000002", { connection: { instanceName: "wa_01", available: true }, jobId: "lane-1" }), async () => {
  firstAcquired();
  await hold;
  return "sent";
});
await acquired;
await assert.rejects(
  eligibility.withSendLock(optionsFor("60120000002", { connection: { instanceName: "wa_02", available: true }, jobId: "lane-2" }), async () => "duplicate"),
  (error) => error.code === "SEND_ELIGIBILITY_BLOCKED" && error.reasonCode === "DUPLICATE_PENDING_SEND",
);
releaseFirst();
assert.equal(await firstSend, "sent");

// Global STOP propagates across projects, memberships, pending jobs, suppression, audit, and CRM outbox.
await db.exec(`INSERT INTO campaign_runs(run_id,project_code,mode,status,started_at) VALUES ('run-stop','eligibility','LIVE','QUEUED','${at}');
INSERT INTO send_jobs(id,run_id,project_lead_key,connection_key,flow_topic,status,created_at,updated_at) VALUES
  ('future-stop','run-stop','eligibility:60120000002','device-06::60111111111','Flow 4','PENDING','${at}','${at}');`);
await eligibility.propagateStop({ phone: "60120000002", source: "test", reasonCode: "WRONG_PERSON", idempotencyKey: "stop-06-1" });
assert.equal((await eligibility.check(optionsFor("60120000002", { requestedAction: SEND_ACTIONS.FLOW_1 }))).reason_code, "GLOBAL_STOP");
const stopState = (await db.query(`SELECT
  (SELECT global_status FROM customers WHERE primary_phone='60120000002') AS globalStatus,
  (SELECT stop_flag FROM contacts WHERE phone='60120000002') AS stopFlag,
  (SELECT status FROM send_jobs WHERE id='future-stop') AS jobStatus,
  (SELECT COUNT(*) FROM global_suppressions WHERE phone='60120000002' AND status='ACTIVE') AS suppressions,
  (SELECT COUNT(*) FROM customer_state_events WHERE event_type='GLOBAL_STOP') AS events,
  (SELECT COUNT(*) FROM sync_jobs WHERE entity_type='crm_customer' AND status='PENDING') AS syncJobs;`))[0];
assert.equal(stopState.globalStatus, "Stop");
assert.equal(stopState.stopFlag, 1);
assert.equal(stopState.jobStatus, "CANCELLED");
assert.equal(stopState.suppressions, 1);
assert.equal(stopState.events, 1);
assert.equal(stopState.syncJobs >= 1, true);

const preview = await eligibility.previewAssignments([
  { id: "p1", lead: { phone: "60120000001", projectCode: "eligibility" }, instanceName: "wa_01" },
  { id: "p2", lead: { phone: "60120000002", projectCode: "eligibility" }, instanceName: "wa_01" },
], { campaign });
assert.equal(preview.selected, 2);
assert.equal(preview.eligible, 0, "reply and STOP preview counts must match the two blocked records");
assert.equal(preview.byReason.CUSTOMER_REPLIED, 1);
assert.equal(preview.byReason.GLOBAL_STOP, 1);

const audited = await eligibility.listDecisions({ runId: "run-06" });
assert.equal(audited.length >= 10, true);
assert.ok(audited.every((item) => item.decisionId && item.reasonCode && item.evaluatedAt));

await fs.rm(rootDir, { recursive: true, force: true });
console.log("✅ Send Eligibility 12-rule, audit, STOP propagation, reply pause, snooze, booking, restart, AI and cross-lane lock tests passed");
