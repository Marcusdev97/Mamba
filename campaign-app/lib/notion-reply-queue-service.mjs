const DEFAULT_BASE_DELAY_MS = 15_000;
const DEFAULT_MAX_DELAY_MS = 60 * 60 * 1000;
const DEFAULT_MANUAL_AFTER_MS = 24 * 60 * 60 * 1000;

function dateMs(value) {
  const ms = new Date(value || 0).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function cleanPhone(value) {
  return String(value ?? "").replace(/\D/g, "");
}

export function notionReplyRetryDelayMs(attempts, {
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
} = {}) {
  const retryNumber = Math.max(1, Number(attempts) || 1);
  return Math.min(maxDelayMs, baseDelayMs * (2 ** Math.min(retryNumber - 1, 12)));
}

export function explainNotionReplyError(error) {
  const details = String(error?.message || error || "没有错误详情。");
  if (/HTTP 401|unauthori[sz]ed|invalid.*token|token.*invalid/i.test(details)) {
    return {
      code: "NOTION_AUTH_FAILED",
      message: "Notion 身份验证失败。",
      action: "打开 Settings，重新保存 Notion token，然后确认 integration 仍可使用。",
      details,
    };
  }
  if (/HTTP 403|HTTP 404|object_not_found|database.*not found|could not find/i.test(details)) {
    return {
      code: "NOTION_DATABASE_ACCESS_FAILED",
      message: "Notion database 找不到或没有授权给 Mamba。",
      action: "在 Notion 打开 Blast Leads database，把它分享给 Mamba integration，并检查 notion_config.json 的 database id。",
      details,
    };
  }
  if (/HTTP 429|rate.?limit/i.test(details)) {
    return {
      code: "NOTION_RATE_LIMITED",
      message: "Notion 暂时限制了请求速度。",
      action: "无需重复点击；Mamba 会自动降低频率后重试。",
      details,
    };
  }
  if (/timeout|timed out|abort|ECONN|ENOTFOUND|fetch failed|network/i.test(details)) {
    return {
      code: "NOTION_NETWORK_FAILED",
      message: "连接 Notion 时网络超时或中断。",
      action: "检查网络；客户回复已保存在本机，Mamba 会自动重试。",
      details,
    };
  }
  return {
    code: "NOTION_REPLY_SYNC_FAILED",
    message: "客户回复暂时无法同步到 Notion。",
    action: "在 System Logs 搜索这个错误代码和电话号码；确认 Notion 配置后等待自动重试。",
    details,
  };
}

export function createNotionReplyQueueService({
  notion,
  reliability,
  clock = () => new Date(),
  onLog = (message) => console.log(message),
  onIssue = null,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
  manualAfterMs = DEFAULT_MANUAL_AFTER_MS,
} = {}) {
  if (!notion) throw new Error("notion is required");
  if (!reliability) throw new Error("reliability is required");

  const activePhones = new Map();
  const phoneCooldowns = new Map();
  let disabledIssueLogged = false;

  function now() {
    return clock();
  }

  function emitIssue(level, issue) {
    const payload = {
      level,
      at: now().toISOString(),
      impact: "客户回复已安全保存在本机，但尚未写入 Notion。",
      ...issue,
      persistedByTracker: typeof onIssue === "function",
    };
    if (typeof onIssue === "function") Promise.resolve(onIssue(payload)).catch(() => {});
    onLog(`[reply-tracker:issue] ${JSON.stringify(payload)}`);
  }

  function itemsForPhone(phone, { includeManual = true } = {}) {
    const normalized = cleanPhone(phone);
    return reliability.values()
      .filter((item) => cleanPhone(item?.event?.phone) === normalized)
      .filter((item) => includeManual || item.status !== "manual_review")
      .sort((a, b) => String(a.event?.receivedAt || a.queuedAt).localeCompare(String(b.event?.receivedAt || b.queuedAt)));
  }

  function nextRetryFor(items) {
    const pending = items.filter((item) => item.status !== "manual_review");
    if (!pending.length) return null;
    const maxAttempts = Math.max(...pending.map((item) => Math.max(0, Number(item.attempts) || 0)));
    const peers = pending.filter((item) => (Number(item.attempts) || 0) === maxAttempts);
    const explicit = peers.map((item) => dateMs(item.nextRetryAt)).filter(Boolean);
    if (explicit.length) return Math.max(...explicit);
    const lastAttempt = Math.max(...peers.map((item) => dateMs(item.lastAttemptAt || item.updatedAt)));
    if (!lastAttempt || maxAttempts === 0) return 0;
    return lastAttempt + notionReplyRetryDelayMs(maxAttempts, { baseDelayMs, maxDelayMs });
  }

  async function markGroupFailure(phone, items, failure, { reason = "retry" } = {}) {
    const attemptedAt = now();
    const attempts = Math.max(0, ...items.map((item) => Number(item.attempts) || 0)) + 1;
    const retryAt = new Date(attemptedAt.getTime() + notionReplyRetryDelayMs(attempts, { baseDelayMs, maxDelayMs }));
    let manualCount = 0;
    const updates = items.map((item) => {
      const oldEnough = attemptedAt.getTime() - dateMs(item.queuedAt) >= manualAfterMs;
      const manualReview = oldEnough && item.event?.stopFlag !== true;
      if (manualReview) manualCount += 1;
      return {
        event: item.event,
        options: {
          attempts,
          status: manualReview ? "manual_review" : "pending",
          errorCode: manualReview ? "NOTION_REPLY_MANUAL_REVIEW" : failure.code,
          lastError: manualReview
            ? `自动同步已等待超过 24 小时。最后结果：${failure.message}`
            : failure.message,
          help: manualReview
            ? "请在 System Logs 按电话号码检查，并确认客户是否应该存在于 Blast Leads。资料不会自动删除。"
            : failure.action,
          lastAttemptAt: attemptedAt.toISOString(),
          nextRetryAt: manualReview ? null : retryAt.toISOString(),
        },
      };
    });
    await reliability.updateMany(updates);
    phoneCooldowns.set(cleanPhone(phone), retryAt.getTime());

    emitIssue(manualCount ? "error" : "warn", {
      code: manualCount ? "NOTION_REPLY_MANUAL_REVIEW" : failure.code,
      phone: cleanPhone(phone),
      message: manualCount
        ? `${manualCount} 条回复等待超过 24 小时，已停止自动重试并转为人工检查。`
        : failure.message,
      action: manualCount
        ? "检查这个电话号码是否应该存在于 Blast Leads；修正后可从 Reply Tracker 手动推送。"
        : failure.action,
      details: failure.details || "",
      queuedMessages: items.length,
      attempt: attempts,
      reason,
      nextRetryAt: manualCount === items.length ? null : retryAt.toISOString(),
    });
    return { action: manualCount === items.length ? "manual_review" : "queued", retryAt: retryAt.toISOString() };
  }

  async function syncPhone(phone, { force = false, reason = "retry" } = {}) {
    const normalized = cleanPhone(phone);
    if (!normalized) return { action: "skipped", reason: "missing_phone" };
    if (activePhones.has(normalized)) return activePhones.get(normalized);

    const run = (async () => {
      const pending = itemsForPhone(normalized, { includeManual: force });
      if (!pending.length) return { action: "idle" };
      const dueAt = nextRetryFor(pending);
      if (!force && dueAt && dueAt > now().getTime()) return { action: "cooldown", nextRetryAt: new Date(dueAt).toISOString() };

      let existingLead;
      try {
        existingLead = await notion.findLeadForReply(normalized);
      } catch (error) {
        return markGroupFailure(normalized, pending, explainNotionReplyError(error), { reason });
      }

      if (!existingLead) {
        // Phone is not in Blast Leads. Retry briefly in case it was just uploaded
        // from another Mac and hasn't synced to Notion yet. Once past the grace
        // window it is clearly not a Blast Lead (e.g. one of your own private
        // leads), so treat it as an UNKNOWN contact we only track locally: drop it
        // from the Notion push queue instead of raising a manual-review alarm.
        // The reply itself stays saved on this machine (replies.jsonl / lead_status
        // / conversations) — nothing is lost.
        const nowMs = now().getTime();
        const settled = pending.filter((item) => nowMs - dateMs(item.queuedAt) >= manualAfterMs);
        const young = pending.filter((item) => nowMs - dateMs(item.queuedAt) < manualAfterMs);
        if (settled.length) {
          await reliability.removeMany(settled.map((item) => String(item.event.id)));
          phoneCooldowns.delete(normalized);
          onLog(`[reply-tracker] not a Blast Lead — tracked locally only, dropped from Notion queue phone=${normalized} messages=${settled.length} reason=${reason}`);
        }
        if (young.length) {
          return markGroupFailure(normalized, young, {
            code: "NOTION_LEAD_NOT_FOUND",
            message: "Blast Leads 暂时找不到这个电话号码。",
            action: "如果客户刚由另一台电脑上传，请等待自动重试；确认不属于 Blast Leads 后会自动转为「仅本机跟踪」，不再报警。",
            details: "Notion phone query returned 0 rows.",
          }, { reason });
        }
        return { action: "tracked_only", matched: false, messages: settled.length };
      }

      phoneCooldowns.delete(normalized);
      const completedIds = [];
      const attemptedIds = new Set();
      let lead = existingLead;
      while (true) {
        const batch = itemsForPhone(normalized).filter((item) => !attemptedIds.has(String(item.event.id)));
        if (!batch.length) break;
        for (let index = 0; index < batch.length; index += 1) {
          const item = batch[index];
          attemptedIds.add(String(item.event.id));
          try {
            const result = await notion.upsertLeadReply(item.event, { createIfMissing: false, existingLead: lead });
            if (!result?.matched) {
              const remaining = batch.slice(index);
              if (completedIds.length) await reliability.removeMany(completedIds.splice(0));
              return markGroupFailure(normalized, remaining, {
                code: "NOTION_LEAD_NOT_FOUND",
                message: "客户资料在处理回复期间消失或无法读取。",
                action: "检查 Blast Leads 是否删除、移动或改变了 Phone 字段，然后等待自动重试。",
                details: "The lead lookup succeeded, but reply upsert reported no match.",
              }, { reason: "lead_changed" });
            }
            lead = result.existingLead || lead;
            completedIds.push(String(item.event.id));
          } catch (error) {
            const remaining = batch.slice(index);
            if (completedIds.length) await reliability.removeMany(completedIds.splice(0));
            return markGroupFailure(normalized, remaining, explainNotionReplyError(error), { reason: "upsert" });
          }
        }
      }
      if (completedIds.length) await reliability.removeMany(completedIds);
      onLog(`[reply-tracker] Notion reply sync complete phone=${normalized} messages=${attemptedIds.size} lookup=shared reason=${reason}`);
      return { action: "synced", matched: true, messages: attemptedIds.size };
    })().finally(() => activePhones.delete(normalized));

    activePhones.set(normalized, run);
    return run;
  }

  async function submit(event) {
    const phone = cleanPhone(event?.phone);
    if (!event?.id || !phone) return { action: "skipped", reason: "invalid_event" };
    const existing = reliability.values().find((item) => String(item.event?.id) === String(event.id));
    const cooldownAt = phoneCooldowns.get(phone) || 0;
    await reliability.enqueue(event, {
      attempts: existing?.attempts || 0,
      status: "pending",
      errorCode: cooldownAt > now().getTime() ? "NOTION_LEAD_NOT_FOUND" : existing?.errorCode || "",
      lastError: cooldownAt > now().getTime() ? "等待同一电话号码的共享重试时间。" : existing?.lastError || "",
      help: cooldownAt > now().getTime() ? "无需处理；Mamba 会把这个号码的回复合并到下一次查询。" : existing?.help || "",
      nextRetryAt: cooldownAt > now().getTime() ? new Date(cooldownAt).toISOString() : existing?.nextRetryAt || null,
    });

    if (!notion.enabled) {
      await reliability.enqueue(event, {
        attempts: existing?.attempts || 0,
        status: "pending",
        errorCode: "NOTION_SYNC_DISABLED",
        lastError: "Notion sync 没有启用，客户回复只保存在本机。",
        help: "打开 Settings，配置 Notion token 后重启 Mamba。",
      });
      if (!disabledIssueLogged) {
        disabledIssueLogged = true;
        emitIssue("error", {
          code: "NOTION_SYNC_DISABLED",
          phone,
          message: "Notion sync 没有启用。",
          action: "打开 Settings，配置 Notion token 后重启 Mamba。",
          queuedMessages: reliability.snapshot().pendingCount,
          nextRetryAt: null,
        });
      }
      return { action: "queued", reason: "notion_disabled" };
    }

    if (!event.stopFlag && cooldownAt > now().getTime()) {
      onLog(`[reply-tracker] reply joined shared Notion retry phone=${phone} retryAt=${new Date(cooldownAt).toISOString()}`);
      return { action: "queued", reason: "shared_cooldown", nextRetryAt: new Date(cooldownAt).toISOString() };
    }
    if (event.stopFlag) phoneCooldowns.delete(phone);
    return syncPhone(phone, { force: true, reason: event.stopFlag ? "stop_safety" : "incoming" });
  }

  async function retryPending() {
    if (!notion.enabled) return { checkedPhones: 0 };
    // Auto-resolve replies from numbers confirmed NOT in Blast Leads (own leads /
    // unknown contacts): keep them tracked locally only, don't leave them sitting
    // as a standing manual-review warning. Data stays on this machine.
    const settleMs = now().getTime();
    const trackOnly = reliability.values().filter((item) =>
      item.status === "manual_review"
      && (item.errorCode === "NOTION_REPLY_MANUAL_REVIEW" || item.errorCode === "NOTION_LEAD_NOT_FOUND")
      && settleMs - dateMs(item.queuedAt) >= manualAfterMs);
    if (trackOnly.length) {
      await reliability.removeMany(trackOnly.map((item) => String(item.event.id)));
      onLog(`[reply-tracker] auto-resolved ${trackOnly.length} non-Blast-Lead repl${trackOnly.length === 1 ? "y" : "ies"} to tracked-only`);
    }
    const phones = [...new Set(reliability.values()
      .filter((item) => item.status !== "manual_review")
      .map((item) => cleanPhone(item.event?.phone))
      .filter(Boolean))];
    let checkedPhones = 0;
    for (const phone of phones) {
      const result = await syncPhone(phone, { reason: "scheduled_retry" });
      if (result?.action !== "cooldown" && result?.action !== "idle") checkedPhones += 1;
    }
    return { checkedPhones };
  }

  function snapshot() {
    const state = reliability.snapshot();
    return {
      pendingMessages: state.pendingCount,
      manualReviewMessages: state.manualReviewCount,
      pendingPhones: new Set(state.pending.map((item) => cleanPhone(item.event?.phone)).filter(Boolean)).size,
      activePhones: activePhones.size,
    };
  }

  return { submit, retryPending, syncPhone, snapshot };
}
