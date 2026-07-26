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

// ---- LID 定址 ----

function lidMessage({ id, lid, fromMe, timestamp, text = "hello", phone = "" }) {
  const key = { id, fromMe, remoteJid: `${lid}@lid` };
  if (phone) key.remoteJidAlt = `${phone}@s.whatsapp.net`;
  return {
    id: `db_${id}`,
    key,
    messageTimestamp: timestamp,
    messageType: "conversation",
    message: { conversation: text },
    pushName: fromMe ? "" : "Customer",
  };
}

function fakeLidMap(initial = {}) {
  const byLid = new Map(Object.entries(initial));
  const learned = [];
  return {
    learned,
    async warm() { return byLid; },
    resolveCached: (lid) => byLid.get(lid) ?? null,
    async learn(entries, options) {
      for (const entry of entries) {
        learned.push({ ...entry, source: options?.source });
        byLid.set(entry.lid, entry.phone);
      }
      return { learned: entries.length };
    },
  };
}

// 对照表认得 lid -> 整段对话照样补得回来。
{
  const log = fakeConversationLog();
  const lidMap = fakeLidMap({ "999888777": "60111111111" });
  const lidPages = {
    1: [lidMessage({ id: "l_out", lid: "999888777", fromMe: true, timestamp: 400, text: "out" })],
    2: [lidMessage({ id: "l_in", lid: "999888777", fromMe: false, timestamp: 500, text: "in" })],
  };
  const sync = createEvolutionHistorySync({
    api: async (_path, options) => {
      const body = JSON.parse(options.body);
      return { messages: { total: 2, pages: 2, currentPage: body.page, records: lidPages[body.page] } };
    },
    conversationLog: log,
    lidMap,
    listInstances: async () => [{ name: "wa_01" }],
    pageSize: 1,
    pageDelayMs: 0,
    retryDelayMs: 0,
  });

  const result = await sync.syncAll();
  assert.deepEqual(log.inbound.map((row) => row.phone), ["60111111111"], "lid 回查出号码");
  assert.deepEqual(log.outbound.map((row) => row.phone), ["60111111111"]);
  assert.equal(result.unresolved, 0);
}

// 讯息同时带 lid 和真号码 -> 顺手记进对照表。
{
  const log = fakeConversationLog();
  const lidMap = fakeLidMap();
  const sync = createEvolutionHistorySync({
    api: async (_path, options) => {
      const body = JSON.parse(options.body);
      return {
        messages: {
          total: 1,
          pages: 1,
          currentPage: body.page,
          records: [lidMessage({ id: "pair_in", lid: "555", fromMe: false, timestamp: 1, phone: "60222222222" })],
        },
      };
    },
    conversationLog: log,
    lidMap,
    listInstances: async () => [{ name: "wa_01" }],
    pageDelayMs: 0,
    retryDelayMs: 0,
  });

  await sync.syncAll();
  assert.ok(lidMap.learned.some((p) => p.lid === "555" && p.phone === "60222222222" && p.source === "live"));
}

// 全是认不出的 lid -> 必须炸掉，而且断点要归零，不能报「同步完成，新增 0 条」。
{
  const log = fakeConversationLog();
  const records = Array.from({ length: 25 }, (_, index) =>
    lidMessage({ id: `x${index}`, lid: `lid${index}`, fromMe: false, timestamp: index }));
  const sync = createEvolutionHistorySync({
    api: async (_path, options) => {
      const body = JSON.parse(options.body);
      return { messages: { total: 25, pages: 1, currentPage: body.page, records } };
    },
    conversationLog: log,
    lidMap: fakeLidMap(),
    listInstances: async () => [{ name: "wa_01" }],
    pageDelayMs: 0,
    retryDelayMs: 0,
  });

  await assert.rejects(() => sync.syncAll(), /认得出 0 条的号码/);
  const last = log.savedStates.at(-1);
  assert.equal(last.status, "failed");
  assert.equal(last.page, 0, "认不出号码的失败要归零断点，逼下次重扫");
  assert.deepEqual(last.repliedPhones, []);
}

// 一个号码都没连上也是错误，不是「同步完成」。
{
  const sync = createEvolutionHistorySync({
    api: async () => ({}),
    conversationLog: fakeConversationLog(),
    listInstances: async () => [],
  });
  await assert.rejects(() => sync.syncAll(), /没有任何已连接的号码/);
}

console.log("Evolution history sync tests passed.");
