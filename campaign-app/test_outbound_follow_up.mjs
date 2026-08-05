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

const overnightCandidate = {
  ...candidate,
  followUpAt: "2026-07-13T02:00:00.000Z",
  lastReplyAt: "2026-07-13T01:00:00.000Z",
};
const overnightRecovery = findHandledOutbound([overnightCandidate], [
  message("overnight-follow-up", true, new Date("2026-07-13T03:30:00.000Z").getTime()),
], {
  normalizePhone: (value) => String(value || "").replace(/\D/g, ""),
  resolvePhone: (item) => item.key.remoteJid.split("@")[0],
  messageTime: (item) => item.messageTimestamp,
  instanceName: "wa_01",
  now: now.getTime(),
});
assert.equal(overnightRecovery.length, 1, "an outbound after the due time must survive an overnight reconciliation delay");

const alreadyAdvanced = findHandledOutbound([{
  ...overnightCandidate,
  followUpAt: "2026-07-15T02:00:00.000Z",
}], [
  message("overnight-follow-up", true, new Date("2026-07-13T03:30:00.000Z").getTime()),
], {
  normalizePhone: (value) => String(value || "").replace(/\D/g, ""),
  resolvePhone: (item) => item.key.remoteJid.split("@")[0],
  messageTime: (item) => item.messageTimestamp,
  instanceName: "wa_01",
  now: new Date("2026-07-15T04:00:00.000Z").getTime(),
});
assert.equal(alreadyAdvanced.length, 0, "the same outbound cannot satisfy the next reminder after Follow Up At advances");

const notionCalls = [];
const ledgerCalls = [];
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
  conversationLog: {
    recordOutbound: async (entry, options) => {
      ledgerCalls.push({ entry, options, notionCallCount: notionCalls.length });
      return { saved: true };
    },
  },
  systemLogs: { write: async () => {} },
  onLog: () => {},
});
const result = await service.runOnce({ reason: "test" });
assert.equal(result.error, "");
assert.equal(result.handled, 1);
assert.equal(notionCalls.filter((call) => call.method === "PATCH").length, 1);
assert.ok(notionCalls.find((call) => call.method === "PATCH").body.properties["Follow Up At"].date.start);
assert.equal(ledgerCalls.length, 1);
assert.equal(ledgerCalls[0].entry.messageId, "manual-sales-reply");
assert.equal(ledgerCalls[0].entry.source, "phone");
assert.equal(ledgerCalls[0].entry.flowTopic, "follow_up");
assert.deepEqual(ledgerCalls[0].options, { requireExisting: true });
assert.equal(ledgerCalls[0].notionCallCount, 1, "SQLite ledger must be written after schema read but before the Notion PATCH");
assert.equal(cacheWrites, 1);

const localFailureNotionCalls = [];
const localFailureService = createOutboundFollowUpService({
  blastDatabaseId: "database123",
  api: async () => ({ messages: [message("local-write-failure", true, liveNow - 5 * 60 * 1000)] }),
  notion: async (method, apiPath, body) => {
    localFailureNotionCalls.push({ method, apiPath, body });
    return method === "GET"
      ? { properties: { "Follow Up At": { type: "date" } } }
      : { ok: true };
  },
  openInstances: async () => [{ name: "wa_01" }],
  normalizePhone: (value) => String(value || "").replace(/\D/g, ""),
  collectMessageObjects: (value) => value.messages || [],
  describeMessage: (item) => item.message.conversation,
  resolvePhone: (item) => item.key.remoteJid.split("@")[0],
  messageTime: (item) => item.messageTimestamp,
  queryNotionRows: async () => [liveCandidate],
  writeCache: async () => {},
  history: { append: async () => ({ added: true }) },
  conversationLog: { recordOutbound: async () => { throw new Error("sqlite unavailable"); } },
  systemLogs: { write: async () => {} },
  onLog: () => {},
});
const localFailureResult = await localFailureService.runOnce({ reason: "local-ledger-failure" });
assert.equal(localFailureResult.handled, 0);
assert.match(localFailureResult.error, /sqlite unavailable/);
assert.equal(
  localFailureNotionCalls.filter((call) => call.method === "PATCH").length,
  0,
  "Notion reminder must not advance when the local conversation ledger could not record the message",
);

