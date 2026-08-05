import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createConversationLogService } from "./lib/conversation-log-service.mjs";
import { createLocalDatabaseService } from "./lib/local-database-service.mjs";

const blockedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-sqlite-active-run-"));
const blockedDataDir = path.join(blockedRoot, "campaign-data");
await fs.mkdir(path.join(blockedDataDir, "runs"), { recursive: true });
await fs.writeFile(path.join(blockedDataDir, "active-runs.json"), JSON.stringify({
  runs: [{ runId: "run_blocks_migration", status: "RUNNING" }],
}), "utf8");
await fs.writeFile(path.join(blockedDataDir, "runs", "run_blocks_migration.json"), JSON.stringify({
  runId: "run_blocks_migration", status: "RUNNING", updatedAt: new Date().toISOString(), assignments: [],
}), "utf8");
const blockedService = createLocalDatabaseService({ dataDir: blockedDataDir });
await assert.rejects(
  blockedService.initialize(),
  (error) => error.code === "ACTIVE_CAMPAIGN_BLOCKS_SCHEMA_MIGRATION",
  "An active Campaign must block schema migration",
);
assert.equal((await blockedService.snapshot()).health, "migration_required");
await fs.rm(blockedRoot, { recursive: true, force: true });

const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-sqlite-core-"));
const dataDir = path.join(rootDir, "campaign-data");
const service = createLocalDatabaseService({
  dataDir,
  device: { id: "sqlite-core-test", name: "SQLite Test", hostname: "test.local" },
  senderPolicy: { configured: true, expectedSenderPhone: "60120000001" },
});

const initialized = await service.initialize();
assert.equal(initialized.health, "ready");
assert.equal(initialized.safeMode, false);
assert.equal(initialized.liveSendingAllowed, false, "Shadow mode must keep LIVE locked");
assert.match(initialized.databaseId, /^[0-9a-f-]{36}$/i);
assert.equal(initialized.journalMode, "wal");
assert.deepEqual(initialized.indexes.missing, []);
assert.deepEqual(initialized.migrations.pending, []);
assert.equal(initialized.migrations.latest.version, 303);
assert.match(initialized.migrations.latest.checksum, /^[0-9a-f]{64}$/);
assert.ok(initialized.lastBackupAt, "Migration must record the pre-change backup time");
assert.ok(initialized.lastHealthCheckAt, "Health check time must be persisted");

const stableDatabaseId = (await service.initialize()).databaseId;
assert.equal(stableDatabaseId, initialized.databaseId, "database_id must remain stable across restart/initialize");
await assert.rejects(service.assertLiveReady(), (error) => error.code === "SQLITE_LIVE_PRIMARY_REQUIRED");

const detected = await service.driver();
const sqlite = (sql, args = []) => execFileSync(detected.binary, ["-batch", ...args, service.databasePath, sql], { encoding: "utf8" });
const migrationColumns = JSON.parse(sqlite("PRAGMA table_info(schema_migrations);", ["-json"]));
for (const column of ["checksum", "duration_ms", "result"]) {
  assert.ok(migrationColumns.some((item) => item.name === column), `schema_migrations.${column} is required`);
}

await service.syncWhatsAppConnections([
  { name: "wa_core_01", owner: "60120000001" },
  { name: "wa_core_02", owner: "60120000002" },
]);
const conversations = createConversationLogService({ dataDir });
await conversations.recordReply({
  id: "SAME-EVOLUTION-ID", phone: "60120000003", sender: "60120000001",
  instanceName: "wa_core_01", text: "first", receivedAt: "2026-08-05T01:00:00.000Z",
}, { force: true });
await conversations.recordReply({
  id: "SAME-EVOLUTION-ID", phone: "60120000003", sender: "60120000002",
  instanceName: "wa_core_02", text: "second", receivedAt: "2026-08-05T01:01:00.000Z",
}, { force: true });
const connectionScopedMessages = JSON.parse(sqlite(`
SELECT COUNT(*) AS count, COUNT(DISTINCT idempotency_key) AS idempotencyKeys
FROM messages WHERE external_message_id='SAME-EVOLUTION-ID';`, ["-json"]))[0];
assert.deepEqual(connectionScopedMessages, { count: 2, idempotencyKeys: 2 });

const backupDir = path.join(dataDir, "backups");
const backupFiles = (await fs.readdir(backupDir)).filter((name) => name.endsWith(".sqlite"));
assert.equal(backupFiles.length, 1, "Migration must create exactly one backup on first apply");
const backupPath = path.join(backupDir, backupFiles[0]);
const manifest = JSON.parse(await fs.readFile(`${backupPath}.manifest.json`, "utf8"));
const backupSha = crypto.createHash("sha256").update(await fs.readFile(backupPath)).digest("hex");
assert.equal(manifest.sha256, backupSha);
assert.deepEqual(manifest.verification, { quickCheck: "ok", foreignKeyErrors: 0, missingIndexes: [] });
assert.match(execFileSync(detected.binary, ["-batch", backupPath, "PRAGMA quick_check;"], { encoding: "utf8" }).trim(), /^ok$/);

// A failed multi-table write must roll back every earlier statement in the transaction.
const failingTransaction = `
PRAGMA foreign_keys=ON;
BEGIN IMMEDIATE;
INSERT INTO contacts(contact_key, phone, created_at, updated_at) VALUES ('rollback-contact','60120000000','2026-08-05T00:00:00.000Z','2026-08-05T00:00:00.000Z');
INSERT INTO project_leads(project_lead_key, contact_key, project_code, phone, created_at, updated_at)
VALUES ('missing-project:60120000000','rollback-contact','missing-project','60120000000','2026-08-05T00:00:00.000Z','2026-08-05T00:00:00.000Z');
COMMIT;`;
assert.throws(() => execFileSync(detected.binary, ["-batch", service.databasePath, failingTransaction], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
}));
assert.equal(JSON.parse(sqlite("SELECT COUNT(*) AS count FROM contacts WHERE contact_key='rollback-contact';", ["-json"]))[0].count, 0);

// Runtime reads stay healthy even when the controlled Notion import source is offline.
service.configureNotionImport({
  async fetchRecords() { throw new Error("Notion offline"); },
  scopeRecords(records) { return { records, counts: {} }; },
});
await assert.rejects(service.previewNotionImport(), /Notion offline/);
assert.equal((await service.snapshot()).health, "ready");

sqlite("UPDATE metadata SET value='primary' WHERE key='storage_mode';");
assert.equal((await service.assertLiveReady()).liveSendingAllowed, true);

// Applied migration files are immutable. A checksum mismatch must enter safe mode.
sqlite("UPDATE schema_migrations SET checksum='tampered' WHERE version=303;");
const tampered = await service.snapshot();
assert.equal(tampered.health, "error");
assert.equal(tampered.liveSendingAllowed, false);
assert.equal(tampered.errorCode, "SQLITE_MIGRATION_CHECKSUM_MISMATCH");

await fs.rm(rootDir, { recursive: true, force: true });
console.log("✅ SQLite core stability tests passed");
