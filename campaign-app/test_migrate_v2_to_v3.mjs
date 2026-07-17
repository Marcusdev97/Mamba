import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-v2-v3-migrate-test-"));
const source = path.join(dir, "mamba.sqlite");
const output = path.join(dir, "mamba.v3.sqlite");
const sqlite = "/usr/bin/sqlite3";

const v2Schema = `
PRAGMA user_version=2;
CREATE TABLE devices(id TEXT PRIMARY KEY, name TEXT, hostname TEXT);
CREATE TABLE sender_accounts(sender_phone TEXT PRIMARY KEY, device_id TEXT, connection_name TEXT, status TEXT);
CREATE TABLE customers(
  id TEXT PRIMARY KEY, notion_page_id TEXT, device_id TEXT, sender_phone TEXT, phone TEXT,
  project TEXT, name TEXT, status TEXT, sequence_status TEXT, last_reply_text TEXT,
  last_reply_at TEXT, payload_json TEXT, source_updated_at TEXT, created_at TEXT, updated_at TEXT
);
CREATE TABLE conversations(
  id TEXT PRIMARY KEY, customer_id TEXT, device_id TEXT, sender_phone TEXT,
  customer_phone TEXT, project TEXT, last_message_at TEXT, created_at TEXT, updated_at TEXT
);
CREATE TABLE messages(
  id TEXT PRIMARY KEY, conversation_id TEXT, direction TEXT, text TEXT, message_type TEXT,
  source TEXT, sent_at TEXT, payload_json TEXT, created_at TEXT
);
INSERT INTO devices VALUES('marcus-mac', 'Marcus Mac', 'marcus.local');
INSERT INTO sender_accounts VALUES('60168568756', 'marcus-mac', 'wa_01', 'BOUND');
INSERT INTO customers VALUES(
  'c1', 'page-1', 'marcus-mac', '60168568756', '60111111111', 'Binastra', 'Alice',
  'Running', 'ACTIVE', 'hello', '2026-07-17T01:00:00Z',
  '{"nextFlow":"Flow 2","replyCount":2}', '2026-07-17T01:00:00Z',
  '2026-07-16T01:00:00Z', '2026-07-17T01:00:00Z'
);
INSERT INTO customers VALUES(
  'c2', 'page-2', 'marcus-mac', '60168568756', '60111111111', 'Enlace', 'Alice',
  'Running', 'ACTIVE', 'hello', '2026-07-17T01:00:00Z',
  '{"nextFlow":"Flow 3","stopFlag":true}', '2026-07-17T02:00:00Z',
  '2026-07-16T02:00:00Z', '2026-07-17T02:00:00Z'
);
INSERT INTO conversations VALUES(
  'conv-1', 'c1', 'marcus-mac', '60168568756', '60111111111', 'Binastra',
  '2026-07-17T03:00:00Z', '2026-07-17T01:00:00Z', '2026-07-17T03:00:00Z'
);
INSERT INTO messages VALUES(
  'msg-1', 'conv-1', 'inbound', 'interested', 'text', 'evolution',
  '2026-07-17T03:00:00Z', '{}', '2026-07-17T03:00:00Z'
);
`;
execFileSync(sqlite, [source, v2Schema]);

const migrate = path.join(root, "campaign-app", "migrate_v2_to_v3.mjs");
const common = [
  migrate,
  "--db", source,
  "--out", output,
  "--schema", path.join(root, "docs", "mamba-schema.sql"),
  "--projects", path.join(root, "campaign-assets", "projects.json"),
];

const dryRun = execFileSync(process.execPath, common, { encoding: "utf8" });
assert.match(dryRun, /DRY_RUN/);
assert.equal(await fs.stat(source).then(() => true), true);
await assert.rejects(fs.stat(output), (error) => error.code === "ENOENT");

const applied = execFileSync(process.execPath, [...common, "--apply"], { encoding: "utf8" });
assert.match(applied, /新库已生成/);

const rows = JSON.parse(execFileSync(sqlite, ["-batch", "-json", output, `
SELECT
  (SELECT COUNT(*) FROM contacts) AS contacts,
  (SELECT COUNT(*) FROM project_leads) AS projectLeads,
  (SELECT COUNT(*) FROM whatsapp_connections) AS connections,
  (SELECT connection_key FROM whatsapp_connections LIMIT 1) AS senderKey,
  (SELECT instance_name FROM whatsapp_connections LIMIT 1) AS instanceName,
  (SELECT stop_flag FROM contacts WHERE phone='60111111111') AS stopFlag,
  (SELECT COUNT(*) FROM messages) AS messages;
`], { encoding: "utf8" }));
assert.deepEqual(rows, [{
  contacts: 1,
  projectLeads: 2,
  connections: 1,
  senderKey: "marcus-mac::60168568756",
  instanceName: "wa_01",
  stopFlag: 1,
  messages: 1,
}]);

const [{ quick_check: quickCheck }] = JSON.parse(execFileSync(sqlite, ["-batch", "-json", output, "PRAGMA quick_check;"], { encoding: "utf8" }));
const foreignKeys = execFileSync(sqlite, ["-batch", "-json", output, "PRAGMA foreign_key_check;"], { encoding: "utf8" }).trim();
assert.equal(quickCheck, "ok");
assert.equal(foreignKeys, "");
assert.equal(execFileSync(sqlite, [source, "PRAGMA user_version;"], { encoding: "utf8" }).trim(), "2", "source DB must remain unchanged");

console.log("✅ v2 → v3 migration dry-run/apply tests passed");
