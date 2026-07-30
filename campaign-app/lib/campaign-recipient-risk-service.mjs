import crypto from "node:crypto";
import { normalizePhone } from "../suppression.mjs";

function clean(value) {
  return String(value ?? "").trim();
}

function recipientFromAssignment(assignment, index) {
  const lead = assignment?.lead || assignment || {};
  const phone = normalizePhone(lead.phone || assignment?.phone);
  if (!phone) return null;
  return {
    id: clean(assignment?.id) || `recipient_${index + 1}`,
    name: clean(lead.name || assignment?.name) || phone,
    phone,
  };
}

function connectedPhone(instance) {
  return normalizePhone(instance?.owner || instance?.number || instance?.phone);
}

function confirmationToken(scopeId, recipients, risks) {
  const payload = {
    scopeId: clean(scopeId),
    recipientIds: recipients.map((item) => item.id).sort(),
    connectedSenderIds: risks.connectedSenders.map((item) => item.id).sort(),
    privateContactIds: risks.privateContacts.map((item) => item.id).sort(),
    previousBlast: risks.previousBlast
      .map((item) => `${item.id}:${item.lastSentAt || ""}:${item.times || 0}`)
      .sort(),
    unavailableChecks: [...risks.unavailableChecks].sort(),
  };
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function createCampaignRecipientRiskService({
  conversationLog,
  workInboxIgnore,
  clock = () => new Date(),
} = {}) {
  async function analyze({
    scopeId,
    assignments = [],
    connectedInstances = [],
    skipIds = [],
  } = {}) {
    const skipped = new Set((skipIds || []).map(String));
    const recipients = assignments
      .map(recipientFromAssignment)
      .filter(Boolean)
      .filter((item) => !skipped.has(item.id));
    const byPhone = new Map(recipients.map((item) => [item.phone, item]));
    const connectedPhones = new Map(
      (connectedInstances || [])
        .map((instance) => [connectedPhone(instance), clean(instance?.name)])
        .filter(([phone]) => phone),
    );
    const risks = {
      connectedSenders: [],
      privateContacts: [],
      previousBlast: [],
      unavailableChecks: [],
    };

    for (const [phone, instanceName] of connectedPhones) {
      const recipient = byPhone.get(phone);
      if (recipient) {
        risks.connectedSenders.push({
          ...recipient,
          instanceName,
          reason: `这是本机已连接的 WhatsApp 号码${instanceName ? `（${instanceName}）` : ""}`,
        });
      }
    }

    if (workInboxIgnore) {
      try {
        const privateEntries = new Map(
          (await workInboxIgnore.snapshot()).entries
            .map((entry) => [normalizePhone(entry.phone), clean(entry.name)])
            .filter(([phone]) => phone),
        );
        for (const [phone, privateName] of privateEntries) {
          const recipient = byPhone.get(phone);
          if (recipient) {
            risks.privateContacts.push({
              ...recipient,
              privateName,
              reason: privateName ? `Settings 私人联系人：${privateName}` : "Settings 私人联系人",
            });
          }
        }
      } catch {
        risks.unavailableChecks.push("私人联系人名单暂时无法读取");
      }
    } else {
      risks.unavailableChecks.push("私人联系人检查未启用");
    }

    if (conversationLog?.sentBlastHistory) {
      try {
        const history = await conversationLog.sentBlastHistory(recipients.map((item) => item.phone));
        for (const [phone, hit] of history) {
          const recipient = byPhone.get(phone);
          if (!recipient) continue;
          risks.previousBlast.push({
            ...recipient,
            lastSentAt: hit.lastSentAt || null,
            times: Number(hit.times || 0),
            flows: Array.isArray(hit.flows) ? hit.flows : [],
            reason: `本机有 ${Number(hit.times || 0)} 条历史 Blast 消息`,
          });
        }
      } catch {
        risks.unavailableChecks.push("历史 Blast 记录暂时无法读取");
      }
    } else {
      risks.unavailableChecks.push("历史 Blast 检查未启用");
    }

    const riskIds = new Set([
      ...risks.connectedSenders,
      ...risks.privateContacts,
      ...risks.previousBlast,
    ].map((item) => item.id));
    const result = {
      version: 1,
      scopeId: clean(scopeId),
      checkedAt: clock().toISOString(),
      total: recipients.length,
      riskCount: riskIds.size,
      hasRisk: riskIds.size > 0 || risks.unavailableChecks.length > 0,
      ...risks,
    };
    result.confirmationToken = confirmationToken(scopeId, recipients, result);
    return result;
  }

  function matchesConfirmation(result, token) {
    const expected = clean(result?.confirmationToken);
    const actual = clean(token);
    if (!expected || !actual || expected.length !== actual.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
  }

  return { analyze, matchesConfirmation };
}
