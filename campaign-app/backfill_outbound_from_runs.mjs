// 把历史 blast 发出去的讯息，从 campaign-data/runs/*.json 补写进本机数据库。
//
// run 档里存着每个 assignment 的原文 (part1Text / part2Text / extraParts) 和发送
// 结果 (part1.messageId / part1.sentAt)。只有真的发出去的 (有 sentAt 或 messageId)
// 才算，SKIPPED / 失败的不写 —— 客户没收到的东西不该出现在对话里。
//
// 配上 replies.jsonl 的 inbound，过去的对话就能重建成完整的一来一回。
//
//   node campaign-app/backfill_outbound_from_runs.mjs               # 全部
//   node campaign-app/backfill_outbound_from_runs.mjs --dry-run     # 只看不写
//   node campaign-app/backfill_outbound_from_runs.mjs --limit=5     # 一次只拉 5 个 run 档

import fs from "node:fs/promises";
import path from "node:path";
import { paths } from "./campaign_core.mjs";
import { createConversationLogService } from "./lib/conversation-log-service.mjs";

const dryRun = process.argv.includes("--dry-run");
const limit = Number(process.argv.find((arg) => arg.startsWith("--limit="))?.split("=")[1]) || 0;
const runsDir = path.join(paths.dataDir, "runs");

// 一个 part 只有拿到发送结果才算真的出去了。
function sentPart(result) {
  return result && (result.sentAt || result.messageId) ? result : null;
}

function messagesFromRun(run) {
  const out = [];
  const flowTopic = run.templateFlow || run.campaignId || run.project || "";
  for (const assignment of run.assignments ?? []) {
    const phone = assignment?.lead?.phone;
    if (!phone) continue;
    const common = {
      phone,
      name: assignment.lead?.name ?? "",
      instanceName: assignment.instanceName ?? "",
      source: "blast",
      flowTopic,
      runId: run.runId ?? "",
    };
    for (const [textKey, resultKey] of [["part1Text", "part1"], ["part2Text", "part2"]]) {
      const result = sentPart(assignment[resultKey]);
      if (!result || !assignment[textKey]) continue;
      out.push({ ...common, text: assignment[textKey], messageId: result.messageId ?? "", sentAt: result.sentAt ?? run.updatedAt ?? "" });
    }
    for (const extra of assignment.extraParts ?? []) {
      const result = sentPart(extra?.sentInfo);
      if (!result || !extra.text) continue;
      out.push({ ...common, text: extra.text, messageId: result.messageId ?? "", sentAt: result.sentAt ?? run.updatedAt ?? "" });
    }
  }
  return out;
}

let files;
try {
  files = (await fs.readdir(runsDir)).filter((file) => file.endsWith(".json")).sort();
} catch (error) {
  console.log(error.code === "ENOENT" ? `找不到 ${runsDir}，没有历史 blast 要补。` : `读取 ${runsDir} 失败：${error.message}`);
  process.exit(error.code === "ENOENT" ? 0 : 1);
}
if (limit) files = files.slice(0, limit);

const messages = [];
let brokenFiles = 0;
for (const file of files) {
  try {
    messages.push(...messagesFromRun(JSON.parse(await fs.readFile(path.join(runsDir, file), "utf8"))));
  } catch {
    brokenFiles += 1;   // 坏掉的 run 档跳过，其他照补
  }
}

console.log(`run 档 ${files.length} 个${brokenFiles ? `（${brokenFiles} 个读不了，已跳过）` : ""}：真的发出去的讯息 ${messages.length} 条`);

const conversationLog = createConversationLogService({ dataDir: paths.dataDir });
const before = await conversationLog.stats();
console.log(`补写前：conversations ${before.conversations} · messages ${before.messages}（入 ${before.inbound} / 出 ${before.outbound}）`);

if (dryRun) {
  console.log("--dry-run：没有写入任何东西。");
  process.exit(0);
}

const startedAt = Date.now();
const report = await conversationLog.recordOutbounds(messages, {
  onProgress: (state) => process.stdout.write(`\r  已处理 ${state.written} / ${messages.length} 条...`),
});
process.stdout.write("\r");
const after = await conversationLog.stats();
const seconds = (Date.now() - startedAt) / 1000;

console.log(`补写完成：处理 ${report.written} · 名单外跳过 ${report.notLeads} · 无效跳过 ${report.skipped} · 失败 ${report.failed.length}`);
for (const failure of report.failed.slice(0, 10)) console.log(`  ✗ ${failure.id}: ${failure.error}`);
console.log(`新增讯息 ${after.messages - before.messages} 条 · 耗时 ${seconds.toFixed(1)}s · ${report.chunks} 批`);
console.log(`补写后：conversations ${after.conversations} · messages ${after.messages}（入 ${after.inbound} / 出 ${after.outbound}）`);
process.exit(report.failed.length ? 1 : 0);
