export const REFRESH_COOLDOWN_DAYS = Object.freeze([14, 21, 30]);
export const DEFAULT_REFRESH_COOLDOWN_DAYS = 14;
export const REFRESH_TEMPLATE_FLOW = "Refresh - Reconnect";

export const REFRESH_EXCLUSION = Object.freeze({
  INVALID_PHONE: "INVALID_PHONE",
  DUPLICATE_PHONE: "DUPLICATE_PHONE",
  NEVER_BLASTED: "NEVER_BLASTED",
  TOO_RECENT: "TOO_RECENT",
  STOPPED: "STOPPED",
  NOT_INTERESTED: "NOT_INTERESTED",
  REPLIED: "REPLIED",
  FOLLOWED_UP: "FOLLOWED_UP",
  PRIVATE_CONTACT: "PRIVATE_CONTACT",
  ACTIVE_CAMPAIGN: "ACTIVE_CAMPAIGN",
  CLOSED_OR_APPOINTMENT: "CLOSED_OR_APPOINTMENT",
});

function text(value) {
  return String(value || "").trim().toLowerCase();
}

function timestamp(value) {
  const time = new Date(value || "").getTime();
  return Number.isFinite(time) ? time : null;
}

function latestIso(...values) {
  const valid = values.map((value) => ({ value, time: timestamp(value) }))
    .filter((item) => item.time !== null)
    .sort((left, right) => right.time - left.time);
  return valid[0]?.value || null;
}

export function normalizeRefreshCooldownDays(value) {
  const days = Number(value);
  return REFRESH_COOLDOWN_DAYS.includes(days) ? days : DEFAULT_REFRESH_COOLDOWN_DAYS;
}

function isNotInterested(record) {
  return [record.status, record.sequenceStatus, record.aiCategory, record.nextAction]
    .map(text)
    .some((value) => (
      value.includes("not interested")
      || value.includes("not_interested")
      || value.includes("不感兴趣")
    ));
}

function isStopped(record) {
  if (record.stopFlag === true) return true;
  return [record.status, record.sequenceStatus]
    .map(text)
    .some((value) => (
      value === "stop"
      || value === "stopped"
      || value.includes("do not contact")
      || value.includes("suppressed")
    ));
}

function hasReply(record, activity) {
  return Number(record.replyCount || 0) > 0
    || Boolean(record.lastReplyAt)
    || Boolean(String(record.lastReplyText || "").trim())
    || Boolean(activity?.lastInboundAt);
}

function hasBeenFollowedUp(record, activity) {
  const lastFlow = text(record.lastFlowSent);
  const nextAction = text(record.nextAction);
  const sequence = text(record.sequenceStatus);
  const followedFlow = Boolean(lastFlow)
    && !lastFlow.includes("flow 1")
    && !lastFlow.includes("project template");
  const assignedAction = Boolean(nextAction)
    && !["no action", "none", "无", "无需行动"].includes(nextAction);
  return Boolean(
    followedFlow
    || sequence === "completed"
    || sequence === "closed"
    || record.followUpAt
    || activity?.lastNonBlastOutboundAt
    || assignedAction
  );
}

function hasClosedOutcome(record) {
  const values = [
    record.status,
    record.sequenceStatus,
    record.aiCategory,
    record.appointmentStatus,
  ].map(text);
  return Boolean(
    record.appointmentDate
    || values.some((value) => (
      value.includes("appointment")
      || value.includes("booked")
      || value.includes("converted")
      || value.includes("closed")
      || value.includes("invalid")
    ))
  );
}

function excluded(reason, detail = "") {
  return { eligible: false, reason, detail };
}

export function evaluateRefreshLead(record, {
  phone,
  now = new Date(),
  cooldownDays = DEFAULT_REFRESH_COOLDOWN_DAYS,
  suppressedPhones = new Set(),
  privatePhones = new Set(),
  activePhones = new Set(),
  activity = null,
  seenPhones = new Set(),
} = {}) {
  if (!phone) return excluded(REFRESH_EXCLUSION.INVALID_PHONE);
  if (seenPhones.has(phone)) return excluded(REFRESH_EXCLUSION.DUPLICATE_PHONE);
  seenPhones.add(phone);

  if (suppressedPhones.has(phone) || isStopped(record)) {
    return excluded(REFRESH_EXCLUSION.STOPPED, record.stopReason || "");
  }
  if (isNotInterested(record)) return excluded(REFRESH_EXCLUSION.NOT_INTERESTED);
  if (privatePhones.has(phone)) return excluded(REFRESH_EXCLUSION.PRIVATE_CONTACT);
  if (activePhones.has(phone)) return excluded(REFRESH_EXCLUSION.ACTIVE_CAMPAIGN);
  if (hasReply(record, activity)) return excluded(REFRESH_EXCLUSION.REPLIED);
  if (hasBeenFollowedUp(record, activity)) return excluded(REFRESH_EXCLUSION.FOLLOWED_UP);
  if (hasClosedOutcome(record)) return excluded(REFRESH_EXCLUSION.CLOSED_OR_APPOINTMENT);

  const lastBlastAt = latestIso(record.lastBlastAt, record.firstBlastAt, activity?.lastBlastAt);
  const lastBlastMs = timestamp(lastBlastAt);
  if (lastBlastMs === null) return excluded(REFRESH_EXCLUSION.NEVER_BLASTED);

  const days = normalizeRefreshCooldownDays(cooldownDays);
  const cutoffMs = now.getTime() - days * 24 * 60 * 60 * 1000;
  if (lastBlastMs > cutoffMs) {
    return excluded(REFRESH_EXCLUSION.TOO_RECENT, lastBlastAt);
  }

  return {
    eligible: true,
    reason: null,
    lastBlastAt,
    ageDays: Math.max(0, Math.floor((now.getTime() - lastBlastMs) / (24 * 60 * 60 * 1000))),
  };
}

export function summarizeRefreshExclusions(items = []) {
  const counts = {};
  for (const item of items) {
    if (!item?.reason) continue;
    counts[item.reason] = (counts[item.reason] || 0) + 1;
  }
  return counts;
}
