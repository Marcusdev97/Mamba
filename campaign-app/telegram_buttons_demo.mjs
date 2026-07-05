// telegram_buttons_demo.mjs — 缺口 2 验收脚本 (LIVE, needs TELEGRAM_BOT_TOKEN).
//
// Sends one test message with the brain service's three buttons to your chat,
// then long-polls until you press one (or reply after pressing ✏️) and prints
// what came back. Ctrl+C to stop.
//
// Run: node campaign-app/telegram_buttons_demo.mjs

import { loadEnv } from "./campaign_core.mjs";
import { makeTelegram, parseUpdate } from "./telegram.mjs";

const env = await loadEnv();
const tg = makeTelegram(env);
if (!tg.enabled) { console.error("TELEGRAM_BOT_TOKEN 不在 .env — 先跑 Setup Telegram。"); process.exit(1); }
if (!tg.hasChatId) { console.error("TELEGRAM_CHAT_ID 不在 .env — 先跑 Setup Telegram。"); process.exit(1); }

const sent = await tg.sendWithButtons(
  "🧠 <b>Mamba 按钮测试</b>\n这是一条 brain service 风格的草稿。按任意按钮:",
  [
    { text: "✅ 照发", data: "ok:demo" },
    { text: "✏️ 改后发", data: "edit:demo" },
    { text: "🙋 接管", data: "take:demo" },
  ],
);
console.log(`已发送测试消息 (message_id=${sent.message_id})。去手机按一个按钮…`);

let offset;
for (;;) {
  const updates = await tg.getUpdates({ offset, timeoutSec: 25 }).catch((err) => {
    console.error(`getUpdates 失败: ${err.message} — 3 秒后重试`);
    return new Promise((res) => setTimeout(() => res([]), 3000));
  });
  for (const raw of updates) {
    offset = raw.update_id + 1;
    const u = parseUpdate(raw);
    if (!u) continue;
    if (u.type === "callback") {
      console.log(`👉 你按了: ${u.data}`);
      await tg.answerCallback(u.callbackQueryId, `收到: ${u.data}`);
      if (u.data.startsWith("edit:")) {
        await tg.send("好,回复我你改好的文本(直接发消息即可)。");
        console.log("   等待你的编辑文本…");
      } else {
        await tg.editMessageText(u.chatId, u.messageId, `🧠 测试完成 — 你按了 <b>${u.data}</b> ✅`);
        console.log("验收通过。Ctrl+C 退出。");
      }
    }
    if (u.type === "message") {
      console.log(`✏️ 你回复的编辑文本: ${u.text}`);
      console.log("验收通过。Ctrl+C 退出。");
    }
  }
}
