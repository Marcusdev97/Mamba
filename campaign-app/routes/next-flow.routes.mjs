import fs from "node:fs/promises";
import path from "node:path";
import { httpError, json, readJson } from "../lib/http.mjs";
import { explainError } from "../lib/error-explainer.mjs";
import { recordDeviceScope } from "../lib/device-scope.mjs";

function requireNextFlow(runtime) {
  if (!runtime.nextFlow) {
    throw httpError(500, "Next-flow service 没有载入。请重启 Mamba server。");
  }
  return runtime.nextFlow;
}

function requireBlastDatabase(nextFlow) {
  if (!nextFlow.blastDatabaseId) {
    throw httpError(400, "没有 Notion Blast Leads database 配置。请到 Settings 检查 Notion。");
  }
}

function pageId(id) {
  return String(id || "").replace(/[^a-fA-F0-9]/g, "");
}

function requireDeviceScope(nextFlow) {
  const device = nextFlow.device || {};
  if (device.configured !== true || device.senderPolicyConfigured !== true || !device.senderPhones?.length) {
    throw httpError(409, "这台电脑还没有完整绑定 Device ID + 真实 WhatsApp 号码。为避免跨电脑误发，Flow 2–10 已锁定；请先到 Settings 设置本机号码。");
  }
  return device;
}

function pageOwnershipRecord(nextFlow, page) {
  const props = page?.properties || {};
  return {
    id: page?.id || "",
    senderInstance: nextFlow.nfSelect(page, "Sender Instance") || "",
    assignedSenderKey: nextFlow.nfSelect(page, "Assigned Sender Key") || nextFlow.nfText(page, "Assigned Sender Key") || "",
    lastSenderKey: nextFlow.nfSelect(page, "Last Sender Key") || nextFlow.nfText(page, "Last Sender Key") || "",
    lastSenderPhone: props["Last Sender Phone"]?.phone_number || nextFlow.nfText(page, "Last Sender Phone") || "",
    lastSentByDevice: nextFlow.nfSelect(page, "Last Sent By Device") || nextFlow.nfText(page, "Last Sent By Device") || "",
  };
}

export function effectiveAutomaticFlow(nextFlowLabel, cohortDay) {
  void cohortDay;
  return { nextFlow: nextFlowLabel, originalNextFlow: "" };
}

export function nextFlowPageDeviceScope(nextFlow, page) {
  return recordDeviceScope(pageOwnershipRecord(nextFlow, page), { device: nextFlow.device || {} });
}

function requireLocalPage(nextFlow, page, action = "操作") {
  requireDeviceScope(nextFlow);
  const scope = nextFlowPageDeviceScope(nextFlow, page);
  if (scope !== "local") {
    throw httpError(403, `${action}已拒绝：客户不属于这台电脑绑定的 WhatsApp 号码（scope=${scope}）。`);
  }
  return page;
}

function requireLocalRunner(nextFlow, runner, action = "Next Flow") {
  const device = requireDeviceScope(nextFlow);
  if (!runner?.state || String(runner.state.deviceId || "") !== String(device.id || "")) {
    throw httpError(403, `${action}已拒绝：Campaign 不属于这台电脑。`);
  }
  return runner;
}

// 拦截逻辑统一搬去 lead_gatekeeper.mjs (2026-07-11 架构重构) — 这里 re-export
// 保持 test_next_flow_safety.mjs 和旧 import 兼容。规则改动请去 gatekeeper 改。
import { canSend, loadGateSnapshot, rowBlockReason, isStopReason } from "../lead_gatekeeper.mjs";

export const nextFlowBlockReason = rowBlockReason;
const REPLY_SAFETY_TTL_MS = 10 * 60 * 1000;
let deepReplySafety = { checkedAt: null, ok: false, instances: 0 };

export function replySafetyStatus({ trackerUpdatedAt, deepCheckedAt, deepOk = false, now = Date.now() } = {}) {
  const trackerMs = new Date(trackerUpdatedAt || 0).getTime();
  const deepMs = new Date(deepCheckedAt || 0).getTime();
  const trackerAgeMs = Number.isFinite(trackerMs) && trackerMs > 0 ? Math.max(0, now - trackerMs) : Infinity;
  const deepAgeMs = Number.isFinite(deepMs) && deepMs > 0 ? Math.max(0, now - deepMs) : Infinity;
  const trackerFresh = trackerAgeMs <= REPLY_SAFETY_TTL_MS;
  const deepFresh = deepOk === true && deepAgeMs <= REPLY_SAFETY_TTL_MS;
  return {
    safeToSend: trackerFresh || deepFresh,
    trackerFresh,
    deepFresh,
    trackerAgeMinutes: Number.isFinite(trackerAgeMs) ? Math.round(trackerAgeMs / 60000) : null,
    deepAgeMinutes: Number.isFinite(deepAgeMs) ? Math.round(deepAgeMs / 60000) : null,
    maxAgeMinutes: Math.round(REPLY_SAFETY_TTL_MS / 60000),
  };
}

async function currentReplySafety(runtime) {
  let trackerUpdatedAt = null;
  try {
    const trackerPath = path.join(runtime.paths.rootDir, "campaign-data", "tracker", "heartbeat.json");
    const status = JSON.parse(await fs.readFile(trackerPath, "utf8"));
    trackerUpdatedAt = status?.heartbeatAt || null;
  } catch {
    // Missing tracker state is handled as stale below.
  }
  return {
    trackerUpdatedAt,
    ...replySafetyStatus({
      trackerUpdatedAt,
      deepCheckedAt: deepReplySafety.checkedAt,
      deepOk: deepReplySafety.ok,
    }),
  };
}

