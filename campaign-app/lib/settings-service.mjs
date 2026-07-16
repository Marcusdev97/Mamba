import fs from "node:fs/promises";
import path from "node:path";

function maskSecret(value) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 10) return `${text.slice(0, 2)}***${text.slice(-2)}`;
  return `${text.slice(0, 6)}...${text.slice(-4)}`;
}

function isTelegramBotToken(value) {
  return /^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(String(value || "").trim());
}

function isTelegramChatId(value) {
  const text = String(value || "").trim();
  return /^-?\d{5,}$/.test(text) || /^@[A-Za-z0-9_]{5,}$/.test(text);
}

function assertTelegramBotToken(value) {
  if (!isTelegramBotToken(value)) {
    throw new Error("Telegram Bot Token 格式不对。Bot token 长这样: 123456789:ABC...，请放在 Bot Token 栏位。");
  }
}

function assertTelegramChatId(value) {
  const text = String(value || "").trim();
  if (!text) return;
  if (isTelegramBotToken(text)) {
    throw new Error("你把 Bot Token 放进 Chat ID 了。Chat ID 是数字；先对 bot 发 hi，再点「自动找 Chat ID」。");
  }
  if (/^[A-Za-z0-9_]+_bot$/i.test(text) || /^@[A-Za-z0-9_]+_bot$/i.test(text)) {
    throw new Error("Chat ID 不是 bot username。先在 Telegram 对这个 bot 发一句 hi，然后点「自动找 Chat ID」。");
  }
  if (!isTelegramChatId(text)) {
    throw new Error("Chat ID 格式不对。私人聊天通常是数字；group/channel 可以是 @username。");
  }
}

