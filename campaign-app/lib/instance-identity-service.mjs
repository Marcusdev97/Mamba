// 「wa_01」这种标签是会换的，真正不变的是你扫进去的那个号码。
//
// 之前整套东西是绑标签的：讯息 payload 记 instanceName，聊天室也按 instanceName 筛。
// 结果同一个号码只要在 Evolution 上被重建成别的标签(wa_02 / wa_03)，那段时间的对话
// 在聊天室就消失了 —— 号码明明是同一个人的手机。6月那 435 条 wa_02 的讯息就是这样
// 被挡在外面的。
//
// 这张表把标签钉回号码上：
//   · Evolution 上还活着的 instance，直接问它 ownerJid，最准
//   · 已经不存在的旧标签(wa_02/wa_03)，如果这台电脑从头到尾只有一个号码，
//     那它们只可能是那个号码 —— 记成 inferred，并且标出来是推断的
//   · 一台电脑真的接过两个以上号码时不猜，宁可留空让人自己确认
//
// 有了它，聊天室问的就不再是「wa_01 的对话」，而是「60168568756 这个号码的对话」。

import path from "node:path";
import { createSqliteCli, sqlValue } from "./sqlite-cli.mjs";

const DIGITS_RE = /\D/g;

const digits = (value) => String(value ?? "").replace(DIGITS_RE, "");
const clean = (value) => String(value ?? "").trim();

export function schemaSql() {
  return `
CREATE TABLE IF NOT EXISTS instance_identity (
  instance_name   TEXT PRIMARY KEY,
  whatsapp_number TEXT NOT NULL,
  source          TEXT NOT NULL DEFAULT 'evolution',
  first_seen_at   TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_instance_identity_number ON instance_identity(whatsapp_number);
`;
}

