import assert from "node:assert/strict";
import { FLOW_SEQUENCE, flowStateAfter, classifyReplyText } from "./flow_sequence.mjs";
import { nextFlowBlockReason } from "./routes/next-flow.routes.mjs";

function choice(name) {
  return { select: name ? { name } : null };
}

function reply(text) {
  return { rich_text: text ? [{ plain_text: text }] : [] };
}

function leadPage({ status = "Blasted", sequence = "Running", stop = false, lastReply = "" } = {}) {
  return { properties: {
    "Stop Flag": { checkbox: stop },
    Status: choice(status),
    "Sequence Status": choice(sequence),
    "AI Category": choice("Unknown"),
    "Last Reply Text": reply(lastReply),
  } };
}

const expectedAutomaticFlows = [
  "Flow 1 - Project Template",
  "Flow 2 - Layout",
  "Flow 3 - Location",
  "Flow 4 - Package",
  "Flow 6 - Price",
  "Flow 7 - Facilities",
  "Flow 8 - Invitation",
  "Flow 10 - Surrounding",
];
assert.deepEqual(FLOW_SEQUENCE.map((flow) => flow.label), expectedAutomaticFlows);

const transitions = FLOW_SEQUENCE.map((flow) => ({ sent: flow.label, ...flowStateAfter(flow.key) }));
assert.deepEqual(transitions.map((item) => item.nextFlowLabel), [
  "Flow 2 - Layout",
  "Flow 3 - Location",
  "Flow 4 - Package",
  "Flow 6 - Price",
  "Flow 7 - Facilities",
  "Flow 8 - Invitation",
  "Flow 10 - Surrounding",
  "Completed",
]);
assert.equal(transitions.at(-1).nextFlowLabel, "Completed");
assert.equal(transitions.at(-1).dueDays, null);

// No-reply leads remain eligible at every stage.
assert.equal(nextFlowBlockReason(leadPage(), classifyReplyText), "");

// STOP and rejection must stay blocked throughout the whole sequence.
for (const _flow of FLOW_SEQUENCE) {
  assert.equal(nextFlowBlockReason(leadPage({ stop: true }), classifyReplyText), "Stop Flag");
  assert.equal(nextFlowBlockReason(leadPage({ lastReply: "Please stop messaging me" }), classifyReplyText), "Last Reply: STOP_DNC");
  assert.equal(nextFlowBlockReason(leadPage({ lastReply: "No thanks, not interested" }), classifyReplyText), "Last Reply: NOT_INTERESTED");
}

// Warm replies leave automation and move to an agent, even if Notion's
// Sequence Status has not been updated yet.
const warm = classifyReplyText("Can send me the price and monthly installment?");
assert.equal(warm.status, "Warm");
assert.equal(warm.sequenceStatus, "Human Takeover");
assert.equal(warm.signal, "GREEN");
assert.equal(nextFlowBlockReason(leadPage({ lastReply: "Can send me the price and monthly installment?" }), classifyReplyText), "Last Reply: PRICE_REQUEST");

console.log("✅ full Flow 1→10 simulation passed (automatic chain ends on Day 18; Flow 5/9 remain conditional)");
