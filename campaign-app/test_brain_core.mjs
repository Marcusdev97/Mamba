// test_brain_core.mjs — offline tests for brain_core.mjs (the brain's decision logic).
// Run: node test_brain_core.mjs
// Most important assertions: Phase-1 policy (complex routes NEVER auto-send) and
// the guardrails baked into the prompt.

import { classifyReplyText } from "./flow_sequence.mjs";
import {
  ROUTE_POLICY, decideAction, logRouteOf, detectLanguage, pickModel,
  buildPrompt, draftButtons, parseCallbackData, logActionOf, draftCard,
} from "./brain_core.mjs";

let fail = 0;
function check(label, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) { console.log(`❌ ${label}:\n   got      ${JSON.stringify(got)}\n   expected ${JSON.stringify(expected)}`); fail += 1; }
}
function checkTrue(label, cond) { check(label, Boolean(cond), true); }

// --- policy covers every route the classifier can produce ---
const sampleByRoute = {
  STOP_DNC: "please stop", COMPLAINT: "scam la you", VIEWING_REQUEST: "can view this weekend?",
  PRICE_REQUEST: "多少钱?", LOAN_MONTHLY_REQUEST: "月供多少", LAYOUT_REQUEST: "有 3房吗",
  LOCATION_REQUEST: "location dekat mana", DETAILS_REQUEST: "send me brochure",
  NOT_INTERESTED: "not interested", AGENT_OR_WRONG_TARGET: "我是agent",
  LATER_BUSY: "现在忙 迟点", UNKNOWN_MANUAL_REVIEW: "??",
};
for (const [route, text] of Object.entries(sampleByRoute)) {
  check(`classifier reaches ${route}`, classifyReplyText(text).route, route);
  checkTrue(`policy exists for ${route}`, ROUTE_POLICY[route]);
}

// --- Phase 1: money/emotion routes are NEVER auto-sent ---
for (const route of ["PRICE_REQUEST", "LOAN_MONTHLY_REQUEST", "VIEWING_REQUEST", "UNKNOWN_MANUAL_REVIEW", "LATER_BUSY"]) {
  check(`${route} is human-approved`, decideAction(route).mode, "ai");
}
check("COMPLAINT is forced handoff", decideAction("COMPLAINT").mode, "handoff");
check("unknown route defaults to ai (never auto)", decideAction("SOME_FUTURE_ROUTE").mode, "ai");
// high-value routes draft with the complex tier
for (const route of ["PRICE_REQUEST", "LOAN_MONTHLY_REQUEST", "VIEWING_REQUEST"]) {
  check(`${route} uses complex tier`, decideAction(route).tier, "complex");
}

// --- log route mapping matches the Notion select options exactly ---
const NOTION_ROUTE_OPTIONS = new Set(["Viewing", "Price", "Layout", "Location", "Loan", "Details", "Later Busy", "Not Interested", "Complaint", "Unknown"]);
for (const route of Object.keys(ROUTE_POLICY)) {
  checkTrue(`logRouteOf(${route}) is a valid Notion option`, NOTION_ROUTE_OPTIONS.has(logRouteOf(route)));
}

// --- language guess ---
check("ZH", detectLanguage("这个多少钱"), "ZH");
check("Mixed", detectLanguage("这个 unit 多少钱"), "Mixed");
check("BM", detectLanguage("berapa harga"), "BM");
check("EN", detectLanguage("how much is it"), "EN");

// --- model pick (env override wins) ---
check("complex default", pickModel("complex", {}), "claude-sonnet-4-5");
check("simple default", pickModel("simple", {}), "claude-haiku-4-5");
check("env override", pickModel("complex", { BRAIN_MODEL_COMPLEX: "claude-x" }), "claude-x");
check("OpenAI complex default", pickModel("complex", {}, "openai"), "gpt-5.4");
check("OpenAI simple default", pickModel("simple", {}, "openai"), "gpt-5.4-nano");
check("OpenAI env override", pickModel("simple", { BRAIN_OPENAI_MODEL_SIMPLE: "gpt-custom" }, "openai"), "gpt-custom");
check("Gemini complex default", pickModel("complex", {}, "gemini"), "gemini-3.1-pro-preview");
check("Gemini simple default", pickModel("simple", {}, "gemini"), "gemini-3.5-flash");

