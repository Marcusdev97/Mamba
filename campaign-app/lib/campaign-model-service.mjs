import {
  CAMPAIGN_MEMBER_STATUSES,
  CAMPAIGN_OUTCOME_TYPES,
  CAMPAIGN_RUN_STATUSES,
  decideMemberTransition,
  normalizeCampaignRunStatus,
  validateCampaignDraft,
} from "../domain/campaign-model.mjs";

function clean(value) { return String(value ?? "").trim(); }
function iso(value, field, { optional = true } = {}) {
  if (!value && optional) return null;
  const ms = new Date(value || "").getTime();
  if (!Number.isFinite(ms)) throw Object.assign(new Error(`${field} 不是有效日期时间。`), { code: "CAMPAIGN_DATE_INVALID" });
  return new Date(ms).toISOString();
}
function required(value, code, message) { if (value) return value; throw Object.assign(new Error(message), { code }); }

export function createCampaignModelService({ repository, clock = () => new Date() } = {}) {
  if (!repository) throw new Error("Campaign Model repository is required.");

  async function ready() {
    return (await repository.schemaStatus()).ready;
  }

  async function saveDraft(input = {}) {
    const validation = validateCampaignDraft(input);
    if (!validation.valid) throw Object.assign(new Error("Campaign Draft 缺少必要资料。"), { code: "CAMPAIGN_DRAFT_INVALID", details: validation.errors });
    const startAt = iso(input.startAt, "Start At");
    const endAt = iso(input.endAt, "End At");
    if (startAt && endAt && new Date(endAt) <= new Date(startAt)) throw Object.assign(new Error("End At 必须晚于 Start At。"), { code: "CAMPAIGN_DATE_RANGE_INVALID" });
    const steps = (input.steps || []).map((step, index) => ({
      stepOrder: Number(step.stepOrder || index + 1), flowLabel: clean(step.flowLabel || `Step ${index + 1}`),
      delayRule: step.delayRule || {}, templateGroup: clean(step.templateGroup), channel: clean(step.channel || validation.value.channel).toUpperCase(),
      requiresHuman: Boolean(step.requiresHuman), active: step.active !== false,
    }));
    if (new Set(steps.map((step) => step.stepOrder)).size !== steps.length || steps.some((step) => !Number.isInteger(step.stepOrder) || step.stepOrder < 1)) {
      throw Object.assign(new Error("Campaign Step 顺序必须是不重复的正整数。"), { code: "CAMPAIGN_STEP_ORDER_INVALID" });
    }
    return repository.saveCampaign({
      campaignId: clean(input.campaignId), ...validation.value, owner: clean(input.owner), status: "DRAFT", startAt, endAt,
      target: input.target || {}, stopPolicy: input.stopPolicy || {}, audience: input.audience || {},
      attributionWindowDays: Math.max(1, Math.min(Number(input.attributionWindowDays) || 30, 365)), steps,
    });
  }

  async function enrollMembers({ campaignId, projectLeadIds = [] } = {}) {
    const campaign = required(await repository.getCampaign(clean(campaignId)), "CAMPAIGN_NOT_FOUND", "找不到 Campaign。");
    if (["COMPLETED", "CANCELLED"].includes(campaign.status)) throw Object.assign(new Error("已结束的 Campaign 不可新增成员。"), { code: "CAMPAIGN_TERMINAL" });
    return repository.enrollMembers({ campaignId: campaign.campaignId, projectLeadIds });
  }

  async function createRun({ campaignId, stepId = "", mode = "TEST", connectionId = "", deviceId = "", status = "DRAFT", runId = "" } = {}) {
    const campaign = required(await repository.getCampaign(clean(campaignId)), "CAMPAIGN_NOT_FOUND", "找不到 Campaign。");
    const normalizedMode = clean(mode).toUpperCase();
    if (!['TEST','LIVE'].includes(normalizedMode)) throw Object.assign(new Error("Run mode 只支持 TEST 或 LIVE。"), { code: "CAMPAIGN_RUN_MODE_INVALID" });
    const normalizedStatus = normalizeCampaignRunStatus(status, "");
    if (!CAMPAIGN_RUN_STATUSES.includes(normalizedStatus)) throw Object.assign(new Error("Run status 无效。"), { code: "CAMPAIGN_RUN_STATUS_INVALID" });
    const step = clean(stepId) ? campaign.steps.find((item) => item.campaignStepId === clean(stepId)) : campaign.steps.find((item) => item.active);
    if (clean(stepId) && !step) throw Object.assign(new Error("Campaign Step 不属于这个 Campaign。"), { code: "CAMPAIGN_STEP_NOT_FOUND" });
    if (normalizedMode === "LIVE" && !campaign.members.some((member) => ["PENDING", "ACTIVE"].includes(member.status))) {
      throw Object.assign(new Error("LIVE Run 没有可用 Campaign Members。"), { code: "CAMPAIGN_LIVE_MEMBERS_REQUIRED" });
    }
    return repository.createRun({ runId, campaignId: campaign.campaignId, stepId: step?.campaignStepId || null, mode: normalizedMode, connectionId: clean(connectionId), deviceId: clean(deviceId), status: normalizedStatus, startedAt: ["RUNNING", "TESTING"].includes(normalizedStatus) ? clock().toISOString() : null });
  }

  async function transitionMember({ campaignMemberId, event, reason = "", currentStepId = null, occurredAt = null } = {}) {
    const member = await repository.getMember(clean(campaignMemberId));
    required(member, "CAMPAIGN_MEMBER_NOT_FOUND", "找不到 Campaign Member。");
    const decision = decideMemberTransition({ from: member.status, event });
    if (!decision.allowed) throw Object.assign(new Error("Campaign Member 状态不允许这次转换。"), { code: decision.code, decision });
    return repository.updateMember({ campaignMemberId: member.campaignMemberId, status: decision.to, currentStepId, reason: clean(reason), occurredAt: iso(occurredAt || clock().toISOString(), "Occurred At", { optional: false }) });
  }

  async function recordOutcome(input = {}) {
    if (!await ready()) return { attributed: false, code: "CAMPAIGN_MODEL_SCHEMA_NOT_READY" };
    const outcomeType = clean(input.outcomeType).toUpperCase();
    if (!CAMPAIGN_OUTCOME_TYPES.includes(outcomeType)) throw Object.assign(new Error("Campaign Outcome Type 无效。"), { code: "CAMPAIGN_OUTCOME_TYPE_INVALID" });
    const result = await repository.recordOutcome({ ...input, outcomeType, occurredAt: iso(input.occurredAt || clock().toISOString(), "Occurred At", { optional: false }), humanOverride: Boolean(input.humanOverride) });
    if (!result.attributed && input.requireAttribution !== false) throw Object.assign(new Error(`Outcome 无法归因：${result.code}`), { code: result.code, attribution: result });
    return result;
  }

  async function recordReply({ runId = "", campaignId = "", customerId = "", projectLeadId = "", sourceEvent = "", occurredAt = null } = {}) {
    if (!await ready()) return { attributed: false, code: "CAMPAIGN_MODEL_SCHEMA_NOT_READY" };
    const at = iso(occurredAt || clock().toISOString(), "Occurred At", { optional: false });
    const member = await repository.findAttributableMember({ runId, campaignId, customerId, projectLeadId });
    if (!member) return { attributed: false, code: "CAMPAIGN_MEMBER_NOT_FOUND" };
    if (["PENDING", "ACTIVE", "PAUSED_SNOOZE"].includes(member.status)) await repository.updateMember({ campaignMemberId: member.campaignMemberId, status: "PAUSED_REPLY", reason: "CUSTOMER_REPLIED", occurredAt: at });
    return recordOutcome({ campaignMemberId: member.campaignMemberId, outcomeType: "REPLY", occurredAt: at, sourceEvent, requireAttribution: false });
  }

  async function recordStageOutcome({ customerId = "", projectLeadId = "", salesStage, value = null, sourceEvent = "", occurredAt = null } = {}) {
    if (!await ready()) return { attributed: false, code: "CAMPAIGN_MODEL_SCHEMA_NOT_READY" };
    const outcomeType = ({ WARM: "WARM", APPOINTMENT: "APPOINTMENT", VIEWED: "VIEWING", LOAN_PROCESSING: "LOAN", BOOKING: "BOOKING", SPA_SIGNED: "SPA", WON: "COMMISSION" })[clean(salesStage).toUpperCase()];
    if (!outcomeType) return { attributed: false, code: "STAGE_NOT_ATTRIBUTABLE" };
    const result = await recordOutcome({ customerId, projectLeadId, outcomeType, value, sourceEvent, occurredAt, requireAttribution: false });
    if (result.attributed && ["APPOINTMENT", "BOOKING"].includes(outcomeType)) {
      await repository.updateMember({ campaignMemberId: result.campaignMemberId, status: outcomeType === "BOOKING" ? "EXIT_BOOKED" : "EXIT_APPOINTMENT", reason: outcomeType, occurredAt: iso(occurredAt || clock().toISOString(), "Occurred At", { optional: false }) });
    }
    return result;
  }

  return {
    schemaStatus: () => repository.schemaStatus(), saveDraft, enrollMembers, createRun, transitionMember, recordOutcome, recordReply, recordStageOutcome,
    recordSendConfirmed: async (input) => await ready() ? repository.recordSendConfirmed(input) : { recorded: false, reason: "campaign_model_schema_not_ready" },
    recordLegacyCheckpoint: async (input) => await ready() ? repository.recordLegacyCheckpoint(input) : { recorded: false, reason: "campaign_model_schema_not_ready" },
    listCampaigns: (input) => repository.listCampaigns(input),
    campaignDetail: async (campaignId) => { const campaign = required(await repository.getCampaign(clean(campaignId)), "CAMPAIGN_NOT_FOUND", "找不到 Campaign。"); return { campaign, metrics: await repository.metrics(campaign.campaignId) }; },
    metrics: (campaignId) => repository.metrics(clean(campaignId)), memberStatuses: CAMPAIGN_MEMBER_STATUSES,
  };
}
