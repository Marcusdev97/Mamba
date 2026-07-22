import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLocalDatabaseService } from "./lib/local-database-service.mjs";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-local-db-test-"));
const device = { id: "mamba-test-device", name: "Test Mac", hostname: "test-mac.local" };
const senderPolicy = { configured: true, expectedSenderPhone: "60168568756" };
const service = createLocalDatabaseService({ dataDir, device, senderPolicy });

const before = await service.snapshot();
assert.equal(before.driverAvailable, true);
assert.equal(before.initialized, false);
assert.equal(before.health, "not_initialized");

const initialized = await service.initialize();
assert.equal(initialized.health, "ready");
assert.equal(initialized.schemaVersion, 3);
assert.equal(initialized.storageMode, "shadow");
assert.equal(initialized.expectedSenderKey, "mamba-test-device::60168568756");
assert.deepEqual(initialized.syncWorker, {
  enabled: false,
  mode: "SHADOW",
  status: "IDLE",
  retryJobs: 0,
  failedJobs: 0,
});
assert.deepEqual(initialized.counts, {
  customers: 0,
  projectLeads: 0,
  conversations: 0,
  messages: 0,
  operations: 0,
  pendingSyncJobs: 0,
});

const second = await service.initialize();
assert.equal(second.health, "ready", "v3 initialization must be idempotent");

const detected = await service.driver();
const bindings = JSON.parse(execFileSync(detected.binary, [
  "-batch", "-json", service.databasePath,
  "SELECT connection_key AS connectionKey, instance_name AS instanceName, device_key AS deviceKey, whatsapp_number AS senderPhone FROM whatsapp_connections;",
], { encoding: "utf8" }));
assert.deepEqual(bindings, [{
  connectionKey: "mamba-test-device::60168568756",
  instanceName: "",
  deviceKey: "mamba-test-device",
  senderPhone: "60168568756",
}]);

service.configureNotionImport({
  fetchRecords: async () => [
    { id: "page-local-1", phone: "60123456789", project: "Binastra", name: "Alice", status: "Running", sequenceStatus: "Running" },
    { id: "page-invalid", phone: "60123450000", project: "", name: "Missing Project" },
    { id: "page-remote", phone: "60123450001", project: "Enlace", name: "Remote" },
    { id: "page-legacy", phone: "60123450002", project: "Enlace", name: "Legacy" },
  ],
  scopeRecords: (records) => ({ records: records.slice(0, 2), counts: { local: 2, remote: 1, legacy: 1, unassigned: 0 } }),
  resolveProjectCode: (name) => ({ Binastra: "binastra", Enlace: "enlace" })[name] || "",
});
const heldPreview = await service.previewNotionImport();
assert.equal(heldPreview.sourceCount, 4);
assert.equal(heldPreview.scopedCount, 2);
assert.equal(heldPreview.inserts, 1);
assert.equal(heldPreview.invalid, 1);
assert.equal(heldPreview.safeToApply, false);
assert.deepEqual(heldPreview.scope, { local: 2, remote: 1, legacy: 1, unassigned: 0 });

service.configureNotionImport({
  fetchRecords: async () => [
    { id: "page-local-1", phone: "60123456789", project: "Binastra", name: "Alice", status: "Running", sequenceStatus: "Running" },
    { id: "page-local-2", phone: "0123456788", project: "Enlace", name: "Bob", status: "Running", sequenceStatus: "Running" },
  ],
  scopeRecords: (records) => ({ records, counts: { local: 2, remote: 0, legacy: 0, unassigned: 0 } }),
  resolveProjectCode: (name) => ({ Binastra: "binastra", Enlace: "enlace" })[name] || "",
});
const safePreview = await service.previewNotionImport();
assert.equal(safePreview.safeToApply, true);
assert.equal(safePreview.inserts, 2);
assert.equal(safePreview.invalid, 0);
assert.equal((await service.snapshot()).notionImport.status, "dry_run_complete");

const dryRunRows = JSON.parse(execFileSync(detected.binary, [
  "-batch", "-json", service.databasePath,
  "SELECT COUNT(*) AS count FROM import_runs WHERE mode = 'DRY_RUN';",
], { encoding: "utf8" }));
assert.deepEqual(dryRunRows, [{ count: 2 }]);
const localLeadRows = JSON.parse(execFileSync(detected.binary, [
  "-batch", "-json", service.databasePath,
  "SELECT (SELECT COUNT(*) FROM contacts) AS contacts, (SELECT COUNT(*) FROM project_leads) AS projectLeads;",
], { encoding: "utf8" }));
assert.deepEqual(localLeadRows, [{ contacts: 0, projectLeads: 0 }], "Dry Run must never import customer data");

