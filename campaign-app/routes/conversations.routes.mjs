import { httpError, json, readJson } from "../lib/http.mjs";
import { filterRecordsForDevice, requireLocalRecord } from "../lib/device-scope.mjs";

function requireConversations(runtime) {
  if (!runtime.conversations) {
    throw httpError(500, "Conversations service 没有载入。请重启 Mamba server。");
  }
  return runtime.conversations;
}

function deviceScope(conversations, records) {
  return filterRecordsForDevice(records, { device: conversations.device });
}

function scopeResponse(conversations, allRecords, scoped) {
  return {
    mode: "strict-device",
    device: conversations.device,
    sharedRows: allRecords.length,
    localRows: scoped.records.length,
    hiddenRows: allRecords.length - scoped.records.length,
    counts: scoped.counts,
  };
}

async function writeConversationLog(conversations, level, event, message, context = {}) {
  await conversations.systemLogs?.write({
    level,
    area: "conversations",
    event,
    message,
    context,
  }).catch(() => {});
}

function clean(value) {
  return String(value ?? "").trim();
}

function includesText(record, q) {
  const haystack = [
    record.name,
    record.phone,
    record.project,
    record.status,
    record.sequenceStatus,
    record.nextAction,
    record.aiCategory,
    record.lastReplyText,
    record.aiSummary,
    record.nextFlow,
    record.lastFlowSent,
  ].join(" ").toLowerCase();
  return haystack.includes(q.toLowerCase());
}

function applyFilters(records, filters) {
  const q = clean(filters.q);
  const project = clean(filters.project);
  const status = clean(filters.status);
  const sequenceStatus = clean(filters.sequenceStatus);
  const onlyReplied = filters.onlyReplied === true;

  return records.filter((record) => {
    if (project && record.project !== project) return false;
    if (status && record.status !== status) return false;
    if (sequenceStatus && record.sequenceStatus !== sequenceStatus) return false;
    if (onlyReplied && !record.lastReplyAt && !record.lastReplyText) return false;
    if (q && !includesText(record, q)) return false;
    return true;
  });
}

function sortRecords(records) {
  return records.slice().sort((a, b) => {
    const ar = a.lastReplyAt || "";
    const br = b.lastReplyAt || "";
    if (ar || br) return br.localeCompare(ar);
    return String(b.lastBlastAt || b.firstBlastAt || "").localeCompare(String(a.lastBlastAt || a.firstBlastAt || ""));
  });
}

