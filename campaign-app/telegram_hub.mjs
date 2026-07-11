// telegram_hub.mjs — Mamba 统一收件箱 (Phase 1: 全量转发)。
//
// 一个 bot (mamba_hub_bot), 两个群:
//   收件箱 (TELEGRAM_INBOX_CHAT_ID, forum/Topics ON) — 客户信息, 一个盘一个 topic
//   系统台 (TELEGRAM_OPS_CHAT_ID)                    — 报告/警报, 不放客户信息
//
// 为什么之前会"丢"信息, 这里怎么修:
//   1. 只有 alert keyword 才提醒     -> 现在全量转发 (SPAM 除外)
//   2. 多进程抢 getUpdates           -> Phase 1 的 Hub 只发不收, 零冲突
//   3. Telegram 限速 429 直接蒸发     -> 每个群一条串行队列, 1.1s 间隔 + retry_after 重试
//   4. HTML 没 escape 被 400 拒收    -> 全字段 escapeHtml
//
// Topics 由 Hub 自建自记 (campaign-data/telegram_topics.json), 因为 Bot API
// 无法列出现有 topics。手动建的 topic Hub 认不到 — 不要手动建。
// 固定 topics: 🔴 STOP · 投诉 (全部盘的 RED) / ❓ 陌生来信 (认不出盘的)。
// 盘 topics: 按 campaign-assets/projects.json 自动开 "📥 <盘名>"。
//
// CLI:
//   node telegram_hub.mjs --test   # 验证 forum 开关 + 建 topics + 发测试卡

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { escapeHtml } from "./telegram.mjs";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(appDir, "..");
const dataDir = path.join(rootDir, "campaign-data");
const topicsPath = path.join(dataDir, "telegram_topics.json");
const API = "https://api.telegram.org";

const FIXED_TOPICS = {
  stop: { name: "🔴 STOP · 投诉", icon_color: 16478047 },
  unknown: { name: "❓ 陌生来信", icon_color: 9367192 },
};

