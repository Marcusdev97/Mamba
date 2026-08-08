const GLOBAL_STATUSES = new Set(["ACTIVE", "STOP", "INVALID", "WON", "LOST", "MERGED"]);

export const SEND_ACTIONS = Object.freeze({
  FLOW_1: "FLOW_1",
  FLOW_SEQUENCE: "FLOW_SEQUENCE",
  CAMPAIGN_QUEUE: "CAMPAIGN_QUEUE",
  DAILY_CAMPAIGN: "DAILY_CAMPAIGN",
  MANUAL_CONTINUE: "MANUAL_CONTINUE",
  RESTART_RECOVERY: "RESTART_RECOVERY",
  RETRY_FAILED_SEND: "RETRY_FAILED_SEND",
  SCHEDULED_FOLLOW_UP: "SCHEDULED_FOLLOW_UP",
  AI_PROPOSED_SEND: "AI_PROPOSED_SEND",
  AI_APPROVED_REPLY: "AI_APPROVED_REPLY",
  MANUAL_INBOX_REPLY: "MANUAL_INBOX_REPLY",
  MANUAL_APPOINTMENT_CONFIRMATION: "MANUAL_APPOINTMENT_CONFIRMATION",
  MOBILE_TEMPLATE_PREVIEW: "MOBILE_TEMPLATE_PREVIEW",
  BULK_IMPORT_PREVIEW: "BULK_IMPORT_PREVIEW",
});

const AUTOMATED_MARKETING_ACTIONS = new Set([
  SEND_ACTIONS.FLOW_1,
  SEND_ACTIONS.FLOW_SEQUENCE,
  SEND_ACTIONS.CAMPAIGN_QUEUE,
  SEND_ACTIONS.DAILY_CAMPAIGN,
  SEND_ACTIONS.MANUAL_CONTINUE,
  SEND_ACTIONS.RESTART_RECOVERY,
  SEND_ACTIONS.RETRY_FAILED_SEND,
  SEND_ACTIONS.SCHEDULED_FOLLOW_UP,
  SEND_ACTIONS.AI_PROPOSED_SEND,
  SEND_ACTIONS.BULK_IMPORT_PREVIEW,
]);

const CAMPAIGN_EXIT_STATUSES = new Set([
  "EXIT_STOP",
  "EXIT_APPOINTMENT",
  "EXIT_BOOKED",
  "COMPLETED",
  "FAILED",
]);

function clean(value) {
  return String(value ?? "").trim();
}

function upperStatus(value, fallback = "") {
  const status = clean(value).replace(/[\s-]+/g, "_").toUpperCase();
  return status || fallback;
}

