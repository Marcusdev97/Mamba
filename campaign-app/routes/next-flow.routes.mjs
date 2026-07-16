import fs from "node:fs/promises";
import path from "node:path";
import { httpError, json, readJson } from "../lib/http.mjs";

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
        await writeReplyToNotion(nextFlow, page, verdict, event.at, event.text);
        record.notionUpdated = true;
      } catch (error) {
        record.notionUpdated = false;
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
    const gateSnapshot = loadGateSnapshot(); // 全局 STOP 名单一次载入, 整批复用
    let cursor;
    try {
      do {
        const body = { filter, page_size: 100 };
        if (cursor) body.start_cursor = cursor;
        const data = await nextFlow.notion("POST", `/databases/${nextFlow.blastDatabaseId}/query`, body);
        for (const page of data?.results ?? []) {
          const phone = nextFlow.normalizePhone(nextFlow.nfPhone(page, "Phone"));
          const next = nextFlow.nfSelect(page, "Next Flow");
          if (!phone || !next || next === "Completed") continue;
          const gate = canSend({ phone, page, classifyReplyText: nextFlow.classifyReplyText, snapshot: gateSnapshot });
          if (!gate.ok) {
            blocked.push({
              pageId: page.id,
              name: nextFlow.nfTitle(page, "Name") || phone,
              phone,
              reason: gate.reason,
            });
            continue;
          }
          const senderKeys = [
            nextFlow.nfSelect(page, "Sender Instance"),
            nextFlow.nfSelect(page, "Assigned Sender Key") || nextFlow.nfText(page, "Assigned Sender Key"),
            nextFlow.nfSelect(page, "Last Sender Key") || nextFlow.nfText(page, "Last Sender Key"),
          ].filter(Boolean);
          leads.push({
            pageId: page.id,
            name: nextFlow.nfTitle(page, "Name") || phone,
            phone,
            project: nextFlow.nfSelect(page, "Project") || "Unknown",
            nextFlow: next,
            cohortDay: nextFlow.nfSelect(page, "Cohort Day"),
            lastReply: nextFlow.nfText(page, "Last Reply Text"),
            lastBlastAt: page?.properties?.["Last Blast At"]?.date?.start || null,
            senderInstance: nextFlow.nfSelect(page, "Sender Instance"),
            senderKeys: [...new Set(senderKeys)],
          });
        }
        cursor = data?.has_more ? data?.next_cursor : null;
      } while (cursor);
    } catch (error) {
      throw httpError(502, `读取 Notion Next Flow 名单失败: ${error.message}`);
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
            await writeReplyToNotion(nextFlow, { id: lead.pageId }, verdict, event.at, event.text, "(picker 开单前检测)");
            skipped[skipped.length - 1].notionUpdated = true;
            await sleep(200);
          } catch (error) {
            skipped[skipped.length - 1].notionUpdated = false;
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
    });
  });

  router.post("/api/next-flow/redflag", async (req, res, runtime) => {
    const nextFlow = requireNextFlow(runtime);
    requireBlastDatabase(nextFlow);
    const body = await readJson(req);
    const ids = Array.isArray(body.pageIds) ? body.pageIds : [];
    let done = 0;

    for (const id of ids) {
      try {
        await nextFlow.notion("PATCH", `/pages/${pageId(id)}`, { properties: {
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
    const gateSnapshot = loadGateSnapshot();
    for (const item of normalized) {
      const phone = item.phone;
      const page = currentPages.get(pageId(item.pageId));
      if (!page) {
        blocked.push({ phone, name: String(item.name ?? "").trim() || phone, reason: "Notion row not found" });
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
    if (!leads.length) {
      const detail = blocked.length ? `（${blocked.length} 人已拒绝、STOP 或转人工）` : "";
      throw httpError(400, `没有可发送的选中客户${detail}。`);
    }

    nextFlow.setLeadsCache({ projectId: project.id, leads, rejected: [], sourcePath: "(next-flow picker)" });
    json(res, 200, { ok: true, project: project.id, loaded: leads.length, blocked });
  });

  router.post("/api/next-flow/set-flow", async (req, res, runtime) => {
    const nextFlow = requireNextFlow(runtime);
    requireBlastDatabase(nextFlow);
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
    const gateSnapshot = loadGateSnapshot();
    for (const phone of phones) {
      const page = await queryLeadPage(nextFlow, phone);
      if (!page) {
        notFound.push(phone);
        continue;
      }
      const gate = canSend({ phone, page, classifyReplyText: nextFlow.classifyReplyText, snapshot: gateSnapshot });
      if (!gate.ok) {
        if (isStopReason(gate.reason)) skippedStop += 1;
        else skippedRejected += 1;
        continue;
      }
      await nextFlow.notion("PATCH", `/pages/${pageId(page.id)}`, { properties: props });
      set += 1;
      await sleep(220);
    }

    json(res, 200, {
      ok: true,
      nextFlow: target.label,
      set,
      skippedStop,
      skippedRejected,
      notFound: notFound.length,
      notFoundSample: notFound.slice(0, 15),
    });
  });

  router.post("/api/next-flow/set-group", async (req, res, runtime) => {
    const nextFlow = requireNextFlow(runtime);
    requireBlastDatabase(nextFlow);
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
        // canSend 没给 phone 时会自己从行里抓 phone_number 查全局 STOP
        const gate = canSend({ page, classifyReplyText: nextFlow.classifyReplyText, snapshot: groupGateSnapshot });
        if (!gate.ok) {
          if (isStopReason(gate.reason)) skippedStop += 1;
          else skippedRejected += 1;
          continue;
        }
        targets.push(page.id);
      }
      cursor = query?.has_more ? query?.next_cursor : null;
    } while (cursor);

    // Phase 2 — now write to every collected page. 350ms keeps us under Notion's
    // ~3 req/s average so a big group doesn't fail partway with 429.
    let set = 0;
    for (const id of targets) {
      await nextFlow.notion("PATCH", `/pages/${pageId(id)}`, { properties: props });
      set += 1;
      await sleep(350);
    }

    json(res, 200, { ok: true, from: fromFlow, to: target.label, set, skippedStop, skippedRejected, matched: targets.length });
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
