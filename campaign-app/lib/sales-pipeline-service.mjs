import {
  calculateCommission,
  decideStageTransition,
  FOLLOW_UP_TASK_TYPES,
  legacyStatusForStage,
  normalizeLeadTemperature,
  normalizeSalesStage,
  OPPORTUNITY_TRIGGERS,
  scoreFollowUpPriority,
  shouldCreateOpportunity,
} from "../domain/sales-pipeline.mjs";

const COMMISSION_STATUSES = new Set(["NOT_EXPECTED", "EXPECTED", "INVOICED", "PARTIAL", "PAID", "CANCELLED"]);
const FIELD_MAP = Object.freeze({
  temperature: "temperature",
  buyingPurpose: "buying_purpose",
  budgetMin: "budget_min",
  budgetMax: "budget_max",
  preferredArea: "preferred_area",
  preferredPropertyType: "preferred_property_type",
  roomRequirement: "room_requirement",
  tenurePreference: "tenure_preference",
  transportRequirement: "transport_requirement",
  buyingTimeline: "buying_timeline",
  mainObjection: "main_objection",
  decisionMaker: "decision_maker",
  loanReadiness: "loan_readiness",
  currentPropertyOwnership: "current_property_ownership",
  nextAction: "next_action",
  nextFollowUpAt: "next_follow_up_at",
  assignedAgent: "assigned_agent",
  lostReason: "lost_reason",
  appointmentAt: "appointment_at",
  viewingCompletedAt: "viewing_completed_at",
  loanUpdatedAt: "loan_updated_at",
});

function clean(value) {
  return String(value ?? "").trim();
}

function canonicalMessageEvent(value) {
  return clean(value).replace(/^(?:brain|tracker|morning|server)-reply:/, "");
}

