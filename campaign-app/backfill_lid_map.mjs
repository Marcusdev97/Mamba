// 建立 lid → 电话号码的对照表，让 Evolution 历史补回和「你手机的回复」认得出客户是谁。
//
// 背景见 lib/lid-map-service.mjs：WhatsApp 换成 LID 定址后，Evolution 存的
// key.remoteJid 变成 "257814068985957@lid"，电话号码不在讯息里。没有对照表的话
// 历史补回会静静地写 0 条。
//
// 四个来源，由可信到不可信：
//   1. pair       讯息本身同时带 @lid 和真号码 —— 白拿的，直接信
//   2. message_id 本机每条讯息都留着 Evolution 自己的 message id，而本机知道号码。
//                 拿这个 id 回去对 Evolution，那条讯息的 remoteJid 就是这个人的 lid。
//                 精确对上，不用猜 —— 涵盖率也最高，因为线上收过的每条回复都算数。
//   3. outbound   我们自己发的 blast 文字 + 时间戳，跟本机发送纪录对得上 ——
//                 本机纪录知道号码，反推这个 lid 是谁。只收「唯一命中」的，
//                 同一句话对到两个人就整条丢掉。
//   4. profile    fetchProfile 拿到 lid 的显示名，跟名单里的名字唯一对上 ——
//                 最弱，预设不开，要 --with-profile-names 才跑
//
// 幂等：高可信度不会被低可信度盖掉，随时可以重跑。
//
//   node campaign-app/backfill_lid_map.mjs
//   node campaign-app/backfill_lid_map.mjs --instance=wa_01
//   node campaign-app/backfill_lid_map.mjs --with-profile-names
//   node campaign-app/backfill_lid_map.mjs --dry-run

import { paths, makeApi, loadEnv, listInstances } from "./campaign_core.mjs";
import { createLidMapService } from "./lib/lid-map-service.mjs";
import { createSqliteCli } from "./lib/sqlite-cli.mjs";
import { lidPhonePair, resolveLid, normalizePhone } from "./reply_intake.mjs";
import path from "node:path";

const PAGE_SIZE = 200;
const PAGE_DELAY_MS = 300;
// 同一句话在这个时间窗内发出去，才算是同一条讯息。太宽会把重发的同一模板
// 对到错的人，太窄会被时钟偏差和排队延迟弄丢。
const TIME_WINDOW_SECONDS = 180;

const dryRun = process.argv.includes("--dry-run");
const withProfileNames = process.argv.includes("--with-profile-names");
const onlyInstance = process.argv.find((a) => a.startsWith("--instance="))?.split("=")[1] || "";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const normText = (value) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 120).toLowerCase();
const normName = (value) => String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();

const env = await loadEnv();
const api = makeApi(env);
const lidMap = createLidMapService({ dataDir: paths.dataDir });
const database = await createSqliteCli({ databasePath: path.join(paths.dataDir, "mamba.sqlite") });

async function fetchAllMessages(instance) {
  const records = [];
  let page = 1;
  let pages = 1;
  while (page <= pages) {
    const response = await api(`/chat/findMessages/${encodeURIComponent(instance)}`, {
      method: "POST",
      body: JSON.stringify({ where: {}, page, offset: PAGE_SIZE }),
      timeoutMs: 60_000,
    });
    const meta = response?.messages;
    if (!meta || !Array.isArray(meta.records)) throw new Error("Evolution 回传的 messages.records 格式不完整");
    pages = Math.max(1, Number(meta.pages) || 1);
    records.push(...meta.records);
    process.stdout.write(`\r[${instance}] 读取 Evolution… 第 ${page}/${pages} 页 · ${records.length} 条   `);
    if (page < pages) await wait(PAGE_DELAY_MS);
    page += 1;
  }
  process.stdout.write("\n");
  return records;
}

// 来源 1：讯息自己招了。
function pairsFromMessages(records) {
  return records.map(lidPhonePair).filter(Boolean);
}

// 一堆 {lid -> phone} 的票，取多数决；票数打平就整个丢掉(宁可不知道，也不要写错人)。
function tallyToPairs(votes, label) {
  const pairs = [];
  let conflicts = 0;
  for (const [lid, tally] of votes) {
    const ranked = [...tally].sort((a, b) => b[1] - a[1]);
    if (ranked.length > 1) {
      conflicts += 1;
      if (ranked[0][1] === ranked[1][1]) continue;
    }
    pairs.push({ lid, phone: ranked[0][0], evidence: `${label} x${ranked[0][1]}` });
  }
  return { pairs, conflicts };
}