const applied = await service.applyNotionImport();
assert.equal(applied.report.imported, 2);
assert.equal(applied.database.counts.customers, 2);
assert.equal(applied.database.counts.projectLeads, 2);
assert.equal(applied.database.storageMode, "shadow", "Apply must not silently enable Primary");
assert.equal((await fs.stat(applied.report.backupPath)).isFile(), true, "Apply must create a restorable backup first");

const localCache = await service.readLeadCache();
assert.equal(localCache.source, "sqlite");
assert.equal(localCache.records.length, 2);
assert.equal(localCache.records.find((row) => row.id === "page-local-1")?.name, "Alice");

const primary = await service.setStorageMode("primary");
assert.equal(primary.storageMode, "primary");
assert.equal(primary.notionImport.status, "primary");
assert.equal(await service.isPrimary(), true);

// initialize / health checks must not silently reset a deliberate Primary cutover.
assert.equal((await service.initialize()).storageMode, "primary");

// Campaign facts must land in SQLite before Notion. A stopped/failed cloud sync
// cannot leave a successfully contacted customer in the old Flow.
const localAdvance = await service.recordCampaignFlowProgress({
  runId: "run_local_first_flow_2",
  projectCode: "binastra",
  projectName: "Binastra",
  flowLabel: "Flow 2 - Layout",
  nextFlow: "Flow 3 - Location",
  cohortDay: "Day 2",
  sequenceStatus: "Running",
  mode: "LIVE",
  runStatus: "STOPPED",
  deviceId: device.id,
  startedAt: "2026-07-22T08:00:00.000Z",
  assignments: [{
    phone: "60123456789",
    name: "Alice",
    instanceName: "wa_01",
    senderPhone: senderPolicy.expectedSenderPhone,
    senderKey: "mamba-test-device::60168568756",
    part1SentAt: "2026-07-22T08:01:00.000Z",
    part2SentAt: "2026-07-22T08:02:00.000Z",
    sentAt: "2026-07-22T08:02:00.000Z",
    dueDate: "2026-07-24",
  }],
});
assert.equal(localAdvance.recorded, 1);
let advancedAlice = (await service.readLeadCache()).records.find((row) => row.id === "page-local-1");
assert.equal(advancedAlice.lastFlowSent, "Flow 2 - Layout");
assert.equal(advancedAlice.nextFlow, "Flow 3 - Location");
assert.equal(advancedAlice.campaignRunId, "run_local_first_flow_2");
assert.equal(advancedAlice.lastBlastAt, "2026-07-22T08:02:00.000Z");
const localRunRows = JSON.parse(execFileSync(detected.binary, [
  "-batch", "-json", service.databasePath,
  "SELECT (SELECT COUNT(*) FROM campaign_runs WHERE run_id='run_local_first_flow_2') AS runs, (SELECT COUNT(*) FROM send_jobs WHERE run_id='run_local_first_flow_2') AS jobs;",
], { encoding: "utf8" }));
assert.deepEqual(localRunRows, [{ runs: 1, jobs: 2 }]);

// A stale Notion refresh must not roll the locally acknowledged send backward.
await service.syncNotionRecords([
  {
    id: "page-local-1", phone: "60123456789", project: "Binastra", name: "Alice",
    status: "Running", sequenceStatus: "Running", lastFlowSent: "Flow 1 - Project Template",
    nextFlow: "Flow 2 - Layout", cohortDay: "Day 0", lastBlastAt: "2026-07-20T08:00:00.000Z",
  },
  { id: "page-local-2", phone: "0123456788", project: "Enlace", name: "Bob", status: "Running", sequenceStatus: "Running" },
], { reason: "stale_notion_test" });
advancedAlice = (await service.readLeadCache()).records.find((row) => row.id === "page-local-1");
assert.equal(advancedAlice.nextFlow, "Flow 3 - Location", "stale Notion must not regress local Flow progress");

const manualFlow = await service.setLeadFlowState({
  targets: [{ pageId: "page-local-2", phone: "60123456788" }],
  nextFlow: "Flow 3 - Location",
  lastFlowSent: "Flow 2 - Layout",
  cohortDay: "Day 2",
  followUpDue: "2026-07-22",
});
assert.equal(manualFlow.updated, 1);
assert.equal((await service.readLeadCache()).records.find((row) => row.id === "page-local-2")?.nextFlow, "Flow 3 - Location");

const localReply = await service.recordLeadReply({
  pageId: "page-local-1",
  phone: "60123456789",
  at: "2026-07-22T09:00:00.000Z",
  text: "not interested",
  reply: { signal: "RED", route: "NOT_INTERESTED", status: "Not Interested", sequenceStatus: "Not Interested", aiCategory: "Not Interested", stopFlag: true },
});
assert.equal(localReply.updated, 1);
advancedAlice = (await service.readLeadCache()).records.find((row) => row.id === "page-local-1");
assert.equal(advancedAlice.stopFlag, true);
assert.equal(advancedAlice.lastReplyText, "not interested");
assert.equal(advancedAlice.sequenceStatus, "Not Interested");

