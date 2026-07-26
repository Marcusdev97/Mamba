// 把 Evolution 的完整 WhatsApp 历史慢速、分批拉进本机 SQL。
//
// CLI 脚本(backfill_evolution_history.mjs)和 Settings 里的「一键同步」按钮共用这套。
//
// 规则：只导入「有客户回过」的号码的完整对话(双向)；纯 blast 没回、私人冷发不导。
// 幂等：靠 messageId 去重，随时可以再跑补新的。
// 续跑：每完成一页就把断点写进 SQLite；中途断线或重启，下次从下一页继续。

import { describeMessage, resolvePhone } from "../reply_intake.mjs";

const DEFAULT_PAGE_SIZE = 200;
const DEFAULT_PAGE_DELAY_MS = 750;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const EARLIEST_MESSAGE_AT = "1970-01-01T00:00:00.000Z";
const EXCLUDED_JID_MARKERS = ["@g.us", "@broadcast", "@newsletter"];
const SYSTEM_MESSAGE_KEYS = new Set([
  "protocolMessage",
  "senderKeyDistributionMessage",
  "messageContextInfo",
  "keepInChatMessage",
]);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function messageTimeIso(message) {
  const ts = Number(message?.messageTimestamp ?? 0);
  if (!ts) return new Date().toISOString();
  return new Date(ts < 100000000000 ? ts * 1000 : ts).toISOString();
}

function isPrivateMessage(message) {
  const key = message?.key ?? {};
  const jids = [key.remoteJid, key.remoteJidAlt].map((value) => String(value ?? ""));
  if (jids.some((jid) => EXCLUDED_JID_MARKERS.some((marker) => jid.includes(marker)))) return false;
  const body = message?.message;
  if (!body || typeof body !== "object") return false;
  const bodyKeys = Object.keys(body);
  if (!bodyKeys.length || bodyKeys.every((name) => SYSTEM_MESSAGE_KEYS.has(name))) return false;
  return Boolean(resolvePhone(message));
}

// 一条 Evolution 讯息 -> {phone, dir, row}。群组/无电话/系统事件 -> null。
function decode(instance, message) {
  if (!isPrivateMessage(message)) return null;
  const key = message?.key ?? {};
  const phone = resolvePhone(message);
  const text = describeMessage(message);
  if (!phone || !text) return null;
  const sentAt = messageTimeIso(message);
  const messageId = String(key.id || message?.id || `${instance}_${phone}_${sentAt}`);
  if (key.fromMe) {
    return {
      phone,
      dir: "out",
      row: {
        phone,
        text,
        instanceName: instance,
        messageId,
        sentAt,
        source: "phone",
        flowTopic: "history",
      },
    };
  }
  return {
    phone,
    dir: "in",
    row: {
      id: messageId,
      phone,
      text,
      instanceName: instance,
      receivedAt: sentAt,
      name: message.pushName || "",
    },
  };
}

function validResumeState(state) {
  return Boolean(
    state
    && ["running", "failed"].includes(state.status)
    && ["discover", "import"].includes(state.phase)
    && state.cutoffAt
    && Array.isArray(state.repliedPhones),
  );
}

