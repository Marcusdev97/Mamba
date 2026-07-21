import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createConversationLogService } from "./lib/conversation-log-service.mjs";
import { createSqliteCli, findSqliteCli } from "./lib/sqlite-cli.mjs";

const binary = await findSqliteCli();
if (!binary) {
  console.log("⚠️ 这台机器没有 sqlite3，跳过 conversation log 测试。");
  process.exit(0);
}

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-conv-log-"));
const database = await createSqliteCli({ databasePath: path.join(dataDir, "mamba.sqlite") });

// 真 schema 的最小子集：够测 FK 和 UNIQUE 的部分。
await database.exec(`
CREATE TABLE devices (device_key TEXT PRIMARY KEY);
CREATE TABLE whatsapp_connections (
  connection_key TEXT PRIMARY KEY,
  whatsapp_number TEXT NOT NULL DEFAULT '',
  instance_name TEXT NOT NULL DEFAULT ''
);
CREATE TABLE contacts (
  contact_key TEXT PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  stop_flag INTEGER NOT NULL DEFAULT 0,
  reply_count INTEGER NOT NULL DEFAULT 0,
  last_reply_text TEXT NOT NULL DEFAULT '',
  last_reply_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  contact_key TEXT NOT NULL,
  connection_key TEXT,
  customer_phone TEXT NOT NULL,
  last_message_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (contact_key, connection_key),
  FOREIGN KEY (contact_key) REFERENCES contacts(contact_key) ON DELETE CASCADE,
  FOREIGN KEY (connection_key) REFERENCES whatsapp_connections(connection_key) ON DELETE SET NULL
);
CREATE TABLE templates (template_key TEXT PRIMARY KEY);
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound','operator','system')),
  text TEXT NOT NULL DEFAULT '',
  message_type TEXT NOT NULL DEFAULT 'text',
  source TEXT NOT NULL DEFAULT 'evolution',
  flow_topic TEXT NOT NULL DEFAULT '',
  template_key TEXT,
  sent_at TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (template_key) REFERENCES templates(template_key) ON DELETE SET NULL
);
CREATE TABLE project_leads (
  project_lead_key TEXT PRIMARY KEY,
  contact_key TEXT NOT NULL,
  phone TEXT NOT NULL
);
INSERT INTO devices VALUES ('device-1');
INSERT INTO whatsapp_connections VALUES ('device-1::601133698121', '601133698121', 'wa_01');
INSERT INTO project_leads VALUES ('binastra:60146426133', '60146426133', '60146426133');`);

// 名单的另外两个来源：blast_leads_cache.json 和 leads.json
await fs.writeFile(path.join(dataDir, "blast_leads_cache.json"), JSON.stringify({ records: [{ phone: "60111222333" }] }));
await fs.writeFile(path.join(dataDir, "leads.json"), JSON.stringify({ leads: [{ phone: "6019 000 111" }] }));

const log = createConversationLogService({ dataDir });

const reply = {
  id: "MSG-1",
  phone: "6014 642 6133",
  name: "KJ Chong",
  text: "Marcus, 5 units got discount?",
  receivedAt: "2026-07-21T12:14:01.000Z",
  route: "PRICE_REQUEST",
  status: "Warm",
  category: "Price Inquiry",
  signal: "GREEN",
  stopFlag: false,
  sender: "601133698121",
  instanceName: "wa_01",
};

assert.deepEqual(await log.recordReply(reply), { saved: true, reason: "" });

const conversations = await database.query("SELECT * FROM conversations;");
assert.equal(conversations.length, 1);
assert.equal(conversations[0].contact_key, "60146426133", "电话要归一化成纯数字");
assert.equal(conversations[0].connection_key, "device-1::601133698121", "sender 对得上就要绑那个连接");

const messages = await database.query("SELECT * FROM messages;");
assert.equal(messages.length, 1);
assert.equal(messages[0].direction, "inbound");
assert.equal(messages[0].flow_topic, "PRICE_REQUEST");
assert.equal(messages[0].sent_at, "2026-07-21T12:14:01.000Z");
assert.equal(JSON.parse(messages[0].payload_json).category, "Price Inquiry", "销售判断要留着给 reply brain 用");

let contacts = await database.query("SELECT * FROM contacts;");
assert.equal(contacts[0].display_name, "KJ Chong");
assert.equal(contacts[0].reply_count, 1);
assert.equal(contacts[0].last_reply_at, "2026-07-21T12:14:01.000Z");