const rejectedLedgerNotionCalls = [];
const rejectedLedgerService = createOutboundFollowUpService({
  blastDatabaseId: "database123",
  api: async () => ({ messages: [message("missing-conversation", true, liveNow - 5 * 60 * 1000)] }),
  notion: async (method, apiPath, body) => {
    rejectedLedgerNotionCalls.push({ method, apiPath, body });
    return method === "GET"
      ? { properties: { "Follow Up At": { type: "date" } } }
      : { ok: true };
  },
  openInstances: async () => [{ name: "wa_01" }],
  normalizePhone: (value) => String(value || "").replace(/\D/g, ""),
  collectMessageObjects: (value) => value.messages || [],
  describeMessage: (item) => item.message.conversation,
  resolvePhone: (item) => item.key.remoteJid.split("@")[0],
  messageTime: (item) => item.messageTimestamp,
  queryNotionRows: async () => [liveCandidate],
  writeCache: async () => {},
  history: { append: async () => ({ added: true }) },
  conversationLog: { recordOutbound: async () => ({ saved: false, reason: "no_conversation" }) },
  systemLogs: { write: async () => {} },
  onLog: () => {},
});
const rejectedLedgerResult = await rejectedLedgerService.runOnce({ reason: "missing-conversation" });
assert.equal(rejectedLedgerResult.handled, 0);
assert.match(rejectedLedgerResult.error, /no_conversation/);
assert.equal(rejectedLedgerNotionCalls.filter((call) => call.method === "PATCH").length, 0);

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

const connectionLogs = [];
const disconnectedService = createOutboundFollowUpService({
  blastDatabaseId: "database123",
  api: async () => { throw new Error("fetch failed"); },
  notion: async (method) => method === "GET" ? { properties: { "Follow Up At": { type: "date" } } } : {},
  openInstances: async () => [{ name: "wa_01" }, { name: "wa_03" }],
  normalizePhone: (value) => String(value || "").replace(/\D/g, ""),
  collectMessageObjects: () => [],
  describeMessage: () => "",
  resolvePhone: () => "",
  messageTime: () => 0,
  queryNotionRows: async () => [liveCandidate],
  writeCache: async () => {},
  systemLogs: { write: async (entry) => { connectionLogs.push(entry); } },
  onLog: () => {},
});
const disconnectedResult = await disconnectedService.runOnce({ reason: "connection-test" });
assert.match(disconnectedResult.error, /全部 WhatsApp connection 核对失败/);
assert.equal(connectionLogs.at(-1).event, "WHATSAPP_NOT_CONNECTED");
assert.doesNotMatch(connectionLogs.at(-1).message, /Notion 当下比较慢/);


// --- 号码全部离线：要讲得出「去重新扫码」，而且不可以每 30 分钟刷一次 ---
{
  const written = [];
  let online = false;
  const offlineService = createOutboundFollowUpService({
    blastDatabaseId: "database123",
    api: async () => ({ messages: [] }),
    notion: async (method) => (method === "GET"
      ? { properties: { "Follow Up At": { type: "date" } } }
      : { ok: true }),
    // 先全部离线，之后恢复一个号码。
    openInstances: async () => (online ? [{ name: "wa_01" }] : []),
    normalizePhone: (value) => String(value || "").replace(/\D/g, ""),
    collectMessageObjects: (value) => value.messages || [],
    describeMessage: () => "",
    resolvePhone: (item) => item.key.remoteJid.split("@")[0],
    messageTime: (item) => item.messageTimestamp,
    queryNotionRows: async (filter) => (filter ? [liveCandidate] : []),
    writeCache: async () => {},
    history: { append: async () => ({ added: true }) },
    conversationLog: { recordOutbound: async () => ({ saved: true }) },
    systemLogs: { write: async (entry) => written.push(entry) },
    onLog: () => {},
  });

  const first = await offlineService.runOnce({ reason: "test" });
  assert.match(first.error, /没有 OPEN 的 WhatsApp connection/);
  const failures = written.filter((item) => item.level === "warn");
  assert.equal(failures.length, 1);
  assert.equal(failures[0].event, "WHATSAPP_ALL_INSTANCES_OFFLINE",
    "以前这里是 UNEXPECTED_ERROR，看不出该做什么");
  assert.match(failures[0].message, /重新扫码/);

  // 同一个故障重复跑，不可以再记一次 —— 否则 System Logs 会被淹掉。
  await offlineService.runOnce({ reason: "test" });
  await offlineService.runOnce({ reason: "test" });
  assert.equal(written.filter((item) => item.level === "warn").length, 1,
    "同一个故障只记一次");

  // 恢复后要留下一笔，才看得出断线区间什么时候结束。
  online = true;
  await offlineService.runOnce({ reason: "test" });
  assert.ok(written.some((item) => item.event === "outbound_follow_up_recovered"),
    "恢复必须留痕");
}

console.log("✅ all outbound follow-up tests passed");
