// test_classifier.mjs — regression tests for classifyReplyText.
// Run: node test_classifier.mjs
// Rule: EVERY time you touch a regex in flow_sequence.mjs, run this first.
// Add new cases from real replies (campaign-data/replies.jsonl) every 2 weeks.

import { classifyReplyText } from "./flow_sequence.mjs";

const cases = [
  // --- STOP_DNC: real opt-outs must stop ---
  ["please stop messaging me", "STOP_DNC"],
  ["stop", "STOP_DNC"],
  ["STOP", "STOP_DNC"],
  ["不要再发了", "STOP_DNC"],
  ["别再发", "STOP_DNC"],
  ["jangan mesej saya", "STOP_DNC"],
  ["unsubscribe", "STOP_DNC"],
  ["remove me from your list", "STOP_DNC"],

  // --- STOP_DNC false positives: normal questions must NOT stop ---
  ["how many stops to TRX?", "LOCATION_REQUEST"],
  ["is it 2 blocks away from the mall? can send location?", "LOCATION_REQUEST"],
  ["got bus stop nearby the project?", "LOCATION_REQUEST"],

  // --- COMPLAINT: real complaints must stop ---
  ["this is spam", "COMPLAINT"],
  ["scam la you all", "COMPLAINT"],
  ["很烦一直发", "COMPLAINT"],
  ["投诉你", "COMPLAINT"],

  // --- COMPLAINT false positive: 麻烦 = polite request, must stay WARM ---
  ["麻烦 send 价格给我", "PRICE_REQUEST"],
  ["麻烦你 share layout", "LAYOUT_REQUEST"],
  ["麻烦发资料给我看看", "DETAILS_REQUEST"],

  // --- Actionable requests win over soft no ---
  ["not interested but can send price see see", "PRICE_REQUEST"],
  ["boleh view unit tak?", "VIEWING_REQUEST"],
  ["showroom 在哪里 可以参观吗", "VIEWING_REQUEST"],
  ["价格多少钱", "PRICE_REQUEST"],
  ["berapa harga?", "PRICE_REQUEST"],
  ["月供大概供多少", "LOAN_MONTHLY_REQUEST"],
  ["有 3房 吗 面积多大", "LAYOUT_REQUEST"],
  ["boleh share brochure?", "DETAILS_REQUEST"],

  // --- Soft rejections ---
  ["not interested", "NOT_INTERESTED"],
  ["没兴趣", "NOT_INTERESTED"],
  ["tak berminat", "NOT_INTERESTED"],
  ["i am agent also", "AGENT_OR_WRONG_TARGET"],
  ["已经买了", "AGENT_OR_WRONG_TARGET"],

  // --- Later / busy ---
  ["现在忙 迟点讲", "LATER_BUSY"],
  ["nanti la, sibuk sekarang", "LATER_BUSY"],

  // --- Unknown -> human ---
  ["ok", "UNKNOWN_MANUAL_REVIEW"],
  ["hmm", "UNKNOWN_MANUAL_REVIEW"],
];

let fail = 0;
for (const [text, expected] of cases) {
  const got = classifyReplyText(text);
  if (got.route !== expected) {
    fail++;
    console.log(`❌ "${text}"\n   got ${got.route}, expected ${expected}`);
  }
}
console.log(fail === 0 ? `✅ ${cases.length}/${cases.length} passed` : `\n${fail}/${cases.length} FAILED — do not deploy.`);
process.exit(fail === 0 ? 0 : 1);
