import crypto from "node:crypto";

export const LEAD_AUDIT_VERSION = "lead-auditor-v1";
export const INTEREST_LEVELS = Object.freeze(["HOT", "WARM", "COLD", "NURTURE"]);
export const RECOMMENDED_ACTIONS = Object.freeze(["CALL", "WHATSAPP", "FOLLOW_UP", "REVIEW", "NONE"]);

const PRIVATE_KEY = /(phone|email|token|secret|api.?key|jid|lid|nric|identity|payload|raw)/i;

function clean(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function redactText(value) {
  return clean(value, 2000)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/(?<!\d)\+?\d[\d\s()-]{5,}\d(?!\d)/g, "[phone]");
}

export function sanitizeAuditInput(value, depth = 0) {
  if (depth > 5 || value === null || value === undefined) return value ?? null;
  if (typeof value === "string") return redactText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeAuditInput(item, depth + 1));
  if (typeof value !== "object") return null;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !PRIVATE_KEY.test(key))
    .slice(0, 50)
    .map(([key, item]) => [key, sanitizeAuditInput(item, depth + 1)]));
}

function numberInRange(value, minimum, maximum, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw Object.assign(new Error(`${field} must be between ${minimum} and ${maximum}.`), { code: "AI_AUDIT_OUTPUT_INVALID" });
  }
  return number;
}

function stringArray(value, field) {
  if (!Array.isArray(value)) throw Object.assign(new Error(`${field} must be an array.`), { code: "AI_AUDIT_OUTPUT_INVALID" });
  return value.slice(0, 8).map((item) => clean(item, 240)).filter(Boolean);
}

export function validateLeadAuditOutput(input = {}) {
  const interestLevel = clean(input.interest_level).toUpperCase();
  const recommendedAction = clean(input.recommended_action).toUpperCase();
  if (!INTEREST_LEVELS.includes(interestLevel)) throw Object.assign(new Error("interest_level is invalid."), { code: "AI_AUDIT_OUTPUT_INVALID" });
  if (!RECOMMENDED_ACTIONS.includes(recommendedAction)) throw Object.assign(new Error("recommended_action is invalid."), { code: "AI_AUDIT_OUTPUT_INVALID" });
  if (typeof input.forgotten_followup !== "boolean") throw Object.assign(new Error("forgotten_followup must be boolean."), { code: "AI_AUDIT_OUTPUT_INVALID" });
  const dueAt = input.recommended_due_at == null || input.recommended_due_at === "" ? null : clean(input.recommended_due_at, 64);
  if (dueAt && Number.isNaN(Date.parse(dueAt))) throw Object.assign(new Error("recommended_due_at must be ISO date-time or null."), { code: "AI_AUDIT_OUTPUT_INVALID" });
  return Object.freeze({
    interest_level: interestLevel,
    score: Math.round(numberInRange(input.score, 0, 100, "score")),
    closing_probability: numberInRange(input.closing_probability, 0, 1, "closing_probability"),
    forgotten_followup: input.forgotten_followup,
    buying_purpose: clean(input.buying_purpose, 240),
    budget: clean(input.budget, 160),
    timeline: clean(input.timeline, 160),
    main_objection: clean(input.main_objection, 240),
    recommended_action: recommendedAction,
    recommended_due_at: dueAt,
    suggested_message: clean(input.suggested_message, 800),
    reasons: stringArray(input.reasons, "reasons"),
    risk_flags: stringArray(input.risk_flags, "risk_flags"),
    confidence: numberInRange(input.confidence, 0, 1, "confidence"),
  });
}

export function buildLeadAuditCacheKey({ customerId, lastMessageId = "", analysisVersion = LEAD_AUDIT_VERSION } = {}) {
  const input = [clean(customerId), clean(lastMessageId), clean(analysisVersion)].join("\u001f");
  return `audit_${crypto.createHash("sha256").update(input).digest("hex").slice(0, 32)}`;
}

export function fingerprintAuditInput(input) {
  return crypto.createHash("sha256").update(JSON.stringify(sanitizeAuditInput(input))).digest("hex");
}

export function ruleAuditCandidate({ globalStatus = "ACTIVE", temperature = "COLD", salesStage = "NEW", dueAt = null, lastMeaningfulContactAt = null, now = new Date() } = {}) {
  if (["STOP", "MERGED", "INVALID"].includes(clean(globalStatus).toUpperCase()) || clean(temperature).toUpperCase() === "STOP") {
    return { eligible: false, reasons: ["Customer is not contactable."], recommendedAction: "NONE", priorityScore: 0 };
  }
  const reasons = [];
  const due = dueAt ? new Date(dueAt) : null;
  const last = lastMeaningfulContactAt ? new Date(lastMeaningfulContactAt) : null;
  const daysSinceContact = last && !Number.isNaN(last.getTime()) ? Math.floor((now.getTime() - last.getTime()) / 86400000) : null;
  if (due && !Number.isNaN(due.getTime()) && due <= now) reasons.push("Follow-up is due or overdue.");
  if (["HOT", "WARM"].includes(clean(temperature).toUpperCase()) && (daysSinceContact == null || daysSinceContact >= 3)) reasons.push(`${clean(temperature).toUpperCase()} lead has no recent meaningful contact.`);
  if (["REPLIED", "QUALIFIED", "WARM", "APPOINTMENT", "VIEWED", "LOAN_PROCESSING", "BOOKING", "SPA_SIGNED"].includes(clean(salesStage).toUpperCase()) && daysSinceContact >= 7) reasons.push("Active opportunity appears stale.");
  return {
    eligible: reasons.length > 0,
    reasons,
    recommendedAction: clean(salesStage).toUpperCase() === "APPOINTMENT" ? "CALL" : "FOLLOW_UP",
    priorityScore: Math.min(100, reasons.length * 30 + (temperature === "HOT" ? 30 : temperature === "WARM" ? 15 : 0)),
  };
}

export function recommendedChannel({ taskType = "", salesStage = "" } = {}) {
  if (["CONFIRM_APPOINTMENT", "CHECK_BOOKING", "UPDATE_SPA", "TRANSACTION"].includes(clean(taskType).toUpperCase())) return "CALL";
  if (["BOOKING", "SPA_SIGNED"].includes(clean(salesStage).toUpperCase())) return "CALL";
  return "WHATSAPP";
}