function loadEnvFile() {
  const env = {};
  try {
    const text = fs.readFileSync(path.join(rootDir, "evolution-pilot", ".env"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* optional */ }
  return env;
}

function readJsonSyncSafe(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}

export function normalizeProjectKey(name) {
  return String(name ?? "").toLowerCase().replace(/[^a-z0-9一-鿿]+/g, "_").replace(/^_+|_+$/g, "");
}

const SIGNAL_EMOJI = { RED: "🔴", GREEN: "🟢", GREY: "⚪️" };

export function makeHub(env = loadEnvFile()) {
  const token = env.TELEGRAM_HUB_BOT_TOKEN || process.env.TELEGRAM_HUB_BOT_TOKEN
    || env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || "";
  const inboxChatId = env.TELEGRAM_INBOX_CHAT_ID || process.env.TELEGRAM_INBOX_CHAT_ID || "";
  const opsChatId = env.TELEGRAM_OPS_CHAT_ID || process.env.TELEGRAM_OPS_CHAT_ID || "";
  const enabled = Boolean(token && inboxChatId);

  // ---------- raw API ----------
  async function call(method, body, timeoutMs = 20000) {
    const response = await fetch(`${API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await response.json().catch(() => ({}));
    if (!data.ok) {
      const err = new Error(`Telegram ${method}: ${data.description ?? JSON.stringify(data)}`);
      err.code = data.error_code;
      err.retryAfter = data.parameters?.retry_after ?? null;
      throw err;
    }
    return data.result;
  }

  // ---------- per-chat send queue (429-proof) ----------
  const queues = new Map(); // chatId -> Promise chain
  const MIN_GAP_MS = 1100;
  function enqueue(chatId, task) {
    const tail = queues.get(chatId) ?? Promise.resolve();
    const next = tail.then(async () => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          const result = await task();
          await new Promise((r) => setTimeout(r, MIN_GAP_MS));
          return result;
        } catch (error) {
          if (error.code === 429) {
            await new Promise((r) => setTimeout(r, ((error.retryAfter ?? 3) + 1) * 1000));
            continue;
          }
          if ([500, 502, 503, 504].includes(error.code) && attempt < 3) {
            await new Promise((r) => setTimeout(r, (attempt + 1) * 2000));
            continue;
          }
          throw error;
        }
      }
      throw new Error("Telegram send retries exhausted");
    });
    // Keep the chain alive even after a failure (one bad card must not jam the queue).
    queues.set(chatId, next.catch(() => {}));
    return next;
  }

  // ---------- topics ----------
  function loadTopics() {
    const stored = readJsonSyncSafe(topicsPath, null);
    // Chat 换了 (重建群/换 ID) -> 旧 topic 编号全部作废。
    if (!stored || String(stored.chatId) !== String(inboxChatId)) return { chatId: inboxChatId, topics: {} };
    return stored;
  }
  let topicStore = loadTopics();

  async function saveTopics() {
    await fsp.mkdir(dataDir, { recursive: true });
    const tmp = `${topicsPath}.tmp`;
    await fsp.writeFile(tmp, `${JSON.stringify(topicStore, null, 2)}\n`);
    await fsp.rename(tmp, topicsPath);
  }

  async function ensureTopic(key, name, iconColor = 7322096) {
    if (!enabled) return null;
    const cached = topicStore.topics[key];
    if (cached?.threadId) return cached.threadId;
    try {
      const topic = await enqueue(inboxChatId, () => call("createForumTopic", {
        chat_id: inboxChatId,
        name,
        icon_color: iconColor,
      }));
      topicStore.topics[key] = { threadId: topic.message_thread_id, name };
      await saveTopics();
      console.log(`[hub] topic created: ${name} (#${topic.message_thread_id})`);
      return topic.message_thread_id;
    } catch (error) {
      // 群没开 Topics / bot 不是 admin / 没 Manage Topics 权限 -> 发去 General。
      console.log(`[hub] createForumTopic "${name}" failed (${error.message}) — 发去 General。`);
      return null;
    }
  }

  async function topicForProject(projectName) {
    const projects = readJsonSyncSafe(path.join(rootDir, "campaign-assets", "projects.json"))?.projects ?? [];
    const key = normalizeProjectKey(projectName);
    const known = projects.find((p) => normalizeProjectKey(p.name) === key || normalizeProjectKey(p.id) === key);
    if (!known) return ensureTopic("unknown", FIXED_TOPICS.unknown.name, FIXED_TOPICS.unknown.icon_color);
    return ensureTopic(`project:${normalizeProjectKey(known.id)}`, `📥 ${known.name}`);
  }

  // topic 被手动删掉 -> "message thread not found" -> 重建一次再发。
  async function sendToThread(chatId, threadKey, getThreadId, payload) {
    const threadId = await getThreadId();
    const body = { chat_id: chatId, parse_mode: "HTML", disable_web_page_preview: true, ...payload };
    if (threadId) body.message_thread_id = threadId;
    try {
      return await enqueue(chatId, () => call("sendMessage", body));
    } catch (error) {
      if (/thread not found/i.test(error.message) && threadKey && topicStore.topics[threadKey]) {
        delete topicStore.topics[threadKey];
        await saveTopics();
        const freshId = await getThreadId();
        const retryBody = { ...body };
        if (freshId) retryBody.message_thread_id = freshId; else delete retryBody.message_thread_id;
        return enqueue(chatId, () => call("sendMessage", retryBody));
      }
      throw error;
    }
  }

  // ---------- public: inbox card ----------
  // event: { phone, name, text, signal, route, instanceName, suggestedReply, stopFlag }
  async function postInbound(event, projectName = null) {
    if (!enabled) return { skipped: "hub not configured" };
    if (event.route === "SPAM_IGNORE") return { skipped: "spam" };

    const isRed = event.signal === "RED" || event.stopFlag;
    const emoji = SIGNAL_EMOJI[event.signal] ?? "⚪️";
    const lines = [
      `${emoji} <b>${escapeHtml(event.name || "Unknown")}</b> (${escapeHtml(event.phone)})`,
      `🏢 ${escapeHtml(projectName || "未知盘")} · 📱 ${escapeHtml(event.instanceName || "?")} · ${escapeHtml(event.route || "")}`,
      "",
      `💬 ${escapeHtml(event.text || "")}`,
    ];
    if (!isRed && event.suggestedReply && !/【/.test(event.suggestedReply)) {
      lines.push("", `💡 建议: ${escapeHtml(event.suggestedReply)}`);
    }
    if (isRed) lines.push("", "⛔ 已进全局 STOP 名单,系统不会再发给这个号码。");
    const text = lines.join("\n").slice(0, 3900);

    const threadKey = isRed ? "stop" : null;
    const getThreadId = isRed
      ? () => ensureTopic("stop", FIXED_TOPICS.stop.name, FIXED_TOPICS.stop.icon_color)
      : () => topicForProject(projectName);
    const projKey = projectName ? `project:${normalizeProjectKey(projectName)}` : "unknown";
    return sendToThread(inboxChatId, threadKey ?? projKey, getThreadId, { text });
  }

  // ---------- public: ops ----------
  async function postOps(text) {
    if (!token || !opsChatId) return { skipped: "ops not configured" };
    return enqueue(opsChatId, () => call("sendMessage", {
      chat_id: opsChatId,
      text: String(text ?? "").slice(0, 3900),
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }));
  }

  async function checkForum() {
    const chat = await call("getChat", { chat_id: inboxChatId });
    return { isForum: chat.is_forum === true, title: chat.title };
  }

  return { enabled, hasOps: Boolean(token && opsChatId), postInbound, postOps, ensureTopic, checkForum };
}

// ---------- CLI: --test ----------
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun && process.argv.includes("--test")) {
  const hub = makeHub();
  if (!hub.enabled) {
    console.error("Hub 未配置: .env 需要 TELEGRAM_HUB_BOT_TOKEN + TELEGRAM_INBOX_CHAT_ID。");
    process.exit(1);
  }
  console.log("MAMBA | TELEGRAM HUB TEST");
  console.log("=========================");
  const { isForum, title } = await hub.checkForum();
  console.log(`收件箱: ${title} · Topics ${isForum ? "ON ✅" : "OFF ⚠️ (去群设置开 Topics, 不开就全部进 General)"}`);
  const projects = readJsonSyncSafe(path.join(rootDir, "campaign-assets", "projects.json"))?.projects ?? [];
  for (const p of projects) {
    await hub.postInbound({
      phone: "60120000000", name: `测试客户 (${p.name})`, text: "monthly berapa? boleh view?",
      signal: "GREEN", route: "TEST_CARD", instanceName: "wa_test", suggestedReply: "这是测试卡,不用理。",
    }, p.name);
    console.log(`✓ 测试卡 -> 📥 ${p.name}`);
  }
  await hub.postInbound({
    phone: "60120000001", name: "测试 STOP", text: "stop please",
    signal: "RED", route: "STOP_DNC", instanceName: "wa_test", stopFlag: true,
  }, projects[0]?.name ?? null);
  console.log("✓ 测试卡 -> 🔴 STOP · 投诉");
  await hub.postInbound({
    phone: "60120000002", name: "测试陌生人", text: "hello? 你是谁",
    signal: "GREY", route: "UNKNOWN_MANUAL_REVIEW", instanceName: "wa_test", suggestedReply: "人工看一下。",
  }, null);
  console.log("✓ 测试卡 -> ❓ 陌生来信");
  const ops = await hub.postOps("🧪 <b>Mamba 系统台测试</b>\n看到这条 = ops 通道正常。");
  console.log(ops?.skipped ? `⚠️ ops: ${ops.skipped}` : "✓ 测试消息 -> Mamba 系统台");
  console.log("\n完成。去 Telegram 两个群看卡片有没有到、topic 有没有自动开出来。");
}
