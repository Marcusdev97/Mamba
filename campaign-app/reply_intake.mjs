// reply_intake.mjs — shared, pure helpers for parsing Evolution webhook payloads.
//
// Single source of truth used by BOTH blaster_tracker.mjs (stats/dashboard) and
// brain_service.mjs (the single responder). Extracted from blaster_tracker so
// the two listeners can never drift on how a customer message is interpreted.
// All functions are pure — no fs, no network — and covered by test_reply_intake.mjs.

// Same normalization as campaign_core/notion_upload: digits only, leading 0 -> 60 (MY).
export function normalizePhone(value) {
  let digits = String(value ?? "").replace(/\D/g, "");
  if (digits.startsWith("0")) digits = `60${digits.slice(1)}`;
  return digits || null;
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
  };
}
