// 把 Evolution 的完整 WhatsApp 历史慢速、分批拉进本机 SQL。
//
// CLI 脚本(backfill_evolution_history.mjs)和 Settings 里的「一键同步」按钮共用这套。
//
// 规则：只导入「有客户回过」的号码的完整对话(双向)；纯 blast 没回、私人冷发不导。
// 幂等：靠 messageId 去重，随时可以再跑补新的。
// 续跑：每完成一页就把断点写进 SQLite；中途断线或重启，下次从下一页继续。

import { describeMessage, messageMediaKind, resolvePhoneWithLid, resolveLid, lidPhonePair } from "../reply_intake.mjs";

const DEFAULT_PAGE_SIZE = 200;
// 扫完一整轮，如果私聊讯息里认得出号码的不到这个比例，就当成「坏掉」而不是
// 「没有新讯息」。LID 定址那次就是这样静静写 0 条还报同步完成的。
const MIN_RESOLVE_RATIO = 0.05;
const DEFAULT_PAGE_DELAY_MS = 750;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RECENT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RECENT_MAX_PAGES = 3;
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

// 「这是一条一对一的真讯息吗」——跟号码认不认得出来无关。
// 认不认得出号码是 decode 的事；两件事混在一起的话，「全部认不出」就跟
// 「本来就没有私聊讯息」长得一模一样，坏掉也看不出来。
function isPrivateMessage(message) {
  const key = message?.key ?? {};
  const jids = [key.remoteJid, key.remoteJidAlt].map((value) => String(value ?? ""));
  if (jids.some((jid) => EXCLUDED_JID_MARKERS.some((marker) => jid.includes(marker)))) return false;
  const body = message?.message;
  if (!body || typeof body !== "object") return false;
  const bodyKeys = Object.keys(body);
  if (!bodyKeys.length || bodyKeys.every((name) => SYSTEM_MESSAGE_KEYS.has(name))) return false;
  return true;
}