function facets(records) {
  const uniq = (items) => [...new Set(items.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return {
    projects: uniq(records.map((record) => record.project)),
    statuses: uniq(records.map((record) => record.status)),
    sequenceStatuses: uniq(records.map((record) => record.sequenceStatus)),
  };
}

function summarize(records) {
  return {
    total: records.length,
    replied: records.filter((record) => record.lastReplyAt || record.lastReplyText).length,
    running: records.filter((record) => record.sequenceStatus === "Running").length,
    stop: records.filter((record) => record.stopFlag || record.status === "Stop").length,
  };
}

function parseLimit(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return 500;
  return Math.min(n, 1000);
}

const SCHEMA_REQUIREMENTS = [
  { name: "Name", types: ["title"], level: "required", reason: "显示客户姓名" },
  { name: "Phone", types: ["phone_number"], level: "required", reason: "匹配 WhatsApp 客户" },
  { name: "Project", types: ["select", "status"], level: "required", reason: "项目筛选" },
  { name: "Status", types: ["select", "status"], level: "required", reason: "客户状态" },
  { name: "Sequence Status", types: ["select", "status"], level: "required", reason: "自动序列状态" },
  { name: "Last Reply Text", types: ["rich_text"], level: "reply", reason: "显示 latest reply" },
  { name: "Last Reply At", types: ["date"], level: "reply", reason: "计算 Replied 和回复时间" },
  { name: "Reply Count", types: ["number"], level: "reply", reason: "累计回复次数" },
  { name: "Reply Checked At", types: ["date"], level: "reply", reason: "记录最后扫描时间" },
  { name: "AI Category", types: ["select", "status"], level: "reply", reason: "回复分类" },
  { name: "Next Action", types: ["select", "status"], level: "reply", reason: "下一步动作" },
  { name: "AI Summary", types: ["rich_text"], level: "reply", reason: "回复摘要/建议" },
  { name: "Sender Instance", types: ["select", "status"], level: "sender", reason: "记录这个客户由哪个 WhatsApp connection 发出" },
  { name: "Last Flow Sent", types: ["select", "status"], level: "flow", reason: "显示已发 Flow" },
  { name: "Next Flow", types: ["select", "status"], level: "flow", reason: "显示下一轮 Flow" },
  { name: "Cohort Day", types: ["select", "status"], level: "flow", reason: "显示发送节奏" },
  { name: "Follow Up At", types: ["date"], level: "pipeline", reason: "下一次人工跟进时间" },
  { name: "Priority", types: ["select", "status"], level: "pipeline", reason: "Agent 跟进优先级" },
  { name: "Appointment Date", types: ["date"], level: "pipeline", reason: "预约日期" },
  { name: "Appointment Time", types: ["rich_text"], level: "pipeline", reason: "预约时间" },
  { name: "Appointment Place", types: ["rich_text"], level: "pipeline", reason: "预约地点" },
  { name: "Appointment Status", types: ["select", "status"], level: "pipeline", reason: "预约 Pipeline 阶段" },
  { name: "Assigned Sales", types: ["rich_text", "select", "status"], level: "pipeline", reason: "负责跟进的 Agent" },
  { name: "Sales Notes", types: ["rich_text"], level: "pipeline", reason: "人工跟进记录" },
  { name: "Contact Key", types: ["rich_text"], level: "multi_pc", reason: "全局客户 identity，通常等于 normalized phone" },
  { name: "Project Lead Key", types: ["rich_text"], level: "multi_pc", reason: "一个客户在一个项目里的唯一 key" },
  { name: "Assigned Sender Key", types: ["rich_text", "select", "status"], level: "multi_pc", reason: "指定由哪个 WhatsApp connection 负责" },
  { name: "Last Sender Key", types: ["rich_text", "select", "status"], level: "multi_pc", reason: "最后实际发送的 WhatsApp connection" },
  { name: "Last Sender Phone", types: ["phone_number", "rich_text"], level: "multi_pc", reason: "最后实际发送号码，方便排查" },
  { name: "Last Sent By Device", types: ["rich_text", "select", "status"], level: "multi_pc", reason: "最后由哪台电脑/worker 发送" },
  { name: "Campaign Run ID", types: ["rich_text"], level: "multi_pc", reason: "连接这次 blast run / audit" },
  { name: "Send Lock", types: ["checkbox"], level: "multi_pc", reason: "多 PC 同时发送时防止重复发送" },
  { name: "Locked By Device", types: ["rich_text", "select", "status"], level: "multi_pc", reason: "目前是哪台电脑锁住这个 lead" },
  { name: "Lock Until", types: ["date"], level: "multi_pc", reason: "锁自动过期时间，避免电脑 crash 后永久卡住" },
  { name: "Stop Flag", types: ["checkbox"], level: "safety", reason: "全局 STOP 拦截" },
  { name: "Stop Reason", types: ["rich_text"], level: "safety", reason: "STOP 原因" },
];

const AUTO_CREATE_SCHEMA = {
  "Contact Key": { rich_text: {} },
  "Project Lead Key": { rich_text: {} },
  "Assigned Sender Key": { rich_text: {} },
  "Last Sender Key": { rich_text: {} },
  "Last Sender Phone": { phone_number: {} },
  "Last Sent By Device": { rich_text: {} },
  "Campaign Run ID": { rich_text: {} },
  "Send Lock": { checkbox: {} },
  "Locked By Device": { rich_text: {} },
  "Lock Until": { date: {} },
  "Follow Up At": { date: {} },
  "Priority": { select: { options: [{ name: "HIGH", color: "red" }, { name: "MED", color: "yellow" }, { name: "LOW", color: "gray" }] } },
  "Appointment Date": { date: {} },
  "Appointment Time": { rich_text: {} },
  "Appointment Place": { rich_text: {} },
  "Appointment Status": { select: { options: [
    { name: "Viewing Interest", color: "blue" },
    { name: "Slot Offered", color: "yellow" },
    { name: "Pending", color: "orange" },
    { name: "Confirmed", color: "green" },
    { name: "Attended", color: "purple" },
    { name: "No Show", color: "red" },
    { name: "Cancelled", color: "gray" },
  ] } },
  "Assigned Sales": { rich_text: {} },
  "Sales Notes": { rich_text: {} },
};

function checkSchema(database) {
  const properties = database?.properties || {};
  const checks = SCHEMA_REQUIREMENTS.map((item) => {
    const prop = properties[item.name];
    const actual = prop?.type || "";
    const ok = Boolean(prop) && item.types.includes(actual);
    return {
      ...item,
      actual: actual || null,
      ok,
      status: !prop ? "missing" : ok ? "ok" : "wrong_type",
    };
  });
  return {
    databaseTitle: (database?.title || []).map((part) => part.plain_text).join("").trim() || "Blast Leads",
    ok: checks.every((item) => item.ok),
    counts: {
      ok: checks.filter((item) => item.status === "ok").length,
      missing: checks.filter((item) => item.status === "missing").length,
      wrongType: checks.filter((item) => item.status === "wrong_type").length,
    },
    checks,
  };
}

function missingAutoCreateProperties(health) {
  return Object.fromEntries(
    health.checks
      .filter((item) => item.status === "missing" && AUTO_CREATE_SCHEMA[item.name])
      .map((item) => [item.name, AUTO_CREATE_SCHEMA[item.name]]),
  );
}

function pageId(id) {
  return String(id || "").replace(/[^a-fA-F0-9]/g, "");
}

function choiceValue(schema, name, option) {
  const type = schema?.[name]?.type;
  if (!option) return type === "status" ? { status: null } : { select: null };
  return type === "status" ? { status: { name: option } } : { select: { name: option } };
}

function richText(value) {
  const text = String(value || "").slice(0, 1900);
  return { rich_text: text ? [{ text: { content: text } }] : [] };
}

function dateValue(value) {
  return { date: value ? { start: new Date(value).toISOString() } : null };
}

function numberValue(value) {
  return { number: Number(value || 0) };
}

function latestBlastMs(record) {
  return new Date(record.lastBlastAt || record.firstBlastAt || 0).getTime() || 0;
}

function latestReplyMs(record) {
  return new Date(record.lastReplyAt || 0).getTime() || 0;
}

function pickLatestRecordByPhone(records, normalizePhone) {
  const byPhone = new Map();
  let duplicateRows = 0;
  for (const record of records) {
    const phone = normalizePhone(record.phone);
    if (!phone) continue;
    const existing = byPhone.get(phone);
    if (existing) duplicateRows += 1;
    if (!existing || latestBlastMs(record) > latestBlastMs(existing)) {
      byPhone.set(phone, record);
    }
  }
  return { byPhone, duplicateRows };
}

function readableEvolutionError(error, action, instanceName = "") {
  const message = String(error?.message || error || "");
  const who = instanceName ? ` (${instanceName})` : "";
  if (/ECONNREFUSED|fetch failed|Failed to fetch/i.test(message)) {
    return `${action}${who}失败：Evolution API 连不上。请确认 Docker / Evolution 已启动，然后到 Settings 按 Refresh Phone Health。`;
  }
  if (/HTTP 401|Unauthorized/i.test(message)) {
    return `${action}${who}失败：Evolution API key 不对。请到 Settings 检查 token / .env。`;
  }
  if (/HTTP 404|not found/i.test(message)) {
    return `${action}${who}失败：Evolution 找不到这个 endpoint 或 connection。请到 Settings 检查 Phone Health 是否 OPEN；如果 OPEN 仍失败，可能是 Evolution 版本不支持 /chat/findMessages。原始错误：${message}`;
  }
  if (/timeout|timed out|aborted/i.test(message)) {
    return `${action}${who}失败：Evolution 没有及时回应，可能 WhatsApp/Docker 卡住。请等一下再试，或重启 Evolution。原始错误：${message}`;
  }
  return `${action}${who}失败：${message || "没有明确原因。"}`;
}

async function latestInboundMessages(conversations, instances, recordsByPhone) {
  const inbound = new Map();
  const historyEvents = [];
  const instanceErrors = [];
  for (const instance of instances) {
    let response;
    try {
      response = await conversations.api(`/chat/findMessages/${encodeURIComponent(instance.name)}`, {
        method: "POST",
        body: JSON.stringify({ where: {} }),
      });
    } catch (error) {
      instanceErrors.push(readableEvolutionError(error, "读取 WhatsApp 回复", instance.name));
      continue;
    }

    for (const message of conversations.collectMessageObjects(response)) {
      if (message?.key?.fromMe) continue;
      const phone = conversations.phoneFromJid(message?.key?.remoteJid);
      const record = phone && recordsByPhone.get(phone);
      if (!record) continue;
      if (record.senderInstance && record.senderInstance !== instance.name) continue;

      const at = conversations.messageTime(message);
      if (!at) continue;
      const minMs = Math.max(latestReplyMs(record) + 1, latestBlastMs(record));
      if (at < minMs) continue;

      const event = {
        phone,
        at: new Date(at).toISOString(),
        text: conversations.extractText(message) || "[reply]",
        record,
        instanceName: instance.name,
        messageId: message?.key?.id || null,
      };
      historyEvents.push(event);
      const previous = inbound.get(phone);
      if (!previous || at > previous.at) {
        inbound.set(phone, { at, text: event.text, record, instanceName: instance.name, messageId: event.messageId });
      }
    }
  }
  return { inbound, historyEvents, instanceErrors };
}

function shouldScheduleAgentFollowUp(verdict) {
  const terminal = [verdict?.status, verdict?.nextAction, verdict?.route].join(" ").toLowerCase();
  return !verdict?.stopFlag
    && verdict?.route !== "SPAM_IGNORE"
    && !/not interested|do not contact|stop_dnc/.test(terminal);
}

function shouldClearAgentFollowUp(verdict) {
  return verdict?.stopFlag
    || ["NOT_INTERESTED", "COLD_SHORT_REJECT", "SPAM_IGNORE", "AGENT_OR_WRONG_TARGET", "WRONG_PERSON"].includes(verdict?.route)
    || ["Stopped", "Not Interested"].includes(verdict?.sequenceStatus);
}

function replyProperties(schema, verdict, event, record) {
  const replyCount = Number(record.replyCount || 0) + 1;
  const props = {
    Status: choiceValue(schema, "Status", verdict.status),
    "Sequence Status": choiceValue(schema, "Sequence Status", verdict.sequenceStatus),
    "Next Action": choiceValue(schema, "Next Action", verdict.nextAction),
    "AI Category": choiceValue(schema, "AI Category", verdict.aiCategory),
    "Last Reply At": dateValue(event.at),
    "Last Reply Text": richText(event.text),
    "Reply Checked At": dateValue(Date.now()),
    "Reply Count": numberValue(replyCount),
    "AI Summary": richText(`[${verdict.signal}] ${verdict.route} · 建议:${verdict.suggestedReply}`),
  };
  if (verdict.stopFlag) {
    props["Stop Flag"] = { checkbox: true };
    props["Stop Reason"] = richText(`Auto: ${verdict.route}`);
    if (schema?.["Follow Up At"]) props["Follow Up At"] = { date: null };
  } else if (shouldClearAgentFollowUp(verdict) && schema?.["Follow Up At"]) {
    props["Follow Up At"] = { date: null };
  } else if (shouldScheduleAgentFollowUp(verdict) && schema?.["Follow Up At"]) {
    props["Follow Up At"] = dateValue(Date.now());
  }
  return props;
}

function classificationProperties(schema, verdict) {
  const props = {
    Status: choiceValue(schema, "Status", verdict.status),
    "Sequence Status": choiceValue(schema, "Sequence Status", verdict.sequenceStatus),
    "Next Action": choiceValue(schema, "Next Action", verdict.nextAction),
    "AI Category": choiceValue(schema, "AI Category", verdict.aiCategory),
    "Reply Checked At": dateValue(Date.now()),
    "AI Summary": richText(`[${verdict.signal}] ${verdict.route} · 建议:${verdict.suggestedReply}`),
  };
  if (verdict.stopFlag) {
    props["Stop Flag"] = { checkbox: true };
    props["Stop Reason"] = richText(`Auto: ${verdict.route}`);
    if (schema?.["Follow Up At"]) props["Follow Up At"] = { date: null };
  } else if (shouldClearAgentFollowUp(verdict) && schema?.["Follow Up At"]) {
    props["Follow Up At"] = { date: null };
  } else if (shouldScheduleAgentFollowUp(verdict) && schema?.["Follow Up At"]) {
    props["Follow Up At"] = dateValue(Date.now());
  }
  return props;
}

function manualCorrectionProperties(schema, correction) {
  const props = {};
  if (correction.status !== undefined) props.Status = choiceValue(schema, "Status", clean(correction.status));
  if (correction.sequenceStatus !== undefined) props["Sequence Status"] = choiceValue(schema, "Sequence Status", clean(correction.sequenceStatus));
  if (correction.nextAction !== undefined) props["Next Action"] = choiceValue(schema, "Next Action", clean(correction.nextAction));
  if (correction.aiCategory !== undefined) props["AI Category"] = choiceValue(schema, "AI Category", clean(correction.aiCategory));
  if (correction.aiSummary !== undefined) props["AI Summary"] = richText(correction.aiSummary);
  if (correction.lastReplyAt !== undefined) props["Last Reply At"] = dateValue(correction.lastReplyAt);
  if (correction.lastBlastAt !== undefined) props["Last Blast At"] = dateValue(correction.lastBlastAt);
  if (correction.stopFlag !== undefined) props["Stop Flag"] = { checkbox: correction.stopFlag === true };
  if (correction.stopReason !== undefined) props["Stop Reason"] = richText(correction.stopReason);
  props["Reply Checked At"] = dateValue(Date.now());
  return props;
}

export function registerConversationsRoutes(router) {
  router.get("/api/conversations/history", async (req, res, runtime) => {
    const conversations = requireConversations(runtime);
    if (!conversations.history) {
      throw httpError(500, "Conversation history service 没有载入。请重启 Mamba server。");
    }
    const url = new URL(req.url, `http://${runtime.host}:${runtime.port}`);
    const phone = conversations.normalizePhone(url.searchParams.get("phone"));
    if (!phone) throw httpError(400, "缺少有效 phone。");
    const cache = await conversations.readCache();
    const localPhone = deviceScope(conversations, cache.records).records.some((record) => conversations.normalizePhone(record.phone) === phone);
    if (!localPhone) throw httpError(403, "这个客户不属于当前 Device + WhatsApp sender，不能读取对话历史。");
    const entries = await conversations.history.read(phone, { limit: url.searchParams.get("limit") || 100 });
    json(res, 200, { ok: true, phone, entries });
  });

  router.get("/api/conversations/schema-health", async (_req, res, runtime) => {
    const conversations = requireConversations(runtime);
    if (!conversations.hasBlastDatabase) {
      throw httpError(400, "没有 Notion Blast Leads database 配置。请到 Settings 检查 Notion。");
    }
    if (!conversations.notion || !conversations.blastDatabaseId) {
      throw httpError(500, "Conversations Notion service 没有载入。请重启 Mamba server。");
    }

    const database = await conversations.notion("GET", `/databases/${conversations.blastDatabaseId}`);
    const health = checkSchema(database);
    await writeConversationLog(
      conversations,
      health.ok ? "info" : "warn",
      "schema_health",
      health.ok ? "Blast Leads schema is healthy." : "Blast Leads schema needs attention.",
      {
        databaseTitle: health.databaseTitle,
        ok: health.counts.ok,
        missing: health.counts.missing,
        wrongType: health.counts.wrongType,
        missingFields: health.checks.filter((item) => item.status === "missing").map((item) => item.name),
        wrongTypeFields: health.checks
          .filter((item) => item.status === "wrong_type")
          .map((item) => ({ name: item.name, current: item.actual, need: item.types.join(" / ") })),
      },
    );
    json(res, 200, { ok: true, ...health });
  });

  router.post("/api/conversations/schema-ensure", async (_req, res, runtime) => {
    const conversations = requireConversations(runtime);
    if (!conversations.hasBlastDatabase) {
      throw httpError(400, "没有 Notion Blast Leads database 配置。请到 Settings 检查 Notion。");
    }
    if (!conversations.notion || !conversations.blastDatabaseId) {
      throw httpError(500, "Conversations Notion service 没有载入。请重启 Mamba server。");
    }

    let database;
    try {
      database = await conversations.notion("GET", `/databases/${conversations.blastDatabaseId}`);
    } catch (error) {
      throw httpError(502, `读取 Notion Blast Leads schema 失败：${error.message}`);
    }

    const before = checkSchema(database);
    const properties = missingAutoCreateProperties(before);
    const createNames = Object.keys(properties);
    const wrongTypeFields = before.checks
      .filter((item) => item.status === "wrong_type")
      .map((item) => ({ name: item.name, current: item.actual, need: item.types.join(" / ") }));

    if (createNames.length) {
      try {
        await conversations.notion("PATCH", `/databases/${conversations.blastDatabaseId}`, { properties });
      } catch (error) {
        await writeConversationLog(conversations, "error", "schema_ensure_failed", "Failed to create missing Blast Leads fields.", {
          fields: createNames,
          error: error.message,
        });
        throw httpError(502, `补齐 Notion Blast Leads 字段失败：${error.message}`);
      }
    }

    let afterDatabase;
    try {
      afterDatabase = await conversations.notion("GET", `/databases/${conversations.blastDatabaseId}`);
    } catch (error) {
      throw httpError(502, `重新读取 Notion Blast Leads schema 失败：${error.message}`);
    }
    const after = checkSchema(afterDatabase);

    await writeConversationLog(
      conversations,
      after.ok ? "info" : "warn",
      "schema_ensure",
      createNames.length ? "Missing Blast Leads fields were created." : "Blast Leads schema already had all auto-create fields.",
      {
        databaseTitle: after.databaseTitle,
        createdFields: createNames,
        remainingMissing: after.checks.filter((item) => item.status === "missing").map((item) => item.name),
        wrongTypeFields,
      },
    );

    json(res, 200, {
      ok: true,
      createdFields: createNames,
      wrongTypeFields,
      ...after,
    });
  });

  router.post("/api/conversations/refresh-replies", async (_req, res, runtime) => {
    const conversations = requireConversations(runtime);
    if (!conversations.hasBlastDatabase) {
      throw httpError(400, "没有 Notion Blast Leads database 配置。请到 Settings 检查 Notion。");
    }
    if (!conversations.notion || !conversations.api || !conversations.openInstances) {
      throw httpError(500, "Conversations refresh service 没有载入。请重启 Mamba server。");
    }

    const cached = await conversations.readCache();
    if (cached.records.length && !deviceScope(conversations, cached.records).records.length) {
      await writeConversationLog(conversations, "info", "refresh_replies_empty_device_scope", "Skipped WhatsApp reply scan because this device has no owned customers.", {
        deviceId: conversations.device?.id || "",
        sharedRows: cached.records.length,
      });
      json(res, 200, {
        ok: true,
        scannedPhones: 0,
        scannedInstances: [],
        found: 0,
        updated: 0,
        failed: [],
        instanceErrors: [],
        duplicateRows: 0,
        senderOffline: 0,
        historyAdded: 0,
        historySkipped: 0,
        updates: [],
      });
      return;
    }

    let database;
    try {
      database = await conversations.notion("GET", `/databases/${conversations.blastDatabaseId}`);
    } catch (error) {
      throw httpError(502, `读取 Notion Blast Leads schema 失败：${error.message}`);
    }
    const schema = database?.properties || {};
    let records;
    try {
      const allRecords = await conversations.queryNotionRows(undefined);
      records = deviceScope(conversations, allRecords).records;
    } catch (error) {
      throw httpError(502, `读取 Notion Blast Leads 客户失败：${error.message}`);
    }
    const { byPhone, duplicateRows } = pickLatestRecordByPhone(records, conversations.normalizePhone);
    if (!records.length) {
      await writeConversationLog(conversations, "info", "refresh_replies_empty_device_scope", "Skipped WhatsApp reply scan because this device has no owned customers.", {
        deviceId: conversations.device?.id || "",
      });
      json(res, 200, {
        ok: true,
        scannedPhones: 0,
        scannedInstances: [],
        found: 0,
        updated: 0,
        failed: [],
        instanceErrors: [],
        duplicateRows,
        senderOffline: 0,
        historyAdded: 0,
        historySkipped: 0,
        updates: [],
      });
      return;
    }
    let instances;
    try {
      instances = await conversations.openInstances();
    } catch (error) {
      throw httpError(503, readableEvolutionError(error, "读取 Phone Health"));
    }
    const openInstances = instances.filter((instance) => instance?.name);
    if (!openInstances.length) {
      throw httpError(400, "没有 OPEN 的 WhatsApp connection。请到 Settings 检查 Phone Health。");
    }
    const openNames = new Set(openInstances.map((instance) => instance.name));
    const senderOffline = records.filter((record) => record.senderInstance && !openNames.has(record.senderInstance)).length;

    await writeConversationLog(conversations, "info", "refresh_replies_start", "Started scanning WhatsApp replies.", {
      notionRows: records.length,
      scannedPhones: byPhone.size,
      openInstances: openInstances.map((instance) => instance.name),
      duplicateRows,
      senderOffline,
    });

    const { inbound, historyEvents, instanceErrors } = await latestInboundMessages(conversations, openInstances, byPhone);
    if (instanceErrors.length) {
      await writeConversationLog(conversations, "warn", "refresh_replies_instance_errors", "Some WhatsApp connections could not be scanned.", {
        failedConnections: instanceErrors.length,
        errors: instanceErrors,
      });
    }
    if (instanceErrors.length === openInstances.length) {
      throw httpError(502, `所有 OPEN WhatsApp connection 都读取失败。${instanceErrors.join(" | ")}`);
    }
    const historyPayloads = historyEvents.map((event) => {
      const verdict = conversations.classifyReplyText(event.text);
      return {
        phone: event.phone,
        name: event.record.name,
        project: event.record.project,
        senderInstance: event.record.senderInstance || "",
        instanceName: event.instanceName,
        messageId: event.messageId,
        at: event.at,
        text: event.text,
        route: verdict.route,
        signal: verdict.signal,
        status: verdict.status,
        sequenceStatus: verdict.sequenceStatus,
        aiCategory: verdict.aiCategory,
        nextAction: verdict.nextAction,
        suggestedReply: verdict.suggestedReply,
        source: "refresh_replies",
      };
    });
    let historyWriteError = "";
    const historyResult = conversations.history
      ? await conversations.history.appendMany(historyPayloads).catch((error) => {
          historyWriteError = error.message || String(error);
          return { added: 0, skipped: historyPayloads.length };
        })
      : { added: 0, skipped: 0 };
    if (historyWriteError) {
      await writeConversationLog(conversations, "warn", "refresh_replies_history_failed", "Reply history could not be saved locally.", {
        attempted: historyPayloads.length,
        error: historyWriteError,
      });
    } else if (historyPayloads.length) {
      await writeConversationLog(conversations, "info", "refresh_replies_history", "Reply history was saved locally.", {
        foundMessages: historyPayloads.length,
        added: historyResult.added,
        skipped: historyResult.skipped,
      });
    }

    const updated = [];
    const failed = [];
    for (const [phone, event] of inbound) {
      const verdict = conversations.classifyReplyText(event.text);
      try {
        await conversations.notion("PATCH", `/pages/${pageId(event.record.id)}`, {
          properties: replyProperties(schema, verdict, event, event.record),
        });
        updated.push({
          phone,
          name: event.record.name,
          project: event.record.project,
          at: new Date(event.at).toISOString(),
          text: event.text,
          route: verdict.route,
          status: verdict.status,
          nextAction: verdict.nextAction,
          instanceName: event.instanceName,
        });
      } catch (error) {
        failed.push({ phone, name: event.record.name, error: error.message });
      }
    }

    if (failed.length) {
      await writeConversationLog(conversations, "warn", "refresh_replies_notion_failed", "Some replies were found but could not update Notion.", {
        failed: failed.length,
        examples: failed.slice(0, 10),
      });
    }

    await writeConversationLog(
      conversations,
      failed.length || instanceErrors.length || senderOffline ? "warn" : "info",
      "refresh_replies_complete",
      `Refresh Replies completed: ${updated.length} updated, ${failed.length} failed.`,
      {
        scannedPhones: byPhone.size,
        scannedInstances: openInstances.map((instance) => instance.name),
        foundReplies: inbound.size,
        updated: updated.length,
        failed: failed.length,
        historyAdded: historyResult.added,
        historySkipped: historyResult.skipped,
        instanceErrors,
        duplicateRows,
        senderOffline,
      },
    );

    const refreshed = await conversations.queryNotionRows(undefined).catch(() => records);
    await conversations.writeCache(refreshed).catch(() => {});
    json(res, 200, {
      ok: true,
      scannedPhones: byPhone.size,
      scannedInstances: openInstances.map((instance) => instance.name),
      found: inbound.size,
      updated: updated.length,
      failed,
      instanceErrors,
      duplicateRows,
      senderOffline,
      historyAdded: historyResult.added,
      historySkipped: historyResult.skipped,
      updates: updated.slice(0, 50),
    });
  });

  router.post("/api/conversations/classify-replies", async (req, res, runtime) => {
    const conversations = requireConversations(runtime);
    if (!conversations.hasBlastDatabase) {
      throw httpError(400, "没有 Notion Blast Leads database 配置。请到 Settings 检查 Notion。");
    }
    if (!conversations.notion || !conversations.queryNotionRows) {
      throw httpError(500, "Conversations classifier service 没有载入。请重启 Mamba server。");
    }

    const body = await readJson(req);
    const onlyUnclassified = body.onlyUnclassified !== false;
    const terminalRepairsOnly = body.terminalRepairsOnly === true;

    const cached = await conversations.readCache();
    if (cached.records.length && !deviceScope(conversations, cached.records).records.length) {
      json(res, 200, {
        ok: true,
        totalRows: 0,
        candidates: 0,
        classified: 0,
        failed: [],
        routeCounts: {},
        updates: [],
      });
      return;
    }

    let database;
    try {
      database = await conversations.notion("GET", `/databases/${conversations.blastDatabaseId}`);
    } catch (error) {
      throw httpError(502, `读取 Notion Blast Leads schema 失败：${error.message}`);
    }
    const schema = database?.properties || {};

    let records;
    try {
      const allRecords = await conversations.queryNotionRows(undefined);
      records = deviceScope(conversations, allRecords).records;
    } catch (error) {
      throw httpError(502, `读取 Notion Blast Leads 客户失败：${error.message}`);
    }

    const candidates = records.filter((record) => {
      if (!clean(record.lastReplyText)) return false;
      if (terminalRepairsOnly) {
        const verdict = conversations.classifyReplyText(record.lastReplyText);
        const alreadyTerminal = record.stopFlag
          || ["Stop", "Not Interested"].includes(clean(record.status))
          || ["Stopped", "Not Interested"].includes(clean(record.sequenceStatus));
        return shouldClearAgentFollowUp(verdict) && !alreadyTerminal;
      }
      if (!onlyUnclassified) return true;
      return !clean(record.aiCategory) || !clean(record.nextAction) || !clean(record.aiSummary);
    });

    await writeConversationLog(conversations, "info", "classify_replies_start", "Started classifying existing Notion replies.", {
      totalRows: records.length,
      candidates: candidates.length,
      onlyUnclassified,
      terminalRepairsOnly,
    });

    const classified = [];
    const failed = [];
    const routeCounts = {};
    for (const record of candidates) {
      const verdict = conversations.classifyReplyText(record.lastReplyText);
      routeCounts[verdict.route] = (routeCounts[verdict.route] || 0) + 1;
      try {
        await conversations.notion("PATCH", `/pages/${pageId(record.id)}`, {
          properties: classificationProperties(schema, verdict),
        });
        classified.push({
          id: record.id,
          phone: record.phone,
          name: record.name,
          route: verdict.route,
          status: verdict.status,
          nextAction: verdict.nextAction,
          aiCategory: verdict.aiCategory,
        });
      } catch (error) {
        failed.push({ phone: record.phone, name: record.name, route: verdict.route, error: error.message });
      }
    }

    await writeConversationLog(
      conversations,
      failed.length ? "warn" : "info",
      "classify_replies_complete",
      `Classified ${classified.length} existing reply row(s).`,
      {
        totalRows: records.length,
        candidates: candidates.length,
        classified: classified.length,
        failed: failed.length,
        routeCounts,
        failedExamples: failed.slice(0, 10),
      },
    );

    const refreshed = await conversations.queryNotionRows(undefined).catch(() => records);
    await conversations.writeCache(refreshed).catch(() => {});
    json(res, 200, {
      ok: true,
      totalRows: records.length,
      candidates: candidates.length,
      classified: classified.length,
      failed,
      routeCounts,
      updates: classified.slice(0, 50),
    });
  });

  router.post("/api/conversations/manual-correction", async (req, res, runtime) => {
    const conversations = requireConversations(runtime);
    if (!conversations.hasBlastDatabase) {
      throw httpError(400, "没有 Notion Blast Leads database 配置。请到 Settings 检查 Notion。");
    }
    if (!conversations.notion || !conversations.queryNotionRows) {
      throw httpError(500, "Conversations manual correction service 没有载入。请重启 Mamba server。");
    }

    const body = await readJson(req);
    const id = pageId(body.id);
    if (!id) throw httpError(400, "缺少客户 Notion page id。请重新选择客户。");
    let ownershipRows;
    try {
      ownershipRows = await conversations.queryNotionRows(undefined);
    } catch {
      ownershipRows = (await conversations.readCache()).records;
    }
    if (!requireLocalRecord(ownershipRows, id, { device: conversations.device })) {
      throw httpError(403, "这个客户不属于当前 Device + WhatsApp sender，不能修改。");
    }

    let database;
    try {
      database = await conversations.notion("GET", `/databases/${conversations.blastDatabaseId}`);
    } catch (error) {
      throw httpError(502, `读取 Notion Blast Leads schema 失败：${error.message}`);
    }
    const schema = database?.properties || {};
    const correction = {
      status: body.status,
      sequenceStatus: body.sequenceStatus,
      nextAction: body.nextAction,
      aiCategory: body.aiCategory,
      aiSummary: body.aiSummary,
      lastReplyAt: body.lastReplyAt,
      lastBlastAt: body.lastBlastAt,
      stopFlag: body.stopFlag === true,
      stopReason: body.stopReason,
    };
    const properties = manualCorrectionProperties(schema, correction);
    if (!Object.keys(properties).length) throw httpError(400, "没有要保存的修改。");

    try {
      await conversations.notion("PATCH", `/pages/${id}`, { properties });
    } catch (error) {
      throw httpError(502, `保存人工分类到 Notion 失败：${error.message}`);
    }

    const phone = conversations.normalizePhone(body.phone);
    if (phone && conversations.history) {
      await conversations.history.append(phone, {
        at: new Date().toISOString(),
        direction: "operator",
        source: "manual_classification",
        text: body.lastReplyText || "[manual correction]",
        route: "MANUAL_CORRECTION",
        signal: correction.stopFlag ? "RED" : "GREY",
        status: correction.status,
        sequenceStatus: correction.sequenceStatus,
        aiCategory: correction.aiCategory,
        nextAction: correction.nextAction,
        suggestedReply: correction.aiSummary,
        name: body.name || "",
        project: body.project || "",
      }).catch(() => {});
    }

    await writeConversationLog(conversations, "info", "manual_classification_saved", "Manual conversation classification saved.", {
      pageId: id,
      phone,
      name: body.name || "",
      project: body.project || "",
      status: correction.status,
      sequenceStatus: correction.sequenceStatus,
      nextAction: correction.nextAction,
      aiCategory: correction.aiCategory,
      lastReplyAt: correction.lastReplyAt,
      lastBlastAt: correction.lastBlastAt,
      stopFlag: correction.stopFlag,
    });

    const refreshed = await conversations.queryNotionRows(undefined).catch(() => []);
    await conversations.writeCache(refreshed).catch(() => {});
    json(res, 200, { ok: true, correction });
  });

  router.get("/api/conversations", async (req, res, runtime) => {
    const conversations = requireConversations(runtime);
    const url = new URL(req.url, `http://${runtime.host}:${runtime.port}`);
    if (!conversations.hasBlastDatabase) {
      throw httpError(400, "没有 Notion Blast Leads database 配置。请到 Settings 检查 Notion。");
    }

    const filters = {
      q: url.searchParams.get("q"),
      project: url.searchParams.get("project"),
      status: url.searchParams.get("status"),
      sequenceStatus: url.searchParams.get("sequenceStatus"),
      onlyReplied: url.searchParams.get("onlyReplied") === "1",
    };
    const limit = parseLimit(url.searchParams.get("limit"));

    let records;
    let source = "notion";
    let warning = "";
    try {
      const synced = conversations.syncCache
        ? await conversations.syncCache({ force: false })
        : { records: await conversations.queryNotionRows(undefined), reused: false };
      records = synced.records;
      source = synced.reused ? "cache" : "notion";
    } catch (error) {
      const cache = await conversations.readCache();
      records = cache.records;
      source = "cache";
      warning = `Notion live 读取失败，已显示本地快照：${error.message}`;
      if (!records.length) {
        throw httpError(502, `读取 Notion Conversation 失败，而且本地没有快照：${error.message}`);
      }
    }

    const allRecords = records;
    const scoped = deviceScope(conversations, allRecords);
    records = scoped.records;
    const allFacets = facets(records);
    const filtered = sortRecords(applyFilters(records, filters));
    json(res, 200, {
      ok: true,
      source,
      warning,
      scope: scopeResponse(conversations, allRecords, scoped),
      summary: summarize(records),
      filteredCount: filtered.length,
      records: filtered.slice(0, limit),
      facets: allFacets,
    });
  });
}