// 来源 2：拿 Evolution 自己的 message id 回来对。
//
// 线上收到回复时我们已经解出号码并存下来了，存的时候 id 用的就是 Evolution 的
// message id。所以「本机这条讯息的号码」+「Evolution 同一条讯息的 remoteJid」
// 就是一组精确的 lid ↔ 号码。这是涵盖率最高的一条路 —— 客户回过一次就永久认得。
// 客户「回」过来的那些讯息说了算，我们「发」出去的只是备胎。
//
// 为什么要分开：发出去的号码是我们名单上拨的那个，回来的号码是 WhatsApp 自己
// 报的 senderPn —— 也就是这个帐号真正的身分。同一个人名单上写马来西亚号、
// 帐号却挂在新加坡号的情况是有的(踩到 2 个)，这时候多数决会选中「我们拨的号」，
// 于是往后这个人的回复全部归错档，对话被劈成两半。
// 规则很简单：只要有客户回过，就以回的那个号码为准。
function pickPhone(tally) {
  const source = tally.inbound.size ? tally.inbound : tally.outbound;
  const ranked = [...source].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return null;
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) return null;   // 打平就宁可不知道
  return { phone: ranked[0][0], votes: ranked[0][1], fromInbound: tally.inbound.size > 0 };
}

async function pairsFromMessageIds(instance, records) {
  const ours = await database.query(`
SELECT m.id AS id, v.contact_key AS phone
FROM messages m
JOIN conversations v ON v.id = m.conversation_id
WHERE m.id <> '';`);
  const phoneById = new Map(ours.map((row) => [String(row.id), String(row.phone)]));

  const votes = new Map();
  for (const message of records) {
    const lid = resolveLid(message);
    const id = String(message?.key?.id ?? "");
    if (!lid || !id) continue;
    const phone = phoneById.get(id);
    if (!phone) continue;
    if (!votes.has(lid)) votes.set(lid, { inbound: new Map(), outbound: new Map() });
    const tally = votes.get(lid);
    const bucket = message?.key?.fromMe === true ? tally.outbound : tally.inbound;
    bucket.set(phone, (bucket.get(phone) ?? 0) + 1);
  }

  const pairs = [];
  const mismatched = [];
  for (const [lid, tally] of votes) {
    const all = new Set([...tally.inbound.keys(), ...tally.outbound.keys()]);
    if (all.size > 1) mismatched.push({ lid, inbound: [...tally.inbound.keys()], outbound: [...tally.outbound.keys()] });
    const picked = pickPhone(tally);
    if (!picked) continue;
    pairs.push({
      lid,
      phone: picked.phone,
      evidence: `${instance}:message_id ${picked.fromInbound ? "inbound" : "outbound"} x${picked.votes}`,
    });
  }
  return { pairs, mismatched };
}

// 来源 3：拿我们自己发出去的话去对。
async function pairsFromOutbound(instance, records) {
  const ours = await database.query(`
SELECT v.contact_key AS phone,
       CAST(strftime('%s', m.sent_at) AS INTEGER) AS ts,
       m.text AS text
FROM messages m
JOIN conversations v ON v.id = m.conversation_id
WHERE m.direction = 'outbound' AND m.text <> '';`);

  const byText = new Map();
  for (const row of ours) {
    const key = normText(row.text);
    if (!byText.has(key)) byText.set(key, []);
    byText.get(key).push({ phone: String(row.phone), ts: Number(row.ts) });
  }

  // 一个 lid 可能对到好几条讯息 —— 收集所有票，最后取多数决。
  const votes = new Map();
  for (const message of records) {
    if (message?.key?.fromMe !== true) continue;
    const lid = resolveLid(message);
    if (!lid) continue;
    const body = message?.message ?? {};
    const text = body.conversation ?? body.extendedTextMessage?.text ?? "";
    if (!text) continue;
    const candidates = byText.get(normText(text));
    if (!candidates) continue;
    const ts = Number(message.messageTimestamp ?? 0);
    const phones = [...new Set(
      candidates.filter((c) => Math.abs(c.ts - ts) <= TIME_WINDOW_SECONDS).map((c) => c.phone),
    )];
    if (phones.length !== 1) continue;   // 对到不只一个人就不算数
    if (!votes.has(lid)) votes.set(lid, new Map());
    const tally = votes.get(lid);
    tally.set(phones[0], (tally.get(phones[0]) ?? 0) + 1);
  }

  return tallyToPairs(votes, `${instance}:outbound_text`);
}

