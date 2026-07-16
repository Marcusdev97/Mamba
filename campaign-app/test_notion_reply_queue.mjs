import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createNotionReplyQueueService, explainNotionReplyError, notionReplyRetryDelayMs } from "./lib/notion-reply-queue-service.mjs";
import { createTrackerReliabilityService } from "./lib/tracker-reliability-service.mjs";

async function makeReliability(name, clock) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `mamba-${name}-`));
  const reliability = createTrackerReliabilityService({ trackerDir: path.join(root, "tracker"), clock });
  await reliability.init();
  return { root, reliability };
}

function event(id, phone = "60111111111", extra = {}) {
  return {
    id,
    phone,
    receivedAt: `2026-07-16T10:00:0${id.slice(-1)}.000Z`,
    text: `message ${id}`,
    route: "UNKNOWN_MANUAL_REVIEW",
    ...extra,
  };
}

assert.equal(notionReplyRetryDelayMs(1), 15_000);
assert.equal(notionReplyRetryDelayMs(2), 30_000);
assert.equal(notionReplyRetryDelayMs(20), 60 * 60 * 1000);
assert.equal(explainNotionReplyError(new Error("HTTP 401 token invalid")).code, "NOTION_AUTH_FAILED");
assert.equal(explainNotionReplyError(new Error("fetch failed")).code, "NOTION_NETWORK_FAILED");

// Messages that arrive together for one phone share one lookup, but every
// distinct message is still written to Notion in order.
{
  let current = new Date("2026-07-16T10:00:00.000Z");
  const { root, reliability } = await makeReliability("reply-batch", () => current);
  let releaseLookup;
  const lookupGate = new Promise((resolve) => { releaseLookup = resolve; });
  let lookups = 0;
  const upserts = [];
  const notion = {
    enabled: true,
    async findLeadForReply() {
      lookups += 1;
      await lookupGate;
      return { id: "page-1", properties: { "Reply Count": { number: 0 } } };
    },
    async upsertLeadReply(item, { existingLead }) {
      upserts.push(item.id);
      const count = Number(existingLead?.properties?.["Reply Count"]?.number || 0) + 1;
      return { matched: true, existingLead: { id: "page-1", properties: { "Reply Count": { number: count } } } };
    },
  };
  const queue = createNotionReplyQueueService({ notion, reliability, clock: () => current, onLog: () => {} });
  const first = queue.submit(event("msg-1"));
  await new Promise((resolve) => setImmediate(resolve));
  const second = queue.submit(event("msg-2"));
  const third = queue.submit(event("msg-3"));
  await new Promise((resolve) => setImmediate(resolve));
  releaseLookup();
  await Promise.all([first, second, third]);
  assert.equal(lookups, 1, "same-phone messages must share one Notion lookup");
  assert.deepEqual(upserts, ["msg-1", "msg-2", "msg-3"], "all messages must remain distinct and ordered");
  assert.equal(reliability.snapshot().pendingCount, 0);
  await fs.rm(root, { recursive: true, force: true });
}

// A Notion miss creates one phone-level cooldown. New messages join that retry
// instead of causing another immediate query.
{
  let current = new Date("2026-07-16T10:00:00.000Z");
  const { root, reliability } = await makeReliability("reply-cooldown", () => current);
  let lookups = 0;
  const issues = [];
  const notion = {
    enabled: true,
    async findLeadForReply() { lookups += 1; return null; },
    async upsertLeadReply() { throw new Error("should not upsert a missing lead"); },
  };
  const queue = createNotionReplyQueueService({ notion, reliability, clock: () => current, onLog: (line) => issues.push(line) });
  await queue.submit(event("msg-1"));
  await queue.submit(event("msg-2"));
  assert.equal(lookups, 1, "new same-phone message must join the existing cooldown");
  assert.equal(reliability.snapshot().pendingCount, 2);
  assert.equal(new Set(reliability.values().map((item) => item.nextRetryAt)).size, 1);
  current = new Date(current.getTime() + 15_001);
  await queue.retryPending();
  assert.equal(lookups, 2, "one lookup should run when the shared cooldown expires");
  assert.equal(issues.filter((line) => line.includes("NOTION_LEAD_NOT_FOUND")).length, 2, "one issue per phone attempt, not per message");
  await fs.rm(root, { recursive: true, force: true });
}

// STOP is safety critical and bypasses a previous miss cooldown. Once the row
// appears, both the older message and STOP are processed without losing either.
{
  let current = new Date("2026-07-16T10:00:00.000Z");
  const { root, reliability } = await makeReliability("reply-stop", () => current);
  let lookups = 0;
  const upserts = [];
  const notion = {
    enabled: true,
    async findLeadForReply() {
      lookups += 1;
      return lookups === 1 ? null : { id: "page-stop", properties: {} };
    },
    async upsertLeadReply(item, { existingLead }) {
      upserts.push(item.id);
      return { matched: true, existingLead };
    },
  };
  const queue = createNotionReplyQueueService({ notion, reliability, clock: () => current, onLog: () => {} });
  await queue.submit(event("msg-1"));
  await queue.submit(event("msg-2", "60111111111", { stopFlag: true, route: "STOP_DNC" }));
  assert.equal(lookups, 2, "STOP must bypass the phone cooldown");
  assert.deepEqual(upserts, ["msg-1", "msg-2"]);
  assert.equal(reliability.snapshot().pendingCount, 0);
  await fs.rm(root, { recursive: true, force: true });
}

// Old unresolved replies stop generating hourly traffic and become a visible,
// durable manual-review item with an actionable error code.
{
  let current = new Date("2026-07-16T10:00:00.000Z");
  const { root, reliability } = await makeReliability("reply-manual", () => current);
  const logs = [];
  const notion = { enabled: true, findLeadForReply: async () => null, upsertLeadReply: async () => null };
  const queue = createNotionReplyQueueService({ notion, reliability, clock: () => current, onLog: (line) => logs.push(line) });
  await queue.submit(event("msg-1"));
  current = new Date("2026-07-17T10:01:00.000Z");
  await queue.retryPending();
  const item = reliability.values()[0];
  assert.equal(item.status, "manual_review");
  assert.equal(item.errorCode, "NOTION_REPLY_MANUAL_REVIEW");
  assert.match(item.help, /电话号码|Blast Leads/);
  assert.ok(logs.some((line) => line.includes('"level":"error"') && line.includes("NOTION_REPLY_MANUAL_REVIEW")));
  notion.findLeadForReply = async () => ({ id: "page-manual", properties: {} });
  notion.upsertLeadReply = async (_event, { existingLead }) => ({ matched: true, existingLead });
  await queue.syncPhone("60111111111", { force: true, reason: "manual_push" });
  assert.equal(reliability.snapshot().pendingCount, 0, "manual action must be able to drain manual-review items");
  await fs.rm(root, { recursive: true, force: true });
}

console.log("✅ all Notion reply-queue tests passed");
