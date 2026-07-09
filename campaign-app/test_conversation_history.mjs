import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createConversationHistoryService } from "./lib/conversation-history-service.mjs";

const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-history-"));
const history = createConversationHistoryService({ rootDir });

const first = await history.append("60123456789", {
  messageId: "msg_1",
  at: "2026-07-09T08:00:00.000Z",
  text: "price?",
  route: "PRICE_REQUEST",
});
assert.equal(first.added, true);

const duplicate = await history.append("60123456789", {
  messageId: "msg_1",
  at: "2026-07-09T08:00:00.000Z",
  text: "price?",
  route: "PRICE_REQUEST",
});
assert.equal(duplicate.added, false);

await history.append("60123456789", {
  messageId: "msg_2",
  at: "2026-07-09T09:00:00.000Z",
  text: "can view?",
  route: "VIEWING_REQUEST",
});

const entries = await history.read("60123456789");
assert.equal(entries.length, 2);
assert.deepEqual(entries.map((entry) => entry.messageId), ["msg_2", "msg_1"]);
assert.equal(entries[0].phone, "60123456789");

const batch = await history.appendMany([
  { phone: "60123456789", messageId: "msg_2", at: "2026-07-09T09:00:00.000Z", text: "can view?" },
  { phone: "60123456789", messageId: "msg_3", at: "2026-07-09T10:00:00.000Z", text: "location?" },
]);
assert.deepEqual(batch, { added: 1, skipped: 1 });

console.log("✅ all conversation-history tests passed");
