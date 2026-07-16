import assert from "node:assert/strict";
import { createOutboundFollowUpService, findHandledOutbound, isOutboundFollowUpCandidate, nextFollowUpAt } from "./lib/outbound-follow-up-service.mjs";

const now = new Date("2026-07-14T04:00:00.000Z");
assert.equal(nextFollowUpAt(now), "2026-07-15T02:00:00.000Z");

const candidate = {
  id: "lead-1",
  phone: "60123456789",
  status: "Warm",
  sequenceStatus: "Human Takeover",
  nextAction: "Send Price",
  lastReplyAt: "2026-07-14T02:00:00.000Z",
  followUpAt: "2026-07-14T03:00:00.000Z",
  senderInstance: "wa_01",
};
assert.equal(isOutboundFollowUpCandidate(candidate, now.getTime()), true);
assert.equal(isOutboundFollowUpCandidate({ ...candidate, sequenceStatus: "Running" }, now.getTime()), false);
assert.equal(isOutboundFollowUpCandidate({ ...candidate, stopFlag: true }, now.getTime()), false);
assert.equal(isOutboundFollowUpCandidate({ ...candidate, followUpAt: "2026-07-15T03:00:00.000Z" }, now.getTime()), false);

const message = (id, fromMe, timestamp, phone = "60123456789") => ({
  key: { id, fromMe, remoteJid: `${phone}@s.whatsapp.net` },
  messageTimestamp: timestamp,
  message: { conversation: id },
});
const handled = findHandledOutbound([
  candidate,
  { ...candidate, id: "running-flow", phone: "60111111111", sequenceStatus: "Running" },
], [
  message("customer-reply", false, new Date("2026-07-14T02:30:00.000Z").getTime()),
  message("old-sales-message", true, new Date("2026-07-14T01:30:00.000Z").getTime()),
  message("manual-sales-reply", true, new Date("2026-07-14T03:30:00.000Z").getTime()),
  message("flow-message", true, new Date("2026-07-14T03:40:00.000Z").getTime(), "60111111111"),
], {
  normalizePhone: (value) => String(value || "").replace(/\D/g, ""),
  resolvePhone: (item) => item.key.remoteJid.split("@")[0],
  messageTime: (item) => item.messageTimestamp,
  instanceName: "wa_01",
  now: now.getTime(),
});
assert.equal(handled.length, 1);
assert.equal(handled[0].message.key.id, "manual-sales-reply");

const oldOutbound = findHandledOutbound([candidate], [
  message("yesterday-sales-reply", true, new Date("2026-07-13T03:30:00.000Z").getTime()),
], {
  normalizePhone: (value) => String(value || "").replace(/\D/g, ""),
  resolvePhone: (item) => item.key.remoteJid.split("@")[0],
  messageTime: (item) => item.messageTimestamp,
  instanceName: "wa_01",
  now: now.getTime(),
});
assert.equal(oldOutbound.length, 0, "an old outbound message cannot repeatedly clear today's queue");

const notionCalls = [];
let cacheWrites = 0;
const liveNow = Date.now();
const liveCandidate = {
  ...candidate,
  lastReplyAt: new Date(liveNow - 10 * 60 * 1000).toISOString(),
  followUpAt: null,
};
const service = createOutboundFollowUpService({
  blastDatabaseId: "database123",
  api: async () => ({ messages: [message("manual-sales-reply", true, liveNow - 5 * 60 * 1000)] }),
  notion: async (method, apiPath, body) => {
    notionCalls.push({ method, apiPath, body });
    if (method === "GET") return { properties: { "Follow Up At": { type: "date" }, "Reply Checked At": { type: "date" } } };
    return { ok: true };
  },
  openInstances: async () => [{ name: "wa_01" }],
  normalizePhone: (value) => String(value || "").replace(/\D/g, ""),
  collectMessageObjects: (value) => value.messages || [],
  describeMessage: (item) => item.message.conversation,
  resolvePhone: (item) => item.key.remoteJid.split("@")[0],
  messageTime: (item) => item.messageTimestamp,
  queryNotionRows: async (filter) => filter ? [liveCandidate] : [],
  writeCache: async () => { cacheWrites += 1; },
  history: { append: async () => ({ added: true }) },
  systemLogs: { write: async () => {} },
  onLog: () => {},
});
const result = await service.runOnce({ reason: "test" });
assert.equal(result.error, "");
assert.equal(result.handled, 1);
assert.equal(notionCalls.filter((call) => call.method === "PATCH").length, 1);
assert.ok(notionCalls.find((call) => call.method === "PATCH").body.properties["Follow Up At"].date.start);
assert.equal(cacheWrites, 1);

let blockedApiCalls = 0;
const blockedService = createOutboundFollowUpService({
  blastDatabaseId: "database123",
  api: async () => { blockedApiCalls += 1; return {}; },
  notion: async (method) => method === "GET" ? { properties: { "Follow Up At": { type: "date" } } } : {},
  openInstances: async () => [{ name: "wa_01" }],
  normalizePhone: (value) => String(value || "").replace(/\D/g, ""),
  collectMessageObjects: () => [],
  describeMessage: () => "",
  resolvePhone: () => "",
  messageTime: () => 0,
  queryNotionRows: async () => [liveCandidate],
  filterRecords: () => [],
  writeCache: async () => {},
  systemLogs: { write: async () => {} },
  onLog: () => {},
});
const blockedResult = await blockedService.runOnce({ reason: "device-scope-test" });
assert.equal(blockedResult.checkedClients, 0);
assert.equal(blockedResult.connections, 0);
assert.equal(blockedApiCalls, 0, "an empty device scope must not scan WhatsApp history");

console.log("✅ all outbound follow-up tests passed");
