import assert from "node:assert/strict";
import { createEvolutionHistorySync } from "./lib/evolution-history-sync.mjs";

function rawMessage({ id, phone, fromMe, timestamp, text = "hello", jid = "" }) {
  return {
    id: `db_${id}`,
    key: {
      id,
      fromMe,
      remoteJid: jid || `${phone}@s.whatsapp.net`,
    },
    messageTimestamp: timestamp,
    messageType: "conversation",
    message: { conversation: text },
    pushName: fromMe ? "" : "Customer",
  };
}

function fakeConversationLog({ initialIds = [], initialState = null } = {}) {
  const ids = new Set(initialIds);
  const states = new Map(initialState ? [[initialState.instance, initialState]] : []);
  const savedStates = [];
  const inbound = [];
  const outbound = [];

  function report(rows, target, idKey) {
    for (const row of rows) {
      target.push(row);
      ids.add(row[idKey]);
    }
    return { written: rows.length, failed: [] };
  }

  return {
    inbound,
    outbound,
    savedStates,
    async stats() {
      return {
        messages: ids.size,
        inbound: inbound.length,
        outbound: outbound.length,
        contactsWithReplies: inbound.length ? 1 : 0,
      };
    },
    async recordReplies(rows) {
      return report(rows, inbound, "id");
    },
    async recordOutbounds(rows) {
      return report(rows, outbound, "messageId");
    },
    async loadHistorySyncState(instance) {
      return states.get(instance) ?? null;
    },
    async saveHistorySyncState(instance, state) {
      const copy = JSON.parse(JSON.stringify(state));
      states.set(instance, copy);
      savedStates.push(copy);
    },
  };
}

const pages = {
  1: [
    rawMessage({ id: "a_out", phone: "60111111111", fromMe: true, timestamp: 400, text: "A outbound" }),
    rawMessage({ id: "b_out", phone: "60222222222", fromMe: true, timestamp: 300, text: "B outbound only" }),
  ],
  2: [
    rawMessage({ id: "a_in", phone: "60111111111", fromMe: false, timestamp: 200, text: "A inbound" }),
    rawMessage({ id: "group_in", phone: "60333333333", fromMe: false, timestamp: 100, jid: "12345@g.us" }),
  ],
};

{
  const log = fakeConversationLog();
  const calls = [];
  const progress = [];
  const sleeps = [];
  let pageTwoCalls = 0;
  const api = async (_path, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    if (body.page === 2) {
      pageTwoCalls += 1;
      if (pageTwoCalls === 2) throw new Error("temporary Evolution timeout");
    }
    return {
      messages: {
        total: 4,
        pages: 2,
        currentPage: body.page,
        records: pages[body.page],
      },
    };
  };
  const sync = createEvolutionHistorySync({
    api,
    conversationLog: log,
    listInstances: async () => [{ name: "wa_01" }],
    pageSize: 2,
    pageDelayMs: 0,
    retryDelayMs: 1,
    sleep: async (ms) => { sleeps.push(ms); },
    clock: () => new Date("2026-07-26T03:00:00.000Z"),
  });

  const result = await sync.syncAll({ onProgress: (value) => progress.push(value) });
  assert.equal(result.added, 2);
  assert.equal(result.results[0].customers, 1);
  assert.equal(result.results[0].inbound, 1);
  assert.equal(result.results[0].outbound, 1);
  assert.deepEqual(log.inbound.map((row) => row.id), ["a_in"]);
  assert.deepEqual(log.outbound.map((row) => row.messageId), ["a_out"]);
  assert.equal(calls.length, 5, "two passes plus one retry");
  assert.ok(calls.every((body) => body.offset === 2));
  assert.ok(calls.every((body) => body.where.messageTimestamp.gte === "1970-01-01T00:00:00.000Z"));
  assert.ok(calls.every((body) => body.where.messageTimestamp.lte === "2026-07-26T03:00:00.000Z"));
  assert.ok(progress.some((item) => item.phase === "retry"));
  assert.deepEqual(sleeps, [1]);
  assert.equal(log.savedStates.at(-1).status, "completed");
}

{
  const resumeState = {
    version: 1,
    instance: "wa_01",
    status: "failed",
    phase: "import",
    cutoffAt: "2026-07-26T03:00:00.000Z",
    page: 1,
    pages: 2,
    total: 4,
    fetched: 2,
    written: 1,
    failed: 0,
    inbound: 0,
    outbound: 1,
    repliedPhones: ["60111111111"],
    databaseMessagesAtStart: 0,
    databaseMessagesAtCheckpoint: 1,
    startedAt: "2026-07-26T03:00:00.000Z",
  };
  const log = fakeConversationLog({ initialIds: ["a_out"], initialState: resumeState });
  const calledPages = [];
  const sync = createEvolutionHistorySync({
    api: async (_path, options) => {
      const body = JSON.parse(options.body);
      calledPages.push(body.page);
      return {
        messages: {
          total: 4,
          pages: 2,
          currentPage: body.page,
          records: pages[body.page],
        },
      };
    },
    conversationLog: log,
    listInstances: async () => [{ name: "wa_01" }],
    pageSize: 2,
    pageDelayMs: 0,
    retryDelayMs: 0,
  });

  const result = await sync.syncAll();
  assert.deepEqual(calledPages, [2], "resume starts at the next unfinished page");
  assert.equal(result.results[0].resumed, true);
  assert.deepEqual(log.inbound.map((row) => row.id), ["a_in"]);
}

{
  const log = fakeConversationLog();
  const calledPages = [];
  const sync = createEvolutionHistorySync({
    api: async (_path, options) => {
      const body = JSON.parse(options.body);
      calledPages.push(body.page);
      return {
        messages: {
          total: 0,
          pages: 0,
          currentPage: body.page,
          records: [],
        },
      };
    },
    conversationLog: log,
    listInstances: async () => [{ name: "wa_empty" }],
    pageDelayMs: 0,
    retryDelayMs: 0,
  });

  const result = await sync.syncAll();
  assert.deepEqual(calledPages, [1, 1], "empty history finishes after one page per pass");
  assert.equal(result.results[0].customers, 0);
}

console.log("Evolution history sync tests passed.");