export function createInstanceIdentityService({
  dataDir,
  sqliteBinary = "",
  clock = () => new Date(),
} = {}) {
  const databasePath = path.join(dataDir, "mamba.sqlite");
  let cliPromise = null;
  let schemaReady = null;

  function cli() {
    if (!cliPromise) {
      cliPromise = createSqliteCli({ databasePath, sqliteBinary }).catch((error) => {
        cliPromise = null;
        throw error;
      });
    }
    return cliPromise;
  }

  async function ensureSchema() {
    if (!schemaReady) {
      schemaReady = (async () => {
        const database = await cli();
        await database.exec(schemaSql());
      })().catch((error) => { schemaReady = null; throw error; });
    }
    return schemaReady;
  }

  async function record(entries, { source = "evolution" } = {}) {
    const rows = [];
    const seen = new Set();
    for (const entry of entries ?? []) {
      const instance = clean(entry?.instance);
      const number = digits(entry?.number);
      if (!instance || !number || seen.has(instance)) continue;
      seen.add(instance);
      rows.push({ instance, number });
    }
    if (!rows.length) return { recorded: 0 };

    await ensureSchema();
    const database = await cli();
    const nowIso = clock().toISOString();
    const values = rows
      .map((row) => `(${sqlValue(row.instance)}, ${sqlValue(row.number)}, ${sqlValue(source)}, ${sqlValue(nowIso)}, ${sqlValue(nowIso)})`)
      .join(",\n  ");

    // Evolution 说的永远赢过推断的；推断的不会盖掉已经问出来的。
    await database.exec(`
INSERT INTO instance_identity (instance_name, whatsapp_number, source, first_seen_at, last_seen_at)
VALUES
  ${values}
ON CONFLICT(instance_name) DO UPDATE SET
  whatsapp_number = excluded.whatsapp_number,
  source = excluded.source,
  last_seen_at = excluded.last_seen_at
WHERE excluded.source = 'evolution' OR instance_identity.source <> 'evolution';`);
    return { recorded: rows.length };
  }

  // 从 Evolution 现在活着的 instance 抓 name -> ownerJid 号码。
  async function syncFromInstances(instances) {
    return record(
      (instances ?? []).map((item) => ({
        instance: item?.name ?? item?.instance?.instanceName,
        number: item?.number ?? item?.owner ?? item?.ownerJid,
      })),
      { source: "evolution" },
    );
  }

  // 讯息里出现过、但 Evolution 已经没有的旧标签。
  // 只有在「这台电脑历来只认得一个号码」时才敢认领 —— 两个以上就不猜。
  async function adoptOrphans() {
    await ensureSchema();
    const database = await cli();
    const rows = await database.query(`
SELECT DISTINCT json_extract(payload_json, '$.instanceName') AS instanceName
FROM messages
WHERE json_extract(payload_json, '$.instanceName') IS NOT NULL
  AND json_extract(payload_json, '$.instanceName') <> ''
  AND json_extract(payload_json, '$.instanceName') NOT IN (SELECT instance_name FROM instance_identity);`);
    const orphans = rows.map((row) => clean(row.instanceName)).filter(Boolean);
    if (!orphans.length) return { adopted: [], skipped: [], number: "" };

    const numbers = (await database.query("SELECT DISTINCT whatsapp_number FROM whatsapp_connections WHERE whatsapp_number <> '';"))
      .map((row) => digits(row.whatsapp_number))
      .filter(Boolean);
    const known = [...new Set(numbers)];
    if (known.length !== 1) return { adopted: [], skipped: orphans, number: "" };

    await record(orphans.map((instance) => ({ instance, number: known[0] })), { source: "inferred" });
    return { adopted: orphans, skipped: [], number: known[0] };
  }

  async function numberFor(instanceName) {
    const instance = clean(instanceName);
    if (!instance) return "";
    await ensureSchema();
    const database = await cli();
    const rows = await database.query(`
SELECT whatsapp_number FROM instance_identity WHERE instance_name = ${sqlValue(instance)} LIMIT 1;`);
    return digits(rows?.[0]?.whatsapp_number);
  }

  // 一个号码历来用过的所有标签。聊天室要靠这个把 wa_01/wa_02/wa_03 合起来看。
  async function instanceNamesFor(number) {
    const key = digits(number);
    if (!key) return [];
    await ensureSchema();
    const database = await cli();
    const rows = await database.query(`
SELECT instance_name FROM instance_identity WHERE whatsapp_number = ${sqlValue(key)} ORDER BY instance_name;`);
    return rows.map((row) => clean(row.instance_name)).filter(Boolean);
  }

  // 给聊天室用：给一个标签，回传「同一个号码」底下所有标签。
  // 查不到对照就只回它自己 —— 宁可少看到，也不要把别的号码的对话混进来。
  async function siblingInstances(instanceName) {
    const instance = clean(instanceName);
    if (!instance) return [];
    const number = await numberFor(instance);
    if (!number) return [instance];
    const names = await instanceNamesFor(number);
    return names.length ? names : [instance];
  }

  // 把标签写回 whatsapp_connections.instance_name。
  //
  // 建库时那一栏是空的 —— 那时候还没连上 Evolution，不可能知道标签叫什么，
  // 而且从来没有人补写。结果 conversation-log 的 byInstance 查表永远是空的，
  // 1239 段对话的 connection_key 全部是 NULL。这里就是补那一步。
  // 一个号码有多个标签时取最新的那个，够 resolveConnection 用了。
  async function linkConnections() {
    await ensureSchema();
    const database = await cli();
    const nowIso = clock().toISOString();
    await database.exec(`
UPDATE whatsapp_connections SET
  instance_name = COALESCE((
    SELECT i.instance_name FROM instance_identity i
    WHERE i.whatsapp_number = whatsapp_connections.whatsapp_number
    ORDER BY i.source = 'evolution' DESC, i.last_seen_at DESC LIMIT 1), instance_name),
  updated_at = ${sqlValue(nowIso)}
WHERE EXISTS (SELECT 1 FROM instance_identity i WHERE i.whatsapp_number = whatsapp_connections.whatsapp_number);`);
    const rows = await database.query("SELECT connection_key AS connectionKey, whatsapp_number AS number, instance_name AS instanceName FROM whatsapp_connections;");
    return rows;
  }

  async function all() {
    await ensureSchema();
    const database = await cli();
    return database.query(`
SELECT instance_name AS instanceName, whatsapp_number AS number, source, first_seen_at AS firstSeenAt
FROM instance_identity ORDER BY whatsapp_number, instance_name;`);
  }

  return { ensureSchema, record, syncFromInstances, adoptOrphans, linkConnections, numberFor, instanceNamesFor, siblingInstances, all };
}
