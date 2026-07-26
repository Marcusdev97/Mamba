// lid ↔ 电话号码的对照表。
//
// 为什么需要这个：WhatsApp 换成 LID 定址之后，Evolution 存下来的讯息里
// key.remoteJid 是 "257814068985957@lid" 这种隐私 ID，不再是电话号码。
// 实测这台机器 8653 条讯息里 8309 条是 @lid，只有 6 条带真号码、2 条带
// remoteJidAlt —— 也就是说 resolvePhone() 认得出的不到千分之一。
//
// 后果是三件事一起坏：
//   · Evolution 历史补回：decode() 拿不到号码，整批丢掉，写 0 条还报「同步完成」
//   · 你手机回的讯息：outboundFromPhone() 同样拿不到号码，记不进聊天室，
//     于是客户永远停在「等你回」
//   · 线上收回复：只有 Baileys 当场附了 senderPn 的那些才认得出来
//
// Evolution / Baileys / Postgres 里都没有现成的 lid→号码对照(IsOnWhatsapp.lid
// 那栏存的是字串 "lid")，所以只能自己建一张，从三个来源慢慢喂：
//
//   live            讯息本身同时带 @lid 和真号码(remoteJidAlt / senderPn) —— 最可信
//   message_id      本机存的每条讯息都留着 Evolution 自己的 message id，而本机知道
//                   号码；拿 id 回去对 Evolution，那条讯息的 remoteJid 就是这个人的
//                   lid。精确对上，不用猜文字
//   outbound_match  我们自己发出去的 blast 文字 + 时间戳，跟本机发送纪录对得上 ——
//                   本机纪录知道号码，于是反推出这个 lid 是谁
//   profile_name    fetchProfile 拿到 lid 的显示名，跟名单里的名字唯一对上
//
// 高可信度不会被低可信度盖掉，所以补回脚本可以重复跑。

import path from "node:path";
import { createSqliteCli, sqlValue } from "./sqlite-cli.mjs";

const CACHE_TTL_MS = 30_000;

// 数字越大越可信。同一个 lid 只有在「新来源不比旧来源差」时才覆盖。
export const LID_SOURCE_CONFIDENCE = {
  live: 100,
  message_id: 90,
  outbound_match: 80,
  profile_name: 50,
};

const DIGITS_RE = /\D/g;

function digits(value) {
  return String(value ?? "").replace(DIGITS_RE, "");
}

function clean(value) {
  return String(value ?? "").trim();
}

export function schemaSql() {
  return `
CREATE TABLE IF NOT EXISTS lid_map (
  lid TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  source TEXT NOT NULL,
  confidence INTEGER NOT NULL DEFAULT 0,
  evidence TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lid_map_phone ON lid_map(phone);
`;
}

export function createLidMapService({
  dataDir,
  sqliteBinary = "",
  clock = () => new Date(),
} = {}) {
  const databasePath = path.join(dataDir, "mamba.sqlite");
  let cliPromise = null;
  let schemaReady = null;
  let cache = { byLid: new Map(), loadedAt: 0 };

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
      })().catch((error) => {
        schemaReady = null;
        throw error;
      });
    }
    return schemaReady;
  }

  // 表很小(一台电脑几百到几千笔)，整张读进来快取，省掉每条讯息 spawn 一次 sqlite3。
  async function load() {
    const nowMs = clock().getTime();
    if (cache.loadedAt && nowMs - cache.loadedAt < CACHE_TTL_MS) return cache.byLid;
    await ensureSchema();
    const byLid = new Map();
    try {
      const database = await cli();
      for (const row of await database.query("SELECT lid, phone, source, confidence FROM lid_map;")) {
        const lid = clean(row.lid);
        const phone = digits(row.phone);
        if (lid && phone) byLid.set(lid, { phone, source: clean(row.source), confidence: Number(row.confidence) || 0 });
      }
    } catch { /* 读不到就当空表，绝不因此挡住回复流程 */ }
    cache = { byLid, loadedAt: nowMs };
    return byLid;
  }

  async function resolve(lid) {
    const key = clean(lid);
    if (!key) return null;
    return (await load()).get(key)?.phone ?? null;
  }

  // 给热路径用的同步版本：先 warm() 一次，之后每条讯息不用 await。
  function resolveCached(lid) {
    const key = clean(lid);
    if (!key) return null;
    return cache.byLid.get(key)?.phone ?? null;
  }

  const warm = () => load();

  // entries: [{ lid, phone, evidence }]
  //
  // 同一个 lid 已经有更可信的来源时不动它 —— 补回脚本可以随便重跑，
  // 不会用「名字猜的」盖掉「讯息里明写的」。
  async function learn(entries, { source = "live", evidence = "" } = {}) {
    const confidence = LID_SOURCE_CONFIDENCE[source] ?? 0;
    const rows = [];
    const seen = new Set();
    for (const entry of entries ?? []) {
      const lid = clean(entry?.lid);
      const phone = digits(entry?.phone);
      if (!lid || !phone || seen.has(lid)) continue;
      seen.add(lid);
      rows.push({ lid, phone, evidence: clean(entry?.evidence ?? evidence) });
    }
    if (!rows.length) return { learned: 0 };

    await ensureSchema();
    const database = await cli();
    const nowIso = clock().toISOString();
    const values = rows
      .map((row) => `(${[
        sqlValue(row.lid),
        sqlValue(row.phone),
        sqlValue(source),
        sqlValue(confidence),
        sqlValue(row.evidence),
        sqlValue(nowIso),
        sqlValue(nowIso),
      ].join(", ")})`)
      .join(",\n  ");

    await database.exec(`
INSERT INTO lid_map (lid, phone, source, confidence, evidence, created_at, updated_at)
VALUES
  ${values}
ON CONFLICT(lid) DO UPDATE SET
  phone = excluded.phone,
  source = excluded.source,
  confidence = excluded.confidence,
  evidence = excluded.evidence,
  updated_at = excluded.updated_at
WHERE excluded.confidence >= lid_map.confidence;`);

    // 就地更新快取，不要整个清掉。清掉的话 resolveCached() 会在下一次 load()
    // 之前一路回传 null —— 补回历史时每页都会 learn 一次，等于全程查无对照，
    // 8000 条讯息只认得出 8 条。踩过一次了。
    if (cache.loadedAt) {
      for (const row of rows) {
        const existing = cache.byLid.get(row.lid);
        if (existing && existing.confidence > confidence) continue;
        cache.byLid.set(row.lid, { phone: row.phone, source, confidence });
      }
    }
    return { learned: rows.length };
  }

  async function stats() {
    await ensureSchema();
    const database = await cli();
    const rows = await database.query(`
SELECT
  (SELECT COUNT(*) FROM lid_map) AS total,
  (SELECT COUNT(*) FROM lid_map WHERE source = 'live') AS live,
  (SELECT COUNT(*) FROM lid_map WHERE source = 'message_id') AS messageId,
  (SELECT COUNT(*) FROM lid_map WHERE source = 'outbound_match') AS outboundMatch,
  (SELECT COUNT(*) FROM lid_map WHERE source = 'profile_name') AS profileName,
  (SELECT COUNT(DISTINCT phone) FROM lid_map) AS phones;`);
    return rows?.[0] ?? { total: 0, live: 0, outboundMatch: 0, profileName: 0, phones: 0 };
  }

  return { databasePath, ensureSchema, resolve, resolveCached, warm, learn, stats };
}
