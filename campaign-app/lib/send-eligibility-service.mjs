import { decideSendEligibility, SEND_ACTIONS } from "../domain/send-eligibility.mjs";

function clean(value) {
  return String(value ?? "").trim();
}

function deniedError(decision) {
  const error = new Error(decision.reason);
  error.code = "SEND_ELIGIBILITY_BLOCKED";
  error.reasonCode = decision.reason_code;
  error.retryAt = decision.retry_at;
  error.requiredAction = decision.required_action;
  error.decision = decision;
  error.retryable = ["CONNECTION_UNAVAILABLE", "OUTSIDE_CAMPAIGN_SCHEDULE", "DUPLICATE_PENDING_SEND", "SNOOZED"].includes(decision.reason_code);
  return error;
}

export function createSendEligibilityService({ repository, clock = () => new Date(), activityObserver = null } = {}) {
  if (!repository) throw new Error("Send Eligibility repository is required.");

  async function observe(operation, payload) {
    const handler = activityObserver?.[operation];
    if (typeof handler !== "function") return null;
    try {
      return await handler(payload);
    } catch (error) {
      // Sales tracking is reconciliable from the message ledger. A confirmed
      // provider result must never become retryable because its CRM projection failed.
      await activityObserver?.onError?.({ operation, error, payload }).catch(() => {});
      return { error: error.message, code: error.code || "SALES_ACTIVITY_RECORD_FAILED" };
    }
  }

  async function check({
    recipient = {},
    projectLead = {},
    campaignMember = {},
    campaign = {},
    connection = {},
    requestedAction = SEND_ACTIONS.FLOW_SEQUENCE,
  } = {}) {
    const context = await repository.loadContext({
      phone: recipient.phone,
      customerId: recipient.customerId,
      projectCode: projectLead.projectCode || campaign.projectCode || campaign.projectId,
      runId: campaign.runId,
      campaignId: campaign.campaignId || campaign.id,
      connectionKey: connection.connectionKey,
      instanceName: connection.instanceName,
      flowTopic: campaign.flowTopic,
      resendCooldownDays: campaign.resendCooldownDays,
      ignoreLockToken: recipient.activeLockToken,
    });
    if (campaign.mode === "TEST" && !recipient.customerId) {
      // TEST recipients are centrally configured safety fixtures, not CRM customers.
      // They still receive connection/schedule/lock checks and a complete audit row.
      context.customer.identityValid = true;
      context.customer.globalStatus = "ACTIVE";
    }
    const mergedContext = {
      ...context,
      projectLead: { ...context.projectLead, ...projectLead },
      campaignMember: { ...context.campaignMember, ...campaignMember },
      connection: {
        ...context.connection,
        ...connection,
        available: connection.available === undefined ? context.connection.available : connection.available,
      },
    };
    await repository.ensureMembership({
      recipientKey: mergedContext.recipientKey,
      customerId: mergedContext.customer.customerId,
      projectLeadKey: mergedContext.projectLead.projectLeadKey,
      campaignId: campaign.campaignId || campaign.id,
      runId: campaign.runId,
    });
    const evaluatedAt = clock().toISOString();
    const decision = decideSendEligibility({
      customer: mergedContext.customer,
      projectLead: mergedContext.projectLead,
      campaignMember: mergedContext.campaignMember,
      campaign,
      connection: mergedContext.connection,
      now: clock(),
      requestedAction,
    });
    const decisionId = await repository.recordDecision({ decision, context: mergedContext, campaign, requestedAction, evaluatedAt });
    if (!decision.allowed) {
      await repository.recordBlockedOutcome({ context: mergedContext, campaign, reasonCode: decision.reason_code });
    }
    return { ...decision, decision_id: decisionId, context: mergedContext, evaluated_at: evaluatedAt };
  }

  async function assertAllowed(options) {
    const decision = await check(options);
    if (!decision.allowed) throw deniedError(decision);
    return decision;
  }

  async function withSendLock(options, send) {
    const first = await assertAllowed(options);
    const lock = await repository.acquireLock({
      context: first.context,
      campaign: options.campaign,
      jobId: options.jobId,
      ttlMs: options.lockTtlMs,
    });
    if (!lock) {
      const blocked = await check(options);
      if (blocked.allowed) {
        blocked.allowed = false;
        blocked.reason_code = "DUPLICATE_PENDING_SEND";
        blocked.reason = "Another send acquired the customer lock first.";
        blocked.required_action = "WAIT_FOR_ACTIVE_SEND";
      }
      throw deniedError(blocked);
    }
    try {
      const second = await assertAllowed({
        ...options,
        campaignMember: { ...(options.campaignMember || {}), duplicatePending: false },
        recipient: { ...(options.recipient || {}), activeLockToken: lock.token },
      });
      const result = await send({ decision: second, lock });
      await observe("onSendConfirmed", { options, decision: second, result });
      return result;
    } finally {
      try {
        await repository.releaseLock(lock.token);
      } catch {
        // A confirmed provider result must never become retryable because lock
        // cleanup failed. The bounded TTL safely expires this lock instead.
      }
    }
  }

  async function previewAssignments(assignments = [], { campaign = {}, requestedAction = SEND_ACTIONS.BULK_IMPORT_PREVIEW } = {}) {
    const decisions = [];
    for (const job of assignments) {
      const decision = await check({
        recipient: { phone: job?.lead?.phone, customerId: job?.lead?.customerId },
        projectLead: { projectCode: job?.lead?.projectCode || campaign.projectCode || campaign.projectId },
        campaign,
        connection: { instanceName: job?.instanceName, available: true },
        requestedAction,
      });
      decisions.push({
        jobId: job?.id || "",
        allowed: decision.allowed,
        reasonCode: decision.reason_code,
        reason: decision.reason,
        retryAt: decision.retry_at,
        requiredAction: decision.required_action,
      });
    }
    const byReason = {};
    for (const item of decisions) byReason[item.reasonCode] = (byReason[item.reasonCode] || 0) + 1;
    return {
      selected: decisions.length,
      eligible: decisions.filter((item) => item.allowed).length,
      blocked: decisions.filter((item) => !item.allowed).length,
      byReason,
      decisions,
    };
  }

  function requestedActionForRunner({ state, job } = {}) {
    if (job?.retryCount > 0) return SEND_ACTIONS.RETRY_FAILED_SEND;
    if (state?.resumeSession) return SEND_ACTIONS.RESTART_RECOVERY;
    const flow = clean(state?.flowLabel || state?.templateFlow);
    if (state?.dailyCampaign === true) return SEND_ACTIONS.DAILY_CAMPAIGN;
    return /flow\s*1\b/i.test(flow) || !flow ? SEND_ACTIONS.FLOW_1 : SEND_ACTIONS.FLOW_SEQUENCE;
  }

  return {
    check,
    assertAllowed,
    withSendLock,
    previewAssignments,
    requestedActionForRunner,
    propagateStop: (input) => repository.propagateStop(input),
    propagateReply: async (input) => {
      const result = await repository.propagateReply(input);
      await observe("onMeaningfulReply", { input, result });
      return result;
    },
    snooze: (input) => repository.snooze(input),
    listDecisions: (input) => repository.listDecisions(input),
    schemaStatus: () => repository.schemaStatus(),
  };
}

export { SEND_ACTIONS };
