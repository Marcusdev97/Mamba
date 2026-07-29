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

function safeFileSegment(value) {
  return clean(value).replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 120);
}

function whatsappMediaKind(body) {
  if (body?.imageMessage) return "image";
  if (body?.videoMessage) return "video";
  if (body?.stickerMessage) return "sticker";
  if (body?.documentMessage) return "document";
  return "";
}

function mediaDefaults(kind, mimetype = "") {
  const mime = clean(mimetype).toLowerCase() || ({
    image: "image/jpeg",
    video: "video/mp4",
    sticker: "image/webp",
    document: "application/octet-stream",
  })[kind] || "application/octet-stream";
  const ext = mime.includes("png") ? "png"
    : mime.includes("webp") ? "webp"
      : mime.includes("gif") ? "gif"
        : mime.includes("mp4") ? "mp4"
          : mime.includes("quicktime") ? "mov"
            : mime.includes("pdf") ? "pdf"
              : mime.startsWith("image/") ? "jpg"
                : kind === "video" ? "mp4"
                  : "bin";
  return { mime, ext };
}

function mimeFromFileName(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  return ({
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".pdf": "application/pdf",
  })[ext] || "application/octet-stream";
}

function kindFromMime(mime) {
  if (String(mime).startsWith("video/")) return "video";
  if (String(mime).startsWith("image/")) return "image";
  return "document";
}

