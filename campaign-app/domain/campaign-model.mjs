export const CAMPAIGN_OBJECTIVES = Object.freeze([
  "REACTIVATE_OLD_LEADS",
  "LAUNCH_NEW_PROJECT",
  "FOLLOW_UP_WARM_LEADS",
  "INVITE_TO_SHOWROOM",
  "RECOVER_MISSED_FOLLOW_UPS",
  "PROMOTE_SPECIFIC_UNIT_TYPE",
  "CALL_LIST_ONLY",
  "MANUAL_FOLLOW_UP_ONLY",
]);

export const CAMPAIGN_STATUSES = Object.freeze(["DRAFT", "TESTING", "SCHEDULED", "ACTIVE", "PAUSED", "COMPLETED", "CANCELLED"]);
export const CAMPAIGN_RUN_STATUSES = Object.freeze(["DRAFT", "TESTING", "QUEUED", "RUNNING", "PAUSED", "INTERRUPTED", "COMPLETED", "FAILED", "CANCELLED"]);
export const CAMPAIGN_MEMBER_STATUSES = Object.freeze(["PENDING", "ACTIVE", "COMPLETED", "PAUSED_REPLY", "PAUSED_SNOOZE", "EXIT_STOP", "EXIT_APPOINTMENT", "EXIT_BOOKED", "FAILED"]);
export const CAMPAIGN_OUTCOME_TYPES = Object.freeze(["REPLY", "WARM", "APPOINTMENT", "VIEWING", "LOAN", "BOOKING", "SPA", "COMMISSION"]);
export const CAMPAIGN_CHANNELS = Object.freeze(["WHATSAPP", "CALL", "MANUAL"]);

const ACTIVE_MEMBER_STATUSES = new Set(["PENDING", "ACTIVE", "PAUSED_REPLY", "PAUSED_SNOOZE"]);

function upper(value) {
  return String(value ?? "").trim().replace(/[\s-]+/g, "_").toUpperCase();
}

export function normalizeCampaignObjective(value, fallback = "") {
  const objective = upper(value);
  return CAMPAIGN_OBJECTIVES.includes(objective) ? objective : fallback;
}

export function normalizeCampaignStatus(value, fallback = "") {
  const status = upper(value);
  return CAMPAIGN_STATUSES.includes(status) ? status : fallback;
}

export function normalizeCampaignRunStatus(value, fallback = "") {
  const status = upper(value);
  if (status === "STOPPED") return "CANCELLED";
  if (status === "PARTIAL") return "INTERRUPTED";
  if (status === "SUCCEEDED") return "COMPLETED";
  return CAMPAIGN_RUN_STATUSES.includes(status) ? status : fallback;
}

export function normalizeCampaignMemberStatus(value, fallback = "") {
  const status = upper(value);
  return CAMPAIGN_MEMBER_STATUSES.includes(status) ? status : fallback;
}

export function validateCampaignDraft(input = {}) {
  const name = String(input.name ?? "").trim();
  const projectId = String(input.projectId ?? input.projectCode ?? "").trim();
  const objective = normalizeCampaignObjective(input.objective);
  const channel = upper(input.channel || "WHATSAPP");
  const errors = [];
  if (!name) errors.push({ field: "name", code: "CAMPAIGN_NAME_REQUIRED" });
  if (!projectId) errors.push({ field: "projectId", code: "CAMPAIGN_PROJECT_REQUIRED" });
  if (!objective) errors.push({ field: "objective", code: "CAMPAIGN_OBJECTIVE_INVALID" });
  if (!CAMPAIGN_CHANNELS.includes(channel)) errors.push({ field: "channel", code: "CAMPAIGN_CHANNEL_INVALID" });
  return { valid: errors.length === 0, errors, value: { name, projectId, objective, channel } };
}

export function decideMemberTransition({ from, event } = {}) {
  const current = normalizeCampaignMemberStatus(from, "PENDING");
  const action = upper(event);
  if (["EXIT_STOP", "EXIT_BOOKED", "EXIT_APPOINTMENT", "COMPLETED", "FAILED"].includes(current)) {
    return { allowed: false, from: current, to: current, code: "CAMPAIGN_MEMBER_TERMINAL" };
  }
  const to = ({
    ACTIVATE: "ACTIVE",
    STEP_COMPLETED: "ACTIVE",
    CAMPAIGN_COMPLETED: "COMPLETED",
    REPLY: "PAUSED_REPLY",
    SNOOZE: "PAUSED_SNOOZE",
    RESUME: "ACTIVE",
    GLOBAL_STOP: "EXIT_STOP",
    APPOINTMENT: "EXIT_APPOINTMENT",
    BOOKING: "EXIT_BOOKED",
    FAILURE: "FAILED",
  })[action];
  if (!to) return { allowed: false, from: current, to: current, code: "CAMPAIGN_MEMBER_EVENT_INVALID" };
  return { allowed: true, from: current, to, code: "CAMPAIGN_MEMBER_TRANSITION_ALLOWED", terminal: !ACTIVE_MEMBER_STATUSES.has(to) };
}

export function decideOutcomeAttribution({ memberStatus, activityAt, outcomeAt, attributionWindowDays = 30, humanOverride = false } = {}) {
  if (humanOverride) return { attributed: true, method: "HUMAN_OVERRIDE", code: "ATTRIBUTION_HUMAN_OVERRIDE" };
  const status = normalizeCampaignMemberStatus(memberStatus);
  if (!status || ["EXIT_STOP", "FAILED"].includes(status)) return { attributed: false, method: "", code: "MEMBER_NOT_ATTRIBUTABLE" };
  const activityMs = new Date(activityAt || "").getTime();
  const outcomeMs = new Date(outcomeAt || "").getTime();
  if (!Number.isFinite(activityMs) || !Number.isFinite(outcomeMs) || outcomeMs < activityMs) {
    return { attributed: false, method: "", code: "ACTIVITY_PRECEDENCE_REQUIRED" };
  }
  const windowMs = Math.max(1, Number(attributionWindowDays) || 30) * 86400000;
  if (outcomeMs - activityMs > windowMs) return { attributed: false, method: "", code: "ATTRIBUTION_WINDOW_EXPIRED" };
  return { attributed: true, method: "LAST_CAMPAIGN_ACTIVITY", code: "ATTRIBUTION_ALLOWED" };
}

export function calculateCampaignMetrics(input = {}) {
  const members = Math.max(0, Number(input.members) || 0);
  const value = (key) => Math.max(0, Number(input[key]) || 0);
  const rate = (count) => members ? Number(((count / members) * 100).toFixed(2)) : 0;
  return {
    members,
    eligible: value("eligible"), sent: value("sent"), delivered: value("delivered"), replied: value("replied"),
    warm: value("warm"), appointments: value("appointments"), viewings: value("viewings"), bookings: value("bookings"), spa: value("spa"),
    expectedCommission: value("expectedCommission"), actualCommission: value("actualCommission"), stop: value("stop"), invalid: value("invalid"), failures: value("failures"),
    replyRate: rate(value("replied")), warmRate: rate(value("warm")), appointmentRate: rate(value("appointments")),
    bookingRate: rate(value("bookings")), spaRate: rate(value("spa")), revenuePerLead: members ? Number((value("actualCommission") / members).toFixed(2)) : 0,
  };
}
