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
assert.equal(before.engine, "SQLite");
assert.equal(before.driverAvailable, true);
assert.equal(before.initialized, false);
assert.equal(before.health, "not_initialized");
assert.equal(before.notionImport.enabled, false);

const initialized = await service.initialize();
assert.equal(initialized.initialized, true);
assert.equal(initialized.health, "ready");
assert.equal(initialized.schemaVersion, 1);
assert.equal(initialized.storageMode, "shadow");
assert.equal(initialized.expectedSenderPhone, "60168568756");
assert.deepEqual(initialized.counts, {
  customers: 0,
  conversations: 0,
  messages: 0,
  operations: 0,
  pendingSyncJobs: 0,
});

const second = await service.initialize();
assert.equal(second.health, "ready", "initialization must be idempotent");

const detected = await service.driver();
const bindings = JSON.parse(execFileSync(detected.binary, [
  "-batch",
  "-json",
  service.databasePath,
  "SELECT device_id AS deviceId, sender_phone AS senderPhone FROM sender_accounts;",
], { encoding: "utf8" }));
assert.deepEqual(bindings, [{ deviceId: "mamba-test-device", senderPhone: "60168568756" }]);

const reboundService = createLocalDatabaseService({
  dataDir,
  device,
  senderPolicy: { configured: true, expectedSenderPhone: "60170000000" },
});
await reboundService.initialize();
const rebound = JSON.parse(execFileSync(detected.binary, [
  "-batch",
  "-json",
  service.databasePath,
  "SELECT device_id AS deviceId, sender_phone AS senderPhone FROM sender_accounts;",
], { encoding: "utf8" }));
assert.deepEqual(rebound, [{ deviceId: "mamba-test-device", senderPhone: "60170000000" }]);

const conflictingDevice = createLocalDatabaseService({
  dataDir,
  device: { id: "another-device", name: "Other Mac", hostname: "other.local" },
  senderPolicy: { configured: true, expectedSenderPhone: "60170000000" },
});
await assert.rejects(
  conflictingDevice.initialize(),
  /UNIQUE constraint failed: sender_accounts\.sender_phone/,
  "one sender phone must not silently move to another device",
);

console.log("✅ all local database shell tests passed");