export function normalizeManualRecipientPhone(value) {
  const raw = clean(value);
  let number = digits(raw);
  if (raw.startsWith("00")) number = number.slice(2);
  else if (number.startsWith("0")) number = `60${number.slice(1)}`;
  if (!/^[1-9]\d{7,14}$/.test(number)) return "";
  return number;
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

  async function prepareContact({ instance, phone, name = "" }) {
    const instanceName = clean(instance);
    const number = normalizeManualRecipientPhone(phone);
    if (!instanceName) throw badRequest("缺少发送号码(instance)。");
    if (!number) throw badRequest("电话号码格式不正确。请填写 012…、60… 或 +60… 的完整号码。");
    if (!conversationLog?.prepareManualContact) {
      const error = new Error("聊天室新增号码功能尚未载入。请重启 Mamba。");
      error.statusCode = 503;
      throw error;
    }
    return conversationLog.prepareManualContact({
      phone: number,
      name: clean(name),
      instanceName,
    });
  }

  // 手动回复文字。发出去之后记进对话纪录(outbound, source=manual)，聊天室立刻看到。
  async function sendText({ instance, phone, text }) {
    const instanceName = clean(instance);
    const number = normalizeManualRecipientPhone(phone);
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
    }, { requireExisting: true }).catch((error) => console.log(`[inbox] 对话纪录写入失败(讯息已发出) ${number}: ${error.message}`));
    return { sent: true, messageId };
  }

  // 手动发照片给客户（可带 caption）。图存本机一份，讯息记 outbound。
  async function sendImage({ instance, phone, imageDataUrl, caption = "" }) {
    const instanceName = clean(instance);
    const number = normalizeManualRecipientPhone(phone);
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
      mediaKind: "image", mediaFileName: fileName, mime,
    }, { requireExisting: true }).catch((error) => console.log(`[inbox] 图片纪录写入失败(已发出) ${number}: ${error.message}`));
    return { sent: true, messageId, fileName };
  }

  async function cachedMedia(number, messageId) {
    const safeId = safeFileSegment(messageId);
    if (!safeId) return null;
    try {
      const prefixes = [`in_${number}_${safeId}_`, `in_${number}_${safeId}.`];
      const fileName = (await fs.readdir(mediaDir)).find((name) => (
        prefixes.some((prefix) => name.startsWith(prefix))
      ));
      if (!fileName) return null;
      const mime = mimeFromFileName(fileName);
      const cachedKind = fileName.match(/_(image|video|sticker|document)\.[^.]+$/)?.[1];
      return {
        available: true,
        cached: true,
        kind: cachedKind || kindFromMime(mime),
        mime,
        fileName,
        messageId: clean(messageId),
      };
    } catch {
      return null;
    }
  }

  // 抓一则 WhatsApp 媒体（按需）。图片靠近可视区才调用；影片必须由操作员点击。
  // 存本机快取，第二次看同一张就不用再抓。
  async function fetchInboundMedia({ instance, phone, messageId = "", direction = "inbound" }) {
    const instanceName = clean(instance);
    const number = digits(phone);
    if (!instanceName || !number) throw badRequest("缺少号码或客户电话。");
    if (simulate) return { available: false, reason: "simulate" };
    const wantedDirection = clean(direction).toLowerCase() === "outbound" ? "outbound" : "inbound";
    const cached = await cachedMedia(number, messageId);
    if (cached) return cached;

    const isWantedMedia = (message) => (
      hasMedia(message?.message)
      && (wantedDirection === "outbound" ? message?.key?.fromMe === true : message?.key?.fromMe !== true)
    );
    const wantedMessageId = clean(messageId);
    let target = null;

    if (wantedMessageId) {
      // Older media can fall outside Evolution's recent-message window. Querying by
      // the stable WhatsApp message ID avoids loading a customer's full history.
      const exact = await api(`/chat/findMessages/${encodeURIComponent(instanceName)}`, {
        method: "POST",
        body: JSON.stringify({
          where: { key: { id: wantedMessageId, remoteJid: `${number}@s.whatsapp.net` } },
          limit: 5,
        }),
      }).catch(() => null);
      target = collectRecords(exact).find((message) => (
        isWantedMedia(message)
        && clean(message?.key?.id) === wantedMessageId
      )) ?? null;
    }

    if (!target) {
      const recent = await api(`/chat/findMessages/${encodeURIComponent(instanceName)}`, {
        method: "POST",
        body: JSON.stringify({ where: { key: { remoteJid: `${number}@s.whatsapp.net` } }, limit: 200 }),
      }).catch(() => null);
      const candidates = collectRecords(recent).filter(isWantedMedia);
      target = wantedMessageId
        ? candidates.find((message) => clean(message?.key?.id) === wantedMessageId)
        : candidates[candidates.length - 1];
    }
    if (!target) return { available: false, reason: "not_found" };

    const key = target.key;
    const kind = whatsappMediaKind(target.message);
    const media = await api(`/chat/getBase64FromMediaMessage/${encodeURIComponent(instanceName)}`, {
      method: "POST",
      body: JSON.stringify({ message: { key }, convertToMp4: kind === "video" }),
      timeoutMs: 45000,
    }).catch(() => null);
    if (!media?.base64) return { available: false, reason: "download_failed" };

    const { mime, ext } = mediaDefaults(kind, media.mimetype);
    const bytes = Buffer.from(media.base64, "base64");
    if (!bytes.length) return { available: false, reason: "download_failed" };

    await fs.mkdir(mediaDir, { recursive: true });
    const fileName = `in_${number}_${safeFileSegment(key.id) || Date.now()}_${kind || "media"}.${ext}`;
    await fs.writeFile(path.join(mediaDir, fileName), bytes);
    return {
      available: true,
      cached: false,
      kind: kind || kindFromMime(mime),
      mime,
      fileName,
      messageId: clean(key.id),
    };
  }

  async function readStoredMedia(fileName) {
    const requested = clean(fileName);
    const safeName = path.basename(requested);
    if (
      !requested
      || safeName !== requested
      || !/^(in|out)_[a-zA-Z0-9_.-]+$/.test(safeName)
    ) {
      throw badRequest("媒体档案名称无效。");
    }
    try {
      const buffer = await fs.readFile(path.join(mediaDir, safeName));
      return { buffer, mime: mimeFromFileName(safeName), fileName: safeName };
    } catch (error) {
      if (error?.code === "ENOENT") {
        const missing = new Error("这个媒体缓存已经不存在，请重新加载。");
        missing.statusCode = 404;
        throw missing;
      }
      throw error;
    }
  }

  return {
    normalizePhone: normalizeManualRecipientPhone,
    prepareContact,
    sendText,
    sendImage,
    fetchInboundMedia,
    readStoredMedia,
  };
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
