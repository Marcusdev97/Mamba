import { httpError, json, readJson } from "../lib/http.mjs";

function requireSettings(runtime) {
  if (!runtime.settings) {
    throw httpError(500, "Settings service 没有载入。请重启 Mamba server。");
  }
  return runtime.settings;
}

function readableTelegramError(error, action) {
  const message = String(error?.message || "");
  if (message.includes("chat not found")) {
    return `${action}失败: Telegram 找不到这个 Chat ID。先去 Telegram 对 bot 发一句 hi，或把 bot 加进 group 后再点「自动找 Chat ID」。`;
  }
  if (message.includes("Unauthorized")) {
    return `${action}失败: Bot Token 无效或已经被 Telegram revoke。请重新复制 BotFather 的 token。`;
  }
  if (message.includes("Bad Request")) {
    return `${action}失败: Telegram 回报 Bad Request。请检查 Bot Token 和 Chat ID 是否放在正确栏位。`;
  }
  return `${action}失败: ${message || "Telegram 没有返回明确原因。"}`;
}

export function registerSettingsRoutes(router) {
  router.get("/api/settings", async (_req, res, runtime) => {
    const settings = requireSettings(runtime);
    json(res, 200, { ok: true, settings: settings.snapshot() });
  });

  router.get("/api/settings/identity", async (_req, res, runtime) => {
    const settings = requireSettings(runtime);
    try {
      json(res, 200, { ok: true, identity: await settings.identity() });
    } catch (error) {
      throw httpError(400, `无法确认 Settings 连接状态: ${error.message}`);
    }
  });

  router.post("/api/settings", async (req, res, runtime) => {
    const settings = requireSettings(runtime);
    const body = await readJson(req);
    const values = {};
    const notionToken = String(body.notionToken ?? "").trim();
    const telegramBotToken = String(body.telegramBotToken ?? "").trim();
    const telegramChatId = String(body.telegramChatId ?? "").trim();

    if (notionToken) values.NOTION_API_KEY = notionToken;
    if (telegramBotToken) {
      settings.assertTelegramBotToken(telegramBotToken);
      values.TELEGRAM_BOT_TOKEN = telegramBotToken;
      if (!telegramChatId && !settings.isTelegramChatId(settings.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID || "")) {
        values.TELEGRAM_CHAT_ID = null;
      }
    }
    if (telegramChatId) {
      settings.assertTelegramChatId(telegramChatId);
      values.TELEGRAM_CHAT_ID = telegramChatId;
    }
    if (!Object.keys(values).length) {
      throw httpError(400, "没有填写任何要保存的 token。请至少填写 Notion Token、Telegram Bot Token 或 Telegram Chat ID 其中一个。");
    }

    try {
      await settings.writeEnvValues(values);
    } catch (error) {
      throw httpError(500, `保存 Settings 失败: 无法写入 evolution-pilot/.env。${error.message}`);
    }
    json(res, 200, { ok: true, settings: settings.snapshot() });
  });

  router.post("/api/settings/telegram-chat", async (req, res, runtime) => {
    const settings = requireSettings(runtime);
    const body = await readJson(req);
    const token = String(body.telegramBotToken ?? settings.env.TELEGRAM_BOT_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
    if (!token) throw httpError(400, "请先填 Telegram Bot Token。");
    settings.assertTelegramBotToken(token);

    let updates;
    try {
      updates = await settings.telegramApi("getUpdates", token, {});
    } catch (error) {
      throw httpError(400, readableTelegramError(error, "自动找 Chat ID"));
    }

    const chats = [];
    for (const update of updates || []) {
      const message = update.message ?? update.edited_message ?? update.channel_post;
      const chat = message?.chat;
      if (chat?.id && !chats.find((c) => c.id === chat.id)) {
        chats.push({ id: chat.id, name: chat.username || chat.first_name || chat.title || "Telegram Chat" });
      }
    }
    if (!chats.length) {
      throw httpError(404, "找不到 chat。先去 Telegram 打开你的 bot，发一句 hi，然后再点一次「自动找 Chat ID」。");
    }

    const chosen = chats.at(-1);
    try {
      await settings.writeEnvValues({ TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: String(chosen.id) });
    } catch (error) {
      throw httpError(500, `找到 Chat ID 了，但保存失败: 无法写入 evolution-pilot/.env。${error.message}`);
    }
    json(res, 200, { ok: true, chat: chosen, settings: settings.snapshot() });
  });

  router.post("/api/settings/test-telegram", async (req, res, runtime) => {
    const settings = requireSettings(runtime);
    const body = await readJson(req);
    const token = String(body.telegramBotToken ?? settings.env.TELEGRAM_BOT_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
    const chatId = String(body.telegramChatId ?? settings.env.TELEGRAM_CHAT_ID ?? process.env.TELEGRAM_CHAT_ID ?? "").trim();
    if (!token) throw httpError(400, "请先填 Telegram Bot Token。");
    if (!chatId) throw httpError(400, "请先填 Telegram Chat ID，或点「自动找 Chat ID」。");
    settings.assertTelegramBotToken(token);
    settings.assertTelegramChatId(chatId);

    let me;
    try {
      me = await settings.telegramApi("getMe", token, {});
      await settings.telegramApi("sendMessage", token, {
        chat_id: chatId,
        text: "Mamba Telegram 已连接成功。",
      });
    } catch (error) {
      throw httpError(400, readableTelegramError(error, "发送测试 Telegram"));
    }

    try {
      await settings.writeEnvValues({ TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chatId });
    } catch (error) {
      throw httpError(500, `Telegram 测试成功，但保存失败: 无法写入 evolution-pilot/.env。${error.message}`);
    }
    json(res, 200, { ok: true, bot: me?.username || me?.first_name || "Telegram Bot", settings: settings.snapshot() });
  });
}
