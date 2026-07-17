import { httpError, json, readJson } from "../lib/http.mjs";

function requireSettings(runtime) {
  if (!runtime.settings) {
    throw httpError(500, "Settings service 没有载入。请重启 Mamba server。");
  }
  return runtime.settings;
}

function requireTelegramFilters(runtime) {
  if (!runtime.telegramFilters) {
    throw httpError(500, "Telegram Filter List 没有载入。请重启 Mamba server。");
  }
  return runtime.telegramFilters;
}

function requireLocalDatabase(runtime) {
  if (!runtime.localDatabase) {
    throw httpError(500, "Local Database service 没有载入。请重启 Mamba server。");
  }
  return runtime.localDatabase;
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

const BRAIN_PROVIDERS = new Set(["rules", "anthropic", "openai", "gemini", "auto"]);
const OPENAI_REASONING_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh"]);

function cleanModel(value, fallback) {
  const model = String(value || fallback).trim();
  if (!/^[a-zA-Z0-9._:-]{2,80}$/.test(model)) {
    throw httpError(400, `AI model 名称格式不对: ${model || "空白"}`);
  }
  return model;
}

function brainSettingsFromBody(body) {
  const provider = String(body.brainProvider || "").trim().toLowerCase();
  const effort = String(body.openaiReasoningEffort || "").trim().toLowerCase();
  const values = {};
  if (Object.hasOwn(body, "brainEnabled")) {
    values.MAMBA_BRAIN_ENABLED = body.brainEnabled === true ? "1" : "0";
  }
  if (provider) {
    if (!BRAIN_PROVIDERS.has(provider)) throw httpError(400, "AI Provider 只支持 Rule Only、Anthropic、OpenAI、Gemini 或 Auto。");
    values.BRAIN_AI_PROVIDER = provider;
  }
  if (body.anthropicSimpleModel) values.BRAIN_ANTHROPIC_MODEL_SIMPLE = cleanModel(body.anthropicSimpleModel, "claude-haiku-4-5");
  if (body.anthropicComplexModel) values.BRAIN_ANTHROPIC_MODEL_COMPLEX = cleanModel(body.anthropicComplexModel, "claude-sonnet-4-5");
  if (body.openaiSimpleModel) values.BRAIN_OPENAI_MODEL_SIMPLE = cleanModel(body.openaiSimpleModel, "gpt-5.4-nano");
  if (body.openaiComplexModel) values.BRAIN_OPENAI_MODEL_COMPLEX = cleanModel(body.openaiComplexModel, "gpt-5.4");
  if (body.geminiSimpleModel) values.BRAIN_GEMINI_MODEL_SIMPLE = cleanModel(body.geminiSimpleModel, "gemini-3.5-flash");
  if (body.geminiComplexModel) values.BRAIN_GEMINI_MODEL_COMPLEX = cleanModel(body.geminiComplexModel, "gemini-3.1-pro-preview");
  if (effort) {
    if (!OPENAI_REASONING_EFFORTS.has(effort)) throw httpError(400, "OpenAI Reasoning 只支持 none、low、medium、high 或 xhigh。");
    values.BRAIN_OPENAI_REASONING_EFFORT = effort;
  }
  return values;
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

  router.get("/api/settings/local-database", async (_req, res, runtime) => {
    const localDatabase = requireLocalDatabase(runtime);
    json(res, 200, { ok: true, database: await localDatabase.snapshot() });
  });

  router.post("/api/settings/local-database/initialize", async (_req, res, runtime) => {
    const localDatabase = requireLocalDatabase(runtime);
    try {
      const database = await localDatabase.initialize();
      json(res, 200, {
        ok: true,
        database,
        message: "SQLite 数据库壳已初始化。Notion 导入仍保持关闭。",
      });
    } catch (error) {
      throw httpError(500, `初始化 SQLite 失败 [${error.code || "SQLITE_INITIALIZE_FAILED"}]：${error.message}`);
    }
  });

  router.post("/api/settings/local-database/notion-import/preview", async (_req, res, runtime) => {
    const localDatabase = requireLocalDatabase(runtime);
    try {
      const report = await localDatabase.previewNotionImport();
      json(res, 200, {
        ok: true,
        report,
        database: await localDatabase.snapshot(),
        message: "Dry Run 完成：只读取 Notion 并写入本机对账报告；没有导入客户，也没有修改 Notion。",
      });
    } catch (error) {
      throw httpError(400, `Notion → SQLite Dry Run 失败 [${error.code || "NOTION_IMPORT_PREVIEW_FAILED"}]：${error.message}`);
    }
  });

  router.post("/api/settings/local-database/notion-import/apply", async (_req, res, runtime) => {
    const localDatabase = requireLocalDatabase(runtime);
    try {
      const result = await localDatabase.applyNotionImport();
      json(res, 200, {
        ok: true,
        ...result,
        message: `已用单一事务导入 ${result.report.imported} 条本机客户到 SQLite。Notion 没有被修改；切换 Primary 前仍可检查一次。`,
      });
    } catch (error) {
      throw httpError(400, `Notion → SQLite 正式导入失败 [${error.code || "NOTION_IMPORT_APPLY_FAILED"}]：${error.message}`);
    }
  });

  router.post("/api/settings/local-database/mode", async (req, res, runtime) => {
    const localDatabase = requireLocalDatabase(runtime);
    const body = await readJson(req);
    try {
      const database = await localDatabase.setStorageMode(body.mode);
      json(res, 200, {
        ok: true,
        database,
        message: database.storageMode === "primary"
          ? "SQLite Primary 已启用：Customer Desk、Follow-Up 和 Customer Search 的本机客户读取将使用 SQLite。Notion 保留作云端镜像。"
          : "已安全回到 Shadow：客户读取暂时回到原有 Notion/cache 路径，SQLite 资料仍完整保留。",
      });
    } catch (error) {
      throw httpError(400, `切换 SQLite mode 失败 [${error.code || "SQLITE_MODE_CHANGE_FAILED"}]：${error.message}`);
    }
  });

  router.get("/api/settings/telegram-filters", async (_req, res, runtime) => {
    const filters = requireTelegramFilters(runtime);
    json(res, 200, { ok: true, filters: await filters.snapshot({ forceConnected: true }) });
  });

  router.post("/api/settings/telegram-filters", async (req, res, runtime) => {
    const filters = requireTelegramFilters(runtime);
    const body = await readJson(req);
    try {
      const saved = await filters.update({
        text: body.text,
        entries: body.entries,
        autoFilterConnectedSenders: body.autoFilterConnectedSenders !== false,
      });
      json(res, 200, { ok: true, filters: saved });
    } catch (error) {
      throw httpError(500, `保存 Telegram Filter List 失败: ${error.message}`);
    }
  });

  router.post("/api/settings", async (req, res, runtime) => {
    const settings = requireSettings(runtime);
    const body = await readJson(req);
    const values = {};
    const notionToken = String(body.notionToken ?? "").trim();
    const telegramBotToken = String(body.telegramBotToken ?? "").trim();
    const telegramChatId = String(body.telegramChatId ?? "").trim();
    const anthropicApiKey = String(body.anthropicApiKey ?? "").trim();
    const openaiApiKey = String(body.openaiApiKey ?? "").trim();
    const geminiApiKey = String(body.geminiApiKey ?? "").trim();
    Object.assign(values, brainSettingsFromBody(body));

    if (notionToken) values.NOTION_API_KEY = notionToken;
    if (anthropicApiKey) {
      if (!/^sk-ant-/.test(anthropicApiKey)) {
        throw httpError(400, "Anthropic API Key 格式不对: 应该以 sk-ant- 开头 (console.anthropic.com 生成)。");
      }
      values.ANTHROPIC_API_KEY = anthropicApiKey;
    }
    if (openaiApiKey) {
      if (!/^sk-/.test(openaiApiKey) || /^sk-ant-/.test(openaiApiKey)) {
        throw httpError(400, "OpenAI API Key 格式不对: 应该使用 OpenAI Platform 生成的 sk-... key。");
      }
      values.OPENAI_API_KEY = openaiApiKey;
    }
    if (geminiApiKey) {
      if (geminiApiKey.length < 20 || /\s/.test(geminiApiKey)) {
        throw httpError(400, "Gemini API Key 格式不对。请从 Google AI Studio 复制完整 API Key。");
      }
      values.GEMINI_API_KEY = geminiApiKey;
    }
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
      throw httpError(400, "没有任何可保存的设置。请填写 token 或调整 AI Provider / model。");
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

  // AI 大脑的 key: 打一发最便宜的 Haiku 验证 key 能用, 能用才写进 .env。
  // Sales Brain 检测到 ANTHROPIC_API_KEY 存在就自动从 Rule-only 升级成 AI 起草。
  router.post("/api/settings/test-anthropic", async (req, res, runtime) => {
    const settings = requireSettings(runtime);
    const body = await readJson(req);
    const key = String(body.anthropicApiKey ?? settings.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? "").trim();
    if (!key) throw httpError(400, "请先填 Anthropic API Key (sk-ant-...)。");
    if (!/^sk-ant-/.test(key)) throw httpError(400, "格式不对: Anthropic API Key 以 sk-ant- 开头。");
    const model = cleanModel(body.anthropicSimpleModel, settings.env.BRAIN_ANTHROPIC_MODEL_SIMPLE || "claude-haiku-4-5");

    let response;
    let data;
    try {
      response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
        body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: "user", content: "reply with: OK" }] }),
        signal: AbortSignal.timeout(20000),
      });
      data = await response.json().catch(() => null);
    } catch (error) {
      throw httpError(400, `AI API 测试失败: 连不上 Anthropic (${error.message})。检查网络后再试。`);
    }

    if (response.status === 401 || response.status === 403) {
      throw httpError(400, "AI API 测试失败: Key 无效或已被 revoke。去 console.anthropic.com 重新生成一个。");
    }
    if (response.status === 429) {
      // Key 是真的, 只是限流/额度问题 — 照样保存, 提醒一下。
      await settings.writeEnvValues({ ANTHROPIC_API_KEY: key, ...brainSettingsFromBody(body) });
      json(res, 200, { ok: true, warning: "Key 有效但目前限流/额度不足 — 已保存, 充值或稍后即可用。", settings: settings.snapshot() });
      return;
    }
    if (!response.ok) {
      throw httpError(400, `AI API 测试失败: ${data?.error?.message || `HTTP ${response.status}`}`);
    }

    try {
      await settings.writeEnvValues({ ANTHROPIC_API_KEY: key, ...brainSettingsFromBody(body) });
    } catch (error) {
      throw httpError(500, `AI API 测试成功, 但保存失败: 无法写入 evolution-pilot/.env。${error.message}`);
    }
    json(res, 200, { ok: true, model: data?.model || "claude", settings: settings.snapshot() });
  });

  router.post("/api/settings/test-openai", async (req, res, runtime) => {
    const settings = requireSettings(runtime);
    const body = await readJson(req);
    const key = String(body.openaiApiKey ?? settings.env.OPENAI_API_KEY ?? process.env.OPENAI_API_KEY ?? "").trim();
    if (!key) throw httpError(400, "请先填 OpenAI API Key (sk-...)。");
    if (!/^sk-/.test(key) || /^sk-ant-/.test(key)) throw httpError(400, "格式不对: 请使用 OpenAI Platform 生成的 API Key。");
    const model = cleanModel(body.openaiSimpleModel, settings.env.BRAIN_OPENAI_MODEL_SIMPLE || "gpt-5.4-nano");
    const effort = String(body.openaiReasoningEffort || settings.env.BRAIN_OPENAI_REASONING_EFFORT || "medium").trim().toLowerCase();
    if (!OPENAI_REASONING_EFFORTS.has(effort)) throw httpError(400, "OpenAI Reasoning 设置不受支持。");

    let response;
    let data;
    try {
      response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          reasoning: { effort },
          max_output_tokens: 16,
          input: "Reply with exactly: OK",
        }),
        signal: AbortSignal.timeout(30000),
      });
      data = await response.json().catch(() => null);
    } catch (error) {
      throw httpError(400, `OpenAI API 测试失败: 无法连接 (${error.message})。检查网络后再试。`);
    }

    if (response.status === 401 || response.status === 403) {
      throw httpError(400, "OpenAI API 测试失败: Key 无效、权限不足或已被撤销。请在 OpenAI Platform 重新生成。");
    }
    if (response.status === 429) {
      await settings.writeEnvValues({ OPENAI_API_KEY: key, ...brainSettingsFromBody(body) });
      json(res, 200, { ok: true, warning: "OpenAI Key 已识别，但目前额度不足或被限流。设置已保存。", settings: settings.snapshot() });
      return;
    }
    if (!response.ok) {
      throw httpError(400, `OpenAI API 测试失败: ${data?.error?.message || `HTTP ${response.status}`}`);
    }

    try {
      await settings.writeEnvValues({ OPENAI_API_KEY: key, ...brainSettingsFromBody(body) });
    } catch (error) {
      throw httpError(500, `OpenAI 测试成功，但保存失败: ${error.message}`);
    }
    json(res, 200, { ok: true, model: data?.model || model, settings: settings.snapshot() });
  });

  router.post("/api/settings/test-gemini", async (req, res, runtime) => {
    const settings = requireSettings(runtime);
    const body = await readJson(req);
    const key = String(body.geminiApiKey ?? settings.env.GEMINI_API_KEY ?? process.env.GEMINI_API_KEY ?? "").trim();
    if (!key) throw httpError(400, "请先填 Gemini API Key。");
    if (key.length < 20 || /\s/.test(key)) throw httpError(400, "Gemini API Key 格式不完整。请从 Google AI Studio 重新复制。");
    const model = cleanModel(body.geminiSimpleModel, settings.env.BRAIN_GEMINI_MODEL_SIMPLE || "gemini-3.5-flash");

    let response;
    let data;
    try {
      response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "Reply with exactly: OK" }] }],
          generationConfig: { maxOutputTokens: 16 },
        }),
        signal: AbortSignal.timeout(30000),
      });
      data = await response.json().catch(() => null);
    } catch (error) {
      throw httpError(400, `Gemini API 测试失败: 无法连接 Google (${error.message})。`);
    }

    if (response.status === 400 && /API key/i.test(String(data?.error?.message || ""))) {
      throw httpError(400, "Gemini API 测试失败: API Key 无效或项目没有启用 Gemini API。");
    }
    if (response.status === 401 || response.status === 403) {
      throw httpError(400, "Gemini API 测试失败: Key 无效、权限不足或 Gemini API 尚未启用。");
    }
    if (response.status === 429) {
      await settings.writeEnvValues({ GEMINI_API_KEY: key, ...brainSettingsFromBody(body) });
      json(res, 200, { ok: true, warning: "Gemini Key 已识别，但目前额度不足或被限流。设置已保存。", settings: settings.snapshot() });
      return;
    }
    if (!response.ok) {
      throw httpError(400, `Gemini API 测试失败: ${data?.error?.message || `HTTP ${response.status}`}`);
    }

    try {
      await settings.writeEnvValues({ GEMINI_API_KEY: key, ...brainSettingsFromBody(body) });
    } catch (error) {
      throw httpError(500, `Gemini 测试成功，但保存失败: ${error.message}`);
    }
    json(res, 200, { ok: true, model, settings: settings.snapshot() });
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
