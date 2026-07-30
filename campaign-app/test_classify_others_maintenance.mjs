import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runClassification } from "../scripts/maintenance/classify-unassigned-contacts-as-others.mjs";

const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-classify-others-"));
const dataDir = path.join(rootDir, "campaign-data");
const runsDir = path.join(dataDir, "runs");
const databasePath = path.join(dataDir, "mamba.sqlite");
await fs.mkdir(runsDir, { recursive: true });
await fs.writeFile(path.join(dataDir, "active-runs.json"), JSON.stringify({ runs: [] }));
await fs.writeFile(path.join(dataDir, "suppressed.json"), JSON.stringify({ phones: ["60120000002"] }));
await fs.writeFile(path.join(dataDir, "suppressed_local.json"), JSON.stringify({ entries: {} }));

execFileSync("/usr/bin/sqlite3", ["-batch", databasePath, `
PRAGMA foreign_keys=ON;
CREATE TABLE contacts(
  contact_key TEXT PRIMARY KEY, phone TEXT UNIQUE, display_name TEXT, stop_flag INTEGER,
  last_reply_at TEXT, updated_at TEXT
);
CREATE TABLE devices(device_key TEXT PRIMARY KEY);
CREATE TABLE whatsapp_connections(
  connection_key TEXT PRIMARY KEY, device_key TEXT, FOREIGN KEY(device_key) REFERENCES devices(device_key)
);
CREATE TABLE conversations(
  id TEXT PRIMARY KEY, contact_key TEXT, connection_key TEXT, last_message_at TEXT, updated_at TEXT,
  FOREIGN KEY(contact_key) REFERENCES contacts(contact_key),
  FOREIGN KEY(connection_key) REFERENCES whatsapp_connections(connection_key)
);
CREATE TABLE project_leads(project_lead_key TEXT PRIMARY KEY, contact_key TEXT);
CREATE TABLE ads_leads(ad_lead_key TEXT PRIMARY KEY, contact_key TEXT);
CREATE TABLE recycle_leads(recycle_lead_key TEXT PRIMARY KEY, contact_key TEXT);
CREATE TABLE own_leads(
  own_lead_key TEXT PRIMARY KEY, contact_key TEXT, phone TEXT, name TEXT,
  assigned_sender_key TEXT, note TEXT, created_at TEXT, updated_at TEXT,
  FOREIGN KEY(contact_key) REFERENCES contacts(contact_key),
  FOREIGN KEY(assigned_sender_key) REFERENCES whatsapp_connections(connection_key)
);
CREATE TABLE lead_origins(
  origin_key TEXT PRIMARY KEY, contact_key TEXT, lead_type TEXT, project_code TEXT,
  assigned_sender_key TEXT, notion_page_id TEXT, notion_sync_status TEXT,
  notion_sync_error TEXT, note TEXT, created_at TEXT, updated_at TEXT,
  FOREIGN KEY(contact_key) REFERENCES contacts(contact_key),
  FOREIGN KEY(assigned_sender_key) REFERENCES whatsapp_connections(connection_key)
);
INSERT INTO devices VALUES ('device-a');
INSERT INTO whatsapp_connections VALUES ('device-a::60111111111','device-a');
INSERT INTO contacts VALUES
  ('60120000001','60120000001','Eligible',0,'2026-07-30T01:00:00.000Z','2026-07-30T01:00:00.000Z'),
  ('60120000002','60120000002','Suppressed',0,'2026-07-30T01:00:00.000Z','2026-07-30T01:00:00.000Z'),
  ('60','60','Invalid',0,'2026-07-30T01:00:00.000Z','2026-07-30T01:00:00.000Z'),
  ('60120000004','60120000004','Project',0,'2026-07-30T01:00:00.000Z','2026-07-30T01:00:00.000Z');
INSERT INTO conversations VALUES
  ('c1','60120000001','device-a::60111111111','2026-07-30T01:00:00.000Z','2026-07-30T01:00:00.000Z'),
  ('c2','60120000002','device-a::60111111111','2026-07-30T01:00:00.000Z','2026-07-30T01:00:00.000Z'),
  ('c3','60','device-a::60111111111','2026-07-30T01:00:00.000Z','2026-07-30T01:00:00.000Z'),
  ('c4','60120000004','device-a::60111111111','2026-07-30T01:00:00.000Z','2026-07-30T01:00:00.000Z');
INSERT INTO project_leads VALUES ('binastra:60120000004','60120000004');
`]);

const dryRun = runClassification({ rootDir, databasePath });
assert.equal(dryRun.mode, "dry-run");
assert.equal(dryRun.eligible, 1);
assert.equal(dryRun.excluded.suppressed, 1);
assert.equal(dryRun.excluded.invalidPhone, 1);
assert.equal(dryRun.sample[0].phone, "…0001");

const applied = runClassification({ rootDir, databasePath, apply: true });
assert.equal(applied.applied, 1);
assert.ok(applied.backupPath.endsWith(".sqlite"));
assert.equal((await fs.stat(applied.backupPath)).isFile(), true);
const rows = JSON.parse(execFileSync("/usr/bin/sqlite3", [
  "-batch", "-json", databasePath,
  "SELECT o.phone, l.lead_type AS leadType, l.notion_sync_status AS syncStatus FROM own_leads o JOIN lead_origins l ON l.contact_key=o.contact_key;",
], { encoding: "utf8" }));
assert.deepEqual(rows, [{ phone: "60120000001", leadType: "OWN", syncStatus: "LOCAL_ONLY" }]);
assert.equal(runClassification({ rootDir, databasePath }).eligible, 0, "apply is idempotent");

const activeRunId = "run_active_test";
await fs.writeFile(path.join(runsDir, `${activeRunId}.json`), JSON.stringify({
  runId: activeRunId,
  status: "RUNNING",
  assignments: [{ lead: { phone: "60120000009" } }],
}));
await fs.writeFile(path.join(dataDir, "active-runs.json"), JSON.stringify({
  runs: [{ runId: activeRunId, status: "RUNNING" }],
}));
assert.throws(
  () => runClassification({ rootDir, databasePath, apply: true }),
  (error) => error.code === "ACTIVE_CAMPAIGN_BLOCKS_OTHERS_APPLY",
);

await fs.rm(rootDir, { recursive: true, force: true });
console.log("✅ Others classification maintenance tests passed");