// --- prompt guardrails ---
const cache = {
  knowledge: { facts: [{ fact: "E2 全栋只有 290 units", category: "Layout", validUntil: null }] },
  golden: { conversations: [] },
  objections: { objections: [{ says: "太贵了", intent: "要价值", direction: "psf 锚", handoff: false }] },
};
const event = { phone: "60123456789", text: "多少钱?", pushName: "Ali" };
const classified = classifyReplyText(event.text);
const { system, user } = buildPrompt({ event, classified, cache, lead: { name: "Ali" } });
checkTrue("guardrail: verified-only rule in system", system.includes("VERIFIED FACTS"));
checkTrue("guardrail: unknown-number fallback phrasing", system.includes("check 最新的资料再回你"));
checkTrue("guardrail: bargain/loan/negative -> handoff", system.includes("砍价、贷款细节、客户情绪负面"));
checkTrue("prompt carries the fact", user.includes("E2 全栋只有 290 units"));
checkTrue("prompt carries the objection", user.includes("太贵了"));
checkTrue("prompt carries the customer text", user.includes("多少钱?"));
const emptyPrompt = buildPrompt({ event, classified, cache: { knowledge: { facts: [] }, golden: {}, objections: {} }, lead: {} });
checkTrue("empty KB -> explicit warning in prompt", emptyPrompt.user.includes("库是空的"));

// --- recall: 客户之前的对话进 prompt ---
const history = [
  { direction: "outbound", source: "blast", flowTopic: "Flow 1 - Project Template", sentAt: "2026-07-10T02:00:00.000Z", text: "X".repeat(900) },
  { direction: "inbound", sentAt: "2026-07-10T03:00:00.000Z", text: "有 3 房的吗?" },
  { direction: "outbound", source: "brain", flowTopic: "ai_reply", sentAt: "2026-07-10T03:05:00.000Z", text: "有的，我发给你看看" },
];
const recalled = buildPrompt({ event, classified, cache, lead: { name: "Ali", replyText: "有 3 房的吗?" }, history });
checkTrue("recall: 历史进了 prompt", recalled.user.includes("这个客户之前的对话"));
checkTrue("recall: 客户讲的话给全文", recalled.user.includes("有 3 房的吗?"));
checkTrue("recall: 群发标成我方", recalled.user.includes("我方(群发)"));
checkTrue("recall: AI 回复标成我方", recalled.user.includes("我方(AI 回复)"));
checkTrue("recall: 出站原文不进 prompt (只给摘要)", !recalled.user.includes("X".repeat(200)));
checkTrue("recall: 历史里的数字不算已核实", recalled.user.includes("不算「已核实」"));
checkTrue("recall: 有历史就不再单独列上一条回复", !recalled.user.includes("上一条回复:"));

const noHistory = buildPrompt({ event, classified, cache, lead: { name: "Ali", replyText: "有 3 房的吗?" }, history: [] });
checkTrue("没有历史时仍然保留上一条回复", noHistory.user.includes("上一条回复:"));
checkTrue("没有历史时不该出现空的历史段落", !noHistory.user.includes("这个客户之前的对话"));

// --- buttons + callback round-trip ---
check("three buttons", draftButtons("abc").map((b) => b.data), ["ok:abc", "edit:abc", "take:abc"]);
check("parse ok", parseCallbackData("ok:abc"), { action: "ok", pendingId: "abc" });
check("parse edit", parseCallbackData("edit:x1"), { action: "edit", pendingId: "x1" });
check("parse take", parseCallbackData("take:x1"), { action: "take", pendingId: "x1" });
check("parse garbage", parseCallbackData("boom"), null);
check("action -> Notion select", ["ok", "edit", "take"].map(logActionOf), ["Sent As-Is", "Edited", "Takeover"]);

// --- draft card escapes HTML ---
const card = draftCard({ event: { ...event, text: "<b>hi</b>" }, classified, draft: "a & b", lead: { name: "Ali" }, tier: "complex" });
checkTrue("card escapes customer text", card.includes("&lt;b&gt;hi&lt;/b&gt;"));
checkTrue("card escapes draft", card.includes("a &amp; b"));
const rulesCard = draftCard({ event, classified, draft: classified.suggestedReply, lead: { name: "Ali" }, tier: "rules" });
checkTrue("rule-only card is labelled", rulesCard.includes("Rule-only"));

console.log(fail ? `${fail} test(s) failed` : "✅ all brain-core tests passed");
process.exitCode = fail ? 1 : 0;
