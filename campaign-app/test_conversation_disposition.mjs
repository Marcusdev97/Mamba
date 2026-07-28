import assert from "node:assert/strict";
import {
  conversationDisposition,
  conversationDispositionProperties,
  createConversationDispositionService,
  listConversationDispositions,
} from "./lib/conversation-disposition-service.mjs";

const device = {
  id: "device-test",
  senderPhones: ["601100000001"],
};
const baseRecord = {
  id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  phone: "60112223333",
  name: "Test Lead",
  project: "Test Project",
  status: "Replied",
  sequenceStatus: "Human Takeover",
  nextAction: "Human Takeover",
  aiCategory: "Unknown",
  followUpAt: "2026-07-29T02:00:00.000Z",
  stopFlag: false,
  assignedSenderKey: "device-test::601100000001",
};
const schema = {
  Status: { type: "select" },
  "Sequence Status": { type: "select" },
  "Next Action": { type: "select" },
  "AI Category": { type: "select" },
  "Reply Checked At": { type: "date" },
  "Follow Up At": { type: "date" },
  "Stop Flag": { type: "checkbox" },
  "Stop Reason": { type: "rich_text" },
};

assert.deepEqual(
  listConversationDispositions().map((item) => item.key),
  ["INTERESTED", "FOLLOW_UP", "NOT_INTERESTED", "DO_NOT_CONTACT"],
);
assert.equal(conversationDisposition("not_interested")?.status, "Not Interested");

const fixedNow = new Date("2026-07-28T06:00:00.000Z");
const notInterestedProps = conversationDispositionProperties(
  schema,
  conversationDisposition("NOT_INTERESTED"),
  { now: fixedNow },
);
assert.equal(notInterestedProps.Status.select.name, "Not Interested");
assert.equal(notInterestedProps["Sequence Status"].select.name, "Not Interested");
assert.equal(notInterestedProps["Next Action"].select.name, "No Action");
assert.equal(notInterestedProps["Follow Up At"].date, null);
assert.equal(notInterestedProps["Stop Flag"], undefined, "soft rejection must not become global STOP");

{
  const notionCalls = [];
  let cachedRecords = [baseRecord];
  const historyEntries = [];
  const service = createConversationDispositionService({
    hasBlastDatabase: true,
    blastDatabaseId: "database-id",
    notion: async (method, pathname, body) => {
      notionCalls.push({ method, pathname, body });
      if (method === "GET") return { properties: schema };
      return { ok: true };
    },
    queryNotionRows: async () => [baseRecord],
    readCache: async () => ({ records: cachedRecords }),
    writeCache: async (records) => { cachedRecords = records; },
    normalizePhone: (phone) => String(phone || "").replace(/\D/g, ""),
    device,
    history: { append: async (_phone, entry) => historyEntries.push(entry) },
    updateLocalDisposition: async () => ({ updated: 1 }),
    clock: () => fixedNow,
  });

  const result = await service.apply({
    id: baseRecord.id,
    phone: baseRecord.phone,
    dispositionKey: "NOT_INTERESTED",
  });
  assert.equal(result.status, "Not Interested");
  assert.equal(result.stopFlag, false);
  assert.equal(notionCalls.at(-1).method, "PATCH");
  assert.equal(notionCalls.at(-1).body.properties.Status.select.name, "Not Interested");
  assert.equal(cachedRecords[0].status, "Not Interested");
  assert.equal(cachedRecords[0].sequenceStatus, "Not Interested");
  assert.equal(cachedRecords[0].followUpAt, null);
  assert.equal(historyEntries[0].source, "quick_remark");
}

{
  const order = [];
  let cachedRecords = [baseRecord];
  const service = createConversationDispositionService({
    hasBlastDatabase: true,
    blastDatabaseId: "database-id",
    notion: async (method) => {
      if (method === "GET") return { properties: schema };
      order.push("notion");
      return { ok: true };
    },
    queryNotionRows: async () => [baseRecord],
    readCache: async () => ({ records: cachedRecords }),
    writeCache: async (records) => { cachedRecords = records; },
    normalizePhone: (phone) => String(phone || "").replace(/\D/g, ""),
    device,
    updateLocalDisposition: async () => { order.push("local"); return { updated: 1 }; },
    addLocalStop: async () => { order.push("local-stop"); },
    clock: () => fixedNow,
  });

  const result = await service.apply({
    id: baseRecord.id,
    phone: baseRecord.phone,
    dispositionKey: "DO_NOT_CONTACT",
  });
  assert.deepEqual(order, ["local", "local-stop", "notion"], "DNC must fail closed locally before Notion");
  assert.equal(result.stopFlag, true);
  assert.equal(cachedRecords[0].stopFlag, true);
  assert.equal(cachedRecords[0].stopReason, "Manual: Do Not Contact");
}

{
  const stoppedRecord = { ...baseRecord, stopFlag: true, status: "Stop" };
  const service = createConversationDispositionService({
    hasBlastDatabase: true,
    blastDatabaseId: "database-id",
    notion: async () => { throw new Error("Notion must not be called"); },
    queryNotionRows: async () => [stoppedRecord],
    readCache: async () => ({ records: [stoppedRecord] }),
    writeCache: async () => {},
    normalizePhone: (phone) => String(phone || ""),
    device,
    updateLocalDisposition: async () => ({ updated: 1 }),
  });
  await assert.rejects(
    service.apply({ id: stoppedRecord.id, dispositionKey: "INTERESTED" }),
    (error) => error.statusCode === 409 && /不会解除全局 STOP/.test(error.message),
  );
}

{
  let localApplied = 0;
  const service = createConversationDispositionService({
    hasBlastDatabase: true,
    blastDatabaseId: "database-id",
    notion: async () => { throw new Error("offline"); },
    queryNotionRows: async () => [baseRecord],
    readCache: async () => ({ records: [baseRecord] }),
    writeCache: async () => {},
    normalizePhone: (phone) => String(phone || ""),
    device,
    updateLocalDisposition: async () => { localApplied += 1; return { updated: 1 }; },
  });
  await assert.rejects(
    service.apply({ id: baseRecord.id, dispositionKey: "NOT_INTERESTED" }),
    (error) => error.statusCode === 502 && error.details?.localApplied === true,
  );
  assert.equal(localApplied, 1, "local disposition must survive a Notion outage");
}

console.log("conversation disposition tests passed");
