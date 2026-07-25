// 聊天室互动能力的测试：手动回复、发图、抓客户的图。
// 用假的 Evolution api，不真的发送、不碰真号码。

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInboxSendService } from "./lib/inbox-send-service.mjs";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-inbox-send-"));

// 假 Evolution：记录被呼叫的 endpoint + body。
const calls = [];
const fakeApi = async (pathname, options = {}) => {
  const body = options.body ? JSON.parse(options.body) : {};
  calls.push({ pathname, body });
  if (pathname.includes("/message/sendText/")) return { key: { id: "OUT-TXT-1" } };
  if (pathname.includes("/message/sendMedia/")) return { key: { id: "OUT-IMG-1" } };
  if (pathname.includes("/chat/findMessages/")) {
    return { messages: [
      { key: { id: "IMG-9", remoteJid: "60111000001@s.whatsapp.net", fromMe: false }, message: { imageMessage: {} } },
      { key: { id: "TXT-1", remoteJid: "60111000001@s.whatsapp.net", fromMe: false }, message: { conversation: "hi" } },
    ] };
  }
  if (pathname.includes("/chat/getBase64FromMediaMessage/")) {
    return { mimetype: "image/png", base64: "aGVsbG8gd29ybGQgaW1hZ2UgYnl0ZXM" };
  }
  return {};
};

// 假对话纪录：记录 recordOutbound 收到什么。
const recorded = [];
const conversationLog = { async recordOutbound(m) { recorded.push(m); return { saved: true }; } };

const svc = createInboxSendService({ api: fakeApi, dataDir, conversationLog });

// --- 手动回复文字 ---
const sent = await svc.sendText({ instance: "wa_01", phone: "6011 100 0001", text: "你好，我发你资料" });
assert.equal(sent.sent, true);
assert.equal(sent.messageId, "OUT-TXT-1");
assert.equal(calls[0].pathname, "/message/sendText/wa_01");
assert.equal(calls[0].body.number, "60111000001", "电话要归一化成纯数字");
assert.equal(calls[0].body.text, "你好，我发你资料");
// 手动发的要记进对话纪录，source=manual
assert.equal(recorded[0].source, "manual");
assert.equal(recorded[0].messageId, "OUT-TXT-1");
assert.equal(recorded[0].phone, "60111000001");

// --- 守卫 ---
await assert.rejects(() => svc.sendText({ instance: "", phone: "60111", text: "x" }), /号码/);
await assert.rejects(() => svc.sendText({ instance: "wa_01", phone: "", text: "x" }), /客户电话/);
await assert.rejects(() => svc.sendText({ instance: "wa_01", phone: "60111", text: "  " }), /空/);

// --- 发图给客户（data URL）---
const tinyPng = "data:image/png;base64,ZmFrZSBwbmcgaW1hZ2UgYnl0ZXMgZm9yIHRlc3RpbmcgcHVycG9zZXMgMTIzNDU2";
const img = await svc.sendImage({ instance: "wa_01", phone: "60111000001", imageDataUrl: tinyPng, caption: "户型图" });
assert.equal(img.sent, true);
assert.equal(img.messageId, "OUT-IMG-1");
const mediaCall = calls.find((c) => c.pathname.includes("/message/sendMedia/"));
assert.equal(mediaCall.body.mediatype, "image");
assert.equal(mediaCall.body.mimetype, "image/png");
assert.equal(mediaCall.body.caption, "户型图");
assert.ok(mediaCall.body.media.length > 10, "base64 要带上去");
// 发出的图要存本机一份
const files = await fs.readdir(path.join(dataDir, "inbox-media"));
assert.ok(files.some((f) => f.startsWith("out_60111000001")), "发出的图要存本机");
// 图也要记进对话纪录
const imgRec = recorded.find((r) => r.flowTopic === "manual_image");
assert.equal(imgRec.text, "户型图");

// caption 空时 text 要有占位
await svc.sendImage({ instance: "wa_01", phone: "60111000001", imageDataUrl: tinyPng });
assert.equal(recorded.find((r) => r.text === "[已发送图片]")?.source, "manual");

// --- 抓客户发来的图 ---
const fetched = await svc.fetchInboundMedia({ instance: "wa_01", phone: "60111000001" });
assert.equal(fetched.available, true);
assert.equal(fetched.mime, "image/png");
assert.match(fetched.dataUrl, /^data:image\/png;base64,/);
assert.equal(fetched.messageId, "IMG-9", "要抓最新那张图");
// 抓到的图也存本机快取
const cached = await fs.readdir(path.join(dataDir, "inbox-media"));
assert.ok(cached.some((f) => f.startsWith("in_60111000001")), "抓到的客户图要快取");

// 指定 messageId 抓特定那张
const byId = await svc.fetchInboundMedia({ instance: "wa_01", phone: "60111000001", messageId: "IMG-9" });
assert.equal(byId.available, true);

// 没有图讯息的客户 → available:false，不炸
const emptyApi = async (p) => p.includes("findMessages") ? { messages: [] } : {};
const svc2 = createInboxSendService({ api: emptyApi, dataDir, conversationLog });
const none = await svc2.fetchInboundMedia({ instance: "wa_01", phone: "60122" });
assert.equal(none.available, false);
assert.equal(none.reason, "not_found");

// --- simulate 模式不真的打 api ---
const simCalls = [];
const simSvc = createInboxSendService({ api: async (p, o) => { simCalls.push(p); return {}; }, dataDir, conversationLog, simulate: true });
await simSvc.sendText({ instance: "wa_01", phone: "60111000001", text: "sim" });
assert.equal(simCalls.length, 0, "simulate 模式不可以真的呼叫 Evolution");

await fs.rm(dataDir, { recursive: true, force: true });
console.log("✅ all inbox send tests passed");
