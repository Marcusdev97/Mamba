// 一次过把 Evolution 里的完整 WhatsApp 历史拉进本机 SQL，让聊天室看到完整对话。
//
// 核心逻辑在 lib/evolution-history-sync.mjs，Settings 里的「一键同步」按钮共用同一套。
// 只导入「有客户回过」的号码的完整对话；幂等，随时可以再跑。
//
//   node campaign-app/backfill_evolution_history.mjs                # 全部号码
//   node campaign-app/backfill_evolution_history.mjs --instance=wa_01
//   node campaign-app/backfill_evolution_history.mjs --dry-run      # 只看不写

import { paths, makeApi, loadEnv, listInstances } from "./campaign_core.mjs";
import { createConversationLogService } from "./lib/conversation-log-service.mjs";
import { createEvolutionHistorySync } from "./lib/evolution-history-sync.mjs";

const dryRun = process.argv.includes("--dry-run");
const onlyInstance = process.argv.find((a) => a.startsWith("--instance="))?.split("=")[1] || "";

const env = await loadEnv();
const api = makeApi(env);
const conversationLog = createConversationLogService({ dataDir: paths.dataDir });
const sync = createEvolutionHistorySync({
  api, conversationLog,
  listInstances: async () => listInstances(api),
});

const before = await conversationLog.stats();
console.log(`导入前：messages ${before.messages}（入 ${before.inbound} / 出 ${before.outbound}）\n`);

const result = await sync.syncAll({
  instance: onlyInstance, dryRun,
  onProgress: (p) => {
    if (p.phase === "fetch") process.stdout.write(`\r[${p.instance}] 拉取中… 第 ${p.page}/${p.pages} 页 · 累计 ${p.fetched} 条   `);
    else if (p.phase === "decoded") process.stdout.write(`\n[${p.instance}] 有回复的客户 ${p.customers} 个（入 ${p.inbound} / 出 ${p.outbound}）\n`);
    else if (p.phase === "write") process.stdout.write(`\r[${p.instance}] 写入 ${p.written}/${p.total}…   `);
  },
}).catch((error) => { console.error(`\n导入出错：${error.message}`); process.exit(1); });

console.log("\n");
for (const r of result.results) {
  console.log(`[${r.instance}] ${r.dryRun ? "(dry-run) " : ""}客户 ${r.customers} 个 · 写入 ${r.written} 条${r.failed ? ` · 失败 ${r.failed}` : ""}`);
}
console.log(`\n新增 ${result.added} 条 · 现在共 ${result.totalMessages} 条 · 有回复的客户 ${result.customersWithReplies} 个`);
