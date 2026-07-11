// daily_scorecard.mjs — 每晚成绩单: 今天 blast 了多少、多少人回、什么温度。
//
// 数据全部来自本地 (不打 Notion, 半夜跑也稳):
//   blast 数   <- campaign-data/runs/*.json   (assignments 里 part1.sentAt 是今天的)
//   回复       <- campaign-data/tracker/replies.jsonl (receivedAt 是今天的, 每人取最后一条)
//   盘归属     <- knowledge_layer.resolveProjectLocal (active-run/tracker/projects.json)
//   新增 STOP  <- 回复里的 stopFlag + suppressed_local.json 今天加的
//
// 发去 Mamba 系统台 (Hub ops 群), 没配 ops 退回旧私聊。
//
// CLI:
//   node daily_scorecard.mjs            # 算今天 + 发送
//   node daily_scorecard.mjs --dry      # 只打印不发送 (测试用)
//   node daily_scorecard.mjs --date 2026-07-10   # 指定日期 (测试/补发)
//
// 定时: launchd/install_launchd.sh 装 com.mamba.scorecard, 每晚 22:00 自动跑。

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeHub } from "./telegram_hub.mjs";
import { resolveProjectLocal } from "./knowledge_layer.mjs";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(appDir, "..");
const dataDir = path.join(rootDir, "campaign-data");
const TZ = "Asia/Kuala_Lumpur";

const DRY = process.argv.includes("--dry");
const dateIdx = process.argv.indexOf("--date");
const TODAY = dateIdx !== -1
  ? String(process.argv[dateIdx + 1])
  : new Date().toLocaleDateString("en-CA", { timeZone: TZ });

const klDay = (iso) => (iso ? new Date(iso).toLocaleDateString("en-CA", { timeZone: TZ }) : null);

async function readJsonSafe(p, fallback = null) {
  try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return fallback; }
}

// ---------- blast counts (per project) ----------
async function blastStats() {
  const perProject = new Map(); // project -> { sent, skippedStop, skippedReplied, failed }
  let files = [];
  try { files = (await fs.readdir(path.join(dataDir, "runs"))).filter((f) => f.endsWith(".json")); } catch { /* none */ }
  for (const file of files) {
    const run = await readJsonSafe(path.join(dataDir, "runs", file));
    if (!run?.assignments) continue;
    // 快速跳过整个 run 都不是今天的 (updatedAt/startAt 都不在今天且没有今天的 sentAt 很少见)
    const project = run.project || "未知盘";
    for (const job of run.assignments) {
      const sentDay = klDay(job?.part1?.sentAt);
      const touchedToday = sentDay === TODAY
        || (String(job.status).startsWith("SKIPPED") && klDay(run.updatedAt) === TODAY);
      if (!touchedToday) continue;
      const s = perProject.get(project) ?? { sent: 0, skippedStop: 0, skippedReplied: 0, failed: 0 };
      if (sentDay === TODAY) s.sent += 1;
      else if (job.status === "SKIPPED_SUPPRESSED") s.skippedStop += 1;
      else if (job.status === "SKIPPED_REPLIED") s.skippedReplied += 1;
      if (job.status === "FAILED" && sentDay === TODAY) s.failed += 1;
      perProject.set(project, s);
    }
  }
  // active-run (还没归档进 runs/ 的当前批) 也算进去
  const active = await readJsonSafe(path.join(dataDir, "active-run.json"));
  if (active?.assignments) {
    const project = active.project || "未知盘";
    for (const job of active.assignments) {
      if (klDay(job?.part1?.sentAt) !== TODAY) continue;
      const s = perProject.get(project) ?? { sent: 0, skippedStop: 0, skippedReplied: 0, failed: 0 };
      s.sent += 1;
      perProject.set(project, s);
    }
  }
  return perProject;
}

// ---------- reply stats (per project, unique phones, latest event wins) ----------
async function replyStats() {
  let lines = [];
  try { lines = (await fs.readFile(path.join(dataDir, "tracker", "replies.jsonl"), "utf8")).split(/\r?\n/).filter(Boolean); }
  catch { /* no tracker data */ }
  const latestByPhone = new Map();
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (klDay(event.receivedAt) !== TODAY) continue;
    const prev = latestByPhone.get(event.phone);
    if (!prev || new Date(event.receivedAt) > new Date(prev.receivedAt)) latestByPhone.set(event.phone, event);
  }
  const perProject = new Map(); // project -> { replies, green, grey, red, viewing }
  for (const [phone, event] of latestByPhone) {
    const project = resolveProjectLocal(phone) || "未知盘";
    const s = perProject.get(project) ?? { replies: 0, green: 0, grey: 0, red: 0, viewing: 0 };
    s.replies += 1;
    if (event.signal === "RED" || event.stopFlag) s.red += 1;
    else if (event.signal === "GREEN") s.green += 1;
    else s.grey += 1;
    if (event.route === "VIEWING_REQUEST") s.viewing += 1;
    perProject.set(project, s);
  }
  return perProject;
}

async function newStopsToday() {
  const overlay = await readJsonSafe(path.join(dataDir, "suppressed_local.json"));
  return Object.values(overlay?.entries ?? {}).filter((e) => klDay(e.at) === TODAY).length;
}