async function telegramApi(method, token, body = {}) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const data = await response.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Telegram ${method}: ${JSON.stringify(data)}`);
  return data.result;
}

function telegramName(value) {
  if (!value) return "";
  const handle = value.username ? `@${value.username}` : "";
  const full = [value.first_name, value.last_name].filter(Boolean).join(" ").trim();
  return value.title || full || handle || String(value.id || "");
}

export function createSettingsService({ env, envPath, getNotionToken, notion }) {
  async function writeEnvValues(values) {
    let text = "";
    try {
      text = await fs.readFile(envPath, "utf8");
    } catch {
      await fs.mkdir(path.dirname(envPath), { recursive: true });
    }

    const lines = text.split(/\r?\n/);
    for (const [key, value] of Object.entries(values)) {
      const clean = value === null ? null : String(value ?? "").trim();
      if (clean !== null && !clean) continue;
      const line = `${key}=${clean}`;
      let replaced = false;

      for (let index = 0; index < lines.length; index += 1) {
        if (lines[index].startsWith(`${key}=`)) {
          if (clean === null) {
            lines.splice(index, 1);
            index -= 1;
            replaced = true;
            continue;
          }
          lines[index] = line;
          replaced = true;
        }
      }

      if (clean !== null && !replaced) {
        if (lines.length && lines.at(-1) !== "") lines.push("");
        lines.push(line);
      }
      if (clean === null) {
        delete env[key];
        delete process.env[key];
      } else {
        env[key] = clean;
        process.env[key] = clean;
      }
    }

    await fs.writeFile(envPath, `${lines.join("\n").replace(/\n+$/, "")}\n`);
  }

  function snapshot() {
    const notionToken = getNotionToken();
    const botToken = env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || "";
    const chatId = env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID || "";
    const anthropicKey = env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || "";
    const openaiKey = env.OPENAI_API_KEY || process.env.OPENAI_API_KEY || "";
    const geminiKey = env.GEMINI_API_KEY || process.env.GEMINI_API_KEY || "";
    const configuredProvider = String(env.BRAIN_AI_PROVIDER || process.env.BRAIN_AI_PROVIDER || "").trim().toLowerCase();
    const brainEnabled = String(env.MAMBA_BRAIN_ENABLED || process.env.MAMBA_BRAIN_ENABLED || "0").trim() === "1";
    const provider = ["rules", "anthropic", "openai", "gemini", "auto"].includes(configuredProvider)
      ? configuredProvider
      : (anthropicKey ? "anthropic" : (openaiKey ? "openai" : (geminiKey ? "gemini" : "rules")));
    const botValid = isTelegramBotToken(botToken);
    const chatValid = isTelegramChatId(chatId);
    return {
      notion: {
        configured: Boolean(notionToken),
        masked: maskSecret(notionToken),
      },
      anthropic: {
        configured: Boolean(anthropicKey),
        masked: maskSecret(anthropicKey),
      },
      openai: {
        configured: Boolean(openaiKey),
        masked: maskSecret(openaiKey),
      },
      gemini: {
        configured: Boolean(geminiKey),
        masked: maskSecret(geminiKey),
      },
      brain: {
        enabled: brainEnabled,
        provider,
        anthropicSimpleModel: env.BRAIN_ANTHROPIC_MODEL_SIMPLE || process.env.BRAIN_ANTHROPIC_MODEL_SIMPLE || "claude-haiku-4-5",
        anthropicComplexModel: env.BRAIN_ANTHROPIC_MODEL_COMPLEX || process.env.BRAIN_ANTHROPIC_MODEL_COMPLEX || "claude-sonnet-4-5",
        openaiSimpleModel: env.BRAIN_OPENAI_MODEL_SIMPLE || process.env.BRAIN_OPENAI_MODEL_SIMPLE || "gpt-5.4-nano",
        openaiComplexModel: env.BRAIN_OPENAI_MODEL_COMPLEX || process.env.BRAIN_OPENAI_MODEL_COMPLEX || "gpt-5.4",
        openaiReasoningEffort: env.BRAIN_OPENAI_REASONING_EFFORT || process.env.BRAIN_OPENAI_REASONING_EFFORT || "medium",
        geminiSimpleModel: env.BRAIN_GEMINI_MODEL_SIMPLE || process.env.BRAIN_GEMINI_MODEL_SIMPLE || "gemini-3.5-flash",
        geminiComplexModel: env.BRAIN_GEMINI_MODEL_COMPLEX || process.env.BRAIN_GEMINI_MODEL_COMPLEX || "gemini-3.1-pro-preview",
      },
      telegram: {
        botConfigured: botValid,
        botInvalid: Boolean(botToken && !botValid),
        botMasked: maskSecret(botToken),
        chatConfigured: chatValid,
        chatInvalid: Boolean(chatId && !chatValid),
        chatId: chatValid ? chatId : "",
      },
    };
  }

  async function identity() {
    const result = {
      notion: { ok: false, label: "", error: "" },
      telegram: { botOk: false, botLabel: "", chatOk: false, chatLabel: "", error: "" },
    };

    const notionToken = getNotionToken();
    if (notionToken) {
      try {
        const me = await notion("GET", "/users/me");
        result.notion.ok = true;
        result.notion.label = me?.name || me?.bot?.owner?.workspace_name || me?.id || "Notion integration";
      } catch (error) {
        result.notion.error = error.message;
      }
    }

    const botToken = env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || "";
    const chatId = env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID || "";
    if (isTelegramBotToken(botToken)) {
      try {
        const bot = await telegramApi("getMe", botToken, {});
        result.telegram.botOk = true;
        result.telegram.botLabel = telegramName(bot);
      } catch (error) {
        result.telegram.error = error.message;
      }
      if (isTelegramChatId(chatId)) {
        try {
          const chat = await telegramApi("getChat", botToken, { chat_id: chatId });
          result.telegram.chatOk = true;
          const name = telegramName(chat);
          const username = chat.username ? `@${chat.username}` : "";
          result.telegram.chatLabel = [name, username && username !== name ? username : "", chat.type ? `(${chat.type})` : ""]
            .filter(Boolean)
            .join(" ");
        } catch (error) {
          result.telegram.error = error.message;
        }
      }
    }

    return result;
  }

  return {
    env,
    snapshot,
    identity,
    writeEnvValues,
    telegramApi,
    isTelegramChatId,
    assertTelegramBotToken,
    assertTelegramChatId,
  };
}
