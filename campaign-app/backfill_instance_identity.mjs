// 把「Evolution 标签」钉回「你扫进去的号码」，并补回旧对话的号码归属。
//
// 为什么要这支：聊天室以前是按 wa_01 这种标签筛对话的。同一支号码在 Evolution 上
// 被重建成 wa_02 / wa_03 之后，那段时间的对话在聊天室就看不到了 —— 号码根本没变，
// 是同一台手机。这支把标签跟号码绑起来，之后聊天室按号码看，标签怎么换都不影响。
//
// 顺便补两件从来没被写过的东西：
//   · whatsapp_connections.instance_name —— 建库时是空的，没人补写
//   · conversations.connection_key       —— 因为上面那栏是空的，1239 段对话全是 NULL
//
//   node campaign-app/backfill_instance_identity.mjs --dry-run
//   node campaign-app/backfill_instance_identity.mjs

import path from "node:path";
import { paths, makeApi, loadEnv, listInstances } from "./campaign_core.mjs";
import { createInstanceIdentityService } from "./lib/instance-identity-service.mjs";
import { conversationIdFor } from "./lib/conversation-log-service.mjs";
import { createSqliteCli, sqlValue } from "./lib/sqlite-cli.mjs";

const dryRun = process.argv.includes("--dry-run");

const env = await loadEnv();
const api = makeApi(env);
const identity = createInstanceIdentityService({ dataDir: paths.dataDir });
const database = await createSqliteCli({ databasePath: path.join(paths.dataDir, "mamba.sqlite") });

await identity.ensureSchema();

// 1. Evolution 上还活着的号码 —— 最准的一手资料。
const live = await listInstances(api);
console.log("Evolution 上现在的号码：");
for (const item of live) console.log(`  ${item.name}  ${item.number}  ${item.status}`);

// 2. 讯息里出现过、Evolution 已经没有的旧标签(wa_02 / wa_03 那些)。
//
// 对照表要先在记忆体里算出来，dry-run 才看得到真正会发生什么 ——
// 不然预览永远是「能补 0 段」，等于没预览。
const numberByInstance = new Map();
for (const item of live) {
  const name = String(item?.name ?? "").trim();
  const number = String(item?.number ?? item?.owner ?? "").replace(/\D/g, "");
  if (name && number) numberByInstance.set(name, number);
}

const seenInstances = (await database.query(`
SELECT DISTINCT json_extract(payload_json, '$.instanceName') AS instanceName
FROM messages
WHERE json_extract(payload_json, '$.instanceName') IS NOT NULL
  AND json_extract(payload_json, '$.instanceName') <> '';`))
  .map((row) => String(row.instanceName).trim()).filter(Boolean);
const orphanNames = seenInstances.filter((name) => !numberByInstance.has(name));
const deviceNumbers = [...new Set((await database.query("SELECT DISTINCT whatsapp_number AS n FROM whatsapp_connections WHERE whatsapp_number <> '';"))
  .map((row) => String(row.n).replace(/\D/g, "")).filter(Boolean))];

if (orphanNames.length && deviceNumbers.length === 1) {
  for (const name of orphanNames) numberByInstance.set(name, deviceNumbers[0]);
  console.log(`\n旧标签认领到号码 ${deviceNumbers[0]}：${orphanNames.join(", ")}`);
  console.log("  （这台电脑历来只接过这一个号码，所以旧标签只可能是它；记为 inferred）");
} else if (orphanNames.length) {
  console.log(`\n⚠ 这台电脑接过 ${deviceNumbers.length} 个号码，不猜旧标签属于谁：${orphanNames.join(", ")}`);
  console.log("  这些标签的对话在聊天室仍然会按标签独立显示。");
}