service.configureNotionImport({
  fetchRecords: async () => [
    { id: "page-local-1", phone: "", project: "Binastra", name: "Broken" },
    { id: "page-local-2", phone: "0123456788", project: "Enlace", name: "Bob" },
  ],
  scopeRecords: (records) => ({ records, counts: { local: 2, remote: 0, legacy: 0, unassigned: 0 } }),
  resolveProjectCode: (name) => ({ Binastra: "binastra", Enlace: "enlace" })[name] || "",
});
await assert.rejects(service.applyNotionImport(), (error) => error.code === "NOTION_IMPORT_CHANGED_AFTER_DRY_RUN");
assert.equal((await service.readLeadCache()).records.length, 2, "Rejected Apply must preserve the current SQLite dataset");

assert.equal((await service.setStorageMode("shadow")).storageMode, "shadow");

// Flow 1 客户群保存在 SQLite，可选择、改名和编辑成员；作用域必须绑定 device + 真实号码。
const group = await service.createLeadGroup({
  projectCode: "binastra",
  projectName: "Binastra",
  name: "July Website Leads",
  sourceType: "file",
  sourceName: "july.xlsx",
  leads: [
    { id: "lead_1", name: "Alice", phone: "60111111111", sourceRow: 2 },
    { id: "lead_2", name: "Bob", phone: "0122222222", sourceRow: 3 },
    { id: "lead_dup", name: "Bob duplicate", phone: "60122222222", sourceRow: 4 },
  ],
});
assert.equal(group.name, "July Website Leads");
assert.equal(group.memberCount, 2, "customer group must deduplicate normalized phones");
assert.equal((await service.listLeadGroups({ projectCode: "binastra" })).length, 1);
const renamedGroup = await service.renameLeadGroup({ groupId: group.id, projectCode: "binastra", name: "July Web Leads · Batch A" });
assert.equal(renamedGroup.name, "July Web Leads · Batch A");
await service.updateLeadGroupMembers({
  groupId: group.id,
  projectCode: "binastra",
  edits: [{ id: "lead_1", name: "Alice Tan" }],
});
assert.equal((await service.readLeadGroup({ groupId: group.id, projectCode: "binastra" })).leads[0].name, "Alice Tan");
await assert.rejects(
  service.createLeadGroup({
    projectCode: "binastra",
    projectName: "Binastra",
    name: "July Web Leads · Batch A",
    leads: [{ name: "New", phone: "60133333333" }],
  }),
  (error) => error.code === "LEAD_GROUP_NAME_EXISTS",
);

// 两台电脑可以都叫 wa_01；真正唯一的是 device::phone。
const otherDevice = createLocalDatabaseService({
  dataDir,
  device: { id: "another-device", name: "Other Mac", hostname: "other.local" },
  senderPolicy: { configured: true, expectedSenderPhone: "60168568756" },
});
await otherDevice.initialize();
assert.deepEqual(await otherDevice.listLeadGroups({ projectCode: "binastra" }), [], "other device must not see this device's Flow 1 customer groups");
await assert.rejects(
  otherDevice.readLeadGroup({ groupId: group.id, projectCode: "binastra" }),
  (error) => error.code === "LEAD_GROUP_NOT_LOCAL",
);
const crossDeviceBindings = JSON.parse(execFileSync(detected.binary, [
  "-batch", "-json", service.databasePath,
  "SELECT connection_key AS connectionKey FROM whatsapp_connections ORDER BY connection_key;",
], { encoding: "utf8" }));
assert.deepEqual(crossDeviceBindings, [
  { connectionKey: "another-device::60168568756" },
  { connectionKey: "mamba-test-device::60168568756" },
]);

// 旧库绝不原地覆盖，只显示清楚的迁移错误。
const oldDir = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-local-db-v2-test-"));
const oldService = createLocalDatabaseService({ dataDir: oldDir, device, senderPolicy });
execFileSync(detected.binary, [path.join(oldDir, "mamba.sqlite"), "PRAGMA user_version=2; CREATE TABLE customers(id TEXT PRIMARY KEY);"]);
const oldSnapshot = await oldService.snapshot();
assert.equal(oldSnapshot.health, "migration_required");
assert.equal(oldSnapshot.errorCode, "SQLITE_V3_MIGRATION_REQUIRED");
await assert.rejects(oldService.initialize(), (error) => error.code === "SQLITE_V3_MIGRATION_REQUIRED");

console.log("✅ all SQLite v3 import and Primary cutover tests passed");
