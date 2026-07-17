import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAccountDeviceBindingService, buildSendIdemKey } from "./lib/account-device-binding-service.mjs";
import { createHandoffBundle, openHandoffBundle } from "./lib/handoff-bundle-service.mjs";
import { createSqliteCli } from "./lib/sqlite-cli.mjs";

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(APP_DIR, "..");
const SQLITE = "/usr/bin/sqlite3";
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-v4-binding-test-"));
const source = path.join(dir, "mamba.sqlite");
const output = path.join(dir, "mamba.v4.sqlite");
const runsDir = path.join(dir, "runs");
await fs.mkdir(runsDir);

const v3Schema = await fs.readFile(path.join(ROOT, "docs", "mamba-schema.sql"), "utf8");
execFileSync(SQLITE, [source], { input: v3Schema });
const sourceDb = await createSqliteCli({ databasePath: source, sqliteBinary: SQLITE });
const now = "2026-07-17T06:00:00.000Z";
await sourceDb.exec(`
BEGIN IMMEDIATE;
INSERT INTO projects(project_code,project_name,aliases_json,active,created_at,updated_at)
VALUES('binastra','Binastra','[]',1,'${now}','${now}');
INSERT INTO devices(device_key,device_name,owner,hostname,created_at,updated_at)
VALUES('marcus-mac','Marcus Mac','','marcus.local','${now}','${now}');
INSERT INTO whatsapp_connections(
  connection_key,instance_name,whatsapp_number,device_key,status,created_at,updated_at
) VALUES('marcus-mac::60168568756','wa_01','60168568756','marcus-mac','OPEN','${now}','${now}');
INSERT INTO contacts(contact_key,phone,display_name,created_at,updated_at)
VALUES('60111111111','60111111111','Alice','${now}','${now}');
INSERT INTO project_leads(
  project_lead_key,contact_key,project_code,phone,name,last_sender_phone,
  assigned_sender_key,first_blast_at,created_at,updated_at
) VALUES(
  'binastra:60111111111','60111111111','binastra','60111111111','Alice','60168568756',
  'marcus-mac::60168568756','2026-07-10T01:00:00.000Z','${now}','${now}'
);
INSERT INTO metadata(key,value,updated_at) VALUES
  ('expected_sender_key','marcus-mac::60168568756','${now}'),
  ('expected_sender_phone','60168568756','${now}')
ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;
COMMIT;
`);

await fs.writeFile(path.join(runsDir, "run-evidence.json"), JSON.stringify({
  runId: "run-old",
  campaignId: "binastra",
  flowLabel: "Flow 1",
  updatedAt: now,
  instances: [{ name: "wa_01", owner: "60168568756" }],
  assignments: [{
    status: "SENT",
    instanceName: "wa_01",
    lead: { phone: "60111111111" },
    part1: { sentAt: "2026-07-17T05:00:00.000Z", messageId: "provider-old-p1" },
    part2: { sentAt: "2026-07-17T05:01:00.000Z" },
    extraParts: [],
  }],
}, null, 2));

const migration = path.join(APP_DIR, "migrate_v3_to_v4.mjs");
const migrationOutput = execFileSync(process.execPath, [
  migration,
  "--source", source,
  "--out", output,
  "--runs", runsDir,
  "--schema", path.join(ROOT, "docs", "mamba-schema-v4.sql"),
  "--apply",
], { encoding: "utf8" });
const migrationReport = JSON.parse(migrationOutput);
assert.equal(migrationReport.validation.ok, true);
assert.equal(migrationReport.historicalEvidence.sent, 1);
assert.equal(migrationReport.historicalEvidence.unverified, 1);

let currentTime = new Date("2026-07-17T06:10:00.000Z");
const clock = () => new Date(currentTime);
const service = createAccountDeviceBindingService({ databasePath: output, sqliteBinary: SQLITE, clock });
assert.deepEqual(await service.assertReady(), { ready: true, schemaVersion: 4 });
const account = await service.accountStatus("60168568756");
assert.equal(account.activeBindingKey, "marcus-mac::60168568756");
assert.equal(account.bindingStatus, "ACTIVE");

const input = {
  campaignRunId: "run-new",
  projectLeadKey: "binastra:60111111111",
  flowTopic: "Flow 2",
  partNo: 1,
  accountKey: "60168568756",
  contactKey: "60111111111",
  recipientPhone: "60111111111",
  deviceKey: "marcus-mac",
  bindingKey: "marcus-mac::60168568756",
  bindingGeneration: 1,
};
const concurrent = await Promise.all(Array.from({ length: 12 }, () => service.claimPart(input)));
assert.equal(concurrent.filter((result) => result.acquired).length, 1, "only one process may acquire an idem key");
const winner = concurrent.find((result) => result.acquired);
await service.markSent({ idemKey: winner.idemKey, claimToken: winner.claimToken, providerMessageId: "provider-new-p1" });