function dateMs(value) {
  const milliseconds = new Date(value || "").getTime();
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function iso(value, field, { future = false } = {}) {
  if (value === null || value === undefined || value === "") return null;
  const milliseconds = dateMs(value);
  if (milliseconds === null) throw Object.assign(new Error(`${field} 不是有效日期时间。`), { code: "SALES_DATE_INVALID" });
  if (future && milliseconds <= Date.now()) throw Object.assign(new Error(`${field} 必须是未来时间。`), { code: "SALES_DATE_NOT_FUTURE" });
  return new Date(milliseconds).toISOString();
}

function requiredLead(lead) {
  if (lead) return lead;
  const error = new Error("找不到对应的 Project Lead。请先完成 Customer Identity 和 Project 归属。 ");
  error.code = "SALES_PROJECT_LEAD_NOT_FOUND";
  error.retryable = false;
  throw error;
}

function stageProbability(stage) {
  return ({ REPLIED: 10, QUALIFIED: 25, WARM: 35, APPOINTMENT: 45, VIEWED: 55, LOAN_PROCESSING: 65, BOOKING: 80, SPA_SIGNED: 90, WON: 100, LOST: 0 })[stage] ?? 10;
}

export function createSalesPipelineService({
  repository,
  clock = () => new Date(),
  policy = {},
  outcomeObserver = null,
} = {}) {
  if (!repository) throw new Error("Sales Pipeline repository is required.");
  const thresholds = {
    replyMinutes: Math.max(1, Number(policy.replyMinutes) || 15),
    warmDays: Math.max(1, Number(policy.warmDays) || 7),
    appointmentReminderHours: Math.max(1, Number(policy.appointmentReminderHours) || 24),
    viewingFollowUpHours: Math.max(1, Number(policy.viewingFollowUpHours) || 24),
    loanUpdateDays: Math.max(1, Number(policy.loanUpdateDays) || 3),
  };

  async function observe(operation, payload) {
    const handler = outcomeObserver?.[operation];
    if (typeof handler !== "function") return null;
    try { return await handler(payload); }
    catch (error) {
      await outcomeObserver?.onError?.({ operation, error, payload }).catch(() => {});
      return { error: error.message, code: error.code || "CAMPAIGN_OUTCOME_PROJECTION_FAILED" };
    }
  }

  async function resolve(input = {}) {
    return requiredLead(await repository.resolveLead(input));
  }

  async function transitionStage({
    projectLeadKey,
    customerId,
    phone,
    projectCode,
    toStage,
    source = "human",
    actorId = "operator",
    reason = "",
    lostReason = "",
    allowBackward = false,
    sourceEvent = "",
  } = {}) {
    const lead = await resolve({ projectLeadKey, customerId, phone, projectCode });
    const decision = decideStageTransition({ from: lead.salesStage, to: toStage, source, reason, lostReason, allowBackward });
    if (!decision.allowed) {
      const error = new Error(decision.reason);
      error.code = decision.code;
      error.retryable = false;
      error.decision = decision;
      throw error;
    }
    if (decision.code === "SALES_STAGE_UNCHANGED") return lead;
    const nextTemperature = decision.to === "LOST" ? lead.temperature
      : decision.to === "WON" ? "HOT"
        : null;
    let updated = await repository.applyStage({
      lead,
      toStage: decision.to,
      legacyStatus: legacyStatusForStage(decision.to),
      temperature: nextTemperature,
      lostReason: decision.to === "LOST" ? clean(lostReason) : "",
      actorType: clean(source).toUpperCase() === "SYSTEM" ? "SYSTEM" : clean(source).toUpperCase() === "NOTION" ? "NOTION" : "AGENT",
      actorId,
      reason,
      sourceEvent,
    });
    if (updated.opportunityId || !["NEW", "CONTACTED"].includes(updated.salesStage)) {
      const creation = shouldCreateOpportunity({ trigger: sourceEvent ? "MEANINGFUL_REPLY" : "MANUAL_PROMOTION", hasOpportunity: Boolean(updated.opportunityId) });
      if (creation.create) updated = await repository.createOpportunity({ lead: updated, triggerType: creation.trigger, triggerEventId: sourceEvent, probabilityPercent: stageProbability(updated.salesStage) });
    }
    await observe("onStageChanged", { lead: updated, sourceEvent, occurredAt: clock().toISOString() });
    return updated;
  }

  async function updateLead({ projectLeadKey, customerId, phone, projectCode, fields = {}, actorId = "operator", reason = "", sourceEvent = "" } = {}) {
    let lead = await resolve({ projectLeadKey, customerId, phone, projectCode });
    if (fields.salesStage !== undefined) {
      lead = await transitionStage({
        projectLeadKey: lead.projectLeadKey,
        toStage: fields.salesStage,
        source: "human",
        actorId,
        reason,
        lostReason: fields.lostReason,
        allowBackward: Boolean(fields.allowBackward),
        sourceEvent,
      });
    }
    const mapped = {};
    for (const [input, column] of Object.entries(FIELD_MAP)) {
      if (fields[input] === undefined) continue;
      mapped[column] = fields[input];
    }
    if (mapped.temperature !== undefined) mapped.temperature = normalizeLeadTemperature(mapped.temperature, "");
    if (mapped.temperature === "") throw Object.assign(new Error("Lead temperature 无效。"), { code: "LEAD_TEMPERATURE_INVALID" });
    if (mapped.temperature === "STOP" && clean(lead.globalStatus).toUpperCase() !== "STOP") {
      throw Object.assign(new Error("Temperature STOP 只能由全局 STOP 流程设置；请使用 Do Not Contact。"), { code: "USE_GLOBAL_STOP_WORKFLOW" });
    }
    if (lead.salesStage === "LOST" && mapped.lost_reason !== undefined && !clean(mapped.lost_reason)) {
      throw Object.assign(new Error("Lost Reason 不可以从 Lost opportunity 清空。"), { code: "LOST_REASON_REQUIRED" });
    }
    for (const field of ["budget_min", "budget_max"]) {
      if (mapped[field] === "" || mapped[field] === null) mapped[field] = null;
      else if (mapped[field] !== undefined) {
        mapped[field] = Number(mapped[field]);
        if (!Number.isFinite(mapped[field]) || mapped[field] < 0) throw Object.assign(new Error(`${field} 必须是非负数字。`), { code: "SALES_BUDGET_INVALID" });
      }
    }
    const budgetMin = mapped.budget_min ?? lead.budgetMin;
    const budgetMax = mapped.budget_max ?? lead.budgetMax;
    if (budgetMin !== null && budgetMax !== null && Number(budgetMin) > Number(budgetMax)) {
      throw Object.assign(new Error("Budget Min 不可以高于 Budget Max。"), { code: "SALES_BUDGET_RANGE_INVALID" });
    }
    for (const field of ["next_follow_up_at", "appointment_at", "viewing_completed_at", "loan_updated_at"]) {
      if (mapped[field] !== undefined) mapped[field] = iso(mapped[field], field);
    }
    if (Object.keys(mapped).length) lead = await repository.updateLeadFields({ lead, fields: mapped, actorId, reason, sourceEvent });
    return lead;
  }

  async function promoteOpportunity({ projectLeadKey, customerId, phone, projectCode, trigger = "MANUAL_PROMOTION", sourceEvent = "", actorId = "operator" } = {}) {
    let lead = await resolve({ projectLeadKey, customerId, phone, projectCode });
    const normalizedTrigger = clean(trigger).replace(/[\s-]+/g, "_").toUpperCase();
    if (!OPPORTUNITY_TRIGGERS.includes(normalizedTrigger)) throw Object.assign(new Error("Opportunity trigger 无效。"), { code: "OPPORTUNITY_TRIGGER_INVALID" });
    const decision = shouldCreateOpportunity({ trigger: normalizedTrigger, hasOpportunity: Boolean(lead.opportunityId) });
    if (decision.create) {
      if (["NEW", "CONTACTED"].includes(lead.salesStage)) {
        lead = await transitionStage({ projectLeadKey: lead.projectLeadKey, toStage: normalizedTrigger === "MEANINGFUL_REPLY" ? "REPLIED" : "QUALIFIED", source: "human", actorId, reason: `Opportunity promoted: ${normalizedTrigger}`, sourceEvent });
      }
      lead = await repository.createOpportunity({ lead, triggerType: normalizedTrigger, triggerEventId: sourceEvent, probabilityPercent: stageProbability(lead.salesStage) });
    }
    return lead;
  }

  async function recordOutbound({ projectLeadKey, customerId, phone, projectCode, sourceEvent = "", actorId = "system", occurredAt = null } = {}) {
    let lead = await resolve({ projectLeadKey, customerId, phone, projectCode });
    const at = iso(occurredAt || clock().toISOString(), "occurredAt");
    await repository.recordActivity({
      idempotencyKey: sourceEvent ? `message-sent:${sourceEvent}` : `message-sent:${lead.projectLeadKey}:${at}`,
      customerId: lead.customerId,
      projectLeadKey: lead.projectLeadKey,
      opportunityId: lead.opportunityId,
      activityType: "MESSAGE_SENT",
      actorType: "AGENT",
      actorId,
      summary: "Outbound message sent",
      sourceEvent,
      occurredAt: at,
    });
    lead = await repository.updateLeadFields({ lead, fields: { last_meaningful_contact_at: at }, actorType: "SYSTEM", actorId, sourceEvent: sourceEvent ? `contact:${sourceEvent}` : "" });
    if (lead.salesStage === "NEW") {
      lead = await transitionStage({ projectLeadKey: lead.projectLeadKey, toStage: "CONTACTED", source: "system", actorId, reason: "First confirmed outbound message", sourceEvent });
    }
    return lead;
  }

  async function recordInbound({ projectLeadKey, customerId, phone, projectCode, sourceEvent = "", category = "OTHER", occurredAt = null } = {}) {
    let lead = await resolve({ projectLeadKey, customerId, phone, projectCode });
    const at = iso(occurredAt || clock().toISOString(), "occurredAt");
    const eventKey = canonicalMessageEvent(sourceEvent);
    await repository.recordActivity({
      idempotencyKey: eventKey ? `message-received:${eventKey}` : `message-received:${lead.projectLeadKey}:${at}`,
      customerId: lead.customerId,
      projectLeadKey: lead.projectLeadKey,
      opportunityId: lead.opportunityId,
      activityType: "MESSAGE_RECEIVED",
      actorType: "CUSTOMER",
      summary: `Meaningful inbound reply: ${clean(category) || "OTHER"}`,
      sourceEvent: eventKey,
      occurredAt: at,
    });
    lead = await repository.updateLeadFields({ lead, fields: { last_meaningful_contact_at: at }, actorType: "SYSTEM", sourceEvent: eventKey ? `contact:${eventKey}` : "" });
    if (["NEW", "CONTACTED"].includes(lead.salesStage)) {
      lead = await transitionStage({ projectLeadKey: lead.projectLeadKey, toStage: "REPLIED", source: "system", actorId: "reply-intake", reason: "Meaningful inbound reply", sourceEvent: eventKey });
    }
    if (!lead.opportunityId) lead = await repository.createOpportunity({ lead, triggerType: "MEANINGFUL_REPLY", triggerEventId: eventKey, probabilityPercent: stageProbability(lead.salesStage) });
    return lead;
  }

  async function updateCommission({ projectLeadKey, customerId, phone, projectCode, actorId = "operator", reason = "", ...input } = {}) {
    const lead = await resolve({ projectLeadKey, customerId, phone, projectCode });
    const status = clean(input.commissionStatus || "EXPECTED").toUpperCase();
    if (!COMMISSION_STATUSES.has(status)) throw Object.assign(new Error("Commission Status 无效。"), { code: "COMMISSION_STATUS_INVALID" });
    const calculation = calculateCommission(input);
    const paidAt = status === "PAID" ? iso(input.paidAt || clock().toISOString(), "Paid At") : iso(input.paidAt, "Paid At");
    const expectedPaymentDate = iso(input.expectedPaymentDate, "Expected Payment Date");
    const updated = await repository.updateCommission({ lead, calculation, commissionStatus: status, expectedPaymentDate, paidAt, actorId, reason });
    if (calculation.actualCommission > 0 || status === "PAID") await observe("onCommissionUpdated", { lead: updated, value: calculation.actualCommission || 0, sourceEvent: `commission:${updated.opportunityId}:${paidAt || clock().toISOString()}`, occurredAt: paidAt || clock().toISOString() });
    return updated;
  }

  async function refreshTasks() {
    const now = clock();
    const nowMs = now.getTime();
    const candidates = await repository.listTaskCandidates();
    const created = [];
    for (const lead of candidates) {
      const triggers = [];
      const inboundMs = dateMs(lead.lastInboundAt);
      const outboundMs = dateMs(lead.lastOutboundAt);
      if (inboundMs !== null && (!outboundMs || inboundMs > outboundMs) && nowMs >= inboundMs + thresholds.replyMinutes * 60000) {
        triggers.push({ type: "REPLY_CUSTOMER", dueAt: new Date(inboundMs + thresholds.replyMinutes * 60000).toISOString(), reason: "Customer is waiting for an agent reply.", nextAction: "Reply customer", sourceEvent: lead.lastInboundAt, commitment: true });
      }
      const contactMs = dateMs(lead.lastMeaningfulContactAt);
      if (["WARM", "HOT"].includes(lead.temperature) && contactMs !== null && nowMs >= contactMs + thresholds.warmDays * 86400000) {
        triggers.push({ type: "WARM_LEAD_FOLLOW_UP", dueAt: new Date(contactMs + thresholds.warmDays * 86400000).toISOString(), reason: `Warm/Hot lead has no meaningful contact for ${thresholds.warmDays} days.`, nextAction: "Follow up warm lead", sourceEvent: lead.lastMeaningfulContactAt });
      }
      const snoozeMs = dateMs(lead.snoozeUntil);
      if (snoozeMs !== null && nowMs >= snoozeMs) {
        triggers.push({ type: "SNOOZE_DUE", dueAt: new Date(snoozeMs).toISOString(), reason: "Human-confirmed snooze time has arrived.", nextAction: "Review before contacting", sourceEvent: lead.snoozeUntil, commitment: true });
      }
      const appointmentMs = dateMs(lead.appointmentAt);
      if (appointmentMs !== null && nowMs >= appointmentMs - thresholds.appointmentReminderHours * 36e5 && nowMs < appointmentMs) {
        triggers.push({ type: "CONFIRM_APPOINTMENT", dueAt: new Date(appointmentMs - thresholds.appointmentReminderHours * 36e5).toISOString(), reason: "Appointment confirmation window is open.", nextAction: "Confirm appointment", sourceEvent: lead.appointmentAt, commitment: true });
      }
      const viewedMs = dateMs(lead.viewingCompletedAt);
      if (lead.salesStage === "VIEWED" && viewedMs !== null && nowMs >= viewedMs + thresholds.viewingFollowUpHours * 36e5) {
        triggers.push({ type: "POST_VIEWING_FOLLOW_UP", dueAt: new Date(viewedMs + thresholds.viewingFollowUpHours * 36e5).toISOString(), reason: "Viewing finished without a recorded outcome.", nextAction: "Record viewing outcome", sourceEvent: lead.viewingCompletedAt, commitment: true });
      }
      const loanMs = dateMs(lead.loanUpdatedAt || lead.stageChangedAt);
      if (lead.salesStage === "LOAN_PROCESSING" && loanMs !== null && nowMs >= loanMs + thresholds.loanUpdateDays * 86400000) {
        triggers.push({ type: "CHECK_LOAN", dueAt: new Date(loanMs + thresholds.loanUpdateDays * 86400000).toISOString(), reason: `No loan update for ${thresholds.loanUpdateDays} days.`, nextAction: "Check loan status", sourceEvent: lead.loanUpdatedAt || lead.stageChangedAt, commitment: true });
      }
      if (lead.salesStage === "BOOKING") triggers.push({ type: "CHECK_BOOKING", dueAt: lead.nextFollowUpAt || now.toISOString(), reason: "Booking requires a recorded next action.", nextAction: lead.nextAction || "Check booking progress", sourceEvent: lead.stageChangedAt, commitment: true });
      if (lead.salesStage === "SPA_SIGNED") triggers.push({ type: "UPDATE_SPA", dueAt: lead.nextFollowUpAt || now.toISOString(), reason: "SPA transaction follow-up is due.", nextAction: lead.nextAction || "Update SPA progress", sourceEvent: lead.stageChangedAt, commitment: true });

      for (const trigger of triggers) {
        const dueMs = dateMs(trigger.dueAt) ?? nowMs;
        const priority = scoreFollowUpPriority({
          overdueHours: Math.max(0, (nowMs - dueMs) / 36e5),
          temperature: lead.temperature,
          stage: lead.salesStage,
          explicitCommitment: trigger.commitment,
          expectedCommission: lead.expectedCommission,
          stopOrRisk: ["STOP", "INVALID", "MERGED"].includes(clean(lead.globalStatus).toUpperCase()),
        });
        const key = `sales-task:${lead.projectLeadKey}:${trigger.type}:${clean(trigger.sourceEvent) || trigger.dueAt}`;
        const taskId = await repository.upsertTask({
          idempotencyKey: key,
          lead,
          taskType: trigger.type,
          dueAt: trigger.dueAt,
          priority: priority.label,
          priorityScore: priority.score,
          reason: trigger.reason,
          nextAction: trigger.nextAction,
          sourceEvent: trigger.sourceEvent,
          owner: lead.assignedAgent,
        });
        created.push({ taskId, projectLeadKey: lead.projectLeadKey, type: trigger.type });
      }
    }
    return { scanned: candidates.length, triggered: created.length, tasks: created };
  }

  async function today({ refresh = true } = {}) {
    if (refresh) await refreshTasks();
    const now = clock();
    const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
    const tasks = await repository.listTasks({ status: "OPEN", limit: 5000 });
    const buckets = { waitingForReply: [], dueToday: [], overdue: [], warmOver7Days: [], appointmentConfirmation: [], bookingSpaAction: [] };
    for (const task of tasks) {
      const due = dateMs(task.dueAt);
      if (task.taskType === "REPLY_CUSTOMER") buckets.waitingForReply.push(task);
      if (task.taskType === "WARM_LEAD_FOLLOW_UP") buckets.warmOver7Days.push(task);
      if (task.taskType === "CONFIRM_APPOINTMENT") buckets.appointmentConfirmation.push(task);
      if (["CHECK_BOOKING", "UPDATE_SPA", "TRANSACTION"].includes(task.taskType)) buckets.bookingSpaAction.push(task);
      if (due !== null && due < dayStart.getTime()) buckets.overdue.push(task);
      else if (due !== null && due < dayEnd.getTime()) buckets.dueToday.push(task);
    }
    return { generatedAt: now.toISOString(), policy: thresholds, counts: Object.fromEntries(Object.entries(buckets).map(([key, value]) => [key, value.length])), buckets };
  }

  async function customerDetail(input = {}) {
    const lead = await resolve(input);
    const [tasks, activities] = await Promise.all([
      repository.listTasks({ customerId: lead.customerId, projectLeadKey: lead.projectLeadKey }),
      repository.listActivities({ customerId: lead.customerId, projectLeadKey: lead.projectLeadKey }),
    ]);
    return { lead, tasks, activities };
  }

  async function completeTask({ taskId, outcome, completedBy = "operator" } = {}) {
    if (!clean(outcome)) throw Object.assign(new Error("完成 task 时必须记录 outcome。"), { code: "TASK_OUTCOME_REQUIRED" });
    const task = await repository.completeTask({ taskId: clean(taskId), outcome: clean(outcome), completedBy: clean(completedBy) || "operator" });
    if (!task) throw Object.assign(new Error("找不到 Follow-up task。"), { code: "FOLLOW_UP_TASK_NOT_FOUND" });
    return task;
  }

  return {
    schemaStatus: () => repository.schemaStatus(),
    listLeads: (input) => repository.listLeads(input),
    customerDetail,
    transitionStage,
    updateLead,
    promoteOpportunity,
    recordOutbound,
    recordInbound,
    updateCommission,
    refreshTasks,
    today,
    completeTask,
    listTasks: (input) => repository.listTasks(input),
  };
}
