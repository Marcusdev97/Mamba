// Shared flow-sequence map + reply classifier for the Mamba campaign system.
//
// One source of truth used by BOTH notion_upload.mjs (sets the initial flow
// state after Flow 1) and morning_followup.mjs (classifies replies, decides
// whether the automatic sequence continues).
//
// Flow 5 (Furnished List) and Flow 9 (Rental) are intentionally NOT in the
// automatic chain — they are conditional and only sent when a lead is manually
// tagged as suitable. The chain skips 4 -> 6 on purpose.

export const FLOW_SEQUENCE = [
  { key: "flow_1", label: "Flow 1 - Project Template", next: "flow_2", dueDays: 2, cohortDay: "Day 0" },
  { key: "flow_2", label: "Flow 2 - Layout", next: "flow_3", dueDays: 2, cohortDay: "Day 2" },
  { key: "flow_3", label: "Flow 3 - Location", next: "flow_4", dueDays: 2, cohortDay: "Day 4" },
  { key: "flow_4", label: "Flow 4 - Package", next: "flow_6", dueDays: 3, cohortDay: "Day 6" },
  { key: "flow_6", label: "Flow 6 - Price", next: "flow_7", dueDays: 3, cohortDay: "Day 9" },
  { key: "flow_7", label: "Flow 7 - Facilities", next: "flow_8", dueDays: 3, cohortDay: "Day 12" },
  { key: "flow_8", label: "Flow 8 - Invitation", next: null, dueDays: null, cohortDay: "Day 15" },
];

const BY_KEY = new Map(FLOW_SEQUENCE.map((f) => [f.key, f]));
const BY_LABEL = new Map(FLOW_SEQUENCE.map((f) => [f.label, f]));

export function getFlow(key) {
  return BY_KEY.get(key) ?? null;
}

export function flowByLabel(label) {
  return BY_LABEL.get(label) ?? null;
}

// The flow that comes after `key`, or null if this was the last automatic flow.
export function nextFlowOf(key) {
  const flow = getFlow(key);
  if (!flow || !flow.next) return null;
  return getFlow(flow.next);
}

// Given the flow we just sent, return the state to stamp on the lead:
//   { lastFlowLabel, nextFlowLabel, cohortDay, dueDays }
// nextFlowLabel is "Completed" when there is no next automatic flow.
export function flowStateAfter(key) {
  const flow = getFlow(key);
  if (!flow) return null;
  const next = nextFlowOf(key);
  return {
    lastFlowLabel: flow.label,
    nextFlowLabel: next ? next.label : "Completed",
    cohortDay: flow.cohortDay,
    dueDays: flow.dueDays,
  };
}

