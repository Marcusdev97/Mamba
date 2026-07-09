// brain_core.mjs — pure decision logic for the Sales Brain service (Task B6).
//
// Everything here is side-effect free and covered by test_brain_core.mjs.
// brain_service.mjs does the wiring (HTTP, Evolution, Telegram, Anthropic,
// Notion); THIS file decides WHAT happens:
//
//   route  -> auto-send canned reply | AI/rule draft + human buttons | forced handoff
//   text   -> language guess (for the AI Reply Log)
//   event  -> the exact prompt the model sees (guardrails hardcoded HERE)
//   button -> ok / edit / take transition
//
// PHASE 1 RULE: complex routes are NEVER auto-sent. The only auto-send is the
// canned suggestedReply on simple routes. Changing a route from "ai" to "auto"
// is a policy decision — do it here, on purpose, with data (照发率 ≥ 90% for
// two consecutive weeks), never inside the service.

// ---------- route policy (缺口 3 数据流的核心分岔) ----------
//
// mode:
//   "auto"    -> send the classifier's canned suggestedReply immediately.
//   "ai"      -> model drafts when an AI key exists; otherwise rule suggestion ->
//                Telegram buttons -> human decides.
//   "handoff" -> no reply at all; Telegram alert; human takes over (情绪负面).
// tier: which model drafts ("complex" = high-value negotiation, "simple" = routine).
export const ROUTE_POLICY = {
  STOP_DNC: { mode: "auto" },
  COMPLAINT: { mode: "handoff" },
  VIEWING_REQUEST: { mode: "ai", tier: "complex" }, // booking = money, use the better model
  PRICE_REQUEST: { mode: "ai", tier: "complex" },
  LOAN_MONTHLY_REQUEST: { mode: "ai", tier: "complex" },
  LAYOUT_REQUEST: { mode: "auto" },
  LOCATION_REQUEST: { mode: "auto" },
  DETAILS_REQUEST: { mode: "auto" },
  NOT_INTERESTED: { mode: "auto" },
  AGENT_OR_WRONG_TARGET: { mode: "auto" },
  LATER_BUSY: { mode: "ai", tier: "simple" },
  UNKNOWN_MANUAL_REVIEW: { mode: "ai", tier: "simple" },
};

export function decideAction(route) {
  return ROUTE_POLICY[route] ?? { mode: "ai", tier: "simple" }; // unknown route -> safest: human-approved AI
}

// classifier route -> "Route" select option in Mamba | AI Reply Log.
const ROUTE_TO_LOG = {
  STOP_DNC: "Not Interested", // log DB has no separate Stop option; Action column carries the truth
  COMPLAINT: "Complaint",
  VIEWING_REQUEST: "Viewing",
  PRICE_REQUEST: "Price",
  LOAN_MONTHLY_REQUEST: "Loan",
  LAYOUT_REQUEST: "Layout",
  LOCATION_REQUEST: "Location",
  DETAILS_REQUEST: "Details",
  NOT_INTERESTED: "Not Interested",
  AGENT_OR_WRONG_TARGET: "Unknown",
  LATER_BUSY: "Later Busy",
  UNKNOWN_MANUAL_REVIEW: "Unknown",
};
export function logRouteOf(route) {
  return ROUTE_TO_LOG[route] ?? "Unknown";
}

// ---------- language guess (EN / ZH / BM / Mixed) ----------
export function detectLanguage(text) {
  const value = String(text ?? "");
  const hasCjk = /[一-鿿]/.test(value);
  const hasLatinWord = /[a-zA-Z]{2,}/.test(value);
  if (hasCjk && hasLatinWord) return "Mixed";
  if (hasCjk) return "ZH";
  if (/\b(boleh|nak|tak|berapa|harga|bilik|dekat|mana|jangan|saya|awak|ada|macam|mana|nanti|sibuk)\b/i.test(value)) return "BM";
  return "EN";
}

// ---------- model pick ----------
export function pickModel(tier, env = {}) {
  if (tier === "complex") return env.BRAIN_MODEL_COMPLEX || "claude-sonnet-4-5";
  return env.BRAIN_MODEL_SIMPLE || "claude-haiku-4-5";
}