// ---------- Notion extras (从旧 nightly_summary 继承的两个指标) ----------
// 今日 call 数 (Recycle "Call Date" + Ads call touches) 和新 ads lead。
// Notion 挂了/没 token -> 返回 null, 成绩单其余部分照发 (best-effort)。
async function notionExtras() {
  try {
    const { loadEnv } = await import("./campaign_core.mjs");
    const { createNotionSync } = await import("./notion_sync.mjs");
    const env = await loadEnv();
    const sync = await createNotionSync({ env, onLog: () => {} });
    if (!sync.enabled) return null;
    const dbs = sync.config.databases ?? {};
    const clean = (v) => String(v ?? "").replace(/[^a-fA-F0-9]/g, "");

    const countWhere = async (dbId, filter) => {
      if (!clean(dbId)) return 0;
      let total = 0;
      let cursor;
      do {
        const res = await sync.request("POST", `/databases/${clean(dbId)}/query`, {
          filter, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}),
        });
        total += (res?.results ?? []).length;
        cursor = res?.has_more ? res.next_cursor : null;
      } while (cursor);
      return total;
    };

    const [recycleCalls, adsToday, newAdLeads] = await Promise.all([
      countWhere(dbs.recycleLeads, { property: "Call Date", date: { equals: TODAY } }).catch(() => 0),
      sync.queryDataSource(dbs.adsLeads, { property: "Last Touch At", date: { equals: TODAY } }, 100).catch(() => null),
      countWhere(dbs.adsLeads, { property: "Lead Received At", date: { equals: TODAY } }).catch(() => 0),
    ]);
    const callTypes = new Set(["Call Attempt", "Call Answered", "No Answer"]);
    const adsCalls = (adsToday?.results ?? []).filter((p) => callTypes.has(p?.properties?.["Last Touch Type"]?.select?.name)).length;
    return { calls: recycleCalls + adsCalls, newAdLeads };
  } catch {
    return null;
  }
}

// ---------- compose ----------
function line(project, b, r) {
  const bits = [`<b>${project}</b>`];
  const sent = b?.sent ?? 0;
  const replies = r?.replies ?? 0;
  bits.push(`blast ${sent}`);
  bits.push(`回复 ${replies}${sent ? ` (${((replies / sent) * 100).toFixed(1)}%)` : ""}`);
  const parts = [`  🟢 ${r?.green ?? 0} · ⚪️ ${r?.grey ?? 0} · 🔴 ${r?.red ?? 0}${r?.viewing ? ` · 📅 约看 ${r.viewing}` : ""}`];
  const skipped = (b?.skippedStop ?? 0) + (b?.skippedReplied ?? 0);
  if (skipped) parts.push(`  防线挡下 ${skipped} 个 (STOP ${b.skippedStop} / 未结算回复 ${b.skippedReplied})`);
  return `${bits.join(" · ")}\n${parts.join("\n")}`;
}

async function main() {
  const [blasts, replies, stops, extras] = await Promise.all([blastStats(), replyStats(), newStopsToday(), notionExtras()]);
  const projects = [...new Set([...blasts.keys(), ...replies.keys()])].sort();

  const dow = new Date(`${TODAY}T12:00:00+08:00`).toLocaleDateString("en-US", { weekday: "short", timeZone: TZ });
  const parts = [`📊 <b>Mamba 今日成绩</b> — ${TODAY} (${dow})`, ""];
  if (!projects.length) {
    parts.push("今天没有 blast 也没有回复。");
  } else {
    for (const p of projects) parts.push(line(p, blasts.get(p), replies.get(p)), "");
    const totalSent = [...blasts.values()].reduce((n, s) => n + s.sent, 0);
    const totalReplies = [...replies.values()].reduce((n, s) => n + s.replies, 0);
    const totalViewing = [...replies.values()].reduce((n, s) => n + s.viewing, 0);
    parts.push(`合计: 发 ${totalSent} · 回 ${totalReplies}${totalSent ? ` (${((totalReplies / totalSent) * 100).toFixed(1)}%)` : ""}${totalViewing ? ` · 约看 ${totalViewing}` : ""}${stops ? ` · 全局 STOP +${stops}` : ""}`);
  }
  if (extras) parts.push(`📞 今日 call ${extras.calls} 通 · 新 ads lead ${extras.newAdLeads} 个`);
  const message = parts.join("\n").trim();

  console.log("MAMBA | DAILY SCORECARD");
  console.log("=======================");
  console.log(message.replace(/<[^>]+>/g, ""));

  if (DRY) { console.log("\n(--dry: 没有发送)"); return; }
  const hub = makeHub();
  if (hub.hasOps) {
    await hub.postOps(message);
    console.log("\nSent to Mamba 系统台。");
  } else {
    const { makeTelegram } = await import("./telegram.mjs");
    const tg = makeTelegram(Object.fromEntries(Object.entries(process.env)));
    if (tg.enabled && tg.hasChatId) { await tg.send(message); console.log("\nSent to Telegram (私聊 fallback)。"); }
    else console.log("\nTelegram 未配置,只打印。");
  }
}

main().catch((error) => {
  console.error(`Scorecard failed: ${error.message}`);
  process.exitCode = 1;
});
