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

export function makeTelegram(env = {}) {
  const token = env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || "";
  const chatId = env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID || "";
  const enabled = Boolean(token);

  async function call(method, body) {
    const response = await fetch(`${API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(20000),
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
    async getUpdates() {
      return call("getUpdates", { timeout: 0 });
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