// --- 幂等：同一条重放不可以写重复，也不可以灌大 reply_count ---
await log.recordReply(reply);
await log.recordReply(reply);
assert.equal((await database.query("SELECT COUNT(*) AS n FROM messages;"))[0].n, 1, "同一个 message id 只能有一行");
contacts = await database.query("SELECT * FROM contacts;");
assert.equal(contacts[0].reply_count, 1, "reply_count 是从 messages 重算的，重放不会灌水");

// --- 同一个客户第二条讯息：同一个 conversation，last_reply 往前推 ---
await log.recordReply({ ...reply, id: "MSG-2", text: "ok send me", receivedAt: "2026-07-21T13:00:00.000Z" });
assert.equal((await database.query("SELECT COUNT(*) AS n FROM conversations;"))[0].n, 1, "同一个客户 + 同一个连接 = 同一个对话");
assert.equal((await database.query("SELECT COUNT(*) AS n FROM messages;"))[0].n, 2);
contacts = await database.query("SELECT * FROM contacts;");
assert.equal(contacts[0].reply_count, 2);
assert.equal(contacts[0].last_reply_text, "ok send me");

// --- 旧讯息迟到：不可以把 last_reply 往回拉 ---
await log.recordReply({ ...reply, id: "MSG-0", text: "早上那条", receivedAt: "2026-07-20T01:00:00.000Z" });
contacts = await database.query("SELECT * FROM contacts;");
assert.equal(contacts[0].last_reply_at, "2026-07-21T13:00:00.000Z", "迟到的旧讯息不可以覆盖最新回复时间");
assert.equal(contacts[0].last_reply_text, "ok send me");

// --- 没有 sender 号码时，用 instance 名字也认得出连接 ---
await log.recordReply({ ...reply, id: "MSG-3", phone: "60111222333", sender: null });
const byInstance = await database.query("SELECT * FROM conversations WHERE contact_key = '60111222333';");
assert.equal(byInstance.length, 1);
assert.equal(byInstance[0].connection_key, "device-1::601133698121", "sender 是空的就靠 instance name 反查");

// --- 号码和 instance 都认不出来就留 NULL，不要瞎绑 ---
await log.recordReply({ ...reply, id: "MSG-3B", phone: "60111222333", sender: null, instanceName: "" });
const orphan = await database.query("SELECT * FROM conversations WHERE contact_key = '60111222333' AND connection_key IS NULL;");
assert.equal(orphan.length, 1, "认不出连接的自成一段对话，connection_key 留 NULL");

// --- 坏事件挡掉 ---
assert.deepEqual(await log.recordReply({ id: "", phone: "60111" }), { saved: false, reason: "invalid_event" });
assert.deepEqual(await log.recordReply({ id: "MSG-9", phone: "" }), { saved: false, reason: "invalid_event" });

// --- 批次补写的统计 ---
const report = await log.recordReplies([reply, { ...reply, id: "MSG-4" }, { id: "", phone: "" }]);
assert.equal(report.written, 2, "重放的那条照样进批次，靠 INSERT OR IGNORE 挡掉");
assert.equal(report.skipped, 1, "没有 id / 没有电话的挡在写入之前");
assert.equal(report.failed.length, 0);
assert.equal((await database.query("SELECT COUNT(*) AS n FROM messages WHERE id='MSG-1';"))[0].n, 1, "重放不会变成两行");

// --- 名单外的号码不进数据库 ---
assert.equal(await log.isKnownLead("60146426133"), true, "project_leads 里的算名单");
assert.equal(await log.isKnownLead("60111222333"), true, "blast_leads_cache 里的算名单");
assert.equal(await log.isKnownLead("6019 000 111"), true, "leads.json 里的算名单");
assert.equal(await log.isKnownLead("60199999999"), false);
assert.equal(await log.isKnownLead("60199999999", { leadId: "notion-page-1" }), true, "tracker 当场认出来的直接信");

const stranger = await log.recordReply({ ...reply, id: "MSG-STRANGER", phone: "60199999999" });
assert.deepEqual(stranger, { saved: false, reason: "not_a_lead" }, "名单外 = 自己的私人联络人，不记录");
assert.equal((await database.query("SELECT COUNT(*) AS n FROM contacts WHERE contact_key='60199999999';"))[0].n, 0, "名单外的号码连 contact 都不该建");

