// Campaign 状态诊断：一次把「现在到底怎么了」需要的东西全印出来。
//
// 只读，不改任何东西，也不会发送任何讯息。跑完把输出整段贴出来就够判断了。
//
// 为什么需要这支：campaign-data/ 全部在 .gitignore 里(里面是客户名单和电话)，
// 所以两台电脑的运行状态永远不会互相同步，也没办法从另一台看。
//
//   node campaign-app/diagnose_campaign_state.mjs

import fs from "node:fs/promises";
import path from "node:path";
import { paths } from "./campaign_core.mjs";
import { createSqliteCli, findSqliteCli } from "./lib/sqlite-cli.mjs";

const line = (label, value) => console.log(`${String(label).padEnd(22)} ${value}`);
const section = (title) => console.log(`\n━━━ ${title} ${"━".repeat(Math.max(0, 46 - title.length))}`);

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(path.join(paths.dataDir, file), "utf8"));
  } catch {
    return fallback;
  }
}

console.log(`Mamba campaign 诊断 · ${new Date().toISOString()} · 本机时间 ${new Date().toLocaleString()}`);

// ---------- 1. 正在跑的 run ----------
section("1. active-run.json（现在这个 run）");
const run = await readJson("active-run.json");
if (!run) {
  console.log("(没有 active-run.json —— 没有任何 run 在跑过)");
} else {
  const assignments = run.assignments ?? [];
  const byStatus = {};
  for (const item of assignments) byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
  // 真的送出去的以「有没有拿到发送结果」为准，不看 status —— status 可能停在中途。
  const sent = assignments.filter((item) => item.part1?.sentAt || item.part1?.messageId || item.part2?.sentAt || item.part2?.messageId);
  line("runId", run.runId);
  line("project / campaign", `${run.project} / ${run.campaignId}`);
  line("mode", run.mode);
  line("status", run.status);
  line("建立 / 开始", `${run.createdAt} / ${run.startAt}`);
  line("最后更新 / 结束", `${run.updatedAt} / ${run.endAt ?? "(还没结束)"}`);
  line("中断纪录", run.interruption ? JSON.stringify(run.interruption) : "无");
  line("assignments", `${assignments.length} 个 · ${JSON.stringify(byStatus)}`);
  console.log("");
  console.log(`  ⚠️ 真的发出去的：${sent.length} / ${assignments.length}`);
  console.log(`     ${sent.length === 0 ? "→ 0 = 确实没发出去，重跑是安全的" : "→ 不是 0 = 已经有客户收到了，重跑会让他们收第二次"}`);
  for (const item of sent.slice(0, 8)) {
    console.log(`     ${item.lead?.phone ?? "?"}  ${item.lead?.name ?? ""}  ${item.part1?.sentAt ?? item.part2?.sentAt ?? ""}`);
  }
  if (sent.length > 8) console.log(`     ... 还有 ${sent.length - 8} 个`);
  const failed = assignments.filter((item) => item.error);
  if (failed.length) {
    console.log(`\n  失败 ${failed.length} 个，前 5 个原因：`);
    for (const item of failed.slice(0, 5)) console.log(`     ${item.lead?.phone ?? "?"}: ${String(item.error).slice(0, 100)}`);
  }
}

// ---------- 2. 排队 / 注册表 ----------
section("2. 排队中 & run 注册表");
const queue = await readJson("campaign-queue.json");
line("queue 项目数", queue ? (queue.items ?? []).length : "(没有档案)");
line("queue hold", queue?.hold ? JSON.stringify(queue.hold) : "无");
line("queue 更新于", queue?.updatedAt ?? "-");
for (const item of (queue?.items ?? []).slice(0, 5)) console.log(`   · ${JSON.stringify(item).slice(0, 160)}`);

