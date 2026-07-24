// 把客户对话写进本机数据库 (conversations / messages / contacts)。
//
// 在这之前，回复只落在 tracker/replies.jsonl 和 replies.csv —— 只能一行行看，
// 没办法按客户、按盘、按时间查，也喂不动 reply brain。conversations 和 messages
// 两张表 schema 早就建好了，只是从来没人写。这个 service 就是补那条写入路径。
//
// 四条原则：
//   1. 幂等。message id 用 Evolution 的 message id，重放来源档不会写重复。
//      contacts 的统计栏位是从 messages 重算出来的，不是累加 —— 所以跑几次都一样。
//   2. 不挡路。回复处理是主线，写库失败只记一笔警告，绝不让客户回复流程炸掉。
//   3. 不猜。认不出是哪个 WhatsApp 连接就写 NULL，不要瞎绑一个 connection。
//   4. 撑得住量。sqlite3 是 spawn 出去的 process，一条讯息一次 spawn 会死在几万条上。
//      所有写入都走批次：一批一个 process、一个 transaction。
//
// 名单闸：只有 blast 名单里的号码才进数据库。名单外的是自己的私人联络人 / 同事 /
// 广告陌生人，之后另外做 add-new-leads 功能来管。

import fs from "node:fs/promises";
import path from "node:path";
import { createSqliteCli, sqlValue } from "./sqlite-cli.mjs";

const DIGITS_RE = /\D/g;
// 名单快取 30 秒重读一次。blast 中途新增名单不用等重启，也不会每条讯息都读档。
const LEAD_INDEX_TTL_MS = 30_000;
// 一批多少条。太小 = process spawn 太频繁；太大 = 单次 SQL 太肥、失败要重做的也多。
const DEFAULT_CHUNK_SIZE = 500;

function digits(value) {
  return String(value ?? "").replace(DIGITS_RE, "");
}

function clean(value) {
  return String(value ?? "").trim();
}

