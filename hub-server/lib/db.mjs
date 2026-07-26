// 只读地读 Mamba 的本机资料库。
//
// 刻意不重用 campaign-app/lib/conversation-log-service.mjs：那个 service 是可以写的，
// 它开资料库的方式也是可读可写。这台 server 要给另一台电脑连进来看，唯一该保证的事
// 就是「它绝对写不了东西」—— 所以这里自己开 sqlite3，而且钉死 -readonly。
// SQL 有一点跟那边重复，换来的是「就算这支程式写错了也弄不坏资料」，值得。
//
// -readonly 是 sqlite3 CLI 的旗标，不是我们自己检查的 —— 就算下面不小心写了
// 一句 UPDATE，sqlite3 也会直接拒绝执行。

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const SQLITE_CANDIDATES = [
  "/usr/bin/sqlite3",
  "/opt/homebrew/bin/sqlite3",
  "/usr/local/bin/sqlite3",
];

async function findSqlite() {
  for (const candidate of SQLITE_CANDIDATES) {
    try {
      await fs.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* 试下一个 */ }
  }
  throw new Error("找不到 sqlite3。请先安装（brew install sqlite）。");
}

export function sqlText(value) {
  return `'${String(value ?? "").replaceAll("'", "''")}'`;
}

export async function createReadOnlyDb({ databasePath }) {
  const binary = await findSqlite();
  await fs.access(databasePath, fs.constants.R_OK);

  function query(sql) {
    return new Promise((resolve, reject) => {
      execFile(
        binary,
        ["-readonly", "-batch", "-json", "-cmd", ".timeout 5000", databasePath],
        { maxBuffer: 1 << 28, timeout: 30_000 },
        (error, stdout, stderr) => {
          if (error) return reject(new Error(stderr?.trim() || error.message));
          const output = String(stdout).trim();
          if (!output) return resolve([]);
          try { resolve(JSON.parse(output)); } catch (parseError) { reject(parseError); }
        },
      ).stdin.end(sql);
    });
  }

  // 「最后一句是客户说的」= 球还在你这边。跟聊天室用的是同一个判断。
  const lastDirection = (alias) => `(
    SELECT m.direction FROM messages m
    JOIN conversations v ON v.id = m.conversation_id
    WHERE v.contact_key = ${alias}.contact_key
    ORDER BY m.sent_at DESC, m.id DESC LIMIT 1)`;

  async function stats() {
    const rows = await query(`
SELECT
  (SELECT COUNT(*) FROM contacts) AS contacts,
  (SELECT COUNT(*) FROM contacts WHERE reply_count > 0) AS replied,
  (SELECT COUNT(*) FROM contacts c WHERE c.reply_count > 0 AND c.stop_flag = 0
     AND ${lastDirection("c")} = 'inbound') AS waiting,
  (SELECT COUNT(*) FROM messages) AS messages,
  (SELECT COUNT(*) FROM messages WHERE direction = 'inbound') AS inbound,
  (SELECT MAX(sent_at) FROM messages) AS lastMessageAt;`);
    return rows?.[0] ?? {};
  }

  // filter: "waiting" 只列等你回的；"all" 列全部回过的。
  async function threads({ filter = "waiting", limit = 300 } = {}) {
    const conditions = ["c.reply_count > 0", "c.stop_flag = 0"];
    if (filter === "waiting") conditions.push(`${lastDirection("c")} = 'inbound'`);
    const safeLimit = Math.max(1, Math.min(Number(limit) || 300, 1000));
    return query(`
SELECT
  c.contact_key AS phone,
  c.display_name AS name,
  c.reply_count AS replyCount,
  (SELECT m.text FROM messages m JOIN conversations v ON v.id = m.conversation_id
   WHERE v.contact_key = c.contact_key ORDER BY m.sent_at DESC, m.id DESC LIMIT 1) AS lastText,
  ${lastDirection("c")} AS lastDirection,
  (SELECT MAX(m.sent_at) FROM messages m JOIN conversations v ON v.id = m.conversation_id
   WHERE v.contact_key = c.contact_key) AS lastAt
FROM contacts c
WHERE ${conditions.join(" AND ")}
ORDER BY lastAt DESC
LIMIT ${safeLimit};`);
  }

  async function thread(phone) {
    const key = String(phone ?? "").replace(/\D/g, "");
    if (!key) return { contact: null, messages: [] };
    const contact = (await query(`
SELECT contact_key AS phone, display_name AS name, reply_count AS replyCount
FROM contacts WHERE contact_key = ${sqlText(key)} LIMIT 1;`))?.[0] ?? null;
    const messages = await query(`
SELECT m.direction AS direction, m.text AS text, m.sent_at AS sentAt, m.source AS source
FROM messages m JOIN conversations v ON v.id = m.conversation_id
WHERE v.contact_key = ${sqlText(key)}
ORDER BY m.sent_at ASC, m.id ASC
LIMIT 800;`);
    return { contact, messages };
  }

  return { databasePath: path.resolve(databasePath), stats, threads, thread };
}
