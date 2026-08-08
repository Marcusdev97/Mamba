import crypto from "node:crypto";
import { normalizePhone } from "../reply_intake.mjs";

export const CUSTOMER_IDENTITY_TYPES = Object.freeze([
  "PHONE_E164",
  "WHATSAPP_JID",
  "WHATSAPP_LID",
  "EVOLUTION_REMOTE_JID",
  "CONTACT_IMPORT_ID",
  "NOTION_PAGE_ID",
  "LEGACY_CONTACT_KEY",
]);

export const IDENTITY_CONFIDENCE = Object.freeze({
  VERIFIED_PHONE_LID: 100,
  STABLE_PHONE_JID: 90,
  CONVERSATION_CONTINUITY: 80,
  IMPORTED_PHONE: 60,
  NAME_ONLY: 30,
});

const TYPE_SET = new Set(CUSTOMER_IDENTITY_TYPES);

function clean(value) {
  return String(value ?? "").trim();
}

function jid(value) {
  const raw = clean(value).toLowerCase();
  if (!raw.includes("@")) return "";
  const [local, domain] = raw.split("@", 2);
  const canonicalLocal = local.split(":")[0].replace(/[^a-z0-9]/g, "");
  return canonicalLocal && domain ? `${canonicalLocal}@${domain}` : "";
}

export function normalizeIdentityValue(identityType, value) {
  if (!TYPE_SET.has(identityType)) return "";
  if (identityType === "PHONE_E164") return normalizePhone(value) || "";
  if (identityType === "WHATSAPP_LID") return clean(value).split("@")[0].split(":")[0].replace(/\D/g, "");
  if (["WHATSAPP_JID", "EVOLUTION_REMOTE_JID"].includes(identityType)) return jid(value);
  return clean(value).slice(0, 500);
}

export function identityKey(identityType, value) {
  const normalized = normalizeIdentityValue(identityType, value);
  return normalized ? `${identityType}:${normalized}` : "";
}

export function identityId(identityType, value) {
  const key = identityKey(identityType, value);
  if (!key) return "";
  return `identity_${crypto.createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}

export function newCustomerId() {
  return `CUS-${crypto.randomBytes(12).toString("hex").toUpperCase()}`;
}

export function messageIdentityEvidence({ phone = "", contactKey = "", remoteJid = "", lid = "", importId = "", notionPageId = "" } = {}) {
  const result = [];
  const normalizedPhone = normalizeIdentityValue("PHONE_E164", phone);
  if (normalizedPhone) result.push({ type: "PHONE_E164", value: normalizedPhone, confidence: IDENTITY_CONFIDENCE.IMPORTED_PHONE });
  const legacy = normalizeIdentityValue("LEGACY_CONTACT_KEY", contactKey || normalizedPhone);
  if (legacy) result.push({ type: "LEGACY_CONTACT_KEY", value: legacy, confidence: IDENTITY_CONFIDENCE.CONVERSATION_CONTINUITY });
  const canonicalRemote = normalizeIdentityValue("EVOLUTION_REMOTE_JID", remoteJid);
  if (canonicalRemote) result.push({ type: "EVOLUTION_REMOTE_JID", value: canonicalRemote, confidence: canonicalRemote.endsWith("@s.whatsapp.net") ? IDENTITY_CONFIDENCE.STABLE_PHONE_JID : IDENTITY_CONFIDENCE.CONVERSATION_CONTINUITY });
  if (canonicalRemote.endsWith("@s.whatsapp.net")) result.push({ type: "WHATSAPP_JID", value: canonicalRemote, confidence: IDENTITY_CONFIDENCE.STABLE_PHONE_JID });
  const canonicalLid = normalizeIdentityValue("WHATSAPP_LID", lid || (canonicalRemote.endsWith("@lid") ? canonicalRemote : ""));
  if (canonicalLid) result.push({ type: "WHATSAPP_LID", value: canonicalLid, confidence: normalizedPhone ? IDENTITY_CONFIDENCE.VERIFIED_PHONE_LID : IDENTITY_CONFIDENCE.CONVERSATION_CONTINUITY });
  const imported = normalizeIdentityValue("CONTACT_IMPORT_ID", importId);
  if (imported) result.push({ type: "CONTACT_IMPORT_ID", value: imported, confidence: IDENTITY_CONFIDENCE.IMPORTED_PHONE });
  const notion = normalizeIdentityValue("NOTION_PAGE_ID", notionPageId);
  if (notion) result.push({ type: "NOTION_PAGE_ID", value: notion, confidence: IDENTITY_CONFIDENCE.CONVERSATION_CONTINUITY });
  return [...new Map(result.map((item) => [identityKey(item.type, item.value), item])).values()];
}

export function assertNoNameOnlyMerge({ identities = [], name = "" } = {}) {
  if (identities.some((item) => Number(item.confidence) >= IDENTITY_CONFIDENCE.IMPORTED_PHONE)) return true;
  const error = new Error(`不能只凭名字「${clean(name)}」自动合并客户。`);
  error.code = "CUSTOMER_IDENTITY_NAME_ONLY_FORBIDDEN";
  error.retryable = false;
  throw error;
}