// --- 出站：我们发出去的那一半 ---
const replyCountBefore = (await database.query("SELECT reply_count FROM contacts WHERE contact_key='60146426133';"))[0].reply_count;
const outbound = await log.recordOutbound({
  phone: "60146426133",
  text: "Hi KJ，这是 Binastra 的资料",
  instanceName: "wa_01",
  messageId: "OUT-1",
  sentAt: "2026-07-21T14:00:00.000Z",
  flowTopic: "Flow 1 - Project Template",
  source: "blast",
});
assert.deepEqual(outbound, { saved: true, reason: "" });

const thread = await database.query(`
SELECT m.direction, m.text, m.sent_at FROM messages m
JOIN conversations c ON c.id = m.conversation_id
WHERE c.contact_key = '60146426133'
ORDER BY m.sent_at;`);
assert.equal(thread.length, 5, "出站入站要落在同一段对话里");
assert.deepEqual(thread.map((row) => row.direction), ["inbound", "inbound", "inbound", "inbound", "outbound"]);
assert.equal(thread.at(-1).text, "Hi KJ，这是 Binastra 的资料");

const outboundRow = (await database.query("SELECT * FROM messages WHERE id = 'OUT-1';"))[0];
assert.equal(outboundRow.source, "blast");
assert.equal(outboundRow.flow_topic, "Flow 1 - Project Template");
assert.equal(outboundRow.template_key, null, "templates 表还没资料，template_key 要留 NULL 免得踩 FK");

const afterOutbound = await database.query("SELECT reply_count FROM contacts WHERE contact_key='60146426133';");
assert.equal(afterOutbound[0].reply_count, replyCountBefore, "我们发出去的不可以算进客户回复数");

assert.deepEqual(
  await log.recordOutbound({ phone: "60199999999", text: "hi", instanceName: "wa_01" }),
  { saved: false, reason: "not_a_lead" },
  "名单外的出站也不记录",
);
assert.deepEqual(await log.recordOutbound({ phone: "60146426133", text: "" }), { saved: false, reason: "invalid_message" });
await log.recordOutbound({ phone: "60146426133", text: "again", messageId: "OUT-1" });
assert.equal(
  (await database.query("SELECT COUNT(*) AS n FROM messages WHERE id='OUT-1';"))[0].n,
  1,
  "重送同一个 message id 不可以写两条",
);

const stats = await log.stats();
assert.equal(stats.messages, 7);
assert.equal(stats.inbound, 6);
assert.equal(stats.outbound, 1);
// 4 段 = 有连接的两个客户各一段，加上「认不出连接」的两段(60111222333 一段、
// 最后那笔没带 instance 的出站一段)。认不出连接就自成一段是刻意的，不要瞎归。
assert.equal(stats.conversations, 4);

// --- recall: 拉出来给大脑当记忆的那段 ---
const thread20 = await log.recentThread("60146426133");
assert.deepEqual(
  thread20.map((row) => row.sentAt),
  [...thread20.map((row) => row.sentAt)].sort(),
  "要由旧到新，大脑才读得懂顺序",
);
assert.equal(thread20.at(-1).direction, "outbound", "最后一条是最新的那条");

const capped = await log.recentThread("60146426133", { limit: 2 });
assert.equal(capped.length, 2, "limit 要生效");
assert.deepEqual(
  capped.map((row) => row.sentAt),
  thread20.slice(-2).map((row) => row.sentAt),
  "取的必须是「最近两条」，不是「最早两条」",
);

const excluded = await log.recentThread("60146426133", { excludeId: "MSG-2" });
assert.ok(!excluded.some((row) => row.text === "ok send me"), "客户刚发来的那条要排除，免得大脑以为讲了两次");

// MSG-0 是 2026-07-20T01:00 那条「早上那条」，用固定时钟才测得准 sinceDays。
const windowedLog = createConversationLogService({ dataDir, clock: () => new Date("2026-07-21T14:30:00.000Z") });
const windowed = await windowedLog.recentThread("60146426133", { sinceDays: 1 });
assert.ok(windowed.length, "窗口内应该还有讯息");
assert.ok(!windowed.some((row) => row.text === "早上那条"), "sinceDays 要把窗口外的旧讯息挡掉");
assert.ok(
  (await windowedLog.recentThread("60146426133", { sinceDays: 30 })).some((row) => row.text === "早上那条"),
  "窗口拉大就该看得到那条",
);
assert.deepEqual(await log.recentThread(""), [], "没有电话就回空的");
assert.deepEqual(await log.recentThread("60199999999"), [], "没聊过的客户回空的");

await fs.rm(dataDir, { recursive: true, force: true });
console.log("✅ all conversation log tests passed");
