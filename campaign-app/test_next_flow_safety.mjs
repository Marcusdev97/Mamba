import assert from "node:assert/strict";
import { fetchInstanceMessagesDeep, nextFlowBlockReason, replySafetyStatus } from "./routes/next-flow.routes.mjs";
import { classifyReplyText } from "./flow_sequence.mjs";

function choice(name) {
  return { select: name ? { name } : null };
}

function reply(text) {
  return { rich_text: text ? [{ plain_text: text }] : [] };
}

function page(properties = {}) {
  return { properties: {
    "Stop Flag": { checkbox: false },
    Status: choice("Blasted"),
    "Sequence Status": choice("Running"),
    "AI Category": choice("Unknown"),
    "Last Reply Text": reply(""),
    ...properties,
  } };
}

assert.equal(nextFlowBlockReason(page(), classifyReplyText), "");
assert.equal(nextFlowBlockReason(page({ "Stop Flag": { checkbox: true } }), classifyReplyText), "Stop Flag");
assert.equal(nextFlowBlockReason(page({ Status: choice("Not Interested") }), classifyReplyText), "Status: Not Interested");
assert.equal(nextFlowBlockReason(page({ "Sequence Status": choice("Human Takeover") }), classifyReplyText), "Sequence Status: Human Takeover");
assert.equal(nextFlowBlockReason(page({ "AI Category": choice("Not Interested") }), classifyReplyText), "AI Category: Not Interested");
assert.equal(nextFlowBlockReason(page({ "Last Reply Text": reply("No thanks, not interested") }), classifyReplyText), "Last Reply: NOT_INTERESTED");
assert.equal(nextFlowBlockReason(page({ "Last Reply Text": reply("How much is the monthly installment?") }), classifyReplyText), "Last Reply: PRICE_REQUEST");
assert.equal(nextFlowBlockReason(page({ "Last Reply Text": reply("Can send me the layout?") }), classifyReplyText), "Last Reply: LAYOUT_REQUEST");
assert.equal(nextFlowBlockReason(page({ "Last Reply Text": reply("okay") }), classifyReplyText), "Last Reply: UNKNOWN_MANUAL_REVIEW");

const pagedMessages = {
  1: [{ key: { id: "M3", remoteJid: "6013@s.whatsapp.net" }, messageTimestamp: 300, message: { conversation: "new" } }],
  2: [{ key: { id: "M2", remoteJid: "6012@s.whatsapp.net" }, messageTimestamp: 200, message: { conversation: "reply" } }],
  3: [{ key: { id: "M1", remoteJid: "6011@s.whatsapp.net" }, messageTimestamp: 100, message: { conversation: "old" } }],
};
const pagesRequested = [];
const deepRuntime = {
  api: async (_path, options) => {
    const body = JSON.parse(options.body);
    pagesRequested.push(body.page);
    return { messages: { total: 3, pages: 3, currentPage: body.page, records: pagedMessages[body.page] || [] } };
  },
  collectMessageObjects: (value) => value.messages.records,
  messageTime: (message) => Number(message.messageTimestamp) * 1000,
};
const deep = await fetchInstanceMessagesDeep(deepRuntime, "wa_01", 150000, { pageSize: 1, maxPages: 10 });
assert.deepEqual(pagesRequested, [1, 2, 3]);
assert.equal(deep.messages.length, 3);
assert.equal(deep.pagesRead, 3);

const safetyNow = Date.parse("2026-07-13T04:00:00.000Z");
assert.equal(replySafetyStatus({ trackerUpdatedAt: "2026-07-13T03:55:00.000Z", now: safetyNow }).safeToSend, true);
assert.equal(replySafetyStatus({ trackerUpdatedAt: "2026-07-13T03:30:00.000Z", now: safetyNow }).safeToSend, false);
assert.equal(replySafetyStatus({ trackerUpdatedAt: "2026-07-13T03:30:00.000Z", deepCheckedAt: "2026-07-13T03:58:00.000Z", deepOk: true, now: safetyNow }).safeToSend, true);
assert.equal(replySafetyStatus({ trackerUpdatedAt: null, deepCheckedAt: "2026-07-13T03:58:00.000Z", deepOk: false, now: safetyNow }).safeToSend, false);

console.log("✅ all next-flow safety tests passed");
