import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { normalizeIdentityValue } from "./domain/customer-identity.mjs";
import { createConversationLogService } from "./lib/conversation-log-service.mjs";
import { createCustomerIdentityRepository } from "./lib/customer-identity-repository.mjs";
import { createLocalDatabaseService } from "./lib/local-database-service.mjs";
import { createLidMapService } from "./lib/lid-map-service.mjs";
import { createSqliteCli, findSqliteCli } from "./lib/sqlite-cli.mjs";
import { migrateSqliteNotionSync } from "../scripts/maintenance/migrate-sqlite-notion-sync.mjs";
import { migrateCustomerIdentity } from "../scripts/maintenance/migrate-customer-identity.mjs";

const binary = await findSqliteCli();
if (!binary) {
  console.log("⚠️ 这台机器没有 sqlite3，跳过 Customer Identity 测试。");
  process.exit(0);
}

assert.equal(normalizeIdentityValue("PHONE_E164", "+60 12-000 0001"), "60120000001");
assert.equal(normalizeIdentityValue("PHONE_E164", "0120000001"), "60120000001");
assert.equal(normalizeIdentityValue("WHATSAPP_LID", "999:12@lid"), "999");

const dashboardHtml = await fs.readFile(new URL("./customer-identity.html", import.meta.url), "utf8");
const dashboardScript = dashboardHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1] || "";
assert.doesNotThrow(() => new vm.Script(dashboardScript), "Customer Identity dashboard JavaScript must parse");

const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-customer-identity-"));
const dataDir = path.join(rootDir, "campaign-data");
const local = createLocalDatabaseService({ dataDir });
await local.initialize();
migrateSqliteNotionSync({
  rootDir,
  databasePath: local.databasePath,
  binary,
  apply: true,
  confirmation: "APPLY_SQLITE_NOTION_SYNC_V1",
});
const db = await createSqliteCli({ databasePath: local.databasePath, sqliteBinary: binary });
const at = "2026-08-08T00:00:00.000Z";
await db.exec(`INSERT INTO contacts(contact_key,phone,display_name,created_at,updated_at) VALUES
  ('60120000001','60120000001','Alex One','${at}','${at}'),
  ('60120000002','60120000002','Alex Two','${at}','${at}');`);

const migration = migrateCustomerIdentity({
  rootDir,
  databasePath: local.databasePath,
  binary,
  apply: true,
  confirmation: "APPLY_CUSTOMER_IDENTITY_V1",
});
assert.equal(migration.verification.quickCheck, "ok");
assert.equal(Number(migration.verification.contactsWithoutCustomer), 0);

const identity = createCustomerIdentityRepository({ dataDir, sqliteBinary: binary });
assert.equal((await identity.schemaStatus()).ready, true);
const [first, second] = await db.query("SELECT customer_id AS customerId,primary_phone AS phone FROM customers ORDER BY primary_phone;");

const samePhone = await identity.resolveRows([{ phone: "+60 12-000 0001", contactKey: "60120000001", name: "Different display name" }]);
assert.equal(samePhone.rows[0].customerId, first.customerId, "phone formatting must resolve to one stable customer");
assert.equal((await db.query("SELECT COUNT(*) AS count FROM customers;"))[0].count, 2, "same phone must not create another customer");
await assert.rejects(
  identity.resolveRows([{ name: "Alex One" }]),
  (error) => error.code === "CUSTOMER_IDENTITY_NAME_ONLY_FORBIDDEN",
  "name-only evidence must never auto-merge or create a customer",
);

const paired = await identity.observeLidPhone({ lid: "999", phone: first.phone, source: "live", externalMessageId: "PAIR-1" });
assert.equal(paired.customerId, first.customerId);
const conflicted = await identity.observeLidPhone({ lid: "999", phone: second.phone, source: "live", externalMessageId: "PAIR-2" });
assert.equal(conflicted.customerId, null);
assert.ok(conflicted.conflict?.conflictId);
const [openConflict] = await identity.listConflicts({ status: "OPEN" });
assert.equal(openConflict.identityType, "WHATSAPP_LID");
assert.equal(openConflict.identityValue, "999");
await identity.resolveConflict(openConflict.conflictId, { action: "KEEP_EXISTING", resolvedBy: "automated-test" });
const replayedConflict = await identity.observeLidPhone({ lid: "999", phone: second.phone, source: "live", externalMessageId: "PAIR-2" });
assert.equal(replayedConflict.customerId, first.customerId, "explicit KEEP_EXISTING must make replay deterministic without moving aliases");
assert.equal(replayedConflict.conflict, null);
const lidMap = createLidMapService({ dataDir, sqliteBinary: binary, identityRepository: identity });
await lidMap.learn([{ lid: "555", phone: first.phone }], { source: "live", evidence: "test" });
const lidMapConflict = await lidMap.learn([{ lid: "555", phone: second.phone }], { source: "live", evidence: "test-conflict" });
assert.equal(lidMapConflict.conflicts.length, 1);
assert.equal(await lidMap.resolve("555"), first.phone, "LID conflict must not overwrite the lookup cache");

