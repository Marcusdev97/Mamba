const POLICY_MODES = new Set(["off", "warn", "enforce"]);
const PERMISSION_ACTIONS = new Set(["GRANTED", "REVOKED"]);

export const DEFAULT_CAMPAIGN_SAFETY_POLICY = Object.freeze({
  version: 1,
  consent: Object.freeze({
    mode: "warn",
    category: "PROPERTY_MARKETING",
    validityDays: 365,
  }),
  contactBudget: Object.freeze({
    mode: "warn",
    windows: Object.freeze([
      Object.freeze({ days: 7, maxRuns: 2 }),
      Object.freeze({ days: 30, maxRuns: 5 }),
    ]),
    maxUnansweredRuns: 3,
  }),
  senderHealth: Object.freeze({
    mode: "enforce",
    lookbackHours: 24,
    minAttempts: 20,
    maxFailureRate: 0.25,
    maxUnknownRate: 0.20,
    maxConsecutiveFailures: 3,
  }),
});

function clean(value) {
  return String(value ?? "").trim();
}

function finiteNumber(value, fallback, { min = -Infinity, max = Infinity, integer = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const normalized = integer ? Math.trunc(number) : number;
  return Math.min(max, Math.max(min, normalized));
}

function mode(value, fallback) {
  const normalized = clean(value).toLowerCase();
  return POLICY_MODES.has(normalized) ? normalized : fallback;
}

export function normalizeCampaignSafetyPolicy(input = {}) {
  const defaults = DEFAULT_CAMPAIGN_SAFETY_POLICY;
  const windows = Array.isArray(input?.contactBudget?.windows)
    ? input.contactBudget.windows
      .map((item) => ({
        days: finiteNumber(item?.days, 0, { min: 1, max: 365, integer: true }),
        maxRuns: finiteNumber(item?.maxRuns, 0, { min: 1, max: 100, integer: true }),
      }))
      .filter((item) => item.days && item.maxRuns)
    : defaults.contactBudget.windows.map((item) => ({ ...item }));
  const uniqueWindows = [...new Map(windows.map((item) => [item.days, item])).values()]
    .sort((a, b) => a.days - b.days);

  return {
    version: 1,
    consent: {
      mode: mode(input?.consent?.mode, defaults.consent.mode),
      category: clean(input?.consent?.category).toUpperCase() || defaults.consent.category,
      validityDays: finiteNumber(input?.consent?.validityDays, defaults.consent.validityDays, {
        min: 1,
        max: 3650,
        integer: true,
      }),
    },
    contactBudget: {
      mode: mode(input?.contactBudget?.mode, defaults.contactBudget.mode),
      windows: uniqueWindows.length ? uniqueWindows : defaults.contactBudget.windows.map((item) => ({ ...item })),
      maxUnansweredRuns: finiteNumber(
        input?.contactBudget?.maxUnansweredRuns,
        defaults.contactBudget.maxUnansweredRuns,
        { min: 1, max: 50, integer: true },
      ),
    },
    senderHealth: {
      mode: mode(input?.senderHealth?.mode, defaults.senderHealth.mode),
      lookbackHours: finiteNumber(input?.senderHealth?.lookbackHours, defaults.senderHealth.lookbackHours, {
        min: 1,
        max: 168,
        integer: true,
      }),
      minAttempts: finiteNumber(input?.senderHealth?.minAttempts, defaults.senderHealth.minAttempts, {
        min: 5,
        max: 10000,
        integer: true,
      }),
      maxFailureRate: finiteNumber(input?.senderHealth?.maxFailureRate, defaults.senderHealth.maxFailureRate, {
        min: 0.01,
        max: 1,
      }),
      maxUnknownRate: finiteNumber(input?.senderHealth?.maxUnknownRate, defaults.senderHealth.maxUnknownRate, {
        min: 0.01,
        max: 1,
      }),
      maxConsecutiveFailures: finiteNumber(
        input?.senderHealth?.maxConsecutiveFailures,
        defaults.senderHealth.maxConsecutiveFailures,
        { min: 1, max: 50, integer: true },
      ),
    },
  };
}

export function latestPermissionEvent(events = [], category = "PROPERTY_MARKETING") {
  const wanted = clean(category).toUpperCase();
  return [...events]
    .filter((event) => clean(event?.category).toUpperCase() === wanted)
    .filter((event) => PERMISSION_ACTIONS.has(clean(event?.action).toUpperCase()))
    .sort((a, b) => {
      const occurred = new Date(b?.occurredAt || 0).getTime() - new Date(a?.occurredAt || 0).getTime();
      if (occurred) return occurred;
      return new Date(b?.recordedAt || b?.createdAt || 0).getTime()
        - new Date(a?.recordedAt || a?.createdAt || 0).getTime();
    })[0] || null;
}

function policyOutcome(policyMode, warningCode) {
  if (policyMode === "off") return { outcome: "ALLOW", code: "CHECK_DISABLED" };
  return policyMode === "enforce"
    ? { outcome: "BLOCK", code: warningCode }
    : { outcome: "WARN", code: warningCode };
}

export function assessConsent(events = [], policyInput = {}, now = new Date()) {
  const policy = normalizeCampaignSafetyPolicy(policyInput).consent;
  const latest = latestPermissionEvent(events, policy.category);
  if (!latest) {
    return {
      ...policyOutcome(policy.mode, "CONSENT_EVIDENCE_MISSING"),
      category: policy.category,
      latest: null,
      reason: "找不到这个客户同意接收房产推广消息的证据。",
    };
  }
  if (clean(latest.action).toUpperCase() === "REVOKED") {
    return {
      outcome: "BLOCK",
      code: "CONSENT_REVOKED",
      category: policy.category,
      latest,
      reason: "客户已经撤回这类消息的同意。",
    };
  }
  const occurredAt = new Date(latest.occurredAt || latest.recordedAt || latest.createdAt || 0);
  const expiresAt = latest.expiresAt
    ? new Date(latest.expiresAt)
    : new Date(occurredAt.getTime() + policy.validityDays * 24 * 60 * 60 * 1000);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= now) {
    return {
      ...policyOutcome(policy.mode, "CONSENT_EVIDENCE_EXPIRED"),
      category: policy.category,
      latest,
      expiresAt: Number.isFinite(expiresAt.getTime()) ? expiresAt.toISOString() : null,
      reason: "客户同意证据已经过期，需要重新确认。",
    };
  }
  return {
    outcome: "ALLOW",
    code: "CONSENT_ACTIVE",
    category: policy.category,
    latest,
    expiresAt: expiresAt.toISOString(),
    reason: "已有有效的客户同意证据。",
  };
}