const registry = await readJson("active-runs.json");
line("latestRunId", registry?.latestRunId ?? "-");
const unfinished = (registry?.runs ?? []).filter((item) => !["COMPLETED", "STOPPED", "CANCELLED", "FAILED"].includes(item.status));
console.log(`   还没结束的 run：${unfinished.length} 个`);
for (const item of unfinished) console.log(`   · ${item.runId}  ${item.status}  ${item.mode}  更新于 ${item.updatedAt}`);

// ---------- 3. 每日排程 ----------
section("3. 每日自动 campaign");
const daily = await readJson("daily-campaign.json");
if (!daily) console.log("(没有 daily-campaign.json)");
else {
  line("启用 / 模式 / 时间", `${daily.config?.enabled} / ${daily.config?.mode} / ${daily.config?.time}`);
  line("项目 / 每次上限", `${(daily.config?.projects ?? []).join(", ")} / ${daily.config?.maxLeads}`);
  line("上次尝试日期", daily.state?.lastAttemptDate ?? "-");
  line("停止日期", daily.state?.stoppedDate ?? "无");
  line("上次跑", daily.state?.lastRun ? `${daily.state.lastRun.at} · ${daily.state.lastRun.status}` : "-");
  line("上次检查", daily.state?.lastCheck ? `${daily.state.lastCheck.checkedAt} · ready=${daily.state.lastCheck.ready}` : "-");
}

// ---------- 4. 客户群（挡住重开的通常是这里）----------
section("4. 客户群 lead_groups（LEAD_GROUP_NAME_EXISTS 来源）");
const binary = await findSqliteCli();
if (!binary) console.log("(这台没有 sqlite3，跳过)");
else {
  try {
    const database = await createSqliteCli({ databasePath: path.join(paths.dataDir, "mamba.sqlite") });
    const groups = await database.query(`
SELECT g.group_id AS id, g.group_name AS name, g.project_code AS project,
       g.source_type AS sourceType, g.source_name AS sourceName,
       (SELECT COUNT(*) FROM lead_group_members m WHERE m.group_id = g.group_id) AS members
FROM lead_groups g ORDER BY g.group_name;`);
    console.log(`共 ${groups.length} 个客户群：`);
    for (const group of groups) {
      console.log(`   · ${group.name}  [${group.project}]  ${group.members} 人  来源 ${group.sourceType}/${group.sourceName}`);
      console.log(`     id: ${group.id}`);
    }
    console.log("\n   想重开同名的一批 -> 先把旧的改名：");
    console.log("   curl -X POST http://127.0.0.1:8787/api/lead-groups/rename \\");
    console.log("     -H 'Content-Type: application/json' \\");
    console.log("     -d '{\"groupId\":\"<上面的 id>\",\"projectCode\":\"<project>\",\"name\":\"作废-MMDD\"}'");
  } catch (error) {
    console.log(`(读不到数据库: ${error.message})`);
  }
}

// ---------- 5. 今天的 campaign 错误 ----------
section("5. 今天的 campaign 相关错误");
try {
  const logDir = path.join(paths.rootDir, "campaign-data", "system-logs");
  const files = (await fs.readdir(logDir)).sort().slice(-2);
  let printed = 0;
  for (const file of files) {
    const lines = (await fs.readFile(path.join(logDir, file), "utf8")).split("\n").filter(Boolean);
    for (const raw of lines) {
      let entry;
      try { entry = JSON.parse(raw); } catch { continue; }
      if (!["error", "warn"].includes(entry.level)) continue;
      if (entry.area === "notion") continue;   // Notion 找不到号码是另一回事，会洗版
      console.log(`   ${entry.at} ${entry.level} ${entry.area}/${entry.event}`);
      console.log(`     ${String(entry.message).slice(0, 160)}`);
      printed += 1;
      if (printed >= 15) break;
    }
    if (printed >= 15) break;
  }
  if (!printed) console.log("   (没有 campaign 相关的 error/warn)");
} catch (error) {
  console.log(`   (读不到 system-logs: ${error.message})`);
}

console.log("\n把以上整段贴回来就够判断了。这支脚本没有改动任何东西。");