function isoOrNull(value) {
  const ms = new Date(value ?? "").getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// 回复事件里跟销售有关的那几个判断留在 payload_json 里，之后 reply brain 要用。
function inboundPayload(event) {
  return JSON.stringify({
    status: clean(event.status),
    category: clean(event.category),
    aiCategory: clean(event.aiCategory),
    nextAction: clean(event.nextAction),
    sequenceStatus: clean(event.sequenceStatus),
    signal: clean(event.signal),
    stopFlag: event.stopFlag === true,
    suggestedReply: clean(event.suggestedReply),
    leadId: clean(event.leadId),
    runId: clean(event.runId),
    campaignId: clean(event.campaignId),
    instanceName: clean(event.instanceName),
    deviceName: clean(event.deviceName),
  });
}

// 同一个客户 + 同一个本机连接 = 同一段对话。
//
// id 必须直接从「解析出来的 connection_key」算，不能从 sender 号码或 instance 名字算。
// 这两个东西会指向同一个连接，如果各自算出不同的 id，第二个 INSERT 就会撞上
// UNIQUE(contact_key, connection_key) 被 IGNORE 掉，接着 messages 找不到那个
// conversation_id，整批 FOREIGN KEY 失败。踩过一次了。
function conversationIdFor(contactKey, connectionKey) {
  const suffix = connectionKey
    ? String(connectionKey).replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")
    : "none";
  return `conv_${contactKey}_${suffix}`;
}

export function createConversationLogService({
  dataDir,
  sqliteBinary = "",
  clock = () => new Date(),
  chunkSize = DEFAULT_CHUNK_SIZE,
} = {}) {
  const databasePath = path.join(dataDir, "mamba.sqlite");
  let cliPromise = null;
  let leadIndex = { phones: new Set(), loadedAt: 0 };
  let connectionIndex = { byNumber: new Map(), byInstance: new Map(), loadedAt: 0 };

  function cli() {
    if (!cliPromise) {
      cliPromise = createSqliteCli({ databasePath, sqliteBinary }).catch((error) => {
        cliPromise = null;   // 下次再试，不要把失败永久缓存住
        throw error;
      });
    }
    return cliPromise;
  }

  // 「这个号码是不是我 blast 的名单」——三个来源联集，任何一个认得就算数：
  //   · project_leads      本机数据库(Notion 镜像)
  //   · blast_leads_cache  Notion Blast Leads 全量快取
  //   · leads.json         本机名单档
  // 用联集而不是单一来源，是因为漏判的代价比误判大：误判只是多存一段自己人的对话，
  // 漏判是真客户的对话直接不见。
  async function leadPhones() {
    const nowMs = clock().getTime();
    if (leadIndex.phones.size && nowMs - leadIndex.loadedAt < LEAD_INDEX_TTL_MS) return leadIndex.phones;
    const phones = new Set();

    try {
      const database = await cli();
      for (const row of await database.query("SELECT contact_key FROM project_leads;")) {
        const phone = digits(row.contact_key);
        if (phone) phones.add(phone);
      }
    } catch { /* 数据库读不到就靠下面两个档案，不要因此整个停掉 */ }

    for (const [file, pick] of [
      ["blast_leads_cache.json", (data) => data.records ?? data.leads ?? (Array.isArray(data) ? data : [])],
      ["leads.json", (data) => data.leads ?? (Array.isArray(data) ? data : [])],
    ]) {
      try {
        const data = JSON.parse(await fs.readFile(path.join(dataDir, file), "utf8"));
        for (const record of pick(data) ?? []) {
          const phone = digits(record?.phone);
          if (phone) phones.add(phone);
        }
      } catch { /* 档案不在就跳过 */ }
    }

    leadIndex = { phones, loadedAt: nowMs };
    return phones;
  }

  // 连接表很小(一台电脑几个号码)，整张读进来快取，一批只查一次。
  // 每条讯息各查一次 = 多 spawn 一个 sqlite process，几万条就是几万次。
  async function connections() {
    const nowMs = clock().getTime();
    if (connectionIndex.loadedAt && nowMs - connectionIndex.loadedAt < LEAD_INDEX_TTL_MS) return connectionIndex;
    const byNumber = new Map();
    const byInstance = new Map();
    try {
      const database = await cli();
      for (const row of await database.query("SELECT connection_key, whatsapp_number, instance_name FROM whatsapp_connections;")) {
        const key = clean(row.connection_key);
        if (!key) continue;
        const number = digits(row.whatsapp_number);
        const instance = clean(row.instance_name);
        if (number) byNumber.set(number, key);
        if (instance) byInstance.set(instance, key);
      }
    } catch { /* 读不到就全部当认不出，连接留 NULL */ }
    connectionIndex = { byNumber, byInstance, loadedAt: nowMs };
    return connectionIndex;
  }

  // 对得上号就绑，对不上就 NULL。绝不瞎绑。
  function resolveConnection(index, senderNumber, instanceName) {
    return index.byNumber.get(digits(senderNumber))
      ?? index.byInstance.get(clean(instanceName))
      ?? null;
  }

  // event.leadId 有值 = tracker 当场就从 active run / leads.json 认出来了，直接信。
  async function isKnownLead(phone, { leadId = "" } = {}) {
    if (clean(leadId)) return true;
    const key = digits(phone);
    if (!key) return false;
    return (await leadPhones()).has(key);
  }

  // 把外面丢进来的东西normalize成一行可以写的资料。回 null = 这条不该写。
  function normalizeInbound(event) {
    const contactKey = digits(event?.phone);
    const id = clean(event?.id);
    if (!id || !contactKey) return null;
    return {
      id,
      contactKey,
      name: clean(event.name),
      direction: "inbound",
      text: clean(event.text),
      source: "evolution",
      flowTopic: clean(event.route),
      senderNumber: digits(event.sender),
      instanceName: clean(event.instanceName),
      sentAt: isoOrNull(event.receivedAt),
      payload: inboundPayload(event),
      leadId: clean(event.leadId),
    };
  }

  function normalizeOutbound(message) {
    const contactKey = digits(message?.phone);
    const text = clean(message?.text);
    if (!contactKey || !text) return null;
    const sentAt = isoOrNull(message.sentAt) ?? clock().toISOString();
    return {
      id: clean(message.messageId) || `out_${contactKey}_${sentAt}`,
      contactKey,
      name: clean(message.name),
      direction: "outbound",
      text,
      source: clean(message.source) || "blast",
      flowTopic: clean(message.flowTopic),
      senderNumber: digits(message.senderNumber),
      instanceName: clean(message.instanceName),
      sentAt,
      payload: JSON.stringify({
        instanceName: clean(message.instanceName),
        templateKey: clean(message.templateKey),
        runId: clean(message.runId),
      }),
      leadId: clean(message.leadId),
    };
  }

  // 一批写进去：一个 process、一个 transaction。
  //
  // contacts 的 reply_count / last_reply_* 是从 messages 重算的，不是 +1 累加 ——
  // 累加碰到重放就会灌水，重算怎么跑都对，而且以前算错的也会顺便修好。
  async function writeChunk(rows) {
    if (!rows.length) return;
    const database = await cli();
    const index = await connections();
    const nowIso = clock().toISOString();
    // 先把每条讯息归到哪段对话算好，后面 conversations 和 messages 用的是同一个值。
    const placed = rows.map((row) => {
      const connectionKey = resolveConnection(index, row.senderNumber, row.instanceName);
      return { ...row, connectionKey, conversationId: conversationIdFor(row.contactKey, connectionKey) };
    });
    const contactKeys = [...new Set(placed.map((row) => row.contactKey))];
    const conversationIds = [...new Set(placed.map((row) => row.conversationId))];

    const contactValues = contactKeys
      .map((key) => `(${sqlValue(key)}, ${sqlValue(key)}, '', 0, '', NULL, ${sqlValue(nowIso)}, ${sqlValue(nowIso)})`)
      .join(",\n  ");

    const conversationValues = [...new Map(placed.map((row) => [
      row.conversationId,
      `(${sqlValue(row.conversationId)}, ${sqlValue(row.contactKey)}, ${sqlValue(row.connectionKey)}, ${sqlValue(row.contactKey)}, NULL, ${sqlValue(nowIso)}, ${sqlValue(nowIso)})`,
    ])).values()].join(",\n  ");

    const messageValues = placed.map((row) => `(${[
      sqlValue(row.id),
      sqlValue(row.conversationId),
      sqlValue(row.direction),
      sqlValue(row.text),
      "'text'",
      sqlValue(row.source),
      sqlValue(row.flowTopic),
      "NULL",
      sqlValue(row.sentAt ?? nowIso),
      sqlValue(row.payload),
      sqlValue(nowIso),
    ].join(", ")})`).join(",\n  ");

    // 名字只在原本是空的时候补，不要用旧资料盖掉现在的。
    const nameUpdates = [...new Map(placed.filter((row) => row.name).map((row) => [row.contactKey, row])).values()]
      .map((row) => `UPDATE contacts SET display_name = ${sqlValue(row.name)}, updated_at = ${sqlValue(nowIso)} WHERE contact_key = ${sqlValue(row.contactKey)} AND display_name = '';`)
      .join("\n");

    const contactList = contactKeys.map(sqlValue).join(", ");
    const conversationList = conversationIds.map(sqlValue).join(", ");

    await database.exec(`
BEGIN IMMEDIATE;

INSERT OR IGNORE INTO contacts (contact_key, phone, display_name, reply_count, last_reply_text, last_reply_at, created_at, updated_at)
VALUES
  ${contactValues};

${nameUpdates}

INSERT OR IGNORE INTO conversations (id, contact_key, connection_key, customer_phone, last_message_at, created_at, updated_at)
VALUES
  ${conversationValues};

INSERT OR IGNORE INTO messages (id, conversation_id, direction, text, message_type, source, flow_topic, template_key, sent_at, payload_json, created_at)
VALUES
  ${messageValues};

UPDATE conversations SET
  last_message_at = (SELECT MAX(m.sent_at) FROM messages m WHERE m.conversation_id = conversations.id),
  updated_at = ${sqlValue(nowIso)}
WHERE id IN (${conversationList});

UPDATE contacts SET
  reply_count = (
    SELECT COUNT(*) FROM messages m JOIN conversations v ON v.id = m.conversation_id
    WHERE v.contact_key = contacts.contact_key AND m.direction = 'inbound'),
  last_reply_at = (
    SELECT MAX(m.sent_at) FROM messages m JOIN conversations v ON v.id = m.conversation_id
    WHERE v.contact_key = contacts.contact_key AND m.direction = 'inbound'),
  last_reply_text = COALESCE((
    SELECT m.text FROM messages m JOIN conversations v ON v.id = m.conversation_id
    WHERE v.contact_key = contacts.contact_key AND m.direction = 'inbound'
    ORDER BY m.sent_at DESC, m.id DESC LIMIT 1), ''),
  updated_at = ${sqlValue(nowIso)}
WHERE contact_key IN (${contactList});

COMMIT;`);
  }

  // 共用的批次入口。名单闸在这里统一挡，chunk 一批一批写，中途可以回报进度。
  async function recordMany(records, normalize, { onProgress = null } = {}) {
    const report = { total: records.length, written: 0, notLeads: 0, skipped: 0, chunks: 0, failed: [] };
    let buffer = [];

    const flush = async () => {
      if (!buffer.length) return;
      const batch = buffer;
      buffer = [];
      try {
        await writeChunk(batch);
        report.written += batch.length;
      } catch (error) {
        // 整批失败就退回一条一条写，把坏的那几条隔离出来，不要因为一条坏资料丢掉一整批。
        for (const row of batch) {
          try {
            await writeChunk([row]);
            report.written += 1;
          } catch (rowError) {
            report.failed.push({ id: row.id, error: rowError.message });
          }
        }
      }
      report.chunks += 1;
      onProgress?.({ ...report, buffered: 0 });
    };

    for (const record of records) {
      const row = normalize(record);
      if (!row) { report.skipped += 1; continue; }
      if (!await isKnownLead(row.contactKey, { leadId: row.leadId })) { report.notLeads += 1; continue; }
      buffer.push(row);
      if (buffer.length >= chunkSize) await flush();
    }
    await flush();
    return report;
  }

  // ---------- 单条(线上路径) ----------

  async function recordReply(event) {
    const row = normalizeInbound(event);
    if (!row) return { saved: false, reason: "invalid_event" };
    if (!await isKnownLead(row.contactKey, { leadId: row.leadId })) return { saved: false, reason: "not_a_lead" };
    await writeChunk([row]);
    return { saved: true, reason: "" };
  }

  async function recordOutbound(message) {
    const row = normalizeOutbound(message);
    if (!row) return { saved: false, reason: "invalid_message" };
    if (!await isKnownLead(row.contactKey, { leadId: row.leadId })) return { saved: false, reason: "not_a_lead" };
    await writeChunk([row]);
    return { saved: true, reason: "" };
  }

  // ---------- 批次(补写历史) ----------

  const recordReplies = (events, options) => recordMany(events, normalizeInbound, options);
  const recordOutbounds = (messages, options) => recordMany(messages, normalizeOutbound, options);

  // 拉一个客户最近的对话，给销售大脑当记忆用 (recall)。
  //
  // 顺序：SQL 先按时间倒着取最近 N 条，再在 JS 里翻正 —— 直接正着取会把「最近」
  // 变成「最早」，大脑就永远读到几个月前那几句。
  //
  // excludeId 是客户「刚发来」那条：它在 prompt 里另外单独列，而且 tracker 和
  // brain 是两个 process，写进库的时机不一定，重复出现只会让大脑以为客户讲了两次。
  async function recentThread(phone, { limit = 15, sinceDays = 0, excludeId = "" } = {}) {
    const contactKey = digits(phone);
    if (!contactKey) return [];
    const database = await cli();
    const conditions = [`v.contact_key = ${sqlValue(contactKey)}`];
    if (sinceDays > 0) {
      const since = new Date(clock().getTime() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
      conditions.push(`m.sent_at >= ${sqlValue(since)}`);
    }
    if (clean(excludeId)) conditions.push(`m.id <> ${sqlValue(clean(excludeId))}`);
    const rows = await database.query(`
SELECT m.direction AS direction, m.text AS text, m.sent_at AS sentAt, m.source AS source, m.flow_topic AS flowTopic
FROM messages m
JOIN conversations v ON v.id = m.conversation_id
WHERE ${conditions.join(" AND ")}
ORDER BY m.sent_at DESC, m.id DESC
LIMIT ${Math.max(1, Math.min(Number(limit) || 15, 200))};`);
    return rows.reverse();
  }

  // 「这些号码最近收过这个 flow 吗」——防重发的核心查询。
  //
  // 这是本机纪录，不依赖 Notion 有没有回写成功。以前唯一防线是 Notion 里的
  // nextFlow 被推进，而那只在 campaign 完整跑完时才写；中途 STOP 就整条防线消失，
  // 隔天重开会把同一批人再发一次。这个查询把防线搬回本机。
  //
  // 一次查一整批(一个 campaign 几百个号码 = 一次查询)，预览和发送共用同一个答案。
  async function sentFlowSince(phones, { flowTopic = "", sinceDays = 7 } = {}) {
    const keys = [...new Set((phones ?? []).map(digits).filter(Boolean))];
    if (!keys.length) return new Map();
    const database = await cli();
    const since = new Date(clock().getTime() - Math.max(0, sinceDays) * 24 * 60 * 60 * 1000).toISOString();
    const conditions = [
      `v.contact_key IN (${keys.map(sqlValue).join(", ")})`,
      "m.direction = 'outbound'",
      `m.sent_at >= ${sqlValue(since)}`,
    ];
    // 没给 flow 就是「任何东西都算」，给了就只挡同一个 flow ——
    // Flow 2 不该因为客户收过 Flow 1 就被挡下来。
    if (clean(flowTopic)) conditions.push(`m.flow_topic = ${sqlValue(clean(flowTopic))}`);
    const rows = await database.query(`
SELECT v.contact_key AS contactKey, MAX(m.sent_at) AS sentAt, COUNT(*) AS times
FROM messages m
JOIN conversations v ON v.id = m.conversation_id
WHERE ${conditions.join(" AND ")}
GROUP BY v.contact_key;`);
    return new Map(rows.map((row) => [row.contactKey, { sentAt: row.sentAt, times: row.times }]));
  }

  // 聊天室的客户列表：某个号码底下、有回复过、而且没被 STOP 的客户。
  // 每个带最后一条讯息预览，按最近活动排序 —— 越新的排越前面。
  async function inboxThreads({ instance = "", limit = 200 } = {}) {
    const database = await cli();
    const conditions = [
      "c.reply_count > 0",       // 只要回复过的
      "c.stop_flag = 0",         // STOP 的不进聊天室
    ];
    // 号码归属来自讯息 payload 里的 instanceName（每条讯息记着走哪个号码发/收）。
    // connection_key 那条路在旧资料里是空的，靠不住 —— payload 才是可靠来源。
    const inst = clean(instance);
    const instanceFilter = inst
      ? `AND EXISTS (
          SELECT 1 FROM messages im
          JOIN conversations iv ON iv.id = im.conversation_id
          WHERE iv.contact_key = c.contact_key
            AND json_extract(im.payload_json, '$.instanceName') = ${sqlValue(inst)})`
      : "";
    const rows = await database.query(`
SELECT
  c.contact_key AS phone,
  c.display_name AS name,
  c.reply_count AS replyCount,
  c.last_reply_at AS lastReplyAt,
  (SELECT m.text FROM messages m
   JOIN conversations vv ON vv.id = m.conversation_id
   WHERE vv.contact_key = c.contact_key
   ORDER BY m.sent_at DESC, m.id DESC LIMIT 1) AS lastText,
  (SELECT m.direction FROM messages m
   JOIN conversations vv ON vv.id = m.conversation_id
   WHERE vv.contact_key = c.contact_key
   ORDER BY m.sent_at DESC, m.id DESC LIMIT 1) AS lastDirection,
  (SELECT MAX(m.sent_at) FROM messages m
   JOIN conversations vv ON vv.id = m.conversation_id
   WHERE vv.contact_key = c.contact_key) AS lastAt
FROM contacts c
WHERE EXISTS (SELECT 1 FROM conversations v WHERE v.contact_key = c.contact_key)
  AND ${conditions.join(" AND ")}
  ${instanceFilter}
ORDER BY lastAt DESC
LIMIT ${Math.max(1, Math.min(Number(limit) || 200, 1000))};`);
    return rows;
  }

  // 一整段对话（由旧到新），聊天室点开一个客户时用。
  async function fullThread(phone, { limit = 500 } = {}) {
    const contactKey = digits(phone);
    if (!contactKey) return { contact: null, messages: [] };
    const database = await cli();
    const contactRows = await database.query(`
SELECT contact_key AS phone, display_name AS name, reply_count AS replyCount,
       stop_flag AS stopFlag, last_reply_at AS lastReplyAt
FROM contacts WHERE contact_key = ${sqlValue(contactKey)} LIMIT 1;`);
    const rows = await database.query(`
SELECT m.direction AS direction, m.text AS text, m.sent_at AS sentAt,
       m.source AS source, m.flow_topic AS flowTopic, m.payload_json AS payloadJson
FROM messages m
JOIN conversations v ON v.id = m.conversation_id
WHERE v.contact_key = ${sqlValue(contactKey)}
ORDER BY m.sent_at ASC, m.id ASC
LIMIT ${Math.max(1, Math.min(Number(limit) || 500, 2000))};`);
    return { contact: contactRows?.[0] ?? { phone: contactKey, name: "", replyCount: 0, stopFlag: 0 }, messages: rows };
  }

  async function stats() {
    const database = await cli();
    const rows = await database.query(`
SELECT
  (SELECT COUNT(*) FROM conversations) AS conversations,
  (SELECT COUNT(*) FROM messages) AS messages,
  (SELECT COUNT(*) FROM messages WHERE direction = 'inbound') AS inbound,
  (SELECT COUNT(*) FROM messages WHERE direction = 'outbound') AS outbound,
  (SELECT COUNT(*) FROM contacts WHERE reply_count > 0) AS contactsWithReplies,
  (SELECT MAX(sent_at) FROM messages) AS lastMessageAt;`);
    return rows?.[0] ?? { conversations: 0, messages: 0, inbound: 0, outbound: 0, contactsWithReplies: 0, lastMessageAt: null };
  }

  return {
    databasePath,
    recordReply,
    recordReplies,
    recordOutbound,
    recordOutbounds,
    recentThread,
    sentFlowSince,
    inboxThreads,
    fullThread,
    isKnownLead,
    stats,
  };
}
