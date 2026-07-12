// lead_gatekeeper.mjs — 唯一的守门员 (2026-07-11 架构重构)。
//
// "这个 lead 现在能不能发?" —— 以前这个判断散落在 4 个地方 (next-flow 的
// list / load / set-flow / set-group, 加 CLI 和 runner 各自的检查), 改规则
// 要改多处。现在拦截规则只存在这一个文件, 所有发送路径都问同一个函数。
//
// 两层检查:
//   1. 全局 STOP 名单 (suppressed.json + 本地 overlay) —— 跨盘跨号。
//      以前 web 版体检不看这个, 跨盘退订的人在页面上"看起来能发",
//      要到 runner 层才被拦 —— 页面显示和实际行为不一致, 这里修正。
//   2. Notion 行体检 —— Stop Flag / Status / Sequence Status / AI Category /
//      上一条回复重新分类 (原 next-flow.routes 的 nextFlowBlockReason 原样搬家,
//      test_next_flow_safety.mjs 继续覆盖它)。
//
// 用法:
//   const snapshot = loadGateSnapshot();          // 一批一次, 循环里复用
//   const gate = canSend({ phone, page, classifyReplyText, snapshot });
//   if (!gate.ok) skip(gate.reason);

import { loadSuppressionSync, isSuppressed, normalizePhone } from "./suppression.mjs";

function propertyChoice(page, name) {
  const property = page?.properties?.[name];
  return String(property?.select?.name ?? property?.status?.name ?? "").trim();
}

function propertyText(page, name) {
  const property = page?.properties?.[name];
  const items = property?.rich_text ?? property?.title ?? [];
  return items.map((item) => item?.plain_text ?? item?.text?.content ?? "").join("").trim();
}

// 从 Notion 行里抓 phone (第一个 phone_number 属性), 让 canSend 只拿 page 也能查全局名单。
function phoneOfPage(page) {
  for (const prop of Object.values(page?.properties ?? {})) {
    if (prop?.type === "phone_number" && prop.phone_number) return normalizePhone(prop.phone_number);
  }
  return null;
}

// ---- 第 2 层: Notion 行体检 (纯函数, 原 nextFlowBlockReason) ----
export function rowBlockReason(page, classifyReplyText) {
  if (page?.properties?.["Stop Flag"]?.checkbox === true) return "Stop Flag";

  const status = propertyChoice(page, "Status");
  if (["Stop", "Not Interested", "Appointment", "Invalid", "Do Not Contact"].includes(status)) {
    return `Status: ${status}`;
  }

  const sequence = propertyChoice(page, "Sequence Status");
  if (["Stopped", "Not Interested", "Human Takeover", "Completed"].includes(sequence)) {
    return `Sequence Status: ${sequence}`;
  }

  const category = propertyChoice(page, "AI Category");
  if (["Stop", "Not Interested", "Spam"].includes(category)) {
    return `AI Category: ${category}`;
  }

  const lastReply = propertyText(page, "Last Reply Text");
  if (lastReply && typeof classifyReplyText === "function") {
    const verdict = classifyReplyText(lastReply);
    if (["STOP_DNC", "COMPLAINT", "NOT_INTERESTED", "AGENT_OR_WRONG_TARGET"].includes(verdict?.route)) {
      return `Last Reply: ${verdict.route}`;
    }
  }

  return "";
}

// ---- snapshot: 一批 load 一次, 别在循环里每行读盘 ----
export function loadGateSnapshot() {
  return { suppression: loadSuppressionSync().set };
}

// ---- 主入口 ----
export function canSend({ phone = null, page = null, classifyReplyText = null, snapshot = null } = {}) {
  const snap = snapshot ?? loadGateSnapshot();
  const n = normalizePhone(phone) ?? (page ? phoneOfPage(page) : null);
  if (phone != null && !normalizePhone(phone)) return { ok: false, reason: "Invalid phone" };
  if (n && isSuppressed(n, snap.suppression)) {
    return { ok: false, reason: "Global STOP (可能在别的盘退订)" };
  }
  if (page) {
    const reason = rowBlockReason(page, classifyReplyText);
    if (reason) return { ok: false, reason };
  }
  return { ok: true, reason: "" };
}

// 统计辅助: 这个拦截原因算 "STOP 类" 还是 "拒绝类" (给 skippedStop/skippedRejected 计数用)。
export function isStopReason(reason) {
  return reason === "Stop Flag" || String(reason).startsWith("Status: Stop") || String(reason).startsWith("Global STOP");
}