// 一条 Evolution 讯息 -> {phone, dir, row}。群组/系统事件/认不出号码 -> null。
function decode(instance, message, lookup = null) {
  if (!isPrivateMessage(message)) return null;
  const key = message?.key ?? {};
  const phone = resolvePhoneWithLid(message, lookup);
  const text = describeMessage(message);
  if (!phone || !text) return null;
  const sentAt = messageTimeIso(message);
  const messageId = String(key.id || message?.id || `${instance}_${phone}_${sentAt}`);
  const remoteJid = String(key.remoteJid ?? message?.remoteJid ?? "");
  const lid = resolveLid(message);
  if (key.fromMe) {
    return {
      phone,
      dir: "out",
      row: {
        phone,
        text,
        mediaKind: messageMediaKind(message),
        instanceName: instance,
        remoteJid,
        lid,
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
      mediaKind: messageMediaKind(message),
      instanceName: instance,
      remoteJid,
      lid,
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
  lidMap = null,
  identityRepository = null,
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
  let identityStateEnabled = null;

  async function canSaveIdentityState() {
    if (!identityRepository) return false;
    if (identityStateEnabled === null) {
      identityStateEnabled = identityRepository.schemaStatus().then((status) => status.ready).catch(() => false);
    }
    return identityStateEnabled;
  }

  async function fetchPage(instance, page, cutoffAt, onProgress, lowerBoundAt = EARLIEST_MESSAGE_AT) {
    let lastError = null;
    for (let attempt = 1; attempt <= safeMaxAttempts; attempt += 1) {
      try {
        const response = await api(`/chat/findMessages/${encodeURIComponent(instance)}`, {
          method: "POST",
          body: JSON.stringify({
            where: {
              messageTimestamp: {
                gte: lowerBoundAt,
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
    if (await canSaveIdentityState()) {
      await identityRepository.saveBackfillState(`evolution_history:${instance}`, {
        status: String(state.status || "running").toUpperCase(),
        cursor: { phase: state.phase, page: state.page, pages: state.pages, cutoffAt: state.cutoffAt },
        processedCount: Number(state.fetched || 0),
        unresolvedCount: Number(state.unresolved || 0),
        startedAt: state.startedAt,
        completedAt: state.status === "completed" ? state.finishedAt : null,
        errorCode: state.status === "failed" ? "EVOLUTION_HISTORY_FAILED" : "",
        errorMessage: state.error || "",
      });
    }
  }

  async function pauseBetweenPages(page, pages) {
    if (safePageDelayMs > 0 && page < pages) await sleep(safePageDelayMs);
  }

  const lookupLid = lidMap ? (lid) => lidMap.resolveCached(lid) : null;

  // 一页里同时带 @lid 和真号码的讯息，顺手记进对照表。
  async function learnPairs(batch, dryRun) {
    if (!lidMap || dryRun) return;
    const pairs = batch.records.map(lidPhonePair).filter(Boolean);
    if (pairs.length) await lidMap.learn(pairs, { source: "live", evidence: "history_sync" }).catch(() => {});
  }

  // 扫完之后回头检查：私聊讯息有多少条根本认不出是谁。
  // 全军覆没时必须炸出来 —— 「导入 0 条」不该长得跟「已经是最新」一样。
  function assertResolvable(instance, { privateSeen, resolved }) {
    if (privateSeen < 20) return;                       // 量太小，比例没有意义
    if (resolved / privateSeen >= MIN_RESOLVE_RATIO) return;
    const error = new Error(
      `[${instance}] 扫到 ${privateSeen} 条一对一讯息，但只认得出 ${resolved} 条的号码。`
      + " Evolution 存的多半是 @lid 隐私 ID，本机 lid 对照表补不上。"
      + " 先跑 node campaign-app/backfill_lid_map.mjs 建对照表，再重新同步历史。",
    );
    error.code = "LID_UNRESOLVABLE";
    throw error;
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
        let privateSeen = 0;
        let resolved = 0;

        while (needsFirstPage || page <= pages) {
          needsFirstPage = false;
          const batch = await fetchPage(instance, page, state.cutoffAt, onProgress);
          pages = batch.pages;
          await learnPairs(batch, dryRun);
          for (const message of batch.records) {
            if (!isPrivateMessage(message)) continue;
            privateSeen += 1;
            const decoded = decode(instance, message, lookupLid);
            if (!decoded) continue;
            resolved += 1;
            if (decoded.dir === "in") repliedPhones.add(decoded.phone);
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
            unresolved: privateSeen - resolved,
            resumed: resuming,
          });
          await pauseBetweenPages(page, pages);
          page += 1;
        }

        assertResolvable(instance, { privateSeen, resolved });

        state = {
          ...state,
          unresolved: privateSeen - resolved,
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
        await learnPairs(batch, dryRun);
        const decoded = batch.records
          .map((message) => decode(instance, message, lookupLid))
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
        unresolved: Number(state.unresolved) || 0,
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
      // 认不出号码不是「网路暂时不通」，是扫出来的东西本身就不能用。
      // 断点留着的话，补好对照表再按一次会直接从断点往下跑，用的还是那份
      // 只认得出几个客户的名单 —— 所以这类失败要把断点归零，逼它重扫。
      if (error.code === "LID_UNRESOLVABLE") {
        state = { ...state, phase: "discover", page: 0, pages: 0, fetched: 0, repliedPhones: [] };
      }
      await saveState(instance, state, dryRun).catch(() => {});
      throw error;
    }
  }

  // 同步全部（或指定）号码。
  async function syncAll({ instance = "", dryRun = false, onProgress = null } = {}) {
    let names = (await listInstances()).map((item) => item.name || item?.instance?.instanceName).filter(Boolean);
    if (instance) names = names.filter((name) => name === instance);
    // 一个号码都没扫到也是坏掉，不是「同步完成」。
    if (!names.length) {
      throw new Error(instance
        ? `找不到号码 ${instance}，或它现在没连上 Evolution。`
        : "Evolution 上没有任何已连接的号码，无法补回历史。");
    }
    if (lidMap) await lidMap.warm().catch(() => {});
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
      // 认不出号码的私聊讯息数。>0 表示还有对话没补进来，UI 要讲出来，
      // 不能只报「新增 0 条」让人以为已经是最新的。
      unresolved: results.reduce((sum, r) => sum + (Number(r.unresolved) || 0), 0),
    };
  }

  // Tracker 的 webhook 是实时入口；这段只补它离线期间的缺口。时间窗和页数都设上限，
  // 避免每次 Tracker 重启都意外触发一次完整历史扫描。
  async function syncRecent({
    instance = "",
    dryRun = false,
    lookbackMs = DEFAULT_RECENT_LOOKBACK_MS,
    maxPages = DEFAULT_RECENT_MAX_PAGES,
    onProgress = null,
  } = {}) {
    let names = (await listInstances()).map((item) => item.name || item?.instance?.instanceName).filter(Boolean);
    if (instance) names = names.filter((name) => name === instance);
    if (!names.length) {
      throw new Error(instance
        ? `找不到号码 ${instance}，或它现在没连上 Evolution。`
        : "Evolution 上没有任何已连接的号码，无法补回近期消息。");
    }

    const safeLookbackMs = Math.max(60_000, Math.min(Number(lookbackMs) || DEFAULT_RECENT_LOOKBACK_MS, 7 * 24 * 60 * 60 * 1000));
    const safeMaxPages = Math.max(1, Math.min(Number(maxPages) || DEFAULT_RECENT_MAX_PAGES, 10));
    const cutoffAt = clock().toISOString();
    const lowerBoundAt = new Date(clock().getTime() - safeLookbackMs).toISOString();
    if (lidMap) await lidMap.warm().catch(() => {});

    const before = await conversationLog.stats();
    const results = [];
    for (const name of names) {
      let page = 1;
      let availablePages = 1;
      let fetched = 0;
      let written = 0;
      let failed = 0;
      let inboundCount = 0;
      let outboundCount = 0;
      let privateSeen = 0;
      let resolved = 0;

      while (page <= availablePages && page <= safeMaxPages) {
        const batch = await fetchPage(name, page, cutoffAt, onProgress, lowerBoundAt);
        availablePages = Math.max(1, batch.pages || 1);
        await learnPairs(batch, dryRun);
        const decoded = [];
        for (const message of batch.records) {
          if (!isPrivateMessage(message)) continue;
          privateSeen += 1;
          const item = decode(name, message, lookupLid);
          if (!item) continue;
          resolved += 1;
          decoded.push(item);
        }
        const inbound = decoded.filter((item) => item.dir === "in").map((item) => item.row);
        const outbound = decoded.filter((item) => item.dir === "out").map((item) => item.row);
        let pageWritten = decoded.length;
        let pageFailed = 0;
        if (!dryRun) {
          const inboundReport = await conversationLog.recordReplies(inbound, { force: true });
          const outboundReport = await conversationLog.recordOutbounds(outbound, { force: true });
          pageWritten = inboundReport.written + outboundReport.written;
          pageFailed = inboundReport.failed.length + outboundReport.failed.length;
        }
        fetched += batch.records.length;
        written += pageWritten;
        failed += pageFailed;
        inboundCount += inbound.length;
        outboundCount += outbound.length;
        onProgress?.({
          instance: name,
          phase: "catch_up",
          page,
          pages: Math.min(availablePages, safeMaxPages),
          fetched,
          written,
          failed,
          sinceAt: lowerBoundAt,
          cutoffAt,
        });
        await pauseBetweenPages(page, Math.min(availablePages, safeMaxPages));
        page += 1;
      }

      assertResolvable(name, { privateSeen, resolved });
      results.push({
        instance: name,
        inbound: inboundCount,
        outbound: outboundCount,
        fetched,
        written: dryRun ? 0 : written,
        failed,
        unresolved: privateSeen - resolved,
        pagesRead: page - 1,
        truncated: availablePages > safeMaxPages,
        dryRun,
      });
    }

    const after = await conversationLog.stats();
    return {
      mode: "bounded_catch_up",
      sinceAt: lowerBoundAt,
      cutoffAt,
      maxPages: safeMaxPages,
      instances: names,
      results,
      added: Number(after.messages) - Number(before.messages),
      totalMessages: after.messages,
      unresolved: results.reduce((sum, result) => sum + (Number(result.unresolved) || 0), 0),
    };
  }

  return { syncInstance, syncAll, syncRecent };
}
