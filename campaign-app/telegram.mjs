// Mamba | Telegram notifier
// Small wrapper around the Telegram Bot API. Token + chat id come from
// evolution-pilot/.env (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID), the same file
// loadEnv() in campaign_core.mjs reads.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(appDir, "..");
const envPath = path.join(rootDir, "evolution-pilot", ".env");

const API = "https://api.telegram.org";

// Telegram HTML parse mode only needs these three escaped.
export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// Build a Telegram inline_keyboard from a friendly shape (pure, unit-tested).
// Accepts a flat array of {text, data} (rendered as ONE row) or an array of
// rows: [[{text,data},...],[...]]. callback_data is capped at 64 bytes by
// Telegram — throw early instead of failing at send time.
export function buildInlineKeyboard(buttons) {
  const rows = Array.isArray(buttons?.[0]) ? buttons : [buttons ?? []];
  const keyboard = rows
    .map((row) =>
      (row ?? [])
        .filter((b) => b && b.text)
        .map((b) => {
          const data = String(b.data ?? b.text);
          if (Buffer.byteLength(data, "utf8") > 64) {
            throw new Error(`callback_data 超过 64 bytes: ${data}`);
          }
          return { text: String(b.text), callback_data: data };
        }),
    )
    .filter((row) => row.length);
  return { inline_keyboard: keyboard };
}

// Normalize one getUpdates entry into what the brain service needs (pure).
// -> { type:"callback", updateId, chatId, messageId, data, callbackQueryId }
// -> { type:"message",  updateId, chatId, messageId, text, replyToMessageId }
// -> null for anything else (edited messages, channel posts, etc.)
export function parseUpdate(update) {
  if (!update || typeof update !== "object") return null;
  const updateId = update.update_id ?? null;
  const cb = update.callback_query;
  if (cb) {
    return {
      type: "callback",
      updateId,
      chatId: cb.message?.chat?.id ?? null,
      messageId: cb.message?.message_id ?? null,
      data: cb.data ?? "",
      callbackQueryId: cb.id ?? null,
    };
  }
  const msg = update.message;
  if (msg && typeof msg.text === "string") {
    return {
      type: "message",
      updateId,
      chatId: msg.chat?.id ?? null,
      messageId: msg.message_id ?? null,
      text: msg.text,
      replyToMessageId: msg.reply_to_message?.message_id ?? null,
    };
  }
  return null;
}

export function makeTelegram(env = {}) {
  const token = env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || "";
  const chatId = env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID || "";
  const enabled = Boolean(token);

  async function call(method, body, timeoutMs = 20000) {
    const response = await fetch(`${API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await response.json().catch(() => ({}));
    if (!data.ok) throw new Error(`Telegram ${method}: ${JSON.stringify(data)}`);
    return data.result;
  }

  return {
    enabled,
    hasChatId: Boolean(chatId),
    token,
    chatId,
    async getMe() {
      return call("getMe");
    },
    // Long-poll friendly: pass { offset, timeoutSec } for the brain service's
    // callback loop. Default stays instant (timeout 0) for setup_telegram.mjs.
    async getUpdates({ offset, timeoutSec = 0 } = {}) {
      return call(
        "getUpdates",
        { timeout: timeoutSec, ...(offset != null ? { offset } : {}) },
        (timeoutSec + 15) * 1000,
      );
    },
    // Draft + inline buttons (✅照发 / ✏️改后发 / 🙋接管). Buttons stay on ONE
    // message, so text is truncated instead of split (splitting would detach
    // the keyboard from the content).
    async sendWithButtons(text, buttons, toChatId = chatId) {
      if (!enabled) throw new Error("TELEGRAM_BOT_TOKEN is not set.");
      if (!toChatId) throw new Error("No chat id. Run Setup Telegram first.");
      const body = String(text ?? "");
      return call("sendMessage", {
        chat_id: toChatId,
        text: body.length > 3800 ? `${body.slice(0, 3800)}\n…(truncated)` : body,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: buildInlineKeyboard(buttons),
      });
    },
    // Ack a button press so the client stops showing the loading spinner.
    async answerCallback(callbackQueryId, text = "") {
      return call("answerCallbackQuery", { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
    },
    // Rewrite a draft message after a decision (also removes the buttons so
    // the same draft can't be approved twice).
    async editMessageText(toChatId, messageId, text) {
      return call("editMessageText", {
        chat_id: toChatId,
        message_id: messageId,
        text: String(text ?? "").slice(0, 4000),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
    },
    // Telegram caps a message at 4096 chars; split on line breaks to stay safe.
    async send(text, toChatId = chatId) {
      if (!enabled) throw new Error("TELEGRAM_BOT_TOKEN is not set.");
      if (!toChatId) throw new Error("No chat id. Run Setup Telegram first.");
      const chunks = splitForTelegram(text);
      let last;
      for (const chunk of chunks) {
        last = await call("sendMessage", {
          chat_id: toChatId,
          text: chunk,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        });
      }
      return last;
    },
  };
}

function splitForTelegram(text, limit = 3800) {
  const lines = String(text ?? "").split("\n");
  const chunks = [];
  let current = "";
  for (const line of lines) {
    if ((current + line + "\n").length > limit) {
      if (current) chunks.push(current.trimEnd());
      current = "";
    }
    current += `${line}\n`;
  }
  if (current.trim()) chunks.push(current.trimEnd());
  return chunks.length ? chunks : [""];
}

// Persist a key back into evolution-pilot/.env (used to save the resolved chat id).
export async function writeEnvValue(key, value) {
  let text = await fs.readFile(envPath, "utf8");
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  text = pattern.test(text) ? text.replace(pattern, line) : `${text.trimEnd()}\n${line}\n`;
  await fs.writeFile(envPath, text);
}