await db.exec(`INSERT INTO devices(device_key,device_name,created_at,updated_at) VALUES
  ('device-a','Device A','${at}','${at}'),('device-b','Device B','${at}','${at}');
INSERT INTO whatsapp_connections(connection_key,instance_name,whatsapp_number,device_key,status,created_at,updated_at) VALUES
  ('device-a::60111111111','wa_01','60111111111','device-a','OPEN','${at}','${at}'),
  ('device-b::60222222222','wa_02','60222222222','device-b','OPEN','${at}','${at}');`);
const conversationLog = createConversationLogService({ dataDir, sqliteBinary: binary, identityRepository: identity });
const baseMessage = {
  id: "SHARED-ID",
  phone: first.phone,
  name: "Alex One",
  text: "first device",
  remoteJid: "444@lid",
  lid: "444",
  receivedAt: "2026-08-08T01:00:00.000Z",
  instanceName: "wa_01",
  sender: "60111111111",
};
await conversationLog.recordReplies([baseMessage, baseMessage], { force: true });
await conversationLog.recordReplies([{
  ...baseMessage,
  text: "second device",
  instanceName: "wa_02",
  sender: "60222222222",
  receivedAt: "2026-08-08T01:01:00.000Z",
}], { force: true });
const sharedRows = await db.query("SELECT connection_key AS connectionKey,external_message_id AS externalMessageId,customer_id AS customerId,remote_jid AS remoteJid,raw_payload_ref AS rawPayloadRef FROM messages WHERE external_message_id='SHARED-ID' ORDER BY connection_key;");
assert.equal(sharedRows.length, 2, "message replay is unique per connection, not globally");
assert.ok(sharedRows.every((row) => row.customerId === first.customerId));
assert.ok(sharedRows.every((row) => row.remoteJid === "444@lid" && row.rawPayloadRef.startsWith("evolution:")));
assert.equal((await db.query(`SELECT COUNT(*) AS count FROM conversations WHERE customer_id='${first.customerId}';`))[0].count, 2, "one customer keeps one conversation per WhatsApp connection");
const timeline = await db.query(`SELECT text FROM messages WHERE customer_id='${first.customerId}' ORDER BY sent_at,row_id;`);
assert.deepEqual(timeline.map((row) => row.text), ["first device", "second device"], "timeline must interleave devices by message time");
await conversationLog.recordOutbounds([{
  phone: first.phone, text: "out A", messageId: "OUT-SHARED", instanceName: "wa_01", senderNumber: "60111111111",
  sentAt: "2026-08-08T01:02:00.000Z", apiStatus: "PENDING",
}, {
  phone: first.phone, text: "out B", messageId: "OUT-SHARED", instanceName: "wa_02", senderNumber: "60222222222",
  sentAt: "2026-08-08T01:03:00.000Z", apiStatus: "PENDING",
}], { force: true });
const delivery = await conversationLog.recordDeliveryUpdates([{
  messageId: "OUT-SHARED", status: "READ", instanceName: "wa_02", observedAt: "2026-08-08T01:04:00.000Z",
}]);
assert.equal(delivery.updated, 1);
const deliveryRows = await db.query("SELECT connection_key AS connectionKey,payload_json AS payloadJson FROM messages WHERE external_message_id='OUT-SHARED' ORDER BY connection_key;");
assert.deepEqual(deliveryRows.map((row) => JSON.parse(row.payloadJson).deliveryStatus), ["PENDING", "READ"], "delivery receipt must update only its sender connection");

const plan = await identity.mergePlan({ survivingCustomerId: first.customerId, duplicateCustomerId: second.customerId });
assert.equal(plan.counts.identities >= 2, true);
await db.exec(`INSERT INTO projects(project_code,project_name,active,created_at,updated_at) VALUES ('identity-test','Identity Test',1,'${at}','${at}');
INSERT INTO campaign_runs(run_id,project_code,mode,status,started_at) VALUES ('live-identity-test','identity-test','LIVE','RUNNING','${at}');`);
await assert.rejects(
  identity.applyMerge({ survivingCustomerId: first.customerId, duplicateCustomerId: second.customerId, confirmation: "MERGE_CUSTOMER_IDENTITIES" }),
  (error) => error.code === "ACTIVE_CAMPAIGN_BLOCKS_CUSTOMER_MERGE",
);
await db.exec("UPDATE campaign_runs SET status='STOPPED' WHERE run_id='live-identity-test';");
const merged = await identity.applyMerge({
  survivingCustomerId: first.customerId,
  duplicateCustomerId: second.customerId,
  confirmation: "MERGE_CUSTOMER_IDENTITIES",
  reason: "verified duplicate test",
  createdBy: "automated-test",
});
assert.equal((await identity.customerDetail(second.customerId)).globalStatus, "Merged");
await identity.reverseMerge(merged.mergeId, { confirmation: "REVERSE_CUSTOMER_MERGE", reversedBy: "automated-test" });
assert.equal((await identity.customerDetail(second.customerId)).globalStatus, "Active");

await fs.rm(rootDir, { recursive: true, force: true });
console.log("✅ Customer Identity migration, resolution, LID conflict, message identity, LIVE guard and reversible merge tests passed");
