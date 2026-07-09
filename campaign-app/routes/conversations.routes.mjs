import { httpError, json } from "../lib/http.mjs";

function requireConversations(runtime) {
  if (!runtime.conversations) {
    throw httpError(500, "Conversations service 没有载入。请重启 Mamba server。");
  }
  return runtime.conversations;
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
  { name: "Last Flow Sent", types: ["select", "status"], level: "flow", reason: "显示已发 Flow" },
  { name: "Next Flow", types: ["select", "status"], level: "flow", reason: "显示下一轮 Flow" },
  { name: "Cohort Day", types: ["select", "status"], level: "flow", reason: "显示发送节奏" },
  { name: "Stop Flag", types: ["checkbox"], level: "safety", reason: "全局 STOP 拦截" },
  { name: "Stop Reason", types: ["rich_text"], level: "safety", reason: "STOP 原因" },
];

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

      const at = conversations.messageTime(message);
      if (!at) continue;
      const minMs = Math.max(latestReplyMs(record) + 1, latestBlastMs(record));
      if (at < minMs) continue;

      const previous = inbound.get(phone);
      if (!previous || at > previous.at) {
        const text = conversations.extractText(message) || "[reply]";
        inbound.set(phone, { at, text, record, instanceName: instance.name });
      }
    }
  }
  return { inbound, instanceErrors };
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
  }
  return props;
}

export function registerConversationsRoutes(router) {
  router.get("/api/conversations/schema-health", async (_req, res, runtime) => {
    const conversations = requireConversations(runtime);
    if (!conversations.hasBlastDatabase) {
      throw httpError(400, "没有 Notion Blast Leads database 配置。请到 Settings 检查 Notion。");
    }
    if (!conversations.notion || !conversations.blastDatabaseId) {
      throw httpError(500, "Conversations Notion service 没有载入。请重启 Mamba server。");
    }

    const database = await conversations.notion("GET", `/databases/${conversations.blastDatabaseId}`);
    json(res, 200, { ok: true, ...checkSchema(database) });
  });

  router.post("/api/conversations/refresh-replies", async (_req, res, runtime) => {
    const conversations = requireConversations(runtime);
    if (!conversations.hasBlastDatabase) {
      throw httpError(400, "没有 Notion Blast Leads database 配置。请到 Settings 检查 Notion。");
    }
    if (!conversations.notion || !conversations.api || !conversations.openInstances) {
      throw httpError(500, "Conversations refresh service 没有载入。请重启 Mamba server。");
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
      records = await conversations.queryNotionRows(undefined);
    } catch (error) {
      throw httpError(502, `读取 Notion Blast Leads 客户失败：${error.message}`);
    }
    const { byPhone, duplicateRows } = pickLatestRecordByPhone(records, conversations.normalizePhone);
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

    const { inbound, instanceErrors } = await latestInboundMessages(conversations, openInstances, byPhone);
    if (instanceErrors.length === openInstances.length) {
      throw httpError(502, `所有 OPEN WhatsApp connection 都读取失败。${instanceErrors.join(" | ")}`);
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

    await conversations.systemLogs?.write({
      level: failed.length ? "warn" : "info",
      area: "conversations",
      event: "refresh_replies",
      message: `Refresh replies updated ${updated.length} lead(s).`,
      context: { scannedPhones: byPhone.size, updated: updated.length, failed: failed.length, instanceErrors, duplicateRows },
    }).catch(() => {});

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
      updates: updated.slice(0, 50),
    });
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
      records = await conversations.queryNotionRows(undefined);
      await conversations.writeCache(records).catch(() => {});
    } catch (error) {
      const cache = await conversations.readCache();
      records = cache.records;
      source = "cache";
      warning = `Notion live 读取失败，已显示本地快照：${error.message}`;
      if (!records.length) {
        throw httpError(502, `读取 Notion Conversation 失败，而且本地没有快照：${error.message}`);
      }
    }

    const allFacets = facets(records);
    const filtered = sortRecords(applyFilters(records, filters));
    json(res, 200, {
      ok: true,
      source,
      warning,
      summary: summarize(records),
      filteredCount: filtered.length,
      records: filtered.slice(0, limit),
      facets: allFacets,
    });
  });
}
