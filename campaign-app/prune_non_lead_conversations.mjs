// 把「名单外」的对话从本机数据库清掉。
//
// 规则(2026-07-21 定的)：只有 blast 名单里的号码才进数据库。名单外的是自己的
// 私人联络人 / 同事 / 广告陌生人，之后会另外做 add-new-leads 功能来管。
//
// 第一次补写历史回复时还没有这条规则，所以库里混进了名单外的人。这支脚本把他们
// 清掉。原始回复仍然完整保留在 tracker/replies.jsonl —— 那才是真正的源头，
// 之后要捞回来随时可以。
//
//   node campaign-app/prune_non_lead_conversations.mjs --dry-run   # 先看会删谁
//   node campaign-app/prune_non_lead_conversations.mjs             # 真的删

import path from "node:path";
import { paths } from "./campaign_core.mjs";
import { createConversationLogService } from "./lib/conversation-log-service.mjs";
import { createSqliteCli, sqlValue } from "./lib/sqlite-cli.mjs";

const dryRun = process.argv.includes("--dry-run");
const log = createConversationLogService({ dataDir: paths.dataDir });
const database = await createSqliteCli({ databasePath: path.join(paths.dataDir, "mamba.sqlite") });

const rows = await database.query(`
SELECT c.contact_key AS contactKey, c.display_name AS name, c.reply_count AS replies,
       (SELECT COUNT(*) FROM messages m
        JOIN conversations v ON v.id = m.conversation_id
        WHERE v.contact_key = c.contact_key) AS messages
FROM contacts c
WHERE EXISTS (SELECT 1 FROM conversations v WHERE v.contact_key = c.contact_key)
ORDER BY c.reply_count DESC;`);

const strangers = [];
for (const row of rows) {
  if (!await log.isKnownLead(row.contactKey)) strangers.push(row);
}

console.log(`有对话的客户 ${rows.length} 个，其中名单外 ${strangers.length} 个：`);
for (const row of strangers) {
  console.log(`  ${String(row.messages).padStart(4)} 条  ${(row.name || "(无名)").padEnd(20).slice(0, 20)} ${row.contactKey}`);
}
if (!strangers.length) {
  console.log("没有要清的，数据库已经干净。");
  process.exit(0);
}

const totalMessages = strangers.reduce((sum, row) => sum + row.messages, 0);
console.log(`\n会删掉 ${strangers.length} 个客户 · ${totalMessages} 条讯息（replies.jsonl 原文不受影响）。`);

if (dryRun) {
  console.log("--dry-run：没有删任何东西。");
  process.exit(0);
}

// contacts → conversations → messages 都是 ON DELETE CASCADE，删 contact 就够。
// 但只删「没有名单纪录」的 contact，绝不碰 project_leads 引用到的那些。
const keys = strangers.map((row) => sqlValue(row.contactKey)).join(", ");
await database.exec(`
BEGIN IMMEDIATE;
DELETE FROM conversations WHERE contact_key IN (${keys});
DELETE FROM contacts
WHERE contact_key IN (${keys})
  AND NOT EXISTS (SELECT 1 FROM project_leads pl WHERE pl.contact_key = contacts.contact_key);
COMMIT;`);

const after = await log.stats();
console.log(`清理完成。现在：conversations ${after.conversations} · messages ${after.messages} · 有回复的客户 ${after.contactsWithReplies}`);