// ---------- prompt build (guardrails live HERE, hardcoded) ----------
//
// The cache passed in is ALREADY Verified-only (brain_cache_sync enforces the
// Verified/Valid-Until gate at the data level). The prompt re-states the rule
// anyway — belt and suspenders.
export function buildPrompt({ event, classified, cache, lead }) {
  const facts = (cache?.knowledge?.facts ?? [])
    .map((f) => `- [${f.category ?? "General"}] ${f.fact}${f.validUntil ? ` (有效至 ${f.validUntil})` : ""}`)
    .join("\n");
  const objections = (cache?.objections?.objections ?? [])
    .slice(0, 20)
    .map((o) => `- 客户说: "${o.says}" | 真实意图: ${o.intent} | 回应方向: ${o.direction}${o.handoff ? " | ⚠️ 需人工" : ""}`)
    .join("\n");
  const golden = (cache?.golden?.conversations ?? [])
    .slice(0, 5)
    .map((g) => `### ${g.title} (${g.scenario ?? "-"} -> ${g.outcome ?? "-"})\n${g.text}\n为什么有效: ${g.why}`)
    .join("\n\n");

  const system = [
    "你是马来西亚 KL 房产项目的 WhatsApp 销售助理 (Sales Brain)。你替业务员起草回复,发送前一定有人工审核,所以专注写出最自然、最像真人业务员的草稿。",
    "",
    "硬性规则 (违反任何一条 = 草稿作废):",
    "1. 只能引用下面 VERIFIED FACTS 里明确写着的数字和事实。列表里没有的数字(价格、面积、月供、折扣、日期)一律不准编,改说「这个我 check 最新的资料再回你」。",
    "2. 砍价、贷款细节、客户情绪负面 → 草稿只能安抚+承接,并以约人工跟进收尾,不准自行承诺任何数字或条件。",
    "3. 用客户的语言回复 (中文/English/BM/混搭跟着客户走),WhatsApp 口语风格,短句,不用敬语套话,不用列表,不用 emoji 轰炸 (最多 1 个)。",
    "4. 一条消息说完,长度控制在 3 句以内,结尾带一个自然的推进问题。",
    "5. 直接输出要发给客户的文本,不要解释,不要引号,不要前缀。",
  ].join("\n");

  const user = [
    `## VERIFIED FACTS (只准用这些)`,
    facts || "(库是空的 — 所有数字都说「我 check 了回你」)",
    "",
    `## OBJECTION PLAYBOOK`,
    objections || "(暂无)",
    golden ? `\n## 成功对话参考\n${golden}` : "",
    "",
    `## 这个 LEAD`,
    `姓名: ${lead?.name ?? "未知"}`,
    `之前状态: ${lead?.lastBlastStatus ?? lead?.status ?? "未知"}`,
    lead?.replyText ? `上一条回复: ${lead.replyText}` : "",
    "",
    `## 客户刚发来 (分类: ${classified.route})`,
    `"${event.text}"`,
    "",
    `## 规则分类器的罐头建议 (可参考可超越)`,
    `"${classified.suggestedReply}"`,
    "",
    "写出你的草稿:",
  ].filter((line) => line !== "").join("\n");

  return { system, user };
}

// ---------- Telegram draft card ----------
export function draftCard({ event, classified, draft, lead, tier }) {
  const esc = (v) => String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const source = tier === "rules" ? " (Rule-only)" : tier === "complex" ? " (Sonnet)" : "";
  return [
    `🧠 <b>${esc(classified.route)}</b> · ${esc(lead?.name ?? event.pushName ?? "Unknown")} (${esc(event.phone)})`,
    `💬 客户: ${esc(event.text)}`,
    "",
    `📝 <b>草稿${source}</b>:`,
    esc(draft),
    "",
    `✏️ 要改的话: 按「改后发」再 <b>回复这条消息</b> 输入新文本。`,
  ].join("\n");
}

export function draftButtons(pendingId) {
  return [
    { text: "✅ 照发", data: `ok:${pendingId}` },
    { text: "✏️ 改后发", data: `edit:${pendingId}` },
    { text: "🙋 接管", data: `take:${pendingId}` },
  ];
}

// "ok:abc123" -> { action:"ok", pendingId:"abc123" } | null
export function parseCallbackData(data) {
  const m = /^(ok|edit|take):(.+)$/.exec(String(data ?? ""));
  return m ? { action: m[1], pendingId: m[2] } : null;
}

// button action -> AI Reply Log "Action" select
export function logActionOf(action) {
  return { ok: "Sent As-Is", edit: "Edited", take: "Takeover" }[action] ?? null;
}
