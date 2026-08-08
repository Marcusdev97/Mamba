import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLidMapService } from "./lib/lid-map-service.mjs";
import { createSqliteCli } from "./lib/sqlite-cli.mjs";
import { LID_MAP_SCHEMA_SQL } from "./lib/v3-runtime-schema.mjs";
import { jidLid, resolveLid, lidPhonePair, resolvePhoneWithLid, normalizePhone } from "./reply_intake.mjs";

// ---- 纯函式 ----

assert.equal(jidLid("257814068985957@lid"), "257814068985957");
assert.equal(jidLid("257814068985957:12@lid"), "257814068985957");
assert.equal(jidLid("60111222333@s.whatsapp.net"), null, "真号码不是 lid");
assert.equal(jidLid("12345@g.us"), null, "群组不是 lid");
assert.equal(jidLid(""), null);

assert.equal(resolveLid({ key: { remoteJid: "999@lid" } }), "999");
assert.equal(resolveLid({ key: { remoteJid: "60111222333@s.whatsapp.net", remoteJidAlt: "999@lid" } }), "999");
assert.equal(resolveLid({ key: { remoteJid: "60111222333@s.whatsapp.net" } }), null);

assert.deepEqual(
  lidPhonePair({ key: { remoteJid: "999@lid", remoteJidAlt: "60111222333@s.whatsapp.net" } }),
  { lid: "999", phone: "60111222333" },
  "同时带 lid 和号码 = 一笔可信对照",
);
assert.equal(lidPhonePair({ key: { remoteJid: "999@lid" } }), null, "只有 lid 证明不了什么");
assert.equal(lidPhonePair({ key: { remoteJid: "60111222333@s.whatsapp.net" } }), null);

// 讯息自带号码时优先用它，不查表。
assert.equal(
  resolvePhoneWithLid({ key: { remoteJid: "60111222333@s.whatsapp.net" } }, () => "60999999999"),
  "60111222333",
);
assert.equal(resolvePhoneWithLid({ key: { remoteJid: "999@lid" } }, (lid) => (lid === "999" ? "60111222333" : null)), "60111222333");
assert.equal(resolvePhoneWithLid({ key: { remoteJid: "999@lid" } }, () => null), null);
assert.equal(resolvePhoneWithLid({ key: { remoteJid: "999@lid" } }), null, "没给 lookup 就是认不出");

// 长度闸：JID 是 "0" 时不能变成一个叫「60」的客户。
assert.equal(normalizePhone("0"), null);
assert.equal(normalizePhone("123"), null);
assert.equal(normalizePhone("0100000000"), "60100000000");
assert.equal(normalizePhone("60100000000"), "60100000000");

// ---- service ----

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-lid-"));
const database = await createSqliteCli({ databasePath: path.join(dataDir, "mamba.sqlite") });
await database.exec(LID_MAP_SCHEMA_SQL);
const lidMap = createLidMapService({ dataDir });

assert.equal(await lidMap.resolve("999"), null, "空表查无");
await database.exec("INSERT INTO lid_map(lid,phone,source,confidence,evidence,created_at,updated_at) VALUES ('legacy-name','60100000000','profile_name',30,'old guess','2026-01-01','2026-01-01');");
const legacyReader = createLidMapService({ dataDir });
assert.equal(await legacyReader.resolve("legacy-name"), null, "历史 display-name 猜测也不能继续参与解析");

await lidMap.learn([{ lid: "999", phone: "60111222333" }], { source: "outbound_match" });
assert.equal(await lidMap.resolve("999"), "60111222333");

// 名字来源完全禁用，不能写进 identity lookup。
const nameOnly = await lidMap.learn([{ lid: "999", phone: "60000000000" }], { source: "profile_name" });
assert.equal(nameOnly.reason, "NAME_ONLY_IDENTITY_FORBIDDEN");
assert.equal(await lidMap.resolve("999"), "60111222333", "profile_name 不该盖掉 outbound_match");

// 一旦同一个 LID 指向不同号码，不论新证据 confidence 多高都不能自动搬家。
const messageConflict = await lidMap.learn([{ lid: "999", phone: "60555555555" }], { source: "message_id" });
assert.equal(messageConflict.conflicts.length, 1);
assert.equal(await lidMap.resolve("999"), "60111222333");
const liveConflict = await lidMap.learn([{ lid: "999", phone: "60777777777" }], { source: "live" });
assert.equal(liveConflict.conflicts.length, 1);
assert.equal(await lidMap.resolve("999"), "60111222333", "LID conflict 必须留给人工处理");

// learn() 之后 resolveCached 必须马上看得到新的对照。
// 之前 learn() 把整个快取清空，导致补回历史时每页 learn 一次、全程查无，
// 8000 条讯息只认得出 8 条。
await lidMap.warm();
await lidMap.learn([{ lid: "888", phone: "60123123123" }], { source: "live" });
assert.equal(lidMap.resolveCached("888"), "60123123123", "learn 之后快取要马上生效");
assert.equal(lidMap.resolveCached("999"), "60111222333", "learn 不能把旧的冲掉");

// 垃圾进不去。
await lidMap.learn([{ lid: "", phone: "60111222333" }, { lid: "777", phone: "" }], { source: "live" });
assert.equal(await lidMap.resolve("777"), null);

const stats = await lidMap.stats();
assert.equal(stats.total, 3, "stats 保留历史审计 row，但 resolver 不采用 profile_name");
assert.equal(stats.live, 1);

await fs.rm(dataDir, { recursive: true, force: true });
console.log("lid map tests passed.");