// 回复检测改读 tracker 的产物 (2026-07-11 架构重构): 实时监听已经在收同样的
// 消息, list 不再每次全量扫 Evolution — 页面从"随消息量变慢"变成毫秒级。
// 想直接问 WhatsApp 用 ?deep=1 (页面上的「深度扫描」按钮)。
async function trackerInbound(runtime, leads) {
  const trackerDir = path.join(runtime.paths.rootDir, "campaign-data", "tracker");
  const inbound = new Map();
  let updatedAt = null;
  try {
    const status = JSON.parse(await fs.readFile(path.join(trackerDir, "heartbeat.json"), "utf8"));
    updatedAt = status?.heartbeatAt ?? null;
  } catch { /* tracker 从没跑过 — 前端会警告 */ }
  const latest = new Map();
  try {
    const lines = (await fs.readFile(path.join(trackerDir, "replies.jsonl"), "utf8")).split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (!event?.phone || !event?.receivedAt) continue;
      const prev = latest.get(event.phone);
      if (!prev || new Date(event.receivedAt) > new Date(prev.receivedAt)) latest.set(event.phone, event);
    }
  } catch { /* 还没有回复记录 */ }
  for (const lead of leads) {
    const event = latest.get(lead.phone);
    if (!event) continue;
    const since = lead.lastBlastAt ? new Date(lead.lastBlastAt).getTime() : Date.now() - 7 * 864e5;
    if (new Date(event.receivedAt).getTime() >= since) {
      inbound.set(lead.phone, { at: event.receivedAt, text: event.text || "[reply]" });
    }
  }
  return { inbound, updatedAt };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeNextFlowLog(nextFlow, level, event, message, context = {}) {
  await nextFlow.systemLogs?.write({
    level,
    area: "next-flow",
    event,
    message,
    context,
  }).catch(() => {});
}

async function queryLeadPage(nextFlow, phone) {
  const data = await nextFlow.notion("POST", `/databases/${nextFlow.blastDatabaseId}/query`, {
    filter: { property: "Phone", phone_number: { equals: phone } },
    page_size: 1,
  });
  return data?.results?.[0] || null;
}

async function queryLeadPages(nextFlow, phones) {
  const pages = new Map();
  const unique = [...new Set(phones.filter(Boolean))];
  for (let offset = 0; offset < unique.length; offset += 40) {
    const chunk = unique.slice(offset, offset + 40);
    let cursor;
    do {
      const data = await nextFlow.notion("POST", `/databases/${nextFlow.blastDatabaseId}/query`, {
        filter: { or: chunk.map((phone) => ({ property: "Phone", phone_number: { equals: phone } })) },
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      });
      for (const page of data?.results ?? []) pages.set(pageId(page.id), page);
      cursor = data?.has_more ? data?.next_cursor : null;
    } while (cursor);
    if (offset + 40 < unique.length) await sleep(350);
  }
  return pages;
}

function replyProps(nextFlow, reply, at, text, reasonSuffix = "") {
  const props = {
    Status: { select: { name: reply.status } },
    "Sequence Status": { select: { name: reply.sequenceStatus } },
    "Next Action": { select: { name: reply.nextAction } },
    "AI Category": { select: { name: reply.aiCategory } },
    "Last Reply At": { date: { start: new Date(at).toISOString() } },
    "Last Reply Text": { rich_text: [{ text: { content: (text || "").slice(0, 1900) } }] },
    "Reply Checked At": { date: { start: new Date().toISOString() } },
    "AI Summary": { rich_text: [{ text: { content: `[${reply.signal}] ${reply.route} · 建议:${reply.suggestedReply}` } }] },
  };
  if (reply.stopFlag) {
    props["Stop Flag"] = { checkbox: true };
    props["Stop Reason"] = { rich_text: [{ text: { content: `Auto: ${reply.route}${reasonSuffix}` } }] };
  }
  return props;
}

async function writeReplyToNotion(nextFlow, page, reply, at, text, reasonSuffix = "") {
  await nextFlow.notion("PATCH", `/pages/${pageId(page.id)}`, {
    properties: replyProps(nextFlow, reply, at, text, reasonSuffix),
  });
}

async function mirrorProjectLeadPatch(runtime, nextFlow, {
  pageId: rawPageId,
  entityId,
  properties,
  idempotencyKey,
} = {}) {
  const notionPageId = pageId(rawPageId);
  if (!notionPageId) throw new Error("客户缺少 Notion Page ID，无法建立云端同步任务。");
  if (runtime.notionOutbox) {
    await runtime.notionOutbox.enqueue({
      entityType: "project_lead_patch",
      entityId: entityId || notionPageId,
      idempotencyKey,
      payload: { pageId: notionPageId, properties },
    });
  }
  try {
    await nextFlow.notion("PATCH", `/pages/${notionPageId}`, { properties });
    if (runtime.notionOutbox && idempotencyKey) {
      await runtime.notionOutbox.markCompletedByKey(idempotencyKey).catch(() => {});
    }
    return { notionUpdated: true, notionQueued: false };
  } catch (error) {
    error.notionQueued = Boolean(runtime.notionOutbox);
    throw error;
  }
}

async function writeReplyLocalFirst(runtime, nextFlow, page, phone, reply, at, text, reasonSuffix = "") {
  const properties = replyProps(nextFlow, reply, at, text, reasonSuffix);
  const local = await nextFlow.recordLocalLeadReply?.({
    pageId: page?.id,
    phone,
    reply,
    at,
    text,
  });
  if (!local || local.updated < 1) {
    const error = new Error("客户回复无法写入本机资料库；为避免误发，Notion 同步已暂停。请检查 SQLite 状态。");
    error.code = "LOCAL_REPLY_WRITE_FAILED";
    throw error;
  }
  const key = `LOCAL_TO_NOTION:project_lead_patch:${pageId(page?.id)}:reply:${new Date(at || Date.now()).toISOString()}`;
  try {
    const mirror = await mirrorProjectLeadPatch(runtime, nextFlow, {
      pageId: page?.id,
      entityId: `${phone}:reply`,
      properties,
      idempotencyKey: key,
    });
    return { localUpdated: true, ...mirror };
  } catch (error) {
    error.localUpdated = true;
    throw error;
  }
}

