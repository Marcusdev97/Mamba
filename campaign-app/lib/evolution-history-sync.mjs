// 把 Evolution 的完整 WhatsApp 历史拉进本机 SQL。
//
// CLI 脚本(backfill_evolution_history.mjs)和 Settings 里的「一键同步」按钮共用这套。
//
// 规则：只导入「有客户回过」的号码的完整对话(双向)；纯 blast 没回、私人冷发不导。
// 幂等：靠 messageId 去重，随时可以再跑补新的。

import { describeMessage, resolvePhone } from "../reply_intake.mjs";

const PAGE_SIZE = 200;

function messageTimeIso(message) {
  const ts = Number(message?.messageTimestamp ?? 0);
  if (!ts) return new Date().toISOString();
  return new Date(ts < 100000000000 ? ts * 1000 : ts).toISOString();
}

// 一条 Evolution 讯息 → {phone, dir, row}。群组/无电话/空内容 → null。
function decode(instance, message) {
  const key = message?.key ?? {};
  if (String(key.remoteJid ?? "").includes("@g.us")) return null;
  const phone = resolvePhone(message);
  if (!phone) return null;
  const text = describeMessage(message);
  if (!text) return null;
  const sentAt = messageTimeIso(message);
  const messageId = String(key.id || `${phone}_${sentAt}`);
  if (key.fromMe) {
    return { phone, dir: "out", row: { phone, text, instanceName: instance, messageId, sentAt, source: "phone", flowTopic: "history" } };
  }
  return { phone, dir: "in", row: { id: messageId, phone, text, instanceName: instance, receivedAt: sentAt, name: message.pushName || "" } };
}

export function createEvolutionHistorySync({ api, conversationLog, listInstances } = {}) {
  if (!api || !conversationLog || !listInstances) throw new Error("evolution history sync 需要 api / conversationLog / listInstances");

  async function fetchAllMessages(instance, onPage) {
    const first = await api(`/chat/findMessages/${encodeURIComponent(instance)}`, {
      method: "POST", body: JSON.stringify({ page: 1, offset: PAGE_SIZE }), timeoutMs: 60000,
    }).catch(() => null);
    const meta = first?.messages || {};
    const pages = Number(meta.pages) || (meta.records?.length ? 1 : 0);
    const all = [...(meta.records || [])];
    onPage?.(1, pages, all.length);
    for (let page = 2; page <= pages; page += 1) {
      const res = await api(`/chat/findMessages/${encodeURIComponent(instance)}`, {
        method: "POST", body: JSON.stringify({ page, offset: PAGE_SIZE }), timeoutMs: 60000,
      }).catch(() => null);
      all.push(...(res?.messages?.records || []));
      onPage?.(page, pages, all.length);
    }
    return all;
  }

  // 同步一个号码。onProgress 回报阶段/进度，让 UI 显示。
  async function syncInstance(instance, { dryRun = false, onProgress = null } = {}) {
    onProgress?.({ instance, phase: "fetch", page: 0, pages: 0, fetched: 0 });
    const messages = await fetchAllMessages(instance, (page, pages, fetched) => {
      onProgress?.({ instance, phase: "fetch", page, pages, fetched });
    });

    const byPhone = new Map();
    for (const m of messages) {
      const d = decode(instance, m);
      if (!d) continue;
      if (!byPhone.has(d.phone)) byPhone.set(d.phone, { in: [], out: [] });
      byPhone.get(d.phone)[d.dir].push(d.row);
    }
    const twoWay = [...byPhone.entries()].filter(([, v]) => v.in.length > 0);
    const inbound = twoWay.flatMap(([, v]) => v.in);
    const outbound = twoWay.flatMap(([, v]) => v.out);
    onProgress?.({ instance, phase: "decoded", customers: twoWay.length, inbound: inbound.length, outbound: outbound.length });

    if (dryRun) return { instance, customers: twoWay.length, inbound: inbound.length, outbound: outbound.length, written: 0, failed: 0, dryRun: true };

    onProgress?.({ instance, phase: "write", written: 0, total: inbound.length + outbound.length });
    let written = 0;
    const total = inbound.length + outbound.length;
    const inRep = await conversationLog.recordReplies(inbound, {
      force: true, onProgress: (s) => onProgress?.({ instance, phase: "write", written: s.written, total }),
    });
    written = inRep.written;
    const outRep = await conversationLog.recordOutbounds(outbound, {
      force: true, onProgress: (s) => onProgress?.({ instance, phase: "write", written: inRep.written + s.written, total }),
    });
    written = inRep.written + outRep.written;
    return { instance, customers: twoWay.length, inbound: inbound.length, outbound: outbound.length, written, failed: inRep.failed.length + outRep.failed.length };
  }

  // 同步全部（或指定）号码。
  async function syncAll({ instance = "", dryRun = false, onProgress = null } = {}) {
    let names = (await listInstances()).map((i) => i.name || i?.instance?.instanceName).filter(Boolean);
    if (instance) names = names.filter((n) => n === instance);
    const before = await conversationLog.stats();
    const results = [];
    for (const name of names) {
      results.push(await syncInstance(name, { dryRun, onProgress }));
    }
    const after = await conversationLog.stats();
    return {
      instances: names,
      results,
      added: after.messages - before.messages,
      totalMessages: after.messages,
      customersWithReplies: after.contactsWithReplies,
    };
  }

  return { syncInstance, syncAll };
}
