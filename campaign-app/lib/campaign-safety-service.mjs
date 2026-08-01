import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizePhone } from "../suppression.mjs";
import {
  assessConsent,
  assessContactBudget,
  assessSenderHealth,
  normalizeCampaignSafetyPolicy,
} from "../domain/campaign-safety.mjs";

function clean(value) {
  return String(value ?? "").trim();
}

function recipientView(recipient, index) {
  const phone = normalizePhone(recipient?.phone || recipient?.lead?.phone);
  if (!phone) return null;
  return {
    id: clean(recipient?.id) || `recipient_${index + 1}`,
    phone,
    name: clean(recipient?.name || recipient?.lead?.name) || phone,
  };
}

function checkId(scopeId, phone, type) {
  return crypto.createHash("sha256").update(`${clean(scopeId)}:${phone}:${type}`).digest("hex");
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

export function createCampaignSafetyService({
  dataDir,
  localDatabase,
  conversationLog,
  listInstances,
  clock = () => new Date(),
} = {}) {
  const policyPath = path.join(dataDir, "campaign_safety_policy.json");
  let policyCache = null;

  async function policy() {
    if (!policyCache) policyCache = normalizeCampaignSafetyPolicy(await readJson(policyPath, {}));
    return structuredClone(policyCache);
  }

  async function savePolicy(input) {
    const normalized = normalizeCampaignSafetyPolicy(input);
    const payload = { ...normalized, updatedAt: clock().toISOString() };
    await fs.mkdir(path.dirname(policyPath), { recursive: true });
    const temp = `${policyPath}.tmp.${process.pid}.${Date.now()}`;
    await fs.writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`);
    await fs.rename(temp, policyPath);
    policyCache = normalized;
    return policy();
  }

  async function recordPermission(input = {}) {
    if (!localDatabase?.recordPermissionEvent) {
      const error = new Error("Consent Ledger 尚未完成 SQLite migration。");
      error.code = "CONSENT_LEDGER_UNAVAILABLE";
      throw error;
    }
    return localDatabase.recordPermissionEvent({
      ...input,
      action: "GRANTED",
      category: input.category || (await policy()).consent.category,
    });
  }

  async function revokePermission(input = {}) {
    if (!localDatabase?.recordPermissionEvent) {
      const error = new Error("Consent Ledger 尚未完成 SQLite migration。");
      error.code = "CONSENT_LEDGER_UNAVAILABLE";
      throw error;
    }
    return localDatabase.recordPermissionEvent({
      ...input,
      action: "REVOKED",
      category: input.category || (await policy()).consent.category,
    });
  }

  async function permissionSnapshot(phone) {
    const normalized = normalizePhone(phone);
    if (!normalized) return { phone: "", events: [], assessment: null };
    const currentPolicy = await policy();
    const events = await localDatabase.permissionEventsForPhones([normalized], {
      category: currentPolicy.consent.category,
    });
    const rows = events.get(normalized) || [];
    return {
      phone: normalized,
      events: rows,
      assessment: assessConsent(rows, currentPolicy, clock()),
    };
  }

  async function analyzeRecipients({ scopeId, recipients = [], record = true } = {}) {
    const normalized = recipients.map(recipientView).filter(Boolean);
    const phones = normalized.map((item) => item.phone);
    const currentPolicy = await policy();
    const unavailableChecks = [];
    let permissionEvents = new Map(phones.map((phone) => [phone, []]));
    let activity = new Map(phones.map((phone) => [phone, {}]));
    try {
      permissionEvents = await localDatabase.permissionEventsForPhones(phones, {
        category: currentPolicy.consent.category,
      });
    } catch (error) {
      unavailableChecks.push(`Consent Ledger 无法读取：${error.code || error.message}`);
    }
    try {
      activity = await conversationLog.campaignTouchActivity(phones, {
        windows: currentPolicy.contactBudget.windows.map((item) => item.days),
      });
    } catch (error) {
      unavailableChecks.push(`联系预算无法读取：${error.code || error.message}`);
    }

    const result = {
      missingConsent: [],
      expiredConsent: [],
      revokedConsent: [],
      contactBudget: [],
      blockedRecipients: [],
      unavailableChecks,
      policy: currentPolicy,
    };
    const checks = [];
    for (const recipient of normalized) {
      const consent = assessConsent(permissionEvents.get(recipient.phone) || [], currentPolicy, clock());
      const budget = assessContactBudget(activity.get(recipient.phone) || {}, currentPolicy);
      const consentItem = { ...recipient, assessment: consent, reason: consent.reason };
      if (consent.code === "CONSENT_EVIDENCE_MISSING") result.missingConsent.push(consentItem);
      if (consent.code === "CONSENT_EVIDENCE_EXPIRED") result.expiredConsent.push(consentItem);
      if (consent.code === "CONSENT_REVOKED") result.revokedConsent.push(consentItem);
      if (budget.outcome !== "ALLOW") {
        result.contactBudget.push({ ...recipient, assessment: budget, reason: budget.reason });
      }
      if (consent.outcome === "BLOCK" || budget.outcome === "BLOCK") {
        result.blockedRecipients.push({
          ...recipient,
          codes: [consent, budget].filter((item) => item.outcome === "BLOCK").map((item) => item.code),
        });
      }
      for (const [type, assessment] of [["CONSENT", consent], ["CONTACT_BUDGET", budget]]) {
        checks.push({
          checkId: checkId(scopeId, recipient.phone, type),
          scopeId,
          phone: recipient.phone,
          checkType: type,
          outcome: assessment.outcome,
          code: assessment.code,
          details: { assessment },
          checkedAt: clock().toISOString(),
        });
      }
    }
    if (record && checks.length && localDatabase?.recordCampaignSafetyChecks) {
      try {
        await localDatabase.recordCampaignSafetyChecks(checks);
      } catch (error) {
        result.unavailableChecks.push(`安全检查审计无法写入：${error.code || error.message}`);
      }
    }
    return result;
  }

  async function senderSnapshot(instanceNames = []) {
    const currentPolicy = await policy();
    const liveInstances = typeof listInstances === "function" ? await listInstances() : [];
    const requested = [...new Set((instanceNames.length ? instanceNames : liveInstances.map((item) => item.name)).map(clean).filter(Boolean))];
    const states = await localDatabase.senderSafetyStates(requested);
    const metrics = await conversationLog.senderDeliveryMetrics(requested, {
      sinceHours: currentPolicy.senderHealth.lookbackHours,
    });
    const byInstance = new Map(liveInstances.map((item) => [clean(item.name), item]));
    return requested.map((instanceName) => {
      const instance = byInstance.get(instanceName) || { name: instanceName, status: "MISSING" };
      const senderMetrics = metrics.get(instanceName) || {
        instanceName,
        attempts: 0,
        failures: 0,
        unknown: 0,
        consecutiveFailures: 0,
      };
      const persistedState = states.get(instanceName) || { instanceName, state: "HEALTHY" };
      return {
        instanceName,
        status: instance.status,
        provider: instance.provider || { key: "UNKNOWN", label: "Provider 未识别", official: false },
        persistedState,
        metrics: senderMetrics,
        assessment: assessSenderHealth(senderMetrics, persistedState, currentPolicy),
      };
    });
  }

  async function assertSendersAllowed(instanceNames = []) {
    const senders = await senderSnapshot(instanceNames);
    const blocked = senders.filter((sender) => sender.assessment.outcome === "BLOCK");
    for (const sender of blocked) {
      if (sender.persistedState?.state === "PAUSED") continue;
      await localDatabase.setSenderSafetyState({
        instanceName: sender.instanceName,
        state: "PAUSED",
        reasonCode: sender.assessment.code,
        reason: sender.assessment.reason,
        metrics: sender.metrics,
      });
    }
    if (blocked.length) {
      const error = new Error(`Sender 安全熔断：${blocked.map((item) => item.instanceName).join(", ")} 已暂停。请先检查发送状态再人工恢复。`);
      error.code = "SENDER_SAFETY_PAUSED";
      error.blocked = blocked;
      throw error;
    }
    return senders;
  }

  async function setSenderState(input = {}) {
    return localDatabase.setSenderSafetyState(input);
  }

  async function snapshot() {
    const currentPolicy = await policy();
    let counts = { permissionEvents: 0, permissionContacts: 0, pausedSenders: 0, blockedChecks: 0 };
    let senders = [];
    let available = true;
    let error = null;
    try {
      [counts, senders] = await Promise.all([
        localDatabase.campaignSafetyCounts(),
        senderSnapshot(),
      ]);
    } catch (caught) {
      available = false;
      error = `${caught.code || "CAMPAIGN_SAFETY_UNAVAILABLE"}: ${caught.message}`;
    }
    return {
      version: 1,
      available,
      error,
      policy: currentPolicy,
      counts,
      senders,
      policyPath,
      transportRecommendation: senders.some((item) => item.provider?.key === "BAILEYS")
        ? "检测到 Baileys / WhatsApp Web sender。正式规模发送建议迁移至 Meta Cloud API。"
        : null,
    };
  }

  return {
    policyPath,
    policy,
    savePolicy,
    recordPermission,
    revokePermission,
    permissionSnapshot,
    analyzeRecipients,
    senderSnapshot,
    assertSendersAllowed,
    setSenderState,
    snapshot,
  };
}
