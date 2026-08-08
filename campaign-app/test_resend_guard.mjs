// 防重发闸门的测试。
//
// 复现 2026-07-21/22 那次事故：昨天 blast 到一半按 STOP，隔天重开一个「新的」
// campaign，同一批人整批再收一次。
//
// 当时为什么挡不住：
//   · campaign_core 的「已发过就跳过」只在同一个 run 内有效(比对 job.part1.sentAt)，
//     新 run 的 assignments 是干净的，一个都跳不过。
//   · 跨 run 的防线只有 Notion 的 nextFlow 被推进，而 autoAdvanceFlow 只在
//     status === "COMPLETED" 时才执行。中途 STOP = 从来没写 = 名单看起来没发过。
//
// 现在改成问本机 messages 表，跟 Notion 通不通、有没有跑完全无关。

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createConversationLogService } from "./lib/conversation-log-service.mjs";
import { createSqliteCli, findSqliteCli } from "./lib/sqlite-cli.mjs";
import { getTestLeads } from "./campaign_core.mjs";

assert.deepEqual(getTestLeads(""), [], "没有 TEST_LEADS 时必须 fail closed，不能内建真人号码");
assert.deepEqual(
  getTestLeads("Test User:60123456789:en").map(({ name, phone, language }) => ({ name, phone, language })),
  [{ name: "Test User", phone: "60123456789", language: "en" }],
  "TEST_LEADS 应从 env 格式正常载入",
);

const binary = await findSqliteCli();
if (!binary) {
  console.log("⚠️ 这台机器没有 sqlite3，跳过防重发测试。");
  process.exit(0);
}

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-resend-"));
const database = await createSqliteCli({ databasePath: path.join(dataDir, "mamba.sqlite") });
await database.exec(`
CREATE TABLE whatsapp_connections (connection_key TEXT PRIMARY KEY, whatsapp_number TEXT NOT NULL DEFAULT '', instance_name TEXT NOT NULL DEFAULT '');
CREATE TABLE contacts (contact_key TEXT PRIMARY KEY, phone TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL DEFAULT '',
  stop_flag INTEGER NOT NULL DEFAULT 0, reply_count INTEGER NOT NULL DEFAULT 0, last_reply_text TEXT NOT NULL DEFAULT '',
  last_reply_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE conversations (id TEXT PRIMARY KEY, contact_key TEXT NOT NULL, connection_key TEXT, customer_phone TEXT NOT NULL,
  last_message_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (contact_key, connection_key),
  FOREIGN KEY (contact_key) REFERENCES contacts(contact_key) ON DELETE CASCADE,
  FOREIGN KEY (connection_key) REFERENCES whatsapp_connections(connection_key) ON DELETE SET NULL);
CREATE TABLE templates (template_key TEXT PRIMARY KEY);
CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound','operator','system')),
  text TEXT NOT NULL DEFAULT '', message_type TEXT NOT NULL DEFAULT 'text', source TEXT NOT NULL DEFAULT 'evolution',
  flow_topic TEXT NOT NULL DEFAULT '', template_key TEXT, sent_at TEXT, payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (template_key) REFERENCES templates(template_key) ON DELETE SET NULL);
CREATE TABLE project_leads (project_lead_key TEXT PRIMARY KEY, contact_key TEXT NOT NULL, phone TEXT NOT NULL);
INSERT INTO project_leads VALUES ('binastra:60111000111', '60111000111', '60111000111');
INSERT INTO project_leads VALUES ('binastra:60111000222', '60111000222', '60111000222');`);

const log = createConversationLogService({ dataDir });
const FLOW = "Flow 1 - Project Template";

// 昨天：60111000111 收到了 Flow 1，然后 campaign 被 STOP（没有 Notion 收尾）。
await log.recordOutbound({
  phone: "60111000111", text: "Hi, Binastra 项目介绍…", instanceName: "wa_01",
  messageId: "YESTERDAY-1", sentAt: new Date(Date.now() - 20 * 3600_000).toISOString(),
  flowTopic: FLOW, source: "blast",
});

// The central repository consumes this evidence. The conversation ledger owns
// only the historical lookup and no longer makes an independent send decision.
const recentFlow1 = await log.sentFlowSince(["60111000111"], { flowTopic: FLOW, sinceDays: 7 });
assert.equal(recentFlow1.has("60111000111"), true, "昨天已经收过 Flow 1 的人必须有本机发送证据");

// --- 没收过的人 -> 照发 ---
assert.equal((await log.sentFlowSince(["60111000222"], { flowTopic: FLOW, sinceDays: 7 })).size, 0, "没收过的人不应出现历史命中");

// --- 不同 flow -> 照发。Flow 2 不能因为收过 Flow 1 就被挡 ---
assert.equal((await log.sentFlowSince(["60111000111"], { flowTopic: "Flow 2 - Layout", sinceDays: 7 })).size, 0, "不同 flow 不应命中");

// --- 冷却期外 -> 放行 ---
await log.recordOutbound({
  phone: "60111000222", text: "很久以前那次", instanceName: "wa_01",
  messageId: "OLD-1", sentAt: new Date(Date.now() - 30 * 24 * 3600_000).toISOString(),
  flowTopic: FLOW, source: "blast",
});
assert.equal((await log.sentFlowSince(["60111000222"], { flowTopic: FLOW, sinceDays: 7 })).size, 0, "30 天前不应命中 7 天窗口");
assert.equal((await log.sentFlowSince(["60111000222"], { flowTopic: FLOW, sinceDays: 60 })).has("60111000222"), true, "60 天窗口应命中旧发送");
assert.equal((await log.sentFlowSince(["60111000111"], { flowTopic: "", sinceDays: 30 })).has("60111000111"), true, "Refresh 可查询任何近期 outbound evidence");

await fs.rm(dataDir, { recursive: true, force: true });
console.log("✅ all resend guard tests passed");
