import { requireLocalRecord } from "./device-scope.mjs";

const DEFINITIONS = Object.freeze({
  INTERESTED: Object.freeze({
    key: "INTERESTED",
    label: "Interested",
    description: "转人工继续跟进",
    tone: "positive",
    status: "Warm",
    sequenceStatus: "Human Takeover",
    nextAction: "Human Takeover",
    aiCategory: "Warm",
    followUp: "now",
    signal: "GREEN",
    requiresConfirmation: false,
  }),
  FOLLOW_UP: Object.freeze({
    key: "FOLLOW_UP",
    label: "Follow Up",
    description: "加入人工跟进清单",
    tone: "neutral",
    status: "Follow Up",
    sequenceStatus: "Human Takeover",
    nextAction: "Human Takeover",
    aiCategory: "Warm",
    followUp: "now",
    signal: "GREEN",
    requiresConfirmation: false,
  }),
  NOT_INTERESTED: Object.freeze({
    key: "NOT_INTERESTED",
    label: "Not Interested",
    description: "停止自动 Flow，但不是全局封锁",
    tone: "warning",
    status: "Not Interested",
    sequenceStatus: "Not Interested",
    nextAction: "No Action",
    aiCategory: "Not Interested",
    followUp: "clear",
    signal: "GREY",
    requiresConfirmation: true,
  }),
  DO_NOT_CONTACT: Object.freeze({
    key: "DO_NOT_CONTACT",
    label: "Do Not Contact",
    description: "全局 STOP，不再联系这个号码",
    tone: "danger",
    status: "Stop",
    sequenceStatus: "Stopped",
    nextAction: "No Action",
    aiCategory: "Stop",
    followUp: "clear",
    signal: "RED",
    stopFlag: true,
    stopReason: "Manual: Do Not Contact",
    requiresConfirmation: true,
  }),
});

function clean(value) {
  return String(value ?? "").trim();
}

function cleanPageId(value) {
  return clean(value).replace(/[^a-fA-F0-9]/g, "");
}