export function assessContactBudget(activity = {}, policyInput = {}) {
  const policy = normalizeCampaignSafetyPolicy(policyInput).contactBudget;
  if (policy.mode === "off") {
    return { outcome: "ALLOW", code: "CONTACT_BUDGET_DISABLED", breaches: [], reason: "联系预算检查已关闭。" };
  }
  const runCounts = activity?.runCounts || {};
  const breaches = policy.windows
    .map((window) => ({
      ...window,
      actualRuns: finiteNumber(runCounts[window.days], 0, { min: 0, integer: true }),
    }))
    .filter((window) => window.actualRuns >= window.maxRuns);
  const unansweredRuns = finiteNumber(activity?.unansweredRuns, 0, { min: 0, integer: true });
  if (unansweredRuns >= policy.maxUnansweredRuns) {
    breaches.push({
      type: "UNANSWERED",
      actualRuns: unansweredRuns,
      maxRuns: policy.maxUnansweredRuns,
    });
  }
  if (!breaches.length) {
    return { outcome: "ALLOW", code: "CONTACT_BUDGET_AVAILABLE", breaches: [], reason: "仍在允许的联系预算内。" };
  }
  return {
    ...policyOutcome(policy.mode, "CONTACT_BUDGET_EXCEEDED"),
    breaches,
    reason: "这个客户近期已收到较多 Campaign，需要暂停或人工确认。",
  };
}

export function assessSenderHealth(metrics = {}, persistedState = {}, policyInput = {}) {
  const policy = normalizeCampaignSafetyPolicy(policyInput).senderHealth;
  const savedState = clean(persistedState?.state).toUpperCase();
  if (savedState === "PAUSED") {
    return {
      outcome: "BLOCK",
      code: clean(persistedState?.reasonCode) || "SENDER_MANUALLY_PAUSED",
      reason: clean(persistedState?.reason) || "这个发送号码已被安全暂停。",
      triggers: ["PERSISTED_PAUSE"],
    };
  }
  if (policy.mode === "off") {
    return { outcome: "ALLOW", code: "SENDER_HEALTH_DISABLED", reason: "Sender 健康熔断已关闭。", triggers: [] };
  }
  const attempts = finiteNumber(metrics?.attempts, 0, { min: 0, integer: true });
  const failures = finiteNumber(metrics?.failures, 0, { min: 0, integer: true });
  const unknown = finiteNumber(metrics?.unknown, 0, { min: 0, integer: true });
  const consecutiveFailures = finiteNumber(metrics?.consecutiveFailures, 0, { min: 0, integer: true });
  const failureRate = attempts ? failures / attempts : 0;
  const unknownRate = attempts ? unknown / attempts : 0;
  const triggers = [];
  if (consecutiveFailures >= policy.maxConsecutiveFailures) triggers.push("CONSECUTIVE_FAILURES");
  if (attempts >= policy.minAttempts && failureRate >= policy.maxFailureRate) triggers.push("FAILURE_RATE");
  if (attempts >= policy.minAttempts && unknownRate >= policy.maxUnknownRate) triggers.push("UNKNOWN_RATE");
  if (!triggers.length) {
    return {
      outcome: "ALLOW",
      code: attempts < policy.minAttempts ? "SENDER_HEALTH_WARMING_UP" : "SENDER_HEALTHY",
      reason: attempts < policy.minAttempts ? "样本仍少，继续观察 Sender 健康。" : "Sender 近期发送状态正常。",
      triggers,
      rates: { failureRate, unknownRate },
    };
  }
  return {
    ...policyOutcome(policy.mode, "SENDER_HEALTH_THRESHOLD_EXCEEDED"),
    reason: "Sender 的失败或不明确状态已超过安全阈值。",
    triggers,
    rates: { failureRate, unknownRate },
  };
}
