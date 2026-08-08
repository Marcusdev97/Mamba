export const SALES_STAGES = Object.freeze([
  "NEW",
  "CONTACTED",
  "REPLIED",
  "QUALIFIED",
  "WARM",
  "APPOINTMENT",
  "VIEWED",
  "LOAN_PROCESSING",
  "BOOKING",
  "SPA_SIGNED",
  "WON",
  "LOST",
]);

export const LEAD_TEMPERATURES = Object.freeze(["HOT", "WARM", "COLD", "NURTURE", "STOP"]);

export const OPPORTUNITY_TRIGGERS = Object.freeze([
  "MEANINGFUL_REPLY",
  "QUALIFIED_CALL",
  "CLEAR_NEED",
  "APPOINTMENT_DISCUSSION",
  "MANUAL_PROMOTION",
]);

export const FOLLOW_UP_TASK_TYPES = Object.freeze([
  "REPLY_CUSTOMER",
  "WARM_LEAD_FOLLOW_UP",
  "SNOOZE_DUE",
  "CONFIRM_APPOINTMENT",
  "POST_VIEWING_FOLLOW_UP",
  "CHECK_LOAN",
  "CHECK_BOOKING",
  "UPDATE_SPA",
  "TRANSACTION",
  "MANUAL",
]);

const STAGE_INDEX = new Map(SALES_STAGES.map((stage, index) => [stage, index]));
const AUTOMATIC_TRANSITIONS = new Set([
  "NEW:CONTACTED",
  "NEW:REPLIED",
  "CONTACTED:REPLIED",
]);

function clean(value) {
  return String(value ?? "").trim();
}

function upper(value) {
  return clean(value).replace(/[\s-]+/g, "_").toUpperCase();
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function normalizeSalesStage(value, fallback = "NEW") {
  const stage = upper(value);
  return STAGE_INDEX.has(stage) ? stage : fallback;
}

export function normalizeLeadTemperature(value, fallback = "COLD") {
  const temperature = upper(value);
  return LEAD_TEMPERATURES.includes(temperature) ? temperature : fallback;
}

export function decideStageTransition({
  from,
  to,
  source = "human",
  reason = "",
  lostReason = "",
  allowBackward = false,
} = {}) {
  const current = normalizeSalesStage(from);
  const next = normalizeSalesStage(to, "");
  if (!next) return { allowed: false, code: "SALES_STAGE_INVALID", reason: "Unknown sales stage." };
  if (current === next) return { allowed: true, code: "SALES_STAGE_UNCHANGED", from: current, to: next, requiresHuman: false };
  if (next === "LOST" && !clean(lostReason)) {
    return { allowed: false, code: "LOST_REASON_REQUIRED", reason: "Moving an opportunity to Lost requires a reason." };
  }
  if (current === "WON" && next !== "WON") {
    return { allowed: false, code: "WON_STAGE_TERMINAL", reason: "Won cannot be reopened without a separate correction workflow." };
  }
  if (current === "LOST" && next !== "LOST" && !allowBackward) {
    return { allowed: false, code: "LOST_REOPEN_REASON_REQUIRED", reason: "Reopening a Lost opportunity requires an explicit correction reason." };
  }
  const currentIndex = STAGE_INDEX.get(current);
  const nextIndex = STAGE_INDEX.get(next);
  const isBackward = next !== "LOST" && nextIndex < currentIndex;
  if (isBackward && (!allowBackward || !clean(reason))) {
    return { allowed: false, code: "STAGE_BACKWARD_REASON_REQUIRED", reason: "A backward stage correction requires an explicit reason." };
  }
  const automatic = upper(source) === "SYSTEM";
  if (automatic && !AUTOMATIC_TRANSITIONS.has(`${current}:${next}`)) {
    return { allowed: false, code: "HUMAN_CONFIRMATION_REQUIRED", reason: `${current} → ${next} requires human confirmation.` };
  }
  return {
    allowed: true,
    code: isBackward ? "STAGE_CORRECTION_ALLOWED" : "STAGE_TRANSITION_ALLOWED",
    from: current,
    to: next,
    requiresHuman: !AUTOMATIC_TRANSITIONS.has(`${current}:${next}`),
    isBackward,
  };
}

export function shouldCreateOpportunity({ trigger, hasOpportunity = false } = {}) {
  const normalized = upper(trigger);
  return {
    create: !hasOpportunity && OPPORTUNITY_TRIGGERS.includes(normalized),
    trigger: normalized,
    reason: OPPORTUNITY_TRIGGERS.includes(normalized)
      ? "Lead supplied qualified buying intent evidence."
      : "Imported or contacted records alone do not create an opportunity.",
  };
}

export function calculateCommission({
  propertyValue,
  commissionRatePercent,
  teamSplitPercent = 100,
  probabilityPercent = 100,
  actualCommission = null,
} = {}) {
  const value = Math.max(0, finiteNumber(propertyValue));
  const rate = Math.max(0, finiteNumber(commissionRatePercent));
  const split = Math.min(100, Math.max(0, finiteNumber(teamSplitPercent, 100)));
  const probability = Math.min(100, Math.max(0, finiteNumber(probabilityPercent, 100)));
  const grossCommission = value * rate / 100;
  const agentCommission = grossCommission * split / 100;
  const expectedCommission = agentCommission * probability / 100;
  const actual = actualCommission === null || actualCommission === "" ? null : Math.max(0, finiteNumber(actualCommission));
  return {
    propertyValue: value,
    commissionRatePercent: rate,
    grossCommission: Number(grossCommission.toFixed(2)),
    teamSplitPercent: split,
    probabilityPercent: probability,
    expectedCommission: Number(expectedCommission.toFixed(2)),
    actualCommission: actual === null ? null : Number(actual.toFixed(2)),
    formula: "property_value × commission_rate × team_split × probability",
  };
}

export function scoreFollowUpPriority({
  overdueHours = 0,
  temperature = "COLD",
  stage = "NEW",
  explicitCommitment = false,
  expectedCommission = 0,
  stopOrRisk = false,
} = {}) {
  if (stopOrRisk || normalizeLeadTemperature(temperature) === "STOP") {
    return { score: 0, label: "LOW", blocked: true };
  }
  const normalizedTemperature = normalizeLeadTemperature(temperature);
  const normalizedStage = normalizeSalesStage(stage);
  const temperatureScore = { HOT: 30, WARM: 20, NURTURE: 6, COLD: 4 }[normalizedTemperature] || 0;
  const stageScore = {
    NEW: 2, CONTACTED: 4, REPLIED: 10, QUALIFIED: 14, WARM: 18,
    APPOINTMENT: 22, VIEWED: 24, LOAN_PROCESSING: 26, BOOKING: 30,
    SPA_SIGNED: 32, WON: 0, LOST: 0,
  }[normalizedStage] || 0;
  const urgencyScore = Math.min(30, Math.max(0, finiteNumber(overdueHours)) / 2);
  const commitmentScore = explicitCommitment ? 15 : 0;
  const commissionScore = Math.min(15, Math.max(0, finiteNumber(expectedCommission)) / 1000);
  const score = Math.round(temperatureScore + stageScore + urgencyScore + commitmentScore + commissionScore);
  return {
    score,
    label: score >= 70 ? "CRITICAL" : score >= 45 ? "HIGH" : score >= 20 ? "MEDIUM" : "LOW",
    blocked: false,
  };
}

export function legacyStatusForStage(stage) {
  return ({ LOAN_PROCESSING: "LOAN", SPA_SIGNED: "SPA" })[normalizeSalesStage(stage)] || normalizeSalesStage(stage);
}