// Deterministic, rule-based reply classifier. Rule-based on purpose for the MVP
// (safer/cheaper than AI). Returns the four values the rest of the system needs.
// Option names below MUST match the Notion select options exactly:
//   status         -> Blast Leads "Status"          (Warm/Replied/Not Interested/Stop)
//   sequenceStatus -> Blast Leads "Sequence Status" (Human Takeover/Not Interested/Stopped)
//   nextAction     -> Blast Leads "Next Action"     (Send Price List/Ask Viewing/Human Takeover/No Action)
export function classifyReplyText(text) {
  const cleaned = String(text || "").toLowerCase();

  // --- Reply Routes (from "Mamba | Reply Routes") — priority order matters ---
  // Each returns: route, status, sequenceStatus, nextAction, aiCategory, stopFlag, signal, suggestedReply.
  // signal drives the row color the operator sees: "RED" (stop) / "GREEN" (warm) / "GREY" (neutral).

  // 1) STOP_DNC — always highest priority.
  // Fix (2026-07): bare /stop|remove|block/ false-positived on normal questions
  // like "how many stops to TRX?" or "2 blocks away?". Now: explicit stop PHRASES
  // always match; bare keywords only count when the whole message is short (<= 20
  // chars), i.e. a standalone "stop" / "别发了", not a word inside a real question.
  const stopPhrase = /(please ?stop|stop (messaging|sending|texting|contacting)|\bunsubscribe\b|do ?not ?contact|don'?t ?contact( me)?|\bremove me\b|\bblock me\b|不要再发|不要联系|别再发|请停止|停止发|jangan mesej|jangan contact|jangan hantar)/i;
  const stopBareShort = cleaned.length <= 20 && /(\bstop\b|\bremove\b|\bblock\b|停止|别发|勿扰)/i.test(cleaned);
  if (stopPhrase.test(cleaned) || stopBareShort) {
    return { route: "STOP_DNC", status: "Stop", sequenceStatus: "Stopped", nextAction: "No Action", aiCategory: "Stop", stopFlag: true, signal: "RED", suggestedReply: "明白，不会再发信息给你。不好意思打扰了。" };
  }
  // 2) COMPLAINT — angry / scam / report -> stop + human takeover.
  // Fix (2026-07): bare 烦 matched inside 麻烦 ("麻烦 send 价格给我" is a HOT lead,
  // was being stop-flagged as a complaint). Only explicit complaint phrases now.
  if (/(scam|spam|\breport\b|harass|annoying|骗人|垃圾信息|投诉|骚扰|很烦|太烦|烦死|好烦|别烦|烦不烦|tipu)/i.test(cleaned)) {
    return { route: "COMPLAINT", status: "Stop", sequenceStatus: "Human Takeover", nextAction: "Human Takeover", aiCategory: "Stop", stopFlag: true, signal: "RED", suggestedReply: "不好意思打扰你了。我这边会停止联系。" };
  }
  // 3) Actionable requests — these WIN over a soft "not interested" (rule 2).
  if (/(view|visit|appointment|show ?unit|showroom|看房|参观|约时间|现场|boleh view|boleh tengok)/i.test(cleaned)) {
    return { route: "VIEWING_REQUEST", status: "Appointment", sequenceStatus: "Human Takeover", nextAction: "Ask Viewing", aiCategory: "Viewing Request", stopFlag: false, signal: "GREEN", suggestedReply: "可以安排。你比较方便 weekday 还是 weekend？我帮你看 slot。" };
  }
  if (/(price|how ?much|package|rebate|discount|多少钱|几钱|价格|配套|回扣|berapa|harga)/i.test(cleaned)) {
    return { route: "PRICE_REQUEST", status: "Warm", sequenceStatus: "Human Takeover", nextAction: "Send Price List", aiCategory: "Price Inquiry", stopFlag: false, signal: "GREEN", suggestedReply: "可以的，我先发你价格范围参考。主要看你要 2房还是 3房。" };
  }
  if (/(loan|bank|salary|payslip|monthly|installment|月供|供多少|贷款|银行|薪水|gaji|ansuran|bayaran bulanan)/i.test(cleaned)) {
    return { route: "LOAN_MONTHLY_REQUEST", status: "Warm", sequenceStatus: "Human Takeover", nextAction: "Ask Budget", aiCategory: "Warm", stopFlag: false, signal: "GREEN", suggestedReply: "可以，我帮你大概算月供方向。你预算大概看多少以内？" };
  }
  if (/(size|layout|floor ?plan|sqft|bedroom|room|2房|3房|户型|面积|平方尺|keluasan|bilik)/i.test(cleaned)) {
    return { route: "LAYOUT_REQUEST", status: "Warm", sequenceStatus: "Human Takeover", nextAction: "Send Brochure", aiCategory: "Warm", stopFlag: false, signal: "GREEN", suggestedReply: "有 2房和 3房选择，我 send layout 给你看，你比较偏小单位还是家庭型？" };
  }
  if (/(location|where|address|map|nearby|distance|\bmrt\b|\blrt\b|\btrx\b|\bklcc\b|station|地点|位置|地址|在哪里|靠近|车站|地铁|dekat mana|lokasi|stesen)/i.test(cleaned)) {
    return { route: "LOCATION_REQUEST", status: "Warm", sequenceStatus: "Human Takeover", nextAction: "Send Brochure", aiCategory: "Warm", stopFlag: false, signal: "GREEN", suggestedReply: "这个在 Old Klang Road / Mid Valley 一带。我可以 send map location 给你参考。" };
  }
  if (/(details|info|brochure|send ?me|can ?send|share|资料|详情|发来看|可以send|可以发|boleh share|boleh send)/i.test(cleaned)) {
    return { route: "DETAILS_REQUEST", status: "Warm", sequenceStatus: "Human Takeover", nextAction: "Send Brochure", aiCategory: "Brochure Request", stopFlag: false, signal: "GREEN", suggestedReply: "可以，我 send 资料给你看。你比较想看价格、地点还是户型先？" };
  }
  // 4) NOT_INTERESTED — soft reject, no actionable request found above.
  if (/(not interested|no need|no thanks|不要了|没兴趣|暂时不用|不需要|tak berminat|tak nak)/i.test(cleaned)) {
    return { route: "NOT_INTERESTED", status: "Not Interested", sequenceStatus: "Not Interested", nextAction: "No Action", aiCategory: "Not Interested", stopFlag: false, signal: "GREY", suggestedReply: "明白的，不打扰你。之后如果有看 KL property 再找我就可以。" };
  }
  // 5) AGENT / WRONG TARGET / ALREADY BOUGHT.
  if (/(agent|already ?bought|bought ?already|owner|wrong ?number|已买|已经买了|我是agent|错号码|salah nombor)/i.test(cleaned)) {
    return { route: "AGENT_OR_WRONG_TARGET", status: "Cold", sequenceStatus: "Not Interested", nextAction: "No Action", aiCategory: "Unknown", stopFlag: false, signal: "GREY", suggestedReply: "明白，谢谢你回复。我这边会更新记录，不再用这个方向跟进。" };
  }
  // 6) LATER / BUSY.
  if (/(later|busy|next ?time|迟点|之后|现在忙|晚点|下次|nanti|sibuk)/i.test(cleaned)) {
    return { route: "LATER_BUSY", status: "Follow Up", sequenceStatus: "Human Takeover", nextAction: "Human Takeover", aiCategory: "Warm", stopFlag: false, signal: "GREEN", suggestedReply: "没问题，我迟点再 follow up。你方便的话我可以先 send 简单资料给你留着看。" };
  }
  // 7) UNKNOWN — unclear -> human review.
  return { route: "UNKNOWN_MANUAL_REVIEW", status: "Replied", sequenceStatus: "Human Takeover", nextAction: "Human Takeover", aiCategory: "Unknown", stopFlag: false, signal: "GREY", suggestedReply: "先不要自动回复，人工判断客户真实意思。" };
}