function serviceError(statusCode, message, details = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

function choiceValue(schema, name, option) {
  const type = schema?.[name]?.type;
  if (!option) return type === "status" ? { status: null } : { select: null };
  return type === "status" ? { status: { name: option } } : { select: { name: option } };
}

function richText(value) {
  const text = clean(value).slice(0, 1900);
  return { rich_text: text ? [{ text: { content: text } }] : [] };
}

function dateValue(value) {
  return { date: value ? { start: new Date(value).toISOString() } : null };
}

export function listConversationDispositions() {
  return Object.values(DEFINITIONS).map((item) => ({
    key: item.key,
    label: item.label,
    description: item.description,
    tone: item.tone,
    requiresConfirmation: item.requiresConfirmation,
  }));
}

export function conversationDisposition(key) {
  return DEFINITIONS[clean(key).toUpperCase()] || null;
}

export function conversationDispositionProperties(schema, disposition, { now = new Date() } = {}) {
  const properties = {
    Status: choiceValue(schema, "Status", disposition.status),
    "Sequence Status": choiceValue(schema, "Sequence Status", disposition.sequenceStatus),
    "Next Action": choiceValue(schema, "Next Action", disposition.nextAction),
    "AI Category": choiceValue(schema, "AI Category", disposition.aiCategory),
    "Reply Checked At": dateValue(now),
  };
  if (schema?.["Follow Up At"]) {
    properties["Follow Up At"] = disposition.followUp === "now" ? dateValue(now) : { date: null };
  }
  if (disposition.stopFlag) {
    properties["Stop Flag"] = { checkbox: true };
    properties["Stop Reason"] = richText(disposition.stopReason);
  }
  return properties;
}

function updateCachedRecord(record, disposition, now) {
  return {
    ...record,
    status: disposition.status,
    sequenceStatus: disposition.sequenceStatus,
    nextAction: disposition.nextAction,
    aiCategory: disposition.aiCategory,
    replyCheckedAt: now.toISOString(),
    followUpAt: disposition.followUp === "now" ? now.toISOString() : null,
    ...(disposition.stopFlag ? {
      stopFlag: true,
      stopReason: disposition.stopReason,
    } : {}),
  };
}

export function createConversationDispositionService({
  hasBlastDatabase,
  blastDatabaseId,
  notion,
  queryNotionRows,
  readCache,
  writeCache,
  normalizePhone,
  device,
  history,
  systemLogs,
  addLocalStop,
  updateLocalDisposition,
  clock = () => new Date(),
} = {}) {
  async function ownershipRows() {
    try {
      return await queryNotionRows(undefined);
    } catch {
      return (await readCache()).records;
    }
  }

  async function writeLog(level, event, message, context = {}) {
    await systemLogs?.write({
      level,
      area: "conversations",
      event,
      message,
      context,
    }).catch(() => {});
  }

  async function apply({ id: rawId, dispositionKey, phone: rawPhone, name = "", project = "" } = {}) {
    if (!hasBlastDatabase) {
      throw serviceError(400, "没有 Notion Blast Leads database 配置。请到 Settings 检查 Notion。");
    }
    if (!notion || !queryNotionRows || !readCache || !writeCache || !updateLocalDisposition) {
      throw serviceError(500, "Conversation Quick Remark service 没有载入。请重启 Mamba server。");
    }

    const id = cleanPageId(rawId);
    if (!id) throw serviceError(400, "缺少客户 Notion page id。请重新选择客户。");
    const disposition = conversationDisposition(dispositionKey);
    if (!disposition) throw serviceError(400, "这个 Quick Remark 不存在。请刷新 ChatRoom 后重试。");

    const records = await ownershipRows();
    const record = requireLocalRecord(records, id, { device });
    if (!record) {
      throw serviceError(403, "这个客户不属于当前 Device + WhatsApp sender，不能修改。");
    }
    if (record.stopFlag === true && !disposition.stopFlag) {
      throw serviceError(
        409,
        "这个客户已经是 Do Not Contact。Quick Remark 不会解除全局 STOP；如需更改必须先人工核实。",
      );
    }

    const now = clock();
    const phone = normalizePhone(rawPhone || record.phone);

    if (!phone) throw serviceError(400, "客户号码无效，无法安全更新 Quick Remark。");
    try {
      const local = await updateLocalDisposition({
        pageId: id,
        phone,
        status: disposition.status,
        sequenceStatus: disposition.sequenceStatus,
        aiCategory: disposition.aiCategory,
        followUpAt: disposition.followUp === "now" ? now.toISOString() : null,
        stopFlag: disposition.stopFlag === true,
        stopReason: disposition.stopReason || "",
        updatedAt: now.toISOString(),
      });
      if (local && Number(local.updated || 0) < 1) {
        throw new Error("本机找不到对应客户记录。");
      }
    } catch (error) {
      throw serviceError(500, `本机客户状态写入失败，Quick Remark 已取消：${error.message}`);
    }

    // DNC must also enter the global suppression overlay before any cloud mirror.
    if (disposition.stopFlag) {
      if (!addLocalStop) {
        throw serviceError(500, "客户已在本机标记 STOP，但全局 STOP service 没有载入。请重启 Mamba server。", {
          localApplied: true,
        });
      }
      try {
        await addLocalStop(phone, disposition.stopReason);
      } catch (error) {
        throw serviceError(500, `客户已在本机标记 STOP，但全局 STOP 防线写入失败：${error.message}`, {
          localApplied: true,
        });
      }
    }

    let database;
    try {
      database = await notion("GET", `/databases/${blastDatabaseId}`);
    } catch (error) {
      throw serviceError(502, `读取 Notion Blast Leads schema 失败：${error.message}`, {
        impact: disposition.stopFlag
          ? "本机已经禁止再次发送，但 Notion 尚未更新。"
          : "本机状态已经更新，但 Notion 尚未同步。",
        localApplied: true,
      });
    }
    const properties = conversationDispositionProperties(database?.properties || {}, disposition, { now });

    try {
      await notion("PATCH", `/pages/${id}`, { properties });
    } catch (error) {
      const impact = disposition.stopFlag
        ? "本机已经禁止再次发送，但 Notion 尚未更新。"
        : "本机状态已经更新，但 Notion 尚未同步。";
      await writeLog("error", "quick_remark_notion_failed", "Quick Remark could not be mirrored to Notion.", {
        disposition: disposition.key,
        localApplied: true,
        localStopApplied: disposition.stopFlag === true,
        error: error.message,
      });
      throw serviceError(502, `保存 Quick Remark 到 Notion 失败：${error.message}`, {
        impact,
        localApplied: true,
      });
    }

    const cached = await readCache().catch(() => ({ records }));
    const cacheRecords = Array.isArray(cached?.records) && cached.records.length ? cached.records : records;
    const updatedRecords = cacheRecords.map((item) => (
      cleanPageId(item?.id) === id ? updateCachedRecord(item, disposition, now) : item
    ));
    await writeCache(updatedRecords).catch(async (error) => {
      await writeLog("warn", "quick_remark_cache_failed", "Quick Remark reached Notion but local cache refresh failed.", {
        disposition: disposition.key,
        error: error.message,
      });
    });

    if (phone && history) {
      await history.append(phone, {
        at: now.toISOString(),
        direction: "operator",
        source: "quick_remark",
        text: `[Quick Remark] ${disposition.label}`,
        route: `MANUAL_${disposition.key}`,
        signal: disposition.signal,
        status: disposition.status,
        sequenceStatus: disposition.sequenceStatus,
        aiCategory: disposition.aiCategory,
        nextAction: disposition.nextAction,
        name: clean(name || record.name),
        project: clean(project || record.project),
      }).catch(() => {});
    }

    await writeLog("info", "quick_remark_saved", "Conversation Quick Remark saved.", {
      disposition: disposition.key,
      project: clean(project || record.project),
      stopFlag: disposition.stopFlag === true,
    });

    return {
      key: disposition.key,
      label: disposition.label,
      status: disposition.status,
      sequenceStatus: disposition.sequenceStatus,
      nextAction: disposition.nextAction,
      aiCategory: disposition.aiCategory,
      stopFlag: disposition.stopFlag === true,
      updatedAt: now.toISOString(),
    };
  }

  return {
    list: listConversationDispositions,
    apply,
  };
}
