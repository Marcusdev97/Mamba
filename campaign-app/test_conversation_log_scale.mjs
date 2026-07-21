// 量级测试：这个补写功能撑不撑得住「另一台机器那种客户量」。
//
// 一开始是一条讯息 spawn 三次 sqlite3 process，几百条还行，几万条直接废掉。
// 改成批次之后，一批(500 条) = 一个 process、一个 transaction。这支测试用真的
// sqlite 跑真的资料量，把吞吐量印出来，不是用猜的。
//
//   node campaign-app/test_conversation_log_scale.mjs            # 20k 条
//   node campaign-app/test_conversation_log_scale.mjs --messages=100000

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createConversationLogService } from "./lib/conversation-log-service.mjs";
import { createSqliteCli, findSqliteCli } from "./lib/sqlite-cli.mjs";

const binary = await findSqliteCli();
if (!binary) {
  console.log("⚠️ 这台机器没有 sqlite3，跳过量级测试。");
  process.exit(0);
}

const totalMessages = Number(process.argv.find((a) => a.startsWith("--messages="))?.split("=")[1]) || 20_000;
const contactCount = Math.max(1, Math.round(totalMessages / 20));   // 平均一个客户 20 条

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-conv-scale-"));
const database = await createSqliteCli({ databasePath: path.join(dataDir, "mamba.sqlite") });

await database.exec(`
CREATE TABLE devices (device_key TEXT PRIMARY KEY);
CREATE TABLE whatsapp_connections (connection_key TEXT PRIMARY KEY, whatsapp_number TEXT NOT NULL DEFAULT '', instance_name TEXT NOT NULL DEFAULT '');
CREATE TABLE contacts (
  contact_key TEXT PRIMARY KEY, phone TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL DEFAULT '',
  stop_flag INTEGER NOT NULL DEFAULT 0, reply_count INTEGER NOT NULL DEFAULT 0,
  last_reply_text TEXT NOT NULL DEFAULT '', last_reply_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE conversations (
  id TEXT PRIMARY KEY, contact_key TEXT NOT NULL, connection_key TEXT, customer_phone TEXT NOT NULL,
  last_message_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (contact_key, connection_key),
  FOREIGN KEY (contact_key) REFERENCES contacts(contact_key) ON DELETE CASCADE,
  FOREIGN KEY (connection_key) REFERENCES whatsapp_connections(connection_key) ON DELETE SET NULL);
CREATE TABLE templates (template_key TEXT PRIMARY KEY);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound','operator','system')),
  text TEXT NOT NULL DEFAULT '', message_type TEXT NOT NULL DEFAULT 'text',
  source TEXT NOT NULL DEFAULT 'evolution', flow_topic TEXT NOT NULL DEFAULT '',
  template_key TEXT, sent_at TEXT, payload_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (template_key) REFERENCES templates(template_key) ON DELETE SET NULL);
CREATE INDEX idx_messages_conv_time ON messages(conversation_id, sent_at);
CREATE TABLE project_leads (project_lead_key TEXT PRIMARY KEY, contact_key TEXT NOT NULL, phone TEXT NOT NULL);
INSERT INTO devices VALUES ('device-1');
INSERT INTO whatsapp_connections VALUES ('device-1::601133698121', '601133698121', 'wa_01');`);

// 名单：全部都是 blast lead，这样量级测的是写入速度，不是被名单闸挡掉的速度。
const phones = Array.from({ length: contactCount }, (_, index) => `6012${String(1000000 + index).padStart(7, "0")}`);
await fs.writeFile(path.join(dataDir, "blast_leads_cache.json"), JSON.stringify({ records: phones.map((phone) => ({ phone })) }));

// 讯息里塞一些引号、换行、emoji、中文 —— 真实客户就是这样打字的，
// 顺便验证跳脱字元在批次 SQL 里没被打断。
const SAMPLE_TEXTS = [
  "Hi bro, 这个 unit 还有吗?",
  "价钱 RM2,XXX/mo 是真的meh? 我朋友说 \"不可能\"",
  "Can send me floor plan?\n谢谢 🙏",
  "O'Brien 说他要 3 房的",
  "不要了， 谢谢",
];

const messages = [];
for (let index = 0; index < totalMessages; index += 1) {
  const phone = phones[index % contactCount];
  messages.push({
    id: `SCALE-${index}`,
    phone,
    name: `Lead ${index % contactCount}`,
    text: SAMPLE_TEXTS[index % SAMPLE_TEXTS.length],
    receivedAt: new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
    route: "PRICE_REQUEST",
    status: "Warm",
    sender: "601133698121",
    instanceName: "wa_01",
  });
}

const log = createConversationLogService({ dataDir });

console.log(`量级测试：${totalMessages.toLocaleString()} 条讯息 / ${contactCount.toLocaleString()} 个客户`);

const startedAt = Date.now();
const report = await log.recordReplies(messages, {
  onProgress: (state) => process.stdout.write(`\r  ${state.written.toLocaleString()} / ${totalMessages.toLocaleString()}...`),
});
const seconds = (Date.now() - startedAt) / 1000;
process.stdout.write("\r");

assert.equal(report.failed.length, 0, `不该有失败: ${JSON.stringify(report.failed.slice(0, 3))}`);
assert.equal(report.written, totalMessages);

const stats = await log.stats();
assert.equal(stats.messages, totalMessages, "每一条都要落地");
assert.equal(stats.conversations, contactCount);
console.log(`✓ 写入 ${totalMessages.toLocaleString()} 条：${seconds.toFixed(1)}s · ${Math.round(totalMessages / seconds).toLocaleString()} 条/秒 · ${report.chunks} 批`);

// 统计栏位要正确：一个客户 20 条 = reply_count 20，不能因为分批就算错。
const sample = await database.query(`SELECT reply_count FROM contacts WHERE contact_key = ${JSON.stringify(phones[0]).replaceAll('"', "'")};`);
assert.equal(sample[0].reply_count, Math.ceil(totalMessages / contactCount), "reply_count 要跟实际讯息数对得上");

// 重跑一次：幂等，而且不可以把 reply_count 灌大一倍。
const replayStart = Date.now();
await log.recordReplies(messages.slice(0, Math.min(5000, totalMessages)));
const replaySeconds = (Date.now() - replayStart) / 1000;
const afterReplay = await log.stats();
assert.equal(afterReplay.messages, totalMessages, "重跑不可以多出讯息");
const sampleAfter = await database.query(`SELECT reply_count FROM contacts WHERE contact_key = ${JSON.stringify(phones[0]).replaceAll('"', "'")};`);
assert.equal(sampleAfter[0].reply_count, sample[0].reply_count, "重跑不可以灌大 reply_count");
console.log(`✓ 重跑 ${Math.min(5000, totalMessages).toLocaleString()} 条：${replaySeconds.toFixed(1)}s，讯息数不变、统计不灌水`);

// 拉一段对话出来 —— recall 之后就是这样用的，要够快。
const readStart = Date.now();
const thread = await database.query(`
SELECT m.direction, m.text, m.sent_at
FROM messages m JOIN conversations v ON v.id = m.conversation_id
WHERE v.contact_key = ${JSON.stringify(phones[0]).replaceAll('"', "'")}
ORDER BY m.sent_at DESC LIMIT 20;`);
console.log(`✓ 拉一个客户最近 20 条对话：${Date.now() - readStart}ms（${thread.length} 条）`);
assert.ok(thread.length > 0);

await fs.rm(dataDir, { recursive: true, force: true });
console.log("✅ 量级测试通过");
