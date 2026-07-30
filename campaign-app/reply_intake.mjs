// reply_intake.mjs — shared, pure helpers for parsing Evolution webhook payloads.
//
// Single source of truth used by BOTH blaster_tracker.mjs (stats/dashboard) and
// brain_service.mjs (the single responder). Extracted from blaster_tracker so
// the two listeners can never drift on how a customer message is interpreted.
// All functions are pure — no fs, no network — and covered by test_reply_intake.mjs.

// Same normalization as campaign_core/notion_upload: digits only, leading 0 -> 60 (MY).
//
// The length guard matters: without it a JID of "0" normalized to "60" and became
// a real contact row — six WhatsApp status/broadcast events piled up under a
// customer called "60" and sat in the inbox as someone waiting for a reply.
// Every real WhatsApp JID is a full international number, so 8-15 digits.
export function normalizePhone(value) {
  let digits = String(value ?? "").replace(/\D/g, "");
  if (digits.startsWith("0")) digits = `60${digits.slice(1)}`;
  return /^\d{8,15}$/.test(digits) ? digits : null;
}

// Pull the option(s) a customer tapped on a WhatsApp poll. Evolution/Baileys put
// the vote in a few different shapes depending on version and whether the option
// names were decrypted, so we check all of them and accept strings or {name}
// objects. Returns "" when there is no poll vote (or it couldn't be decoded).
export function extractPollVote(body) {
  if (!body || typeof body !== "object") return "";
  const vote = body.pollUpdateMessage?.vote
    ?? body.pollUpdateMessage
    ?? body.pollVote
    ?? null;
  const candidates = [
    vote?.selectedOptions,
    vote?.selectedValues,
    vote?.selectedOptionNames,
    body.selectedOptions,
    body.pollVotes,
  ].find((v) => Array.isArray(v) && v.length);
  if (!candidates) {
    const single = vote?.selectedName ?? vote?.name ?? vote?.optionName;
    return typeof single === "string" ? single.trim() : "";
  }
  return candidates
    .map((opt) => (typeof opt === "string" ? opt : (opt?.name ?? opt?.optionName ?? opt?.title ?? "")))
    .map((s) => String(s).trim())
    .filter(Boolean)
    .join(", ");
}

export function extractText(message) {
  const body = message?.message ?? message;
  if (!body || typeof body !== "object") return "";
  return [
    body.conversation,
    body.extendedTextMessage?.text,
    body.imageMessage?.caption,
    body.videoMessage?.caption,
    body.documentMessage?.caption,
    body.buttonsResponseMessage?.selectedDisplayText,
    body.listResponseMessage?.title,
    body.templateButtonReplyMessage?.selectedDisplayText,
    extractPollVote(body),
  ].find((value) => typeof value === "string" && value.trim())?.trim() ?? "";
}

export function messageMediaKind(message) {
  const body = message?.message ?? message;
  if (!body || typeof body !== "object") return "";
  if (body.imageMessage) return "image";
  if (body.videoMessage) return "video";
  if (body.stickerMessage) return "sticker";
  if (body.documentMessage) return "document";
  return "";
}

// Never empty for a real inbound message: media replies get a readable label
// instead of being dropped (voice notes, images, stickers, reactions, etc.).
export function describeMessage(message) {
  const text = extractText(message);
  if (text) return text;
  const body = message?.message ?? message;
  if (!body || typeof body !== "object") return "[reply]";
  if (body.audioMessage) return body.audioMessage.ptt ? "[voice note]" : "[audio]";
  if (body.imageMessage) return "[image]";
  if (body.videoMessage) return "[video]";
  if (body.stickerMessage) return "[sticker]";
  if (body.documentMessage) return "[document]";
  if (body.locationMessage || body.liveLocationMessage) return "[location]";
  if (body.contactMessage || body.contactsArrayMessage) return "[contact]";
  if (body.reactionMessage) return `[reaction ${body.reactionMessage.text ?? ""}]`.trim();
  // A vote whose option text we couldn't decode still counts as an inbound reply
  // (so the lead exits the sequence to human takeover) — extractText already
  // returned the option name when it *was* decodable.
  if (body.pollUpdateMessage) return "[poll vote]";
  if (body.pollCreationMessage) return "[poll]";
  return "[reply]";
}

// Extract a usable phone from a JID, ignoring device suffix (":12"). Returns
// null for @lid / @g.us / anything that isn't a real phone JID.
export function jidPhone(jid) {
  const value = String(jid ?? "");
  if (!value.includes("@s.whatsapp.net")) return null;
  return normalizePhone(value.split("@")[0].split(":")[0]);
}

// Resolve the customer's phone even when the primary JID is a privacy id (@lid):
// WhatsApp/Baileys often carry the real number in an alternate field.
export function resolvePhone(message) {
  const key = message?.key ?? {};
  return (
    jidPhone(key.remoteJid) ||
    jidPhone(key.remoteJidAlt) ||
    jidPhone(message?.senderPn) ||
    jidPhone(key.participantPn) ||
    jidPhone(key.participant) ||
    jidPhone(message?.participant) ||
    null
  );
}

// Extract the privacy id ("lid") from a JID. WhatsApp's LID addressing replaces
// the phone number with an opaque id, so this is often the ONLY stable handle a
// stored message carries — see lib/lid-map-service.mjs for how it maps back.
export function jidLid(jid) {
  const value = String(jid ?? "");
  if (!value.endsWith("@lid")) return null;
  const id = value.split("@")[0].split(":")[0].replace(/\D/g, "");
  return id || null;
}

export function resolveLid(message) {
  const key = message?.key ?? {};
  return (
    jidLid(key.remoteJid) ||
    jidLid(key.remoteJidAlt) ||
    jidLid(key.participant) ||
    jidLid(message?.participant) ||
    null
  );
}