const part2 = await service.claimPart({ ...input, partNo: 2 });
assert.equal(part2.acquired, true);
await service.markSent({ idemKey: part2.idemKey, claimToken: part2.claimToken, providerMessageId: "provider-new-p2" });
const usage = await service.dailyUsage("60168568756", "2026-07-17");
assert.deepEqual(usage, { date: "2026-07-17", contactsSent: 1, messagesSent: 3 });

const retryable = await service.claimPart({ ...input, partNo: 3 });
await service.markFailure({
  idemKey: retryable.idemKey,
  claimToken: retryable.claimToken,
  errorCode: "PROVIDER_REJECTED_BEFORE_SEND",
  errorMessage: "Provider confirmed no message was accepted.",
  confirmedNotSent: true,
  retryable: true,
});
const retry = await service.retryClaim({
  idemKey: retryable.idemKey,
  bindingKey: input.bindingKey,
  deviceKey: input.deviceKey,
  bindingGeneration: 1,
});
assert.equal(retry.acquired, true);
const uncertain = await service.markFailure({
  idemKey: retryable.idemKey,
  claimToken: retry.claimToken,
  errorCode: "SEND_TIMEOUT",
  errorMessage: "No provider acknowledgement.",
});
assert.equal(uncertain.state, "UNKNOWN");
assert.equal((await service.retryClaim({
  idemKey: retryable.idemKey,
  bindingKey: input.bindingKey,
  deviceKey: input.deviceKey,
  bindingGeneration: 1,
})).acquired, false, "UNKNOWN must never auto-retry");

const stale = await service.claimPart({ ...input, partNo: 4 });
assert.equal(stale.acquired, true);
currentTime = new Date("2026-07-17T06:20:01.000Z");
assert.equal((await service.recoverStaleClaims({ olderThanMs: 5 * 60 * 1000 })).recovered, 1);
assert.equal((await service.listManualReview("60168568756")).length, 3, "legacy, timeout and stale claims require review");

const firstTransfer = await service.beginHandoff({
  accountKey: "60168568756",
  sourceBindingKey: "marcus-mac::60168568756",
  targetDeviceKey: "cici-mac",
});
await service.abortHandoff({ transferId: firstTransfer.transferId, reason: "test export failure" });
assert.equal((await service.accountStatus("60168568756")).bindingStatus, "ACTIVE");

const transfer = await service.beginHandoff({
  accountKey: "60168568756",
  sourceBindingKey: "marcus-mac::60168568756",
  targetDeviceKey: "cici-mac",
});
const snapshot = await service.buildHandoffSnapshot({ accountKey: "60168568756", transferId: transfer.transferId });
assert.ok(snapshot.data.claims.length >= 5, "bundle snapshot carries all claim states");
const passphrase = "correct horse battery staple";
const bundle = await createHandoffBundle({ snapshot, passphrase, clock, expiresInMs: 30 * 60 * 1000 });
const opened = await openHandoffBundle({ bundle, passphrase, clock });
assert.equal(opened.snapshotHash, bundle.snapshotHash);
assert.equal(opened.snapshot.transfer.transfer_id, transfer.transferId);
await assert.rejects(openHandoffBundle({ bundle, passphrase: "wrong password 123", clock }), (error) => error.code === "HANDOFF_BUNDLE_AUTH_FAILED");
await service.markHandoffExported({
  transferId: transfer.transferId,
  bundleId: bundle.bundleId,
  snapshotHash: bundle.snapshotHash,
  expiresAt: bundle.expiresAt,
});
assert.equal((await service.accountStatus("60168568756")).activeBindingKey, null);
await assert.rejects(service.abortHandoff({ transferId: transfer.transferId }), (error) => error.code === "HANDOFF_ABORT_UNSAFE");

const db = await createSqliteCli({ databasePath: output, sqliteBinary: SQLITE });
const [sentDuplicates] = await db.query("SELECT COUNT(*) AS count FROM send_events WHERE idem_key='does-not-exist' AND event_type='SENT';");
assert.equal(Number(sentDuplicates.count), 0);
const [integrity] = await db.query("PRAGMA quick_check;");
assert.equal(integrity.quick_check, "ok");
assert.equal((await db.query("PRAGMA foreign_key_check;")).length, 0);

assert.equal(buildSendIdemKey({ campaignRunId: "a:b", projectLeadKey: "p:1", flowTopic: "Flow 1", partNo: 2 }), "a%3Ab:p%3A1:Flow%201:2");
console.log("✅ all SQLite v4 account/device binding tests passed");