export function createEvolutionHistorySync({
  api,
  conversationLog,
  listInstances,
  pageSize = DEFAULT_PAGE_SIZE,
  pageDelayMs = DEFAULT_PAGE_DELAY_MS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  sleep = wait,
  clock = () => new Date(),
} = {}) {
  if (!api || !conversationLog || !listInstances) {
    throw new Error("evolution history sync 需要 api / conversationLog / listInstances");
  }

  const safePageSize = Math.max(1, Math.min(Number(pageSize) || DEFAULT_PAGE_SIZE, 500));
  const safePageDelayMs = Math.max(0, Number(pageDelayMs) || 0);
  const safeRetryDelayMs = Math.max(0, Number(retryDelayMs) || 0);
  const safeMaxAttempts = Math.max(1, Number(maxAttempts) || DEFAULT_MAX_ATTEMPTS);

  async function fetchPage(instance, page, cutoffAt, onProgress) {
    let lastError = null;
    for (let attempt = 1; attempt <= safeMaxAttempts; attempt += 1) {
      try {
        const response = await api(`/chat/findMessages/${encodeURIComponent(instance)}`, {
          method: "POST",
          body: JSON.stringify({
            where: {
              messageTimestamp: {
                gte: EARLIEST_MESSAGE_AT,
                lte: cutoffAt,
              },
            },
            page,
            offset: safePageSize,
          }),
          timeoutMs: 60_000,
        });
        const meta = response?.messages;
        if (!meta || !Array.isArray(meta.records)) {
          throw new Error("Evolution 回传的 messages.records 格式不完整");
        }
        return {
          page: Number(meta.currentPage) || page,
          pages: Math.max(0, Number(meta.pages) || 0),
          total: Math.max(0, Number(meta.total) || 0),
          records: meta.records,
        };
      } catch (error) {
        lastError = error;
        if (attempt >= safeMaxAttempts) break;
        onProgress?.({
          instance,
          phase: "retry",
          page,
          attempt,
          maxAttempts: safeMaxAttempts,
          error: error.message,
        });
        await sleep(safeRetryDelayMs * attempt);
      }
    }
    throw new Error(`[${instance}] Evolution 历史第 ${page} 页读取失败（已试 ${safeMaxAttempts} 次）：${lastError?.message || "未知错误"}`);
  }

  async function loadState(instance) {
    if (typeof conversationLog.loadHistorySyncState !== "function") return null;
    return await conversationLog.loadHistorySyncState(instance);
  }

  async function saveState(instance, state, dryRun) {
    if (dryRun || typeof conversationLog.saveHistorySyncState !== "function") return;
    await conversationLog.saveHistorySyncState(instance, state);
  }

  async function pauseBetweenPages(page, pages) {
    if (safePageDelayMs > 0 && page < pages) await sleep(safePageDelayMs);
  }

  // 同步一个号码。先扫一遍找「有客户回复」的号码，再扫一遍逐页写入完整双向历史。
  async function syncInstance(instance, { dryRun = false, onProgress = null } = {}) {
    const databaseBefore = await conversationLog.stats();
    let previous = dryRun ? null : await loadState(instance);

    // Reset/清空聊天后，旧断点不能继续用，否则断点之前的页不会补回来。
    if (
      validResumeState(previous)
      && Number(previous.databaseMessagesAtCheckpoint ?? previous.databaseMessagesAtStart) > Number(databaseBefore.messages)
    ) {
      previous = null;
    }

    const resuming = validResumeState(previous);
    let state = resuming
      ? { ...previous, status: "running", error: "" }
      : {
          version: 1,
          instance,
          status: "running",
          phase: "discover",
          cutoffAt: clock().toISOString(),
          page: 0,
          pages: 0,
          total: 0,
          fetched: 0,
          written: 0,
          failed: 0,
          inbound: 0,
          outbound: 0,
          repliedPhones: [],
          databaseMessagesAtStart: Number(databaseBefore.messages) || 0,
          databaseMessagesAtCheckpoint: Number(databaseBefore.messages) || 0,
          startedAt: clock().toISOString(),
          finishedAt: null,
          error: "",
        };

    await saveState(instance, state, dryRun);
    const repliedPhones = new Set(state.repliedPhones);

    try {
      if (state.phase === "discover") {
        const startPage = Math.max(1, Number(state.page) + 1);
        let pages = Math.max(0, Number(state.pages) || 0);
        let page = startPage;
        let needsFirstPage = pages === 0;

        while (needsFirstPage || page <= pages) {
          needsFirstPage = false;
          const batch = await fetchPage(instance, page, state.cutoffAt, onProgress);
          pages = batch.pages;
          for (const message of batch.records) {
            const decoded = decode(instance, message);
            if (decoded?.dir === "in") repliedPhones.add(decoded.phone);
          }
          state = {
            ...state,
            page,
            pages,
            total: batch.total,
            fetched: Number(state.fetched) + batch.records.length,
            repliedPhones: [...repliedPhones],
          };
          await saveState(instance, state, dryRun);
          onProgress?.({
            instance,
            phase: "discover",
            page,
            pages,
            fetched: state.fetched,
            total: batch.total,
            customers: repliedPhones.size,
            resumed: resuming,
          });
          await pauseBetweenPages(page, pages);
          page += 1;
        }

        state = {
          ...state,
          phase: "import",
          page: 0,
          fetched: 0,
          written: 0,
          failed: 0,
          inbound: 0,
          outbound: 0,
          repliedPhones: [...repliedPhones],
        };
        await saveState(instance, state, dryRun);
        onProgress?.({
          instance,
          phase: "decoded",
          customers: repliedPhones.size,
          total: state.total,
        });
      }

      const startPage = Math.max(1, Number(state.page) + 1);
      let pages = Math.max(0, Number(state.pages) || 0);
      let page = startPage;
      let needsFirstPage = pages === 0;
      while (needsFirstPage || page <= pages) {
        needsFirstPage = false;
        const batch = await fetchPage(instance, page, state.cutoffAt, onProgress);
        pages = batch.pages;
        const decoded = batch.records
          .map((message) => decode(instance, message))
          .filter((item) => item && repliedPhones.has(item.phone));
        const inbound = decoded.filter((item) => item.dir === "in").map((item) => item.row);
        const outbound = decoded.filter((item) => item.dir === "out").map((item) => item.row);

        let pageWritten = 0;
        let pageFailed = 0;
        if (!dryRun) {
          const inboundReport = await conversationLog.recordReplies(inbound, { force: true });
          const outboundReport = await conversationLog.recordOutbounds(outbound, { force: true });
          pageWritten = inboundReport.written + outboundReport.written;
          pageFailed = inboundReport.failed.length + outboundReport.failed.length;
        } else {
          pageWritten = decoded.length;
        }
        const checkpointStats = dryRun ? databaseBefore : await conversationLog.stats();

        state = {
          ...state,
          page,
          pages,
          total: batch.total,
          fetched: Number(state.fetched) + batch.records.length,
          written: Number(state.written) + pageWritten,
          failed: Number(state.failed) + pageFailed,
          inbound: Number(state.inbound) + inbound.length,
          outbound: Number(state.outbound) + outbound.length,
          databaseMessagesAtCheckpoint: Number(checkpointStats.messages) || 0,
        };
        await saveState(instance, state, dryRun);
        onProgress?.({
          instance,
          phase: "import",
          page,
          pages,
          fetched: state.fetched,
          total: batch.total,
          written: state.written,
          failed: state.failed,
          customers: repliedPhones.size,
          resumed: resuming,
        });
        await pauseBetweenPages(page, pages);
        page += 1;
      }

      state = {
        ...state,
        status: "completed",
        finishedAt: clock().toISOString(),
        error: "",
      };
      await saveState(instance, state, dryRun);
      return {
        instance,
        customers: repliedPhones.size,
        inbound: state.inbound,
        outbound: state.outbound,
        written: dryRun ? 0 : state.written,
        failed: state.failed,
        dryRun,
        resumed: resuming,
      };
    } catch (error) {
      state = {
        ...state,
        status: "failed",
        finishedAt: clock().toISOString(),
        error: error.message,
      };
      await saveState(instance, state, dryRun).catch(() => {});
      throw error;
    }
  }

  // 同步全部（或指定）号码。
  async function syncAll({ instance = "", dryRun = false, onProgress = null } = {}) {
    let names = (await listInstances()).map((item) => item.name || item?.instance?.instanceName).filter(Boolean);
    if (instance) names = names.filter((name) => name === instance);
    const before = await conversationLog.stats();
    const results = [];
    for (const name of names) {
      results.push(await syncInstance(name, { dryRun, onProgress }));
    }
    const after = await conversationLog.stats();
    return {
      instances: names,
      results,
      added: Number(after.messages) - Number(before.messages),
      totalMessages: after.messages,
      customersWithReplies: after.contactsWithReplies,
    };
  }

  return { syncInstance, syncAll };
}
