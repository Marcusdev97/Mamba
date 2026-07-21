// 把 tracker/replies.jsonl 里的历史回复补写进本机数据库。
//
// 幂等：message id 已经在库里就自然被 INSERT OR IGNORE 挡掉，contacts 的统计栏位
// 是重算不是累加，所以重复跑几次结果都一样。写失败随时可以再跑。
//
//   node campaign-app/backfill_reply_conversations.mjs              # 全部
//   node campaign-app/backfill_reply_conversations.mjs --dry-run    # 只看不写
//   node campaign-app/backfill_reply_conversations.mjs --limit=2000 # 一次只拉一批

import fs from "node:fs/promises";
import path from "node:path";
import { paths } from "./campaign_core.mjs";
import { createConversationLogService } from "./lib/conversation-log-service.mjs";

const dryRun = process.argv.includes("--dry-run");
const limit = Number(process.argv.find((arg) => arg.startsWith("--limit="))?.split("=")[1]) || 0;
const eventsPath = path.join(paths.dataDir, "tracker", "replies.jsonl");

let raw;
try {
  raw = await fs.readFile(eventsPath, "utf8");
} catch (error) {
  console.log(error.code === "ENOENT"
    ? `找不到 ${eventsPath}，没有历史回复要补。`
    : `读取 ${eventsPath} 失败：${error.message}`);
  process.exit(error.code === "ENOENT" ? 0 : 1);
}

const events = [];
let broken = 0;
for (const line of raw.split(/\r?\n/)) {
  if (!line.trim()) continue;
  try {
    events.push(JSON.parse(line));
  } catch {
    broken += 1;   // 旧的/损坏的行跳过，不要让整批补写停下来
  }
}
const batch = limit ? events.slice(0, limit) : events;

console.log(`replies.jsonl: ${events.length} 条可读${broken ? `，${broken} 行损坏已跳过` : ""}${limit ? `，这次处理前 ${batch.length} 条` : ""}`);

const conversationLog = createConversationLogService({ dataDir: paths.dataDir });
const before = await conversationLog.stats();
console.log(`补写前：conversations ${before.conversations} · messages ${before.messages}`);

if (dryRun) {
  console.log("--dry-run：没有写入任何东西。");
  process.exit(0);
}

const startedAt = Date.now();
const report = await conversationLog.recordReplies(batch, {
  onProgress: (state) => process.stdout.write(`\r  已处理 ${state.written} / ${batch.length} 条...`),
});
process.stdout.write("\r");
const after = await conversationLog.stats();
const seconds = (Date.now() - startedAt) / 1000;

console.log(`补写完成：处理 ${report.written} · 名单外跳过 ${report.notLeads} · 无效跳过 ${report.skipped} · 失败 ${report.failed.length}`);
for (const failure of report.failed.slice(0, 10)) console.log(`  ✗ ${failure.id}: ${failure.error}`);
if (report.failed.length > 10) console.log(`  ... 还有 ${report.failed.length - 10} 条失败`);
console.log(`新增讯息 ${after.messages - before.messages} 条（其余是已经写过的）· 耗时 ${seconds.toFixed(1)}s · ${report.chunks} 批`);
console.log(`补写后：conversations ${after.conversations} · messages ${after.messages}（入 ${after.inbound} / 出 ${after.outbound}）· 有回复的客户 ${after.contactsWithReplies}`);
process.exit(report.failed.length ? 1 : 0);