function validDate(value) {
  const milliseconds = new Date(value || "").getTime();
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function result(allowed, reasonCode, reason, { retryAt = null, requiredAction = null } = {}) {
  return {
    allowed,
    reason_code: reasonCode,
    reason,
    retry_at: retryAt,
    required_action: requiredAction,
  };
}

export function normalizeGlobalCustomerStatus(value) {
  const normalized = upperStatus(value, "ACTIVE");
  return GLOBAL_STATUSES.has(normalized) ? normalized : "ACTIVE";
}

export function isAutomatedMarketingAction(requestedAction) {
  return AUTOMATED_MARKETING_ACTIONS.has(upperStatus(requestedAction));
}

export function decideSendEligibility({
  customer = {},
  projectLead = {},
  campaignMember = {},
  campaign = {},
  connection = {},
  now = new Date(),
  requestedAction = SEND_ACTIONS.FLOW_SEQUENCE,
} = {}) {
  const action = upperStatus(requestedAction, SEND_ACTIONS.FLOW_SEQUENCE);
  const globalStatus = normalizeGlobalCustomerStatus(customer.globalStatus ?? customer.status);
  const leadStatus = upperStatus(projectLead.status);
  const sequenceStatus = upperStatus(projectLead.sequenceStatus);
  const memberStatus = upperStatus(campaignMember.status, "PENDING");
  const isMarketing = isAutomatedMarketingAction(action);
  const nowMs = validDate(now) ?? Date.now();

  // Identity ambiguity is checked before every business status because sending
  // to the wrong physical person cannot be repaired by a later suppression check.
  if (globalStatus === "MERGED" || customer.mergedIntoCustomerId || customer.identityValid === false) {
    return result(false, "CUSTOMER_IDENTITY_INVALID", "Customer identity is merged, unresolved, or invalid.", {
      requiredAction: "RESOLVE_CUSTOMER_IDENTITY",
    });
  }
  if (globalStatus === "STOP" || customer.stopFlag === true || customer.isSuppressed === true) {
    return result(false, "GLOBAL_STOP", "Customer is globally suppressed from outbound contact.", {
      requiredAction: "KEEP_SUPPRESSED",
    });
  }
  if (globalStatus === "INVALID" || customer.phoneValid === false) {
    return result(false, "INVALID_NUMBER", "Customer does not have a valid sendable phone number.", {
      requiredAction: "CORRECT_CUSTOMER_NUMBER",
    });
  }
  if (isMarketing && (["BOOKING", "SPA", "WON"].includes(leadStatus) || globalStatus === "WON")) {
    return result(false, "CUSTOMER_CONVERTED", "Customer has reached Booking, SPA, or Won for this project.", {
      requiredAction: "USE_TRANSACTION_FOLLOW_UP",
    });
  }
  if (isMarketing && (projectLead.requiresHandoff === true
    || leadStatus === "REPLIED"
    || ["HUMAN_TAKEOVER", "PAUSED_REPLY"].includes(sequenceStatus)
    || memberStatus === "PAUSED_REPLY")) {
    return result(false, "CUSTOMER_REPLIED", "Customer replied and requires human follow-up.", {
      requiredAction: "HANDOFF_TO_AGENT",
    });
  }

  const snoozeMs = validDate(projectLead.snoozeUntil);
  if (isMarketing && snoozeMs !== null && snoozeMs > nowMs) {
    return result(false, "SNOOZED", "Customer is snoozed until the confirmed follow-up time.", {
      retryAt: new Date(snoozeMs).toISOString(),
      requiredAction: "WAIT_FOR_DUE_TASK",
    });
  }
  if (isMarketing && (leadStatus === "APPOINTMENT"
    || ["PENDING", "CONFIRMED", "DONE"].includes(upperStatus(projectLead.appointmentStatus)))) {
    return result(false, "APPOINTMENT_EXISTS", "An appointment exists; generic marketing is paused.", {
      requiredAction: "USE_APPOINTMENT_FOLLOW_UP",
    });
  }
  if (isMarketing && CAMPAIGN_EXIT_STATUSES.has(memberStatus)) {
    return result(false, "CAMPAIGN_MEMBER_EXITED", "Campaign membership has already exited this sequence.", {
      requiredAction: "REVIEW_CAMPAIGN_MEMBERSHIP",
    });
  }
  if (customer.duplicatePending === true || campaignMember.duplicatePending === true) {
    return result(false, "DUPLICATE_PENDING_SEND", "Another send or active lock already exists for this customer.", {
      retryAt: customer.lockExpiresAt || campaignMember.lockExpiresAt || null,
      requiredAction: "WAIT_FOR_ACTIVE_SEND",
    });
  }
  if (customer.recentFlowAlreadySent === true) {
    return result(false, "RECENT_FLOW_ALREADY_SENT", "Customer already received this flow inside the resend guard window.", {
      retryAt: customer.resendEligibleAt || null,
      requiredAction: "WAIT_OR_CHOOSE_ANOTHER_FLOW",
    });
  }
  if (action === SEND_ACTIONS.AI_PROPOSED_SEND) {
    return result(false, "AI_APPROVAL_REQUIRED", "AI may propose a reply but cannot send it directly.", {
      requiredAction: "HUMAN_APPROVAL",
    });
  }
  if (connection.available === false) {
    return result(false, "CONNECTION_UNAVAILABLE", "The selected WhatsApp connection is not available.", {
      retryAt: connection.retryAt || null,
      requiredAction: "RESTORE_CONNECTION",
    });
  }

  const isPreview = action === SEND_ACTIONS.BULK_IMPORT_PREVIEW;
  const startMs = validDate(campaign.startAt ?? campaign.startsAt);
  const endMs = validDate(campaign.endAt ?? campaign.endsAt);
  if (!isPreview && ((startMs !== null && nowMs < startMs) || (endMs !== null && nowMs > endMs))) {
    return result(false, "OUTSIDE_CAMPAIGN_SCHEDULE", "Campaign is outside its approved sending schedule.", {
      retryAt: startMs !== null && nowMs < startMs ? new Date(startMs).toISOString() : null,
      requiredAction: "WAIT_FOR_APPROVED_WINDOW",
    });
  }

  return result(true, "ELIGIBLE", "Customer is eligible for the requested send action.");
}