// The phone when the message carries one, otherwise whatever the lid map knows.
//
// `lookup` is a synchronous (lid) => phone|null — kept as an argument so this
// module stays pure and testable; callers pass lidMap.resolveCached.
export function resolvePhoneWithLid(message, lookup = null) {
  const direct = resolvePhone(message);
  if (direct) return direct;
  if (typeof lookup !== "function") return null;
  const lid = resolveLid(message);
  if (!lid) return null;
  return normalizePhone(lookup(lid));
}

// A message that proves "this lid is that phone" — it carries both. These are the
// only fully trustworthy mappings; everything else in the lid map is inferred.
export function lidPhonePair(message) {
  const lid = resolveLid(message);
  if (!lid) return null;
  const phone = resolvePhone(message);
  if (!phone) return null;
  return { lid, phone };
}

// Walk an arbitrary Evolution payload and collect message-shaped objects.
export function collectMessages(value, found = []) {
  if (!value || typeof value !== "object") return found;
  if (value.key && (value.message || value.messageTimestamp || value.pushName)) found.push(value);
  for (const child of Object.values(value)) collectMessages(child, found);
  return found;
}

export function senderFromPayload(payload) {
  return payload?.instance ?? payload?.instanceName ?? payload?.data?.instance ?? "unknown";
}

const DELIVERY_STATUS_ALIASES = new Map([
  ["0", "ERROR"],
  ["1", "PENDING"],
  ["2", "SERVER_ACK"],
  ["3", "DELIVERY_ACK"],
  ["4", "READ"],
  ["5", "PLAYED"],
  ["FAILED", "ERROR"],
  ["FAILURE", "ERROR"],
  ["SENT", "SERVER_ACK"],
  ["DELIVERED", "DELIVERY_ACK"],
]);

const DELIVERY_STATUS_RANKS = new Map([
  ["PENDING", 0],
  ["ERROR", 1],
  ["SERVER_ACK", 2],
  ["DELIVERY_ACK", 3],
  ["READ", 4],
  ["PLAYED", 5],
]);

export function normalizeMessageDeliveryStatus(value) {
  const key = String(value ?? "").trim().toUpperCase().replace(/[\s.-]+/g, "_");
  const normalized = DELIVERY_STATUS_ALIASES.get(key) ?? key;
  return DELIVERY_STATUS_RANKS.has(normalized) ? normalized : "";
}

export function deliveryStatusRank(value) {
  return DELIVERY_STATUS_RANKS.get(normalizeMessageDeliveryStatus(value)) ?? -1;
}

function normalizedEventName(value) {
  return String(value ?? "").trim().toUpperCase().replace(/[\s.-]+/g, "_");
}

function statusTimestamp(payload, node) {
  const raw = node?.date_time
    ?? node?.dateTime
    ?? node?.updatedAt
    ?? node?.timestamp
    ?? node?.update?.date_time
    ?? node?.update?.dateTime
    ?? node?.update?.timestamp
    ?? payload?.date_time
    ?? payload?.dateTime
    ?? payload?.timestamp;
  if (raw === undefined || raw === null || raw === "") return new Date().toISOString();
  const numeric = Number(raw);
  const ms = Number.isFinite(numeric)
    ? (numeric < 100000000000 ? numeric * 1000 : numeric)
    : new Date(raw).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString();
}

// Evolution sends delivery receipts separately from message upserts. Keep the
// parser tolerant of v1/v2 and Baileys shapes, but only accept MESSAGES_UPDATE
// payloads so a message body's unrelated "status" field cannot change delivery.
export function collectMessageStatusUpdates(payload) {
  if (normalizedEventName(payload?.event ?? payload?.type) !== "MESSAGES_UPDATE") return [];

  const updates = new Map();
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    const status = normalizeMessageDeliveryStatus(
      node.messageStatus
      ?? node.message_status
      ?? node.update?.status
      ?? node.status,
    );
    const messageId = String(
      node.messageId
      ?? node.message_id
      ?? node.keyId
      ?? node.key?.id
      ?? (status ? node.id : "")
      ?? "",
    ).trim();
    const fromMe = node.fromMe ?? node.key?.fromMe;

    if (status && messageId && fromMe !== false) {
      const candidate = {
        messageId,
        status,
        observedAt: statusTimestamp(payload, node),
        instanceName: senderFromPayload(payload),
      };
      const current = updates.get(messageId);
      if (!current || deliveryStatusRank(candidate.status) >= deliveryStatusRank(current.status)) {
        updates.set(messageId, candidate);
      }
    }
    for (const child of Object.values(node)) walk(child);
  };

  walk(payload?.data ?? payload);
  return [...updates.values()];
}

// Turn one raw message into the normalized inbound event both services use.
// Returns null for own messages, group chats, or unresolvable phones.
export function inboundEvent(payload, message) {
  const key = message?.key ?? {};
  if (key.fromMe) return null;
  const remoteJid = String(key.remoteJid ?? message?.remoteJid ?? "");
  if (remoteJid.includes("@g.us")) return null;
  const phone = resolvePhone(message);
  if (!phone) return null;
  const text = describeMessage(message);
  const timestamp = Number(message.messageTimestamp ?? Date.now());
  const receivedAt = new Date(timestamp < 100000000000 ? timestamp * 1000 : timestamp).toISOString();
  return {
    id: key.id ?? `${phone}_${Date.now()}`,
    receivedAt,
    instanceName: senderFromPayload(payload),
    pushName: message.pushName ?? null,
    phone,
    text,
    mediaKind: messageMediaKind(message),
  };
}
