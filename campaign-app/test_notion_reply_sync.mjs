import assert from "node:assert/strict";
import { buildLeadReplyProperties, NotionSync } from "./notion_sync.mjs";

const schema = {
  Status: { type: "select" },
  "Sequence Status": { type: "select" },
  "AI Category": { type: "select" },
  "Next Action": { type: "select" },
};

const rejected = buildLeadReplyProperties(schema, {
  receivedAt: "2026-07-11T02:00:00.000Z",
  text: "not interested",
  status: "Not Interested",
  sequenceStatus: "Not Interested",
  nextAction: "No Action",
  aiCategory: "Not Interested",
  route: "NOT_INTERESTED",
  signal: "GREY",
  stopFlag: false,
  suggestedReply: "Noted",
}, 2, "2026-07-11T02:00:01.000Z");

assert.equal(rejected.Status.select.name, "Not Interested");
assert.equal(rejected["Sequence Status"].select.name, "Not Interested");
assert.equal(rejected["Next Action"].select.name, "No Action");
assert.equal(rejected["Reply Count"].number, 2);
assert.equal(rejected["Reply Checked At"].date.start, "2026-07-11T02:00:01.000Z");
assert.equal(rejected["Stop Flag"], undefined);

const stopped = buildLeadReplyProperties(schema, {
  receivedAt: "2026-07-11T02:00:00.000Z",
  text: "stop messaging me",
  status: "Stop",
  sequenceStatus: "Stopped",
  nextAction: "No Action",
  aiCategory: "Stop",
  route: "STOP_DNC",
  signal: "RED",
  stopFlag: true,
}, 1, "2026-07-11T02:00:01.000Z");

assert.equal(stopped["Sequence Status"].select.name, "Stopped");
assert.equal(stopped["Stop Flag"].checkbox, true);
assert.match(stopped["Stop Reason"].rich_text[0].text.content, /STOP_DNC/);

const crossPc = new NotionSync({ token: "test", config: { databases: {}, dataSources: {} } });
crossPc.state = { leadPages: {}, syncedReplyIds: {}, creditedResponses: {} };
crossPc.getBlastSchema = async () => schema;
crossPc.findLeadByPhone = async () => ({
  id: "page-cross-pc",
  properties: {
    "Reply Count": { number: 0 },
    "Template Sent": { relation: [] },
    "Stop Flag": { checkbox: false },
  },
});
crossPc.saveState = async () => {};
crossPc.creditResponse = async () => {};
let updatedProperties;
crossPc.updatePage = async (_id, properties) => {
  updatedProperties = properties;
  return { id: "page-cross-pc" };
};

const crossPcResult = await crossPc.upsertLeadReply({
  id: "msg-cross-pc",
  phone: "60123456789",
  receivedAt: "2026-07-11T02:00:00.000Z",
  text: "not interested",
  status: "Not Interested",
  sequenceStatus: "Not Interested",
  nextAction: "No Action",
  aiCategory: "Not Interested",
  route: "NOT_INTERESTED",
  signal: "GREY",
}, { createIfMissing: false });

assert.equal(crossPcResult.matched, true);
assert.equal(crossPcResult.action, "updated");
assert.equal(updatedProperties["Sequence Status"].select.name, "Not Interested");

const stranger = new NotionSync({ token: "test", config: { databases: {}, dataSources: {} } });
stranger.state = { leadPages: {}, syncedReplyIds: {}, creditedResponses: {} };
stranger.getBlastSchema = async () => schema;
stranger.findLeadByPhone = async () => null;
let strangerCreated = false;
stranger.request = async () => { strangerCreated = true; };
const strangerResult = await stranger.upsertLeadReply({
  id: "msg-stranger",
  phone: "60199999999",
  text: "hello",
}, { createIfMissing: false });
assert.equal(strangerResult.matched, false);
assert.equal(strangerResult.action, "not_found");
assert.equal(strangerCreated, false);

console.log("✅ all Notion reply-sync tests passed");