if (!dryRun) {
  await identity.syncFromInstances(live);
  const inferred = orphanNames.filter((name) => numberByInstance.has(name)).map((name) => ({ instance: name, number: numberByInstance.get(name) }));
  if (inferred.length) await identity.record(inferred, { source: "inferred" });
  for (const row of await identity.linkConnections()) {
    console.log(`\nwhatsapp_connections: ${row.number} → instance_name = ${row.instanceName || "(仍为空)"}`);
  }
}

console.log("\n号码 ↔ 标签对照：");
for (const [name, number] of numberByInstance) console.log(`  ${number}  ←  ${name}`);

// 4. conversations.connection_key 补写。
//
// 每段对话看它的讯息走过哪些标签，标签对应到号码，号码对应到 connection_key。
// 一段对话跨过同一号码的多个标签是正常的(换过标签)，那就是同一个 connection。
const pending = await database.query(`
SELECT v.id AS conversationId, v.contact_key AS contactKey,
       (SELECT GROUP_CONCAT(DISTINCT json_extract(m.payload_json, '$.instanceName'))
        FROM messages m WHERE m.conversation_id = v.id) AS instanceNames
FROM conversations v
WHERE v.connection_key IS NULL OR v.connection_key = '';`);

const connections = await database.query("SELECT connection_key AS connectionKey, whatsapp_number AS number FROM whatsapp_connections;");
const keyByNumber = new Map(connections.map((row) => [String(row.number).replace(/\D/g, ""), String(row.connectionKey)]));

const updates = [];
let ambiguous = 0;
for (const row of pending) {
  const names = String(row.instanceNames ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const numbers = [...new Set(names.map((name) => numberByInstance.get(name)).filter(Boolean))];
  if (numbers.length !== 1) { if (numbers.length > 1) ambiguous += 1; continue; }
  const connectionKey = keyByNumber.get(numbers[0]);
  if (!connectionKey) continue;
  updates.push({
    conversationId: String(row.conversationId),
    contactKey: String(row.contactKey),
    connectionKey,
    targetId: conversationIdFor(String(row.contactKey), connectionKey),
  });
}

console.log(`\n对话缺 connection_key 的：${pending.length} 段，这次能补：${updates.length} 段${ambiguous ? `（${ambiguous} 段跨多个号码，跳过）` : ""}`);

if (dryRun) {
  console.log("\n(dry-run) 没有实际修改。");
  process.exit(0);
}
if (!updates.length) {
  console.log("没有要补的。");
  process.exit(0);
}

// conversations.id 本身是从 connection_key 算出来的，补了 key 就得跟着改 id，
// 否则下次写入会算出新 id、变成同一个客户两段对话。
//
// 但 messages.conversation_id 的外键只有 ON DELETE CASCADE、没有 ON UPDATE CASCADE，
// 直接改 id 会整批 FOREIGN KEY constraint failed。所以走三步：
//   1. 先建好新的 conversation(带 connection_key)
//   2. 把 messages 指过去
//   3. 再删掉旧的 —— 这时它底下已经没有 messages，CASCADE 删不到东西
const nowIso = new Date().toISOString();
await database.exec(`
BEGIN IMMEDIATE;
${updates.map((u) => `
INSERT OR IGNORE INTO conversations (id, contact_key, connection_key, customer_phone, last_message_at, created_at, updated_at)
SELECT ${sqlValue(u.targetId)}, contact_key, ${sqlValue(u.connectionKey)}, customer_phone, last_message_at, created_at, ${sqlValue(nowIso)}
FROM conversations WHERE id = ${sqlValue(u.conversationId)};
UPDATE messages SET conversation_id = ${sqlValue(u.targetId)} WHERE conversation_id = ${sqlValue(u.conversationId)};
DELETE FROM conversations WHERE id = ${sqlValue(u.conversationId)} AND id <> ${sqlValue(u.targetId)};`).join("")}
COMMIT;`);

const left = await database.query("SELECT COUNT(*) AS n FROM conversations WHERE connection_key IS NULL OR connection_key = '';");
console.log(`\n补好了。还缺 connection_key 的对话：${left?.[0]?.n ?? "?"} 段`);
