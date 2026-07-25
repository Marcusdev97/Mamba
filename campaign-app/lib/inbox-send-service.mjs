// 聊天室的互动能力：手动回复客户、发照片给客户、抓客户发来的照片。
//
// 跟自动回复(brain_service)分开：这是**人**在聊天室里手动发的，不受 Sales Brain
// 开关影响。Sales Brain 关着的时候，这里照样能手动回。
//
// 收图是「按需」抓的 —— 客户发图时只存了「[image]」占位，真正的图片在需要看的
// 时候才向 Evolution 要(getBase64FromMediaMessage)，不碰生产收讯息路径。

import fs from "node:fs/promises";
import path from "node:path";

function clean(value) {
  return String(value ?? "").trim();
}

function digits(value) {
  return String(value ?? "").replace(/\D/g, "");
}

// data URL 或纯 base64 都接受，回 { base64, mime, ext }。
function parseImageInput(dataUrl) {
  const raw = clean(dataUrl);
  const match = raw.match(/^data:([^;]+);base64,(.+)$/s);
  const mime = match ? match[1] : "image/jpeg";
  const base64 = match ? match[2] : raw;
  const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : mime.includes("gif") ? "gif" : "jpg";
  return { base64, mime, ext };
}

export function createInboxSendService({ api, dataDir, conversationLog, simulate = false } = {}) {
  const mediaDir = path.join(dataDir, "inbox-media");

  // 手动回复文字。发出去之后记进对话纪录(outbound, source=manual)，聊天室立刻看到。
  async function sendText({ instance, phone, text }) {
    const instanceName = clean(instance);
    const number = digits(phone);
    const body = clean(text);
    if (!instanceName) throw badRequest("缺少号码(instance)。");
    if (!number) throw badRequest("缺少客户电话。");
    if (!body) throw badRequest("讯息是空的。");

    let messageId = "";
    if (simulate) {
      console.log(`[inbox:simulate] ${instanceName} -> ${number}: ${body}`);
    } else {
      const result = await api(`/message/sendText/${encodeURIComponent(instanceName)}`, {
        method: "POST",
        body: JSON.stringify({ number, text: body, delay: 800 }),
      });
      messageId = result?.key?.id ?? "";
    }
    await conversationLog?.recordOutbound({
      phone: number, text: body, instanceName, messageId,
      source: "manual", flowTopic: "manual_reply",
    }).catch((error) => console.log(`[inbox] 对话纪录写入失败(讯息已发出) ${number}: ${error.message}`));
    return { sent: true, messageId };
  }

  // 手动发照片给客户（可带 caption）。图存本机一份，讯息记 outbound。
  async function sendImage({ instance, phone, imageDataUrl, caption = "" }) {
    const instanceName = clean(instance);
    const number = digits(phone);
    if (!instanceName) throw badRequest("缺少号码(instance)。");
    if (!number) throw badRequest("缺少客户电话。");
    const { base64, mime, ext } = parseImageInput(imageDataUrl);
    if (!base64 || base64.length < 32) throw badRequest("没有有效的图片资料。");

    // 存一份到本机，聊天室之后就直接看得到自己发过的图。
    await fs.mkdir(mediaDir, { recursive: true });
    const fileName = `out_${number}_${Date.now()}.${ext}`;
    await fs.writeFile(path.join(mediaDir, fileName), Buffer.from(base64, "base64"));

    let messageId = "";
    if (simulate) {
      console.log(`[inbox:simulate] ${instanceName} -> ${number}: [image ${ext}] ${clean(caption)}`);
    } else {
      const result = await api(`/message/sendMedia/${encodeURIComponent(instanceName)}`, {
        method: "POST",
        body: JSON.stringify({
          number, mediatype: "image", mimetype: mime,
          caption: clean(caption), media: base64, fileName, delay: 1200,
        }),
        timeoutMs: 45000,
      });
      messageId = result?.key?.id ?? "";
    }
    await conversationLog?.recordOutbound({
      phone: number, text: clean(caption) || "[已发送图片]", instanceName, messageId,
      source: "manual", flowTopic: "manual_image",
    }).catch((error) => console.log(`[inbox] 图片纪录写入失败(已发出) ${number}: ${error.message}`));
    return { sent: true, messageId, fileName };
  }

  // 抓客户发来的一张图（按需）。找出这个客户的图讯息，向 Evolution 要 base64。
  // 存本机快取，第二次看同一张就不用再抓。
  async function fetchInboundMedia({ instance, phone, messageId = "" }) {
    const instanceName = clean(instance);
    const number = digits(phone);
    if (!instanceName || !number) throw badRequest("缺少号码或客户电话。");
    if (simulate) return { available: false, reason: "simulate" };

    const found = await api(`/chat/findMessages/${encodeURIComponent(instanceName)}`, {
      method: "POST",
      body: JSON.stringify({ where: { key: { remoteJid: `${number}@s.whatsapp.net` } }, limit: 200 }),
    }).catch(() => null);

    const records = collectRecords(found);
    // 指定了 messageId 就抓那一条；否则抓最新一张图。
    const candidates = records.filter((m) => !m?.key?.fromMe && hasMedia(m?.message));
    const target = clean(messageId)
      ? candidates.find((m) => String(m?.key?.id) === clean(messageId))
      : candidates[candidates.length - 1];
    if (!target) return { available: false, reason: "not_found" };

    const key = target.key;
    const media = await api(`/chat/getBase64FromMediaMessage/${encodeURIComponent(instanceName)}`, {
      method: "POST",
      body: JSON.stringify({ message: { key }, convertToMp4: false }),
      timeoutMs: 45000,
    }).catch(() => null);
    if (!media?.base64) return { available: false, reason: "download_failed" };

    // 存快取
    await fs.mkdir(mediaDir, { recursive: true });
    const ext = (media.mimetype || "").includes("png") ? "png" : (media.mimetype || "").includes("webp") ? "webp" : "jpg";
    const fileName = `in_${number}_${clean(key.id) || Date.now()}.${ext}`;
    await fs.writeFile(path.join(mediaDir, fileName), Buffer.from(media.base64, "base64"));
    return {
      available: true,
      mime: media.mimetype || "image/jpeg",
      dataUrl: `data:${media.mimetype || "image/jpeg"};base64,${media.base64}`,
      messageId: clean(key.id),
    };
  }

  return { sendText, sendImage, fetchInboundMedia };
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function collectRecords(found) {
  if (!found) return [];
  if (Array.isArray(found)) return found;
  if (Array.isArray(found?.messages)) return found.messages;
  if (Array.isArray(found?.messages?.records)) return found.messages.records;
  return [];
}

function hasMedia(body) {
  return Boolean(body?.imageMessage || body?.videoMessage || body?.documentMessage || body?.stickerMessage);
}
