// Mamba | Setup Telegram
// One-time helper. After you have sent your bot any message in Telegram, this
// reads your chat id from getUpdates, saves it into evolution-pilot/.env, and
// sends a confirmation message so you know it works.

import { loadEnv } from "./campaign_core.mjs";
import { makeTelegram, writeEnvValue } from "./telegram.mjs";

async function main() {
  const env = await loadEnv();
  const tg = makeTelegram(env);

  console.log("MAMBA | SETUP TELEGRAM");
  console.log("======================");

  if (!tg.enabled) {
    console.log("No TELEGRAM_BOT_TOKEN found in evolution-pilot/.env.");
    process.exit(1);
  }

  const me = await tg.getMe();
  console.log(`Bot: @${me.username} (${me.first_name})`);

  if (tg.hasChatId) {
    console.log(`Chat id already set: ${tg.chatId}`);
    await tg.send("✅ <b>Mamba Sales OS</b> 已连接。设置完成,你会在这里收到每天的跟进清单和日报。");
    console.log("Sent a confirmation message. Done.");
    return;
  }

  const updates = await tg.getUpdates();
  const chats = [];
  for (const update of updates) {
    const message = update.message ?? update.edited_message ?? update.channel_post;
    const chat = message?.chat;
    if (chat?.id && !chats.find((c) => c.id === chat.id)) {
      chats.push({ id: chat.id, who: chat.username || chat.first_name || chat.title || "?" });
    }
  }

  if (!chats.length) {
    console.log("");
    console.log("找不到任何消息。请先在 Telegram 里打开你的 bot,发一句话(例如 hi),");
    console.log(`然后再点一次这个 Setup。Bot: @${me.username}`);
    process.exit(1);
  }

  // Newest chat to message the bot wins.
  const chosen = chats[chats.length - 1];
  await writeEnvValue("TELEGRAM_CHAT_ID", String(chosen.id));
  console.log(`Found chat: ${chosen.who} (id ${chosen.id}) — saved to .env`);

  const confirmTg = makeTelegram({ ...env, TELEGRAM_CHAT_ID: String(chosen.id) });
  await confirmTg.send("✅ <b>Mamba Sales OS</b> 已连接成功!\n以后每天的「今日跟进清单」和「晚间日报」都会发到这里。");
  console.log("Sent a confirmation message. Setup complete.");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
