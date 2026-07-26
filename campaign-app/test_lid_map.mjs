import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLidMapService } from "./lib/lid-map-service.mjs";
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
assert.equal(normalizePhone("0168568756"), "60168568756");
assert.equal(normalizePhone("60168568756"), "60168568756");

// ---- service ----

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-lid-"));
const lidMap = createLidMapService({ dataDir });

assert.equal(await lidMap.resolve("999"), null, "空表查无");

await lidMap.learn([{ lid: "999", phone: "60111222333" }], { source: "outbound_match" });
assert.equal(await lidMap.resolve("999"), "60111222333");

// 低可信度不能盖掉高可信度，补回脚本才能随便重跑。
await lidMap.learn([{ lid: "999", phone: "60000000000" }], { source: "profile_name" });
assert.equal(await lidMap.resolve("999"), "60111222333", "profile_name 不该盖掉 outbound_match");

// message id 是精确比对，该赢过猜文字的。
await lidMap.learn([{ lid: "999", phone: "60555555555" }], { source: "message_id" });
assert.equal(await lidMap.resolve("999"), "60555555555", "message_id 应该赢过 outbound_match");

// 高可信度可以修正低可信度。
await lidMap.learn([{ lid: "999", phone: "60777777777" }], { source: "live" });
assert.equal(await lidMap.resolve("999"), "60777777777", "live 应该修正得了");

// 同可信度可以覆盖 —— 同一支来源重跑要能修正自己上次的结论。
await lidMap.learn([{ lid: "999", phone: "60666666666" }], { source: "live" });
assert.equal(await lidMap.resolve("999"), "60666666666");
await lidMap.learn([{ lid: "999", phone: "60777777777" }], { source: "live" });

// learn() 之后 resolveCached 必须马上看得到新的对照。
// 之前 learn() 把整个快取清空，导致补回历史时每页 learn 一次、全程查无，
// 8000 条讯息只认得出 8 条。
await lidMap.warm();
await lidMap.learn([{ lid: "888", phone: "60123123123" }], { source: "live" });
assert.equal(lidMap.resolveCached("888"), "60123123123", "learn 之后快取要马上生效");
assert.equal(lidMap.resolveCached("999"), "60777777777", "learn 不能把旧的冲掉");

// 垃圾进不去。
await lidMap.learn([{ lid: "", phone: "60111222333" }, { lid: "777", phone: "" }], { source: "live" });
assert.equal(await lidMap.resolve("777"), null);

const stats = await lidMap.stats();
assert.equal(stats.total, 2);
assert.equal(stats.live, 2);

await fs.rm(dataDir, { recursive: true, force: true });
console.log("lid map tests passed.");