// 来源 4：靠显示名对名单。名字重复的一律不要。
async function pairsFromProfiles(instance, records, known) {
  const leads = await database.query("SELECT contact_key AS phone, display_name AS name FROM contacts WHERE display_name <> '';");
  const byName = new Map();
  for (const row of leads) {
    const key = normName(row.name);
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, new Set());
    byName.get(key).add(String(row.phone));
  }

  const lids = [...new Set(records.map(resolveLid).filter(Boolean))].filter((lid) => !known.has(lid));
  const pairs = [];
  let checked = 0;
  for (const lid of lids) {
    checked += 1;
    process.stdout.write(`\r[${instance}] 查显示名… ${checked}/${lids.length}   `);
    const profile = await api(`/chat/fetchProfile/${encodeURIComponent(instance)}`, {
      method: "POST",
      body: JSON.stringify({ number: `${lid}@lid` }),
      timeoutMs: 30_000,
    }).catch(() => null);
    const matches = byName.get(normName(profile?.name));
    if (matches?.size === 1) {
      pairs.push({ lid, phone: [...matches][0], evidence: `${instance}:profile_name ${profile.name}` });
    }
    await wait(PAGE_DELAY_MS);
  }
  if (lids.length) process.stdout.write("\n");
  return pairs;
}

const all = await listInstances(api);
let names = all.filter((item) => String(item.status).toUpperCase() === "OPEN").map((item) => item.name);
if (onlyInstance) names = names.filter((name) => name === onlyInstance);
if (!names.length) {
  console.error(onlyInstance ? `找不到已连接的号码 ${onlyInstance}。` : "Evolution 上没有已连接的号码。");
  process.exit(1);
}

const before = await lidMap.stats();
console.log(`对照表现有 ${before.total} 笔（live ${before.live} · message id ${before.messageId} · 文字比对 ${before.outboundMatch} · 显示名 ${before.profileName}）\n`);

for (const instance of names) {
  const records = await fetchAllMessages(instance);
  const privateRecords = records.filter((m) => !String(m?.key?.remoteJid ?? "").includes("@g.us"));
  console.log(`[${instance}] 共 ${records.length} 条，其中一对一 ${privateRecords.length} 条`);

  const direct = pairsFromMessages(privateRecords);
  if (!dryRun && direct.length) await lidMap.learn(direct, { source: "live", evidence: `${instance}:message_field` });
  console.log(`[${instance}] 讯息自带号码：${new Set(direct.map((p) => p.lid)).size} 个 lid`);

  const { pairs: byId, mismatched } = await pairsFromMessageIds(instance, privateRecords);
  if (!dryRun && byId.length) await lidMap.learn(byId, { source: "message_id" });
  console.log(`[${instance}] message id 精确比对：${byId.length} 个 lid`);
  // 同一个 WhatsApp 帐号在本机挂着两个号码 —— 这是名单资料本身的问题，
  // 不是程式选错，所以要讲出来让人去合并，不能默默吞掉。
  for (const item of mismatched) {
    console.log(`  ⚠ 同一个客户挂着多个号码：回复来自 ${item.inbound.join("/") || "(无)"}，我们发给 ${item.outbound.join("/") || "(无)"} —— 已以回复的号码为准，建议在名单里合并`);
  }

  const { pairs: matched, conflicts } = await pairsFromOutbound(instance, privateRecords);
  if (!dryRun && matched.length) await lidMap.learn(matched, { source: "outbound_match" });
  console.log(`[${instance}] 发送文字比对：${matched.length} 个 lid${conflicts ? `（另有 ${conflicts} 个票数冲突）` : ""}`);

  if (withProfileNames) {
    await lidMap.warm();
    const known = new Set([...direct, ...byId, ...matched].map((p) => p.lid));
    const byName = await pairsFromProfiles(instance, privateRecords, known);
    if (!dryRun && byName.length) await lidMap.learn(byName, { source: "profile_name" });
    console.log(`[${instance}] 显示名比对：${byName.length} 个 lid`);
  }

  const unresolvedLids = [...new Set(privateRecords.map(resolveLid).filter(Boolean))];
  await lidMap.warm();
  const stillUnknown = unresolvedLids.filter((lid) => !lidMap.resolveCached(lid));
  console.log(`[${instance}] 仍然认不出的 lid：${stillUnknown.length}/${unresolvedLids.length}\n`);
}

const after = await lidMap.stats();
console.log(`${dryRun ? "(dry-run) " : ""}对照表现在 ${after.total} 笔（live ${after.live} · message id ${after.messageId} · 文字比对 ${after.outboundMatch} · 显示名 ${after.profileName}）· 涵盖 ${after.phones} 个号码`);
console.log(`新增 ${after.total - before.total} 笔。接着跑：node campaign-app/backfill_evolution_history.mjs`);