function localRecordAsPage(record) {
  const rich = (value) => ({ rich_text: value ? [{ text: { content: String(value) } }] : [] });
  const select = (value) => ({ select: value ? { name: String(value) } : null });
  return {
    id: record?.id,
    properties: {
      Phone: { type: "phone_number", phone_number: record?.phone || "" },
      "Stop Flag": { checkbox: record?.stopFlag === true },
      Status: select(record?.status),
      "Sequence Status": select(record?.sequenceStatus),
      "AI Category": select(record?.aiCategory),
      "Last Reply Text": rich(record?.lastReplyText),
    },
  };
}

function dateMs(value) {
  const ms = new Date(value || 0).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

async function creditReplyMetrics(nextFlow, state, phone, signal) {
  const job = state.assignments.find((item) => nextFlow.normalizePhone(item.lead?.phone) === phone);
  let credits = job?.tplCredit;
  if (!credits) {
    const language = String(job?.language || "en").toUpperCase();
    const templates = (state.creditByLang || {})[language] || Object.values(state.creditByLang || {})[0] || {};
    credits = [(templates.p1 || [])[0], (templates.p2 || [])[0]]
      .filter((item) => item && item.pageId)
      .map((item) => ({ pageId: item.pageId, imagePageId: item.imagePageId }));
  }

  for (const part of credits || []) {
    if (!part?.pageId) continue;
    await nextFlow.incPageNumber(part.pageId, "Response Count", 1);
    if (signal === "GREEN") await nextFlow.incPageNumber(part.pageId, "Warm Count", 1);
    else if (signal === "RED") await nextFlow.incPageNumber(part.pageId, "Stop Count", 1);

    if (part.imagePageId) {
      await nextFlow.incPageNumber(part.imagePageId, "Response Count", 1);
      if (signal === "GREEN") await nextFlow.incPageNumber(part.imagePageId, "Warm Count", 1);
      else if (signal === "RED") await nextFlow.incPageNumber(part.imagePageId, "Stop Count", 1);
    }
  }
}

async function latestInboundReplies(nextFlow, instances, leadsByPhone, sinceForLead) {
  const inbound = new Map();
  const diagnostics = [];
  const oldestNeeded = Math.min(...[...leadsByPhone.values()].map(sinceForLead).filter(Number.isFinite));
  for (const instance of instances) {
    let scan;
    try {
      scan = await fetchInstanceMessagesDeep(nextFlow, instance.name, Number.isFinite(oldestNeeded) ? oldestNeeded : Date.now() - 7 * 864e5);
    } catch (error) {
      diagnostics.push({ instance: instance.name, pages: 0, messages: 0, error: error.message || String(error) });
      continue;
    }

    let matched = 0;
    for (const message of scan.messages) {
      if (message?.key?.fromMe) continue;
      const phone = nextFlow.resolvePhone?.(message) || nextFlow.phoneFromJid(message?.key?.remoteJid);
      const lead = phone && leadsByPhone.get(phone);
      if (!lead) continue;
      const senderKeys = Array.isArray(lead.senderKeys)
        ? lead.senderKeys.filter(Boolean)
        : [lead.senderInstance].filter(Boolean);
      if (senderKeys.length && !senderKeys.includes(instance.name)) continue;

      const at = nextFlow.messageTime(message);
      const sinceMs = sinceForLead(lead);
      if (at < sinceMs) continue;

      const previous = inbound.get(phone);
      if (!previous || at > previous.at) {
        const text = nextFlow.describeMessage?.(message) || nextFlow.extractText(message) || "[reply]";
        inbound.set(phone, { at, text });
        matched += 1;
      }
    }
    diagnostics.push({
      instance: instance.name,
      pages: scan.pagesRead,
      messages: scan.messages.length,
      matched,
      totalReported: scan.totalReported,
      truncated: scan.truncated,
    });
  }
  return { inbound, diagnostics };
}

async function loadOpenInstances(nextFlow) {
  try {
    return await retryTransientConnection(() => nextFlow.openInstances());
  } catch (error) {
    throw httpError(503, `读取 WhatsApp Phone Health 失败: ${error.message}`);
  }
}

export function isTransientConnectionError(error) {
  const message = String(error?.message || error || "");
  return /fetch failed|timeout|timed out|aborted|ECONNRESET|ECONNREFUSED|EPIPE|HTTP (?:408|429|5\d\d)\b/i.test(message);
}

export async function retryTransientConnection(operation, { attempts = 3, delayMs = 400 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isTransientConnectionError(error)) throw error;
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
  throw lastError;
}

function paginationNumber(value, names) {
  const containers = [value, value?.messages, value?.data, value?.data?.messages];
  for (const container of containers) {
    for (const name of names) {
      const number = Number(container?.[name]);
      if (Number.isFinite(number) && number >= 0) return number;
    }
  }
  return null;
}

function messageIdentity(message) {
  return String(message?.key?.id || `${message?.key?.remoteJid || "?"}_${message?.messageTimestamp || "?"}`);
}

export async function fetchInstanceMessagesDeep(nextFlow, instanceName, sinceMs, options = {}) {
  const pageSize = Number(options.pageSize || 200);
  const maxPages = Number(options.maxPages || 60);
  const messages = [];
  const seenMessages = new Set();
  const seenPages = new Set();
  let pagesRead = 0;
  let totalReported = null;
  let truncated = false;

  for (let page = 1; page <= maxPages; page += 1) {
    const response = await retryTransientConnection(() => nextFlow.api(`/chat/findMessages/${encodeURIComponent(instanceName)}`, {
      method: "POST",
      body: JSON.stringify({ where: {}, page, offset: pageSize }),
    }), { attempts: Number(options.retryAttempts || 3), delayMs: Number(options.retryDelayMs ?? 400) });
    const pageMessages = nextFlow.collectMessageObjects(response);
    pagesRead += 1;

    const fingerprint = pageMessages.map(messageIdentity).slice(0, 5).join("|");
    if (fingerprint && seenPages.has(fingerprint)) break;
    if (fingerprint) seenPages.add(fingerprint);

    let added = 0;
    for (const message of pageMessages) {
      const identity = messageIdentity(message);
      if (seenMessages.has(identity)) continue;
      seenMessages.add(identity);
      messages.push(message);
      added += 1;
    }

    const total = paginationNumber(response, ["total", "totalRecords", "count"]);
    const totalPages = paginationNumber(response, ["pages", "totalPages", "pageCount"]);
    if (total !== null) totalReported = total;

    if (!pageMessages.length || !added) break;
    if (totalPages !== null && page >= totalPages) break;
    if (total !== null && seenMessages.size >= total) break;

    const times = pageMessages.map(nextFlow.messageTime).filter((time) => time > 0);
    if (times.length && Math.max(...times) < sinceMs) break;
    if (page === maxPages) truncated = true;
  }

  return { messages, pagesRead, totalReported, truncated };
}

export function registerNextFlowRoutes(router) {
  router.post("/api/next-flow/scan-replies", async (req, res, runtime) => {
    const nextFlow = requireNextFlow(runtime);
    const body = await readJson(req);
    const runner = nextFlow.getRunner(body.runId);
    if (!runner || !runner.state) {
      json(res, 200, { ok: true, replies: [] });
      return;
    }
    requireLocalRunner(nextFlow, runner, "回复扫描");
    requireBlastDatabase(nextFlow);

    const state = runner.state;
    state.repliesSeen = state.repliesSeen || {};
    const startMs = new Date(state.startAt || Date.now()).getTime();
    const runPhones = new Map();
    for (const job of state.assignments || []) {
      const phone = nextFlow.normalizePhone(job.lead?.phone);
      if (phone) runPhones.set(phone, job.lead?.name || phone);
    }

    let instances;
    try {
      instances = await nextFlow.openInstances();
    } catch {
      json(res, 200, { ok: true, replies: Object.values(state.repliesSeen), evoOffline: true });
      return;
    }

    const leadsByPhone = new Map([...runPhones.entries()].map(([phone, name]) => [phone, { phone, name }]));
    const { inbound } = await latestInboundReplies(nextFlow, instances, leadsByPhone, () => startMs);
    for (const [phone, event] of inbound) {
      if (state.repliesSeen[phone]) continue;
      const verdict = nextFlow.classifyReplyText(event.text);
      const record = {
        phone,
        name: runPhones.get(phone),
        signal: verdict.signal,
        route: verdict.route,
        status: verdict.status,
        text: (event.text || "").slice(0, 80),
      };
      state.repliesSeen[phone] = record;

      try {
        const page = await queryLeadPage(nextFlow, phone);
        if (!page) throw new Error(`Notion Blast Leads 找不到号码 ${phone}`);
        const persisted = await writeReplyLocalFirst(runtime, nextFlow, page, phone, verdict, event.at, event.text);
        record.localUpdated = persisted.localUpdated;
        record.notionUpdated = true;
      } catch (error) {
        record.localUpdated = error.localUpdated === true;
        record.notionUpdated = false;
        record.notionQueued = error.notionQueued === true;
        record.notionError = error.message || String(error);
        await writeNextFlowLog(nextFlow, "error", "reply_notion_update_failed", "A reply was detected during Next Flow but Notion could not be updated.", {
          phone,
          name: record.name,
          route: verdict.route,
          error: record.notionError,
        });
      }

      try {
        await creditReplyMetrics(nextFlow, state, phone, verdict.signal);
      } catch {
        // Reply analytics are best-effort; sending state must keep moving.
      }
    }

    json(res, 200, { ok: true, replies: Object.values(state.repliesSeen) });
  });

  router.get("/api/next-flow/list", async (req, res, runtime) => {
    const nextFlow = requireNextFlow(runtime);
    if (!nextFlow.blastDatabaseId) {
      json(res, 200, { ok: true, leads: [] });
      return;
    }
    const localDevice = requireDeviceScope(nextFlow);
    // Refresh is also a recovery trigger. If the app/browser stopped after WhatsApp
    // acknowledged some sends but before Notion finalisation, replay the persisted
    // run state into SQLite first. This is idempotent and sentAt prevents regression.
    const localReconcile = { runsChecked: 0, runsRecorded: 0, leadsRecorded: 0, errors: [] };
    for (const runner of nextFlow.listRunners?.() || []) {
      const state = runner?.state;
      if (!state?.flowLabel || state.mode !== "LIVE" || !(state.assignments || []).some((job) => job?.part1?.sentAt)) continue;
      localReconcile.runsChecked += 1;
      try {
        const result = await nextFlow.recordLocalFlowProgress?.(runner);
        localReconcile.runsRecorded += 1;
        localReconcile.leadsRecorded += Number(result?.recorded || 0);
      } catch (error) {
        localReconcile.errors.push({ runId: state.runId, error: error.message || String(error) });
      }
    }
    if (localReconcile.errors.length) {
      throw httpError(500, `本机 Flow 补账失败；为避免把已发送客户放回旧 Flow，本次名单已锁定。${localReconcile.errors.map((item) => `${item.runId}: ${item.error}`).join("；")}`);
    }
    const localCache = await nextFlow.readLocalLeadCache?.().catch(() => ({ records: [] })) || { records: [] };
    const localByPage = new Map();
    const localByProjectPhone = new Map();
    for (const record of localCache.records || []) {
      if (record.id) localByPage.set(pageId(record.id), record);
      localByProjectPhone.set(`${String(record.project || "").trim().toLowerCase()}:${nextFlow.normalizePhone(record.phone)}`, record);
    }
    // deep=1 -> 直接扫 Evolution (慢, 手动按钮); 默认读 tracker 产物 (快)。
    const deep = new URL(req.url, "http://x").searchParams.get("deep") === "1";

    const today = nextFlow.klTodayKL();
    const filter = { and: [
      { property: "Sequence Status", select: { equals: "Running" } },
      { property: "Follow Up Due", date: { on_or_before: today } },
      { property: "Stop Flag", checkbox: { equals: false } },
      { property: "Status", select: { does_not_equal: "Stop" } },
      { property: "Status", select: { does_not_equal: "Not Interested" } },
      { property: "Status", select: { does_not_equal: "Appointment" } },
      { property: "Status", select: { does_not_equal: "Invalid" } },
    ] };

    const leads = [];
    const blocked = [];
    const ownershipCounts = { local: 0, remote: 0, legacy: 0, unassigned: 0 };
    const gateSnapshot = loadGateSnapshot(); // 全局 STOP 名单一次载入, 整批复用
    let cursor;
    try {
      do {
        const body = { filter, page_size: 100 };
        if (cursor) body.start_cursor = cursor;
        const data = await nextFlow.notion("POST", `/databases/${nextFlow.blastDatabaseId}/query`, body);
        for (const page of data?.results ?? []) {
          const phone = nextFlow.normalizePhone(nextFlow.nfPhone(page, "Phone"));
          const project = nextFlow.nfSelect(page, "Project") || "Unknown";
          const local = localByPage.get(pageId(page.id))
            || localByProjectPhone.get(`${project.trim().toLowerCase()}:${phone}`)
            || null;
          const notionLastBlastAt = page?.properties?.["Last Blast At"]?.date?.start || null;
          const localFlowWins = (Boolean(local?.campaignRunId)
              && dateMs(local?.lastBlastAt) >= dateMs(notionLastBlastAt))
            || dateMs(local?.localUpdatedAt) > dateMs(page?.last_edited_time);
          const rawNext = localFlowWins ? local.nextFlow : nextFlow.nfSelect(page, "Next Flow");
          const cohortDay = localFlowWins && local?.cohortDay !== null && local?.cohortDay !== undefined
            ? `Day ${local.cohortDay}`
            : nextFlow.nfSelect(page, "Cohort Day");
          const effective = effectiveAutomaticFlow(rawNext, cohortDay);
          const next = effective.nextFlow;
          if (!phone || !next || next === "Completed") continue;
          const ownership = nextFlowPageDeviceScope(nextFlow, page);
          ownershipCounts[ownership] = (ownershipCounts[ownership] || 0) + 1;
          if (ownership !== "local") continue;
          const effectivePage = local ? localRecordAsPage({
            ...local,
            nextFlow: next,
            sequenceStatus: localFlowWins ? local.sequenceStatus : nextFlow.nfSelect(page, "Sequence Status"),
            status: local.status || nextFlow.nfSelect(page, "Status"),
          }) : page;
          const gate = canSend({ phone, page: effectivePage, classifyReplyText: nextFlow.classifyReplyText, snapshot: gateSnapshot });
          if (!gate.ok) {
            blocked.push({
              pageId: page.id,
              name: nextFlow.nfTitle(page, "Name") || phone,
              phone,
              reason: gate.reason,
            });
            continue;
          }
          const nextDueDate = localFlowWins
            ? local.followUpDue
            : page?.properties?.["Follow Up Due"]?.date?.start || null;
          if (nextDueDate && nextDueDate > today) continue;
          if (localFlowWins && local.sequenceStatus !== "Running") continue;
          const senderKeys = [
            local?.senderInstance || nextFlow.nfSelect(page, "Sender Instance"),
            local?.assignedSenderKey || nextFlow.nfSelect(page, "Assigned Sender Key") || nextFlow.nfText(page, "Assigned Sender Key"),
            local?.lastSenderKey || nextFlow.nfSelect(page, "Last Sender Key") || nextFlow.nfText(page, "Last Sender Key"),
          ].filter(Boolean);
          leads.push({
            pageId: page.id,
            name: nextFlow.nfTitle(page, "Name") || phone,
            phone,
            project,
            nextFlow: next,
            originalNextFlow: effective.originalNextFlow,
            cohortDay,
            nextDueDate,
            lastReply: dateMs(local?.lastReplyAt) >= dateMs(page?.properties?.["Last Reply At"]?.date?.start)
              ? local?.lastReplyText || ""
              : nextFlow.nfText(page, "Last Reply Text"),
            lastBlastAt: localFlowWins ? local.lastBlastAt : notionLastBlastAt,
            senderInstance: local?.senderInstance || nextFlow.nfSelect(page, "Sender Instance"),
            senderKeys: [...new Set(senderKeys)],
            localFlowRecovered: localFlowWins,
          });
        }
        cursor = data?.has_more ? data?.next_cursor : null;
      } while (cursor);
    } catch (error) {
      // 这是最常出现的一条错误(三天 49 次)，原本只丢 "aborted due to timeout"，
      // 看不出严不严重。讲清楚：名单读不到而已，没有任何东西被发出去。
      const explanation = explainError(error, { area: "api", event: "next_flow_list" });
      throw httpError(502, [
        "读不到 Notion 的 Next Flow 名单。",
        `为什么：${explanation.why}`,
        "影响：这个页面暂时列不出客户，但没有任何讯息被发出去，也没有资料被改动。",
        `处理：${explanation.action}`,
        `原始讯息：${explanation.details}`,
      ].join("\n"), explanation.code);
    }

    const skipped = [];
    const candidatesChecked = leads.length;
    let instancesChecked = 0;
    let scanDiagnostics = [];
    let evoOffline = false;
    let trackerUpdatedAt = null;
    let inbound = new Map();
    if (leads.length) {
      if (deep) {
        // 深度扫描: 直接问 Evolution (旧默认行为, 现在只在手动按钮时跑)
        let instances = [];
        try {
          instances = await loadOpenInstances(nextFlow);
        } catch {
          evoOffline = true;
        }
        if (!evoOffline && instances.length) {
          instancesChecked = instances.length;
          const byPhoneScan = new Map(leads.map((lead) => [lead.phone, lead]));
          const scan = await latestInboundReplies(nextFlow, instances, byPhoneScan, (lead) =>
            lead.lastBlastAt ? new Date(lead.lastBlastAt).getTime() : Date.now() - 7 * 864e5);
          inbound = scan.inbound;
          scanDiagnostics = scan.diagnostics;
        } else {
          evoOffline = true;
        }
      } else {
        // 默认: 读实时追踪 (tracker/brain webhook) 已经收好的回复, 不碰 Evolution
        ({ inbound, updatedAt: trackerUpdatedAt } = await trackerInbound(runtime, leads));
      }

      {
        const byPhone = new Map(leads.map((lead) => [lead.phone, lead]));

        for (const [phone, event] of inbound) {
          const lead = byPhone.get(phone);
          const verdict = nextFlow.classifyReplyText(event.text);
          skipped.push({
            name: lead.name,
            phone,
            signal: verdict.signal,
            route: verdict.route,
            text: (event.text || "").slice(0, 80),
          });
          try {
            const persisted = await writeReplyLocalFirst(runtime, nextFlow, { id: lead.pageId }, phone, verdict, event.at, event.text, "(picker 开单前检测)");
            skipped[skipped.length - 1].localUpdated = persisted.localUpdated;
            skipped[skipped.length - 1].notionUpdated = true;
            await sleep(200);
          } catch (error) {
            skipped[skipped.length - 1].localUpdated = error.localUpdated === true;
            skipped[skipped.length - 1].notionUpdated = false;
            skipped[skipped.length - 1].notionQueued = error.notionQueued === true;
            skipped[skipped.length - 1].notionError = error.message || String(error);
            await writeNextFlowLog(nextFlow, "error", "picker_reply_notion_update_failed", "A rejection was detected before Next Flow, but Notion could not be updated.", {
              phone,
              name: lead.name,
              route: verdict.route,
              error: error.message || String(error),
            });
          }
        }

        if (skipped.length) {
          const skipPhones = new Set(skipped.map((item) => item.phone));
          for (let i = leads.length - 1; i >= 0; i -= 1) {
            if (skipPhones.has(leads[i].phone)) leads.splice(i, 1);
          }
        }
      }
    }

    if (deep) {
      const scanOk = !evoOffline
        && instancesChecked > 0
        && !scanDiagnostics.some((item) => item.error || item.truncated);
      deepReplySafety = { checkedAt: new Date().toISOString(), ok: scanOk, instances: instancesChecked };
    }
    const replySafety = await currentReplySafety(runtime);

    json(res, 200, {
      ok: true,
      today,
      leads,
      skipped,
      blocked,
      evoOffline,
      whatsappCheck: {
        checkedAt: new Date().toISOString(),
        scanSource: deep ? "evolution-deep" : "tracker",
        trackerUpdatedAt,
        ...replySafety,
        candidates: candidatesChecked,
        instances: instancesChecked,
        repliesFound: skipped.length,
        pagesRead: scanDiagnostics.reduce((sum, item) => sum + Number(item.pages || 0), 0),
        messagesRead: scanDiagnostics.reduce((sum, item) => sum + Number(item.messages || 0), 0),
        matched: scanDiagnostics.reduce((sum, item) => sum + Number(item.matched || 0), 0),
        truncated: scanDiagnostics.some((item) => item.truncated),
        errors: scanDiagnostics.filter((item) => item.error),
      },
      deviceScope: {
        mode: "strict-device-sender",
        deviceId: localDevice.id,
        senderSuffixes: localDevice.senderPhones.map((phone) => String(phone).slice(-4)),
        ...ownershipCounts,
      },
      localReconcile,
    });
  });

  router.post("/api/next-flow/redflag", async (req, res, runtime) => {
    const nextFlow = requireNextFlow(runtime);
    requireBlastDatabase(nextFlow);
    requireDeviceScope(nextFlow);
    const body = await readJson(req);
    const ids = Array.isArray(body.pageIds) ? body.pageIds : [];
    const pages = [];
    for (const id of ids) {
      let page;
      try {
        page = await nextFlow.notion("GET", `/pages/${pageId(id)}`);
      } catch (error) {
        throw httpError(502, `标记不发前读取客户归属失败: ${error.message}`);
      }
      pages.push(requireLocalPage(nextFlow, page, "标记不发"));
    }
    let done = 0;

    for (const page of pages) {
      try {
        await nextFlow.notion("PATCH", `/pages/${pageId(page.id)}`, { properties: {
          "Stop Flag": { checkbox: true },
          "Sequence Status": { select: { name: "Stopped" } },
          "Stop Reason": { rich_text: [{ text: { content: "Manual: marked 不发 in picker" } }] },
        } });
        done += 1;
        await sleep(200);
      } catch {
        // Skip a failed page and report the successful count.
      }
    }

    json(res, 200, { ok: true, flagged: done });
  });

  router.post("/api/next-flow/load", async (req, res, runtime) => {
    const nextFlow = requireNextFlow(runtime);
    requireDeviceScope(nextFlow);
    const replySafety = await currentReplySafety(runtime);
    if (!replySafety.safeToSend) {
      throw httpError(409, `回复安全检查已过期。Tracker 超过 ${replySafety.maxAgeMinutes} 分钟没有更新，请先按「Refresh + Check WhatsApp」完成深度扫描。`);
    }

    const body = await readJson(req);
    let project;
    try {
      ({ project } = await nextFlow.getProject(body.project));
    } catch (error) {
      throw httpError(500, `读取 project 失败: ${error.message}`);
    }

    const incoming = Array.isArray(body.leads) ? body.leads : [];
    const seen = new Set();
    const normalized = [];
    for (const item of incoming) {
      const phone = nextFlow.normalizePhone(item.phone);
      if (!phone || seen.has(phone)) continue;
      seen.add(phone);
      normalized.push({ ...item, phone });
    }

    let currentPages;
    try {
      currentPages = await queryLeadPages(nextFlow, normalized.map((item) => item.phone));
    } catch (error) {
      throw httpError(502, `发送前批量检查 Notion 状态失败: ${error.message}`);
    }

    const leads = [];
    const blocked = [];
    const foreignSelected = [];
    const gateSnapshot = loadGateSnapshot();
    for (const item of normalized) {
      const phone = item.phone;
      const page = currentPages.get(pageId(item.pageId));
      if (!page) {
        blocked.push({ phone, name: String(item.name ?? "").trim() || phone, reason: "Notion row not found" });
        continue;
      }
      const ownership = nextFlowPageDeviceScope(nextFlow, page);
      if (ownership !== "local") {
        foreignSelected.push({ phone, ownership });
        continue;
      }
      const gate = canSend({ phone, page, classifyReplyText: nextFlow.classifyReplyText, snapshot: gateSnapshot });
      if (!gate.ok) {
        blocked.push({ phone, name: String(item.name ?? "").trim() || phone, reason: gate.reason });
        continue;
      }
      leads.push({
        id: `pick_${String(leads.length + 1).padStart(5, "0")}`,
        name: String(item.name ?? "").trim() || "there",
        phone,
        senderInstance: String(item.senderInstance ?? "").trim(),
      });
    }
    if (foreignSelected.length) {
      throw httpError(403, `发送已拒绝：选中的 ${foreignSelected.length} 位客户不属于本机 Device + WhatsApp 号码。请刷新名单后重选。`);
    }
    if (!leads.length) {
      const detail = blocked.length ? `（${blocked.length} 人已拒绝、STOP 或转人工）` : "";
      throw httpError(400, `没有可发送的选中客户${detail}。`);
    }

    // Register the picked list as a proper saved local customer group so it carries a
    // leadGroupId. Upstream's send gate now requires one; the picker path previously set
    // the cache without it, which blocked sending. The leads here already passed device
    // scope + STOP/reply gates above, so this changes who gets messaged not at all — it
    // only supplies the missing group record and its id.
    let group;
    try {
      group = await nextFlow.createLeadGroup({
        projectCode: project.id,
        projectName: project.name,
        name: `${project.name || project.id} · Next-Flow ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
        sourceType: "database",
        sourceName: "next-flow picker",
        leads,
      });
    } catch (error) {
      throw httpError(400, `建立客户群失败: ${error.message}`);
    }
    nextFlow.setLeadsCache({
      projectId: project.id,
      leads,
      rejected: [],
      sourcePath: "(next-flow picker)",
      leadGroupId: group.id,
      leadGroupName: group.name,
      groupMemberCount: group.memberCount,
    });
    json(res, 200, {
      ok: true,
      project: project.id,
      loaded: leads.length,
      blocked,
      group: { id: group.id, name: group.name, memberCount: group.memberCount },
    });
  });

  router.post("/api/next-flow/set-flow", async (req, res, runtime) => {
    const nextFlow = requireNextFlow(runtime);
    requireBlastDatabase(nextFlow);
    requireDeviceScope(nextFlow);
    const body = await readJson(req);
    const targetFlow = String(body.nextFlow ?? "").trim();
    const target = nextFlow.flowByLabel(targetFlow);
    if (!target) throw httpError(400, `未知的 Next Flow: ${targetFlow}`);
    const previous = nextFlow.flowSequence.find((flow) => flow.next === target.key);

    const raw = Array.isArray(body.phones) ? body.phones : String(body.phones ?? "").split(/[\s,;]+/);
    const phones = [...new Set(raw.map(nextFlow.normalizePhone).filter(Boolean))];
    if (!phones.length) throw httpError(400, "没有有效的电话号码。");

    const props = {
      "Next Flow": { select: { name: target.label } },
      "Sequence Status": { select: { name: "Running" } },
      "Cohort Day": { select: { name: previous ? previous.cohortDay : "Day 0" } },
      "Follow Up Due": { date: { start: nextFlow.klTodayKL() } },
    };
    if (previous) props["Last Flow Sent"] = { select: { name: previous.label } };

    let set = 0;
    let skippedStop = 0;
    let skippedRejected = 0;
    const notFound = [];
    const targets = [];
    const foreign = [];
    for (const phone of phones) {
      const page = await queryLeadPage(nextFlow, phone);
      if (!page) {
        notFound.push(phone);
        continue;
      }
      const ownership = nextFlowPageDeviceScope(nextFlow, page);
      if (ownership !== "local") {
        foreign.push({ phone, ownership });
        continue;
      }
      targets.push({ phone, page });
    }
    if (foreign.length) {
      throw httpError(403, `改 Flow 已拒绝：${foreign.length} 位客户不属于这台电脑。`);
    }
    const gateSnapshot = loadGateSnapshot();
    const eligible = [];
    for (const { phone, page } of targets) {
      const gate = canSend({ phone, page, classifyReplyText: nextFlow.classifyReplyText, snapshot: gateSnapshot });
      if (!gate.ok) {
        if (isStopReason(gate.reason)) skippedStop += 1;
        else skippedRejected += 1;
        continue;
      }
      eligible.push({ phone, page });
    }
    const localWrite = await nextFlow.setLocalLeadFlowState?.({
      targets: eligible.map(({ phone, page }) => ({ pageId: page.id, phone })),
      nextFlow: target.label,
      lastFlowSent: previous?.label || "",
      cohortDay: previous?.cohortDay || "Day 0",
      followUpDue: nextFlow.klTodayKL(),
    });
    if (eligible.length && (!localWrite || localWrite.updated < eligible.length)) {
      throw httpError(500, `本机只更新 ${localWrite?.updated || 0}/${eligible.length} 位客户，Notion 尚未修改。请先检查 Local Storage。`);
    }
    let notionPending = 0;
    const operationAt = new Date().toISOString();
    for (const { phone, page } of eligible) {
      try {
        await mirrorProjectLeadPatch(runtime, nextFlow, {
          pageId: page.id,
          entityId: `${phone}:flow`,
          properties: props,
          idempotencyKey: `LOCAL_TO_NOTION:project_lead_patch:${pageId(page.id)}:manual-flow:${operationAt}`,
        });
      } catch {
        notionPending += 1;
      }
      set += 1;
      await sleep(220);
    }

    json(res, 200, {
      ok: true,
      nextFlow: target.label,
      set,
      skippedStop,
      skippedRejected,
      localUpdated: localWrite?.updated || 0,
      notionPending,
      notFound: notFound.length,
      notFoundSample: notFound.slice(0, 15),
    });
  });

  router.post("/api/next-flow/set-group", async (req, res, runtime) => {
    const nextFlow = requireNextFlow(runtime);
    requireBlastDatabase(nextFlow);
    requireDeviceScope(nextFlow);
    const body = await readJson(req);
    const projectName = String(body.projectName ?? "").trim();
    const fromFlow = String(body.fromFlow ?? "").trim();
    const toFlow = String(body.toFlow ?? "").trim();
    const target = nextFlow.flowByLabel(toFlow);
    if (!projectName || !fromFlow) throw httpError(400, "缺少 projectName / fromFlow。");
    if (!target) throw httpError(400, `未知的目标 Flow: ${toFlow}`);
    const previous = nextFlow.flowSequence.find((flow) => flow.next === target.key);

    const props = {
      "Next Flow": { select: { name: target.label } },
      "Sequence Status": { select: { name: "Running" } },
      "Cohort Day": { select: { name: previous ? previous.cohortDay : "Day 0" } },
      "Follow Up Due": { date: { start: nextFlow.klTodayKL() } },
    };
    if (previous) props["Last Flow Sent"] = { select: { name: previous.label } };

    // Phase 1 — collect ALL matching page ids first, WITHOUT writing yet.
    // The filter pages through "Next Flow = fromFlow", but the write CHANGES
    // "Next Flow" — so mutating mid-pagination drops rows out of the very set
    // we're paging, and later pages skip people (the "only 58 changed" bug).
    // Read the whole set first, then write.
    const targets = [];
    let cursor;
    let skippedStop = 0;
    let skippedRejected = 0;
    let skippedForeign = 0;
    const groupGateSnapshot = loadGateSnapshot();
    do {
      const query = await nextFlow.notion("POST", `/databases/${nextFlow.blastDatabaseId}/query`, {
        filter: { and: [
          { property: "Project", select: { equals: projectName } },
          { property: "Next Flow", select: { equals: fromFlow } },
          { property: "Sequence Status", select: { equals: "Running" } },
        ] },
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      });
      for (const page of query?.results ?? []) {
        if (nextFlowPageDeviceScope(nextFlow, page) !== "local") {
          skippedForeign += 1;
          continue;
        }
        // canSend 没给 phone 时会自己从行里抓 phone_number 查全局 STOP
        const gate = canSend({ page, classifyReplyText: nextFlow.classifyReplyText, snapshot: groupGateSnapshot });
        if (!gate.ok) {
          if (isStopReason(gate.reason)) skippedStop += 1;
          else skippedRejected += 1;
          continue;
        }
        targets.push({ id: page.id, phone: nextFlow.normalizePhone(nextFlow.nfPhone(page, "Phone")) });
      }
      cursor = query?.has_more ? query?.next_cursor : null;
    } while (cursor);

    // Phase 2 — now write to every collected page. 350ms keeps us under Notion's
    // ~3 req/s average so a big group doesn't fail partway with 429.
    const localWrite = await nextFlow.setLocalLeadFlowState?.({
      targets: targets.map((item) => ({ pageId: item.id, phone: item.phone })),
      nextFlow: target.label,
      lastFlowSent: previous?.label || "",
      cohortDay: previous?.cohortDay || "Day 0",
      followUpDue: nextFlow.klTodayKL(),
    });
    if (targets.length && (!localWrite || localWrite.updated < targets.length)) {
      throw httpError(500, `本机只更新 ${localWrite?.updated || 0}/${targets.length} 位客户，Notion 尚未修改。请先检查 Local Storage。`);
    }
    let set = 0;
    let notionPending = 0;
    const operationAt = new Date().toISOString();
    for (const item of targets) {
      try {
        await mirrorProjectLeadPatch(runtime, nextFlow, {
          pageId: item.id,
          entityId: `${item.phone}:flow`,
          properties: props,
          idempotencyKey: `LOCAL_TO_NOTION:project_lead_patch:${pageId(item.id)}:group-flow:${operationAt}`,
        });
      } catch {
        notionPending += 1;
      }
      set += 1;
      await sleep(350);
    }

    json(res, 200, {
      ok: true,
      from: fromFlow,
      to: target.label,
      set,
      localUpdated: localWrite?.updated || 0,
      notionPending,
      skippedStop,
      skippedRejected,
      skippedForeign,
      matched: targets.length,
    });
  });

  router.post("/api/next-flow/preview-template", async (req, res, runtime) => {
    const nextFlow = requireNextFlow(runtime);
    requireBlastDatabase(nextFlow);
    const body = await readJson(req);
    const projectName = String(body.projectName ?? "").trim();
    const flow = String(body.flow ?? "").trim();
    if (!projectName || !flow) throw httpError(400, "缺少 projectName / flow。");

    let languages;
    try {
      languages = await nextFlow.fetchFlowTemplates(projectName, flow);
    } catch (error) {
      throw httpError(502, `读取 Notion 模板失败: ${error.message}`);
    }
    json(res, 200, { ok: true, projectName, flow, languages });
  });

  router.post("/api/next-flow/apply-templates", async (req, res, runtime) => {
    const nextFlow = requireNextFlow(runtime);
    requireBlastDatabase(nextFlow);
    const body = await readJson(req);
    const runner = nextFlow.getRunner(body.runId);
    if (!runner || !runner.state) throw httpError(400, "请先 prepare。");
    requireLocalRunner(nextFlow, runner, "套用 Next Flow 模板");
    if (runner.running) throw httpError(409, "campaign 正在运行。");

    const projectName = String(body.projectName ?? "").trim();
    const flow = String(body.flow ?? "").trim();
    if (!projectName || !flow) throw httpError(400, "缺少 projectName 或 flow。");

    let result;
    try {
      result = await nextFlow.applyNotionFlowTemplatesToState(runner.state, {
        projectName,
        flow,
        markFlowRun: true,
        credit: true,
      });
    } catch (error) {
      throw httpError(502, `套用 Notion 模板失败: ${error.message}`);
    }

    try {
      await runner.saveState();
    } catch (error) {
      throw httpError(500, `保存 next-flow 预览失败: ${error.message}`);
    }

    const sample = runner.state.assignments[0];
    json(res, 200, {
      ok: true,
      flow,
      project: projectName,
      languages: Object.keys(result.byLang),
      overridden: result.overridden,
      twoPart: Object.values(result.byLang).some((value) =>
        value.parts && Object.keys(value.parts).filter((part) => (value.parts[part] || []).length).length >= 2),
      sample: sample ? String(sample.part1Text || "").slice(0, 120) : "",
    });
  });
}
