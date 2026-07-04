// Mamba | Nightly Summary
//
// Click it at the end of the day (after you've uploaded today's call records to
// Notion). It counts today's activity and sends a digest to Telegram:
//   - calls made today      (Recycle "Call Date" today + Ads call touches today)
//   - blasts sent today     (from campaign-data/runs/*.json)
//   - new ad leads today    (Ads "Lead Received At" today)
//   - replies received today (Blast "Last Reply At" today) — bonus
//
// All dates are Kuala Lumpur / GMT+8.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./campaign_core.mjs";
import { createNotionSync } from "./notion_sync.mjs";
import { makeTelegram } from "./telegram.mjs";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(appDir, "..");
const runsDir = path.join(rootDir, "campaign-data", "runs");
const TZ = "Asia/Kuala_Lumpur";

function klDate(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86400000).toLocaleDateString("en-CA", { timeZone: TZ });
}
function klDateOf(iso) {
  return iso ? new Date(iso).toLocaleDateString("en-CA", { timeZone: TZ }) : "";
}

async function countWhere(sync, dbId, filter) {
  if (!dbId) return 0;
  let total = 0;
  let cursor;
  do {
    const res = await sync.request("POST", `/databases/${dbId.replace(/[^a-fA-F0-9]/g, "")}/query`, {
      filter,
      page_size: 100,
      start_cursor: cursor,
    });
    total += (res?.results ?? []).length;
    cursor = res?.has_more ? res.next_cursor : null;
  } while (cursor);
  return total;
}

// Ads call touches: Last Touch At today AND a call-type touch.
async function countAdsCalls(sync, adsId, today) {
  if (!adsId) return 0;
  const res = await sync.queryDataSource(adsId, { property: "Last Touch At", date: { equals: today } }, 100);
  const callTypes = new Set(["Call Attempt", "Call Answered", "No Answer"]);
  return (res?.results ?? []).filter((p) => callTypes.has(p?.properties?.["Last Touch Type"]?.select?.name)).length;
}

async function blastsToday(today) {
  let files = [];
  try { files = (await fs.readdir(runsDir)).filter((f) => f.endsWith(".json")); } catch { return 0; }
  const phones = new Set();
  for (const file of files) {
    let run;
    try { run = JSON.parse(await fs.readFile(path.join(runsDir, file), "utf8")); } catch { continue; }
    for (const job of run?.assignments ?? []) {
      const sentAt = job?.part1?.sentAt ?? job?.part2?.sentAt;
      if (sentAt && klDateOf(sentAt) === today) phones.add(job?.lead?.phone ?? `${file}:${job.id}`);
    }
  }
  return phones.size;
}

async function main() {
  const env = await loadEnv();
  const sync = await createNotionSync({ env, onLog: () => {} });
  const tg = makeTelegram(env);

  console.log("MAMBA | NIGHTLY SUMMARY");
  console.log("=======================");
  if (!sync.enabled) { console.log("Notion token missing. Run Set Notion Token first."); process.exit(1); }

  const today = klDate(0);
  const ids = {
    blast: sync.config.databases.blastLeads,
    ads: sync.config.databases.adsLeads,
    recycle: sync.config.databases.recycleLeads,
  };

  // Each metric is isolated: one failing Notion query (e.g. a property name that
  // doesn't match your schema) no longer aborts the whole summary. Failed metrics
  // show as "?" and the reason is listed at the bottom.
  const errors = [];
  const safe = async (label, fn) => {
    try { return await fn(); }
    catch (error) { errors.push(`${label} → ${error.message}`); return null; }
  };

  const [recycleCalls, adsCalls, newAds, replies, blasted] = await Promise.all([
    safe("Recycle「Call Date」", () => countWhere(sync, ids.recycle, { property: "Call Date", date: { equals: today } })),
    safe("Ads「Last Touch At/Type」", () => countAdsCalls(sync, ids.ads, today)),
    safe("Ads「Lead Received At」", () => countWhere(sync, ids.ads, { property: "Lead Received At", date: { equals: today } })),
    safe("Blast「Last Reply At」", () => countWhere(sync, ids.blast, { property: "Last Reply At", date: { equals: today } })),
    safe("Blast runs (本地)", () => blastsToday(today)),
  ]);
  const num = (v) => (v == null ? "?" : v);
  const calls = (recycleCalls == null && adsCalls == null) ? "?" : (recycleCalls ?? 0) + (adsCalls ?? 0);

  const dow = new Date(`${today}T20:00:00+08:00`).toLocaleDateString("en-US", { weekday: "short", timeZone: TZ });
  const message = [
    `🌙 <b>Mamba 今日总结</b> — ${today} (${dow})`,
    "",
    `📞 电话:<b>${calls}</b> 通`,
    `📣 Blast:<b>${num(blasted)}</b> 个`,
    `🆕 新广告 leads:<b>${num(newAds)}</b> 个`,
    `💬 今天收到回复:<b>${num(replies)}</b> 条`,
    "",
    "<i>提醒:电话数来自你今天上传 Notion 的通话记录。</i>",
  ].join("\n");

  console.log("");
  console.log(message.replace(/<[^>]+>/g, ""));
  console.log(`(detail: recycle calls ${num(recycleCalls)}, ads calls ${num(adsCalls)})`);
  if (errors.length) {
    console.log("");
    console.log(`⚠️ ${errors.length} 个指标查询失败(多半是 Notion 栏位名字对不上):`);
    for (const e of errors) console.log(`   - ${e}`);
  }

  if (tg.enabled && tg.hasChatId) {
    await tg.send(message);
    console.log("\nSent to Telegram.");
  } else {
    console.log("\n(Telegram not configured — run Setup Telegram to push this to your phone.)");
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
