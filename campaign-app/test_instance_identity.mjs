import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInstanceIdentityService } from "./lib/instance-identity-service.mjs";
import { createSqliteCli } from "./lib/sqlite-cli.mjs";
import { INSTANCE_IDENTITY_SCHEMA_SQL } from "./lib/v3-runtime-schema.mjs";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-identity-"));
const database = await createSqliteCli({ databasePath: path.join(dataDir, "mamba.sqlite") });

await database.exec(`
CREATE TABLE whatsapp_connections (
  connection_key TEXT PRIMARY KEY,
  instance_name TEXT NOT NULL DEFAULT '',
  whatsapp_number TEXT NOT NULL DEFAULT '',
  updated_at TEXT
);
CREATE TABLE messages (id TEXT PRIMARY KEY, payload_json TEXT);
INSERT INTO whatsapp_connections VALUES ('device-1::60168568756', '', '60168568756', '');
INSERT INTO messages VALUES
  ('m1', '{"instanceName":"wa_01"}'),
  ('m2', '{"instanceName":"wa_02"}'),
  ('m3', '{"instanceName":"wa_03"}');
${INSTANCE_IDENTITY_SCHEMA_SQL}`);

const identity = createInstanceIdentityService({ dataDir });

// Evolution 上活着的号码 -> 标签，最准。
await identity.syncFromInstances([{ name: "wa_01", number: "+60168568756" }]);
assert.equal(await identity.numberFor("wa_01"), "60168568756");

// 讯息里出现过、Evolution 已经没有的旧标签，在只有一个号码时归给它。
const orphans = await identity.adoptOrphans();
assert.deepEqual(orphans.adopted.sort(), ["wa_02", "wa_03"]);
assert.equal(orphans.number, "60168568756");

// 这才是重点：选 wa_01 要连 wa_02 / wa_03 的对话一起看到。
assert.deepEqual((await identity.siblingInstances("wa_01")).sort(), ["wa_01", "wa_02", "wa_03"]);
assert.deepEqual((await identity.instanceNamesFor("60168568756")).sort(), ["wa_01", "wa_02", "wa_03"]);

// Evolution 说的不能被推断的盖掉。
await identity.record([{ instance: "wa_01", number: "60999999999" }], { source: "inferred" });
assert.equal(await identity.numberFor("wa_01"), "60168568756", "inferred 不该盖掉 evolution");

// 但 Evolution 自己改口要听它的（号码换手机重扫）。
await identity.syncFromInstances([{ name: "wa_01", number: "60777777777" }]);
assert.equal(await identity.numberFor("wa_01"), "60777777777");
await identity.syncFromInstances([{ name: "wa_01", number: "60168568756" }]);

// instance_name 要补回 whatsapp_connections —— 建库时是空的，从来没人写。
await identity.linkConnections();
const rows = await database.query("SELECT instance_name AS n FROM whatsapp_connections;");
assert.equal(rows[0].n, "wa_01", "connection 要拿到标签，resolveConnection 才认得出来");

// 查不到对照的标签只回它自己，不要把别的号码的对话混进来。
assert.deepEqual(await identity.siblingInstances("wa_99"), ["wa_99"]);
assert.deepEqual(await identity.siblingInstances(""), []);

// 一台电脑接过两个号码时不猜。
{
  const twoDir = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-identity2-"));
  const db2 = await createSqliteCli({ databasePath: path.join(twoDir, "mamba.sqlite") });
  await db2.exec(`
CREATE TABLE whatsapp_connections (connection_key TEXT PRIMARY KEY, instance_name TEXT NOT NULL DEFAULT '', whatsapp_number TEXT NOT NULL DEFAULT '', updated_at TEXT);
CREATE TABLE messages (id TEXT PRIMARY KEY, payload_json TEXT);
INSERT INTO whatsapp_connections VALUES ('d::60111111111','', '60111111111',''), ('d::60222222222','', '60222222222','');
INSERT INTO messages VALUES ('m1', '{"instanceName":"wa_09"}');
${INSTANCE_IDENTITY_SCHEMA_SQL}`);
  const two = createInstanceIdentityService({ dataDir: twoDir });
  const result = await two.adoptOrphans();
  assert.deepEqual(result.adopted, [], "两个号码就不该乱猜");
  assert.deepEqual(result.skipped, ["wa_09"]);
  await fs.rm(twoDir, { recursive: true, force: true });
}

await fs.rm(dataDir, { recursive: true, force: true });
console.log("instance identity tests passed.");
