// 把「归错客户」的讯息搬回正确的人身上。
//
// 为什么会归错：lid 对照表是慢慢补出来的。补回历史时如果某个 lid 还没对照、或者
// 当时对照到了错的号码，那一整段对话就写在错的客户底下。之后对照表修好了，
// 再跑一次补回也搬不动 —— messages 是 INSERT OR IGNORE，同一个 message id
// 已经存在就整条跳过，不会换人。所以要有这支单独的修正。
//
// 判断依据：Evolution 那条讯息的 remoteJid 是谁的 lid，对照表说那个 lid 是谁，
// 那条讯息就该归谁。
//
// 不动 source='blast' 的讯息：那是我们「拨出去的号码」的纪录，本身就是名单资料，
// 搬走的话就查不到当初到底发给了哪个号码。只搬从 Evolution 补回来的那些。
//
//   node campaign-app/repair_lid_attribution.mjs --dry-run
//   node campaign-app/repair_lid_attribution.mjs

import path from "node:path";
import { paths, makeApi, loadEnv, listInstances } from "./campaign_core.mjs";
import { createLidMapService } from "./lib/lid-map-service.mjs";
import { conversationIdFor } from "./lib/conversation-log-service.mjs";
import { createSqliteCli, sqlValue } from "./lib/sqlite-cli.mjs";
import { resolveLid, resolvePhone } from "./reply_intake.mjs";

const PAGE_SIZE = 200;
const dryRun = process.argv.includes("--dry-run");

const env = await loadEnv();
const api = makeApi(env);
const lidMap = createLidMapService({ dataDir: paths.dataDir });
const database = await createSqliteCli({ databasePath: path.join(paths.dataDir, "mamba.sqlite") });

await lidMap.warm();

// message id -> 这条讯息真正属于哪个号码
const ownerById = new Map();
for (const item of await listInstances(api)) {
  if (String(item.status).toUpperCase() !== "OPEN") continue;
  let page = 1;
  let pages = 1;
  while (page <= pages) {
    const response = await api(`/chat/findMessages/${encodeURIComponent(item.name)}`, {
      method: "POST",
      body: JSON.stringify({ where: {}, page, offset: PAGE_SIZE }),
      timeoutMs: 60_000,
    });
    const meta = response?.messages;
    if (!meta || !Array.isArray(meta.records)) throw new Error("Evolution 回传的 messages.records 格式不完整");
    pages = Math.max(1, Number(meta.pages) || 1);
    for (const message of meta.records) {
      const id = String(message?.key?.id ?? "");
      if (!id) continue;
      const phone = resolvePhone(message) ?? lidMap.resolveCached(resolveLid(message));
      if (phone) ownerById.set(id, phone);
    }
    process.stdout.write(`\r[${item.name}] 读取 Evolution… 第 ${page}/${pages} 页   `);
    page += 1;
  }
  process.stdout.write("\n");
}
console.log(`Evolution 里认得出主人的讯息：${ownerById.size} 条\n`);

const local = await database.query(`
SELECT m.id AS id, m.conversation_id AS conversationId, m.source AS source,
       v.contact_key AS contactKey, v.connection_key AS connectionKey
FROM messages m
JOIN conversations v ON v.id = m.conversation_id
WHERE m.source <> 'blast';`);

const moves = [];
for (const row of local) {
  const owner = ownerById.get(String(row.id));
  if (!owner || owner === String(row.contactKey)) continue;
  moves.push({ ...row, owner, targetConversationId: conversationIdFor(owner, row.connectionKey) });
}

if (!moves.length) {
  console.log("没有归错的讯息，不用修。");
  process.exit(0);
}

const byPair = new Map();
for (const move of moves) {
  const key = `${move.contactKey} -> ${move.owner}`;
  byPair.set(key, (byPair.get(key) ?? 0) + 1);
}
console.log(`要搬 ${moves.length} 条讯息：`);
for (const [pair, count] of [...byPair].sort((a, b) => b[1] - a[1])) console.log(`  ${pair}  ${count} 条`);

if (dryRun) {
  console.log("\n(dry-run) 没有实际修改。");
  process.exit(0);
}

const nowIso = new Date().toISOString();
const contactKeys = [...new Set(moves.map((m) => m.owner))];
const touched = [...new Set([...moves.map((m) => m.owner), ...moves.map((m) => String(m.contactKey))])];
const conversations = [...new Map(moves.map((m) => [
  m.targetConversationId,
  `(${sqlValue(m.targetConversationId)}, ${sqlValue(m.owner)}, ${sqlValue(m.connectionKey)}, ${sqlValue(m.owner)}, NULL, ${sqlValue(nowIso)}, ${sqlValue(nowIso)})`,
])).values()].join(",\n  ");

await database.exec(`
BEGIN IMMEDIATE;

INSERT OR IGNORE INTO contacts (contact_key, phone, display_name, reply_count, last_reply_text, last_reply_at, created_at, updated_at)
VALUES
  ${contactKeys.map((key) => `(${sqlValue(key)}, ${sqlValue(key)}, '', 0, '', NULL, ${sqlValue(nowIso)}, ${sqlValue(nowIso)})`).join(",\n  ")};

INSERT OR IGNORE INTO conversations (id, contact_key, connection_key, customer_phone, last_message_at, created_at, updated_at)
VALUES
  ${conversations};

${moves.map((m) => `UPDATE messages SET conversation_id = ${sqlValue(m.targetConversationId)} WHERE id = ${sqlValue(m.id)};`).join("\n")}

UPDATE conversations SET
  last_message_at = (SELECT MAX(m.sent_at) FROM messages m WHERE m.conversation_id = conversations.id),
  updated_at = ${sqlValue(nowIso)}
WHERE contact_key IN (${touched.map(sqlValue).join(", ")});

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
WHERE contact_key IN (${touched.map(sqlValue).join(", ")});

COMMIT;`);

console.log(`\n搬好了 ${moves.length} 条。回聊天室刷新即可看到。`);
