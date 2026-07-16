import crypto from "node:crypto";
import { syncBrainCache } from "../brain_cache_sync.mjs";
import { httpError, json, readJson } from "../lib/http.mjs";

const ACTIONS_ALLOWED = new Set(["Edited", "Sent As-Is"]);
const LEARNING_STATUSES = ["Pending", "Approved", "Rejected"];
const LEARNING_TYPES = ["Golden", "Objection"];

const LOG_SCHEMA = {
  "Learning Status": { select: { options: LEARNING_STATUSES.map((name) => ({ name })) } },
  "Learning Type": { select: { options: LEARNING_TYPES.map((name) => ({ name })) } },
  "Learning Note": { rich_text: {} },
  "Learning Key": { rich_text: {} },
  "Learned At": { date: {} },
  "Conversation Context": { rich_text: {} },
  "Sender Instance": { rich_text: {} },
};

const GOLDEN_SCHEMA = {
  "Golden Key": { rich_text: {} },
};

const OBJECTION_SCHEMA = {
  "Objection Key": { rich_text: {} },
};

function requireLearning(runtime) {
  const service = runtime.brainLearning;
  if (!service?.notion || !service.aiReplyLogDbId || !service.goldenDbId || !service.objectionDbId) {
    throw httpError(500, "Brain Learning service 没有完整载入。请重启 Mamba server。");
  }
  return service;
}

export async function learningQueueSnapshot(service) {
  if (!service?.notion || !service.aiReplyLogDbId || !service.goldenDbId || !service.objectionDbId) {
    throw new Error("Brain Learning configuration is incomplete.");
  }
  const pages = await queryAll(service.notion, service.aiReplyLogDbId);
  const records = pages.map(learningCandidateFromPage).filter(Boolean)
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  return {
    records,
    summary: Object.fromEntries(LEARNING_STATUSES.map((name) => [name, records.filter((item) => item.learningStatus === name).length])),
    projects: [...new Set(records.map((item) => item.project).filter(Boolean))].sort(),
  };
}

function clean(value) {
  return String(value ?? "").trim();
}

function pageId(value) {
  return clean(value).replace(/[^a-fA-F0-9]/g, "");
}

function propText(prop) {
  return [...(prop?.title || []), ...(prop?.rich_text || [])].map((part) => part?.plain_text || "").join("").trim();
}

function propChoice(prop) {
  return prop?.select?.name || prop?.status?.name || "";
}

function propDate(prop) {
  return prop?.date?.start || "";
}

function propPhone(prop) {
  return clean(prop?.phone_number).replace(/\D/g, "");
}

function richText(value, max = 1900) {
  const content = clean(value).slice(0, max);
  return { rich_text: content ? [{ text: { content } }] : [] };
}

function title(value) {
  const content = clean(value).slice(0, 180);
  return { title: content ? [{ text: { content } }] : [] };
}

function select(value) {
  const name = clean(value);
  return { select: name ? { name } : null };
}

export function learningTypeFor(route) {
  const value = clean(route).toLowerCase();
  return /not interested|complaint|objection/.test(value) ? "Objection" : "Golden";
}

export function learningKeyFor({ project, route, conversationText, customerText, responseText, learningType }) {
  const normalized = [project, route, conversationText, customerText, responseText, learningType]
    .map((value) => clean(value).toLowerCase().replace(/\s+/g, " "))
    .join("|");
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 20);
}

export function learningCandidateFromPage(page) {
  const p = page?.properties || {};
  const action = propChoice(p.Action);
  const customerText = propText(p["Reply Summary"]);
  const responseText = propText(p["Final Sent"]);
  if (!ACTIONS_ALLOWED.has(action) || !customerText || !responseText) return null;
  const route = propChoice(p.Route) || "Unknown";
  const learningStatus = propChoice(p["Learning Status"]) || "Pending";
  const learningType = propChoice(p["Learning Type"]) || learningTypeFor(route);
  return {
    id: pageId(page.id),
    url: page.url || "",
    project: propChoice(p.Project),
    phone: propPhone(p["Lead Phone"]),
    senderInstance: propText(p["Sender Instance"]),
    route,
    language: propChoice(p.Language) || "EN",
    action,
    customerText,
    aiDraft: propText(p["AI Draft"]),
    responseText,
    timestamp: propDate(p.Timestamp) || page.created_time || "",
    learningStatus,
    learningType,
    learningNote: propText(p["Learning Note"]),
    learningKey: propText(p["Learning Key"]),
    conversationText: propText(p["Conversation Context"]),
  };
}

export function goldenProperties(item, key) {
  const project = clean(item.project) || "General";
  const scenario = clean(item.route) || "General";
  return {
    Conversation: title(`${project} · ${scenario} · ${key.slice(0, 8)}`),
    Scenario: select(scenario),
    Project: select(project),
    "Conversation Text": contextRichText(clean(item.conversationText) || `Customer: ${clean(item.customerText)}\nSales: ${clean(item.responseText)}`),
    "Why It Worked": richText(clean(item.note) || `Human approved for reuse. Source action: ${clean(item.action) || "reviewed"}.`),
    Language: select(clean(item.language) || "EN"),
    "Golden Key": richText(key),
  };
}

export function objectionProperties(item, key) {
  const scenario = clean(item.route) || "Objection";
  return {
    "Customer Says": title(item.customerText),
    "Real Intent": richText(clean(item.note) || scenario),
    "Response Direction": richText(item.responseText),
    "Handoff Required": { checkbox: false },
    Scenario: select(scenario),
    Language: select(clean(item.language) || "EN"),
    "Objection Key": richText(key),
  };
}

async function queryAll(notion, databaseId, limit = 1000) {
  const pages = [];
  let cursor = null;
  do {
    const result = await notion("POST", `/databases/${databaseId}/query`, {
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    pages.push(...(result?.results || []));
    cursor = result?.has_more && pages.length < limit ? result.next_cursor : null;
  } while (cursor);
  return pages.slice(0, limit);
}

async function ensureProperties(service, databaseId, definitions) {
  let database = await service.notion("GET", `/databases/${databaseId}`);
  const current = database?.properties || {};
  const missing = Object.fromEntries(Object.entries(definitions).filter(([name]) => !current[name]));
  if (Object.keys(missing).length) {
    await service.notion("PATCH", `/databases/${databaseId}`, { properties: missing });
    database = await service.notion("GET", `/databases/${databaseId}`);
  }
  return database;
}

async function existingKeys(service, databaseId, propertyName) {
  const pages = await queryAll(service.notion, databaseId, 2000);
  return new Set(pages.map((page) => propText(page?.properties?.[propertyName])).filter(Boolean));
}

function learningLogProperties({ status, learningType, note, key, learnedAt }) {
  return {
    "Learning Status": select(status),
    "Learning Type": select(learningType),
    "Learning Note": richText(note),
    "Learning Key": richText(key),
    "Learned At": { date: learnedAt ? { start: learnedAt } : null },
  };
}

function contextRichText(value) {
  const text = clean(value).slice(0, 50000);
  return { rich_text: text ? text.match(/[\s\S]{1,1900}/g).map((content) => ({ text: { content } })) : [] };
}

function isoTime(service, message) {
  const ms = Number(service.messageTime(message) || 0);
  return ms ? new Date(ms).toISOString() : "";
}

function threadFromMessages(service, messages, phone) {
  const seen = new Set();
  const normalized = [];
  for (const message of messages || []) {
    const messagePhone = service.resolvePhone(message);
    if (messagePhone && messagePhone !== phone) continue;
    const remote = clean(message?.key?.remoteJid);
    if (!messagePhone && !remote.startsWith(phone)) continue;
    const id = clean(message?.key?.id) || `${remote}:${isoTime(service, message)}:${service.describeMessage(message)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    normalized.push({
      id,
      at: isoTime(service, message),
      direction: message?.key?.fromMe ? "outbound" : "inbound",
      text: service.describeMessage(message),
    });
  }
  return normalized
    .filter((item) => item.text)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)))
    .slice(-200);
}

function threadText(messages) {
  return messages.map((item) => `[${item.at || "time unknown"}] ${item.direction === "outbound" ? "SALES" : "CUSTOMER"}: ${item.text}`).join("\n");
}

function ensureCandidateTurn(messages, item) {
  const result = messages.slice();
  const customerText = clean(item.customerText);
  const responseText = clean(item.responseText);
  if (customerText && !result.some((message) => message.direction === "inbound" && clean(message.text) === customerText)) {
    result.push({ id: `candidate-in:${item.id}`, at: item.timestamp || "", direction: "inbound", text: customerText });
  }
  if (responseText && !result.some((message) => message.direction === "outbound" && clean(message.text) === responseText)) {
    result.push({ id: `candidate-out:${item.id}`, at: item.timestamp || "", direction: "outbound", text: responseText });
  }
  return result.sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(-200);
}

async function fetchCandidateThread(service, item, instances, senderByPhone) {
  const phone = service.normalizePhone(item.phone);
  if (!phone) return { id: item.id, source: "fallback", messages: [], conversationText: clean(item.conversationText) };
  if (clean(item.conversationText)) {
    return { id: item.id, source: "notion", messages: [], conversationText: clean(item.conversationText) };
  }
  const preferred = clean(item.senderInstance) || clean(senderByPhone.get(phone));
  const names = [...new Set([preferred, ...instances.map((instance) => instance.name)].filter(Boolean))];
  const errors = [];
  for (const instanceName of names) {
    try {
      const response = await service.api(`/chat/findMessages/${encodeURIComponent(instanceName)}`, {
        method: "POST",
        body: JSON.stringify({ where: { key: { remoteJid: `${phone}@s.whatsapp.net` } }, limit: 100 }),
      });
      const messages = ensureCandidateTurn(threadFromMessages(service, service.collectMessageObjects(response), phone), item);
      if (messages.length) return { id: item.id, source: `whatsapp:${instanceName}`, messages, conversationText: threadText(messages) };
    } catch (error) {
      errors.push(`${instanceName}: ${error.message}`);
    }
  }
  const local = await service.history?.read(phone, { limit: 100 }).catch(() => []) || [];
  const localMessages = local.slice().reverse().map((entry) => ({
    id: entry.eventKey || entry.messageId,
    at: entry.at || entry.savedAt || "",
    direction: ["outbound", "operator"].includes(entry.direction) ? "outbound" : "inbound",
    text: entry.text || "[message]",
  })).slice(-40);
  if (localMessages.length) {
    const messages = ensureCandidateTurn(localMessages, item);
    return { id: item.id, source: "local-history", messages, conversationText: threadText(messages), errors };
  }
  const fallback = [
    { at: item.timestamp, direction: "inbound", text: item.customerText },
    { at: item.timestamp, direction: "outbound", text: item.responseText },
  ].filter((message) => message.text);
  return { id: item.id, source: "reply-log-fallback", messages: fallback, conversationText: threadText(fallback), errors };
}

async function writeApproved(service, item, learningType, key, keySets) {
  if (learningType === "Golden") {
    if (keySets.golden.has(key)) return { created: false, duplicate: true };
    await service.notion("POST", "/pages", {
      parent: { database_id: service.goldenDbId },
      properties: goldenProperties(item, key),
    });
    keySets.golden.add(key);
    return { created: true, duplicate: false };
  }
  if (keySets.objection.has(key)) return { created: false, duplicate: true };
  await service.notion("POST", "/pages", {
    parent: { database_id: service.objectionDbId },
    properties: objectionProperties(item, key),
  });
  keySets.objection.add(key);
  return { created: true, duplicate: false };
}

export function registerBrainLearningRoutes(router) {
  router.get("/api/brain-learning", async (req, res, runtime) => {
    const service = requireLearning(runtime);
    const url = new URL(req.url, `http://${runtime.host}:${runtime.port}`);
    const status = clean(url.searchParams.get("status")) || "Pending";
    const project = clean(url.searchParams.get("project"));
    const q = clean(url.searchParams.get("q")).toLowerCase();
    const snapshot = await learningQueueSnapshot(service);
    const all = snapshot.records;
    const filtered = all.filter((item) => {
      if (status !== "All" && item.learningStatus !== status) return false;
      if (project && item.project !== project) return false;
      if (q && ![item.project, item.route, item.customerText, item.responseText].join(" ").toLowerCase().includes(q)) return false;
      return true;
    });
    json(res, 200, {
      ok: true,
      summary: snapshot.summary,
      projects: snapshot.projects,
      count: filtered.length,
      records: filtered.slice(0, 500),
    });
  });

  router.post("/api/brain-learning/conversations", async (req, res, runtime) => {
    const service = requireLearning(runtime);
    const body = await readJson(req);
    const items = Array.isArray(body.items) ? body.items.slice(0, 50) : [];
    if (!items.length) throw httpError(400, "没有需要补齐的 Conversation。");
    const instances = await service.openInstances().catch(() => []);
    const cache = await service.readCache().catch(() => ({ records: [] }));
    const senderByPhone = new Map();
    for (const record of cache.records || []) {
      const phone = service.normalizePhone(record.phone);
      if (phone && record.senderInstance) senderByPhone.set(phone, record.senderInstance);
    }
    const threads = [];
    let cursor = 0;
    async function worker() {
      while (cursor < items.length) {
        const item = items[cursor];
        cursor += 1;
        threads.push(await fetchCandidateThread(service, item, instances, senderByPhone));
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, items.length) }, () => worker()));
    json(res, 200, { ok: true, threads });
  });

  router.post("/api/brain-learning/review", async (req, res, runtime) => {
    const service = requireLearning(runtime);
    const body = await readJson(req);
    const decision = clean(body.decision);
    const items = Array.isArray(body.items) ? body.items.slice(0, 100) : [];
    if (!["approve", "reject"].includes(decision)) throw httpError(400, "decision 必须是 approve 或 reject。");
    if (!items.length) throw httpError(400, "请至少选择一条 Learning Candidate。");

    await ensureProperties(service, service.aiReplyLogDbId, LOG_SCHEMA);
    let keySets = { golden: new Set(), objection: new Set() };
    if (decision === "approve") {
      await ensureProperties(service, service.goldenDbId, GOLDEN_SCHEMA);
      await ensureProperties(service, service.objectionDbId, OBJECTION_SCHEMA);
      keySets = {
        golden: await existingKeys(service, service.goldenDbId, "Golden Key"),
        objection: await existingKeys(service, service.objectionDbId, "Objection Key"),
      };
    }

    const succeeded = [];
    const failed = [];
    for (const raw of items) {
      const id = pageId(raw.id);
      const learningType = LEARNING_TYPES.includes(clean(raw.learningType)) ? clean(raw.learningType) : learningTypeFor(raw.route);
      if (!id) {
        failed.push({ id: clean(raw.id), error: "Invalid AI Reply Log page id" });
        continue;
      }
      const item = {
        ...raw,
        customerText: clean(raw.customerText),
        responseText: clean(raw.responseText),
        learningType,
        conversationText: clean(raw.conversationText),
      };
      if (decision === "approve" && (!item.customerText || !item.responseText)) {
        failed.push({ id, error: "Customer message and final response are required" });
        continue;
      }
      const key = learningKeyFor(item);
      try {
        const target = decision === "approve"
          ? await writeApproved(service, item, learningType, key, keySets)
          : { created: false, duplicate: false };
        const learnedAt = new Date().toISOString();
        await service.notion("PATCH", `/pages/${id}`, {
          properties: {
            ...learningLogProperties({
            status: decision === "approve" ? "Approved" : "Rejected",
            learningType,
            note: raw.note,
            key,
            learnedAt,
            }),
            "Conversation Context": contextRichText(item.conversationText),
          },
        });
        succeeded.push({ id, key, learningType, ...target });
      } catch (error) {
        failed.push({ id, error: error.message || "Notion write failed" });
      }
    }

    let cache = null;
    let cacheError = "";
    if (decision === "approve" && succeeded.length) {
      try { cache = await syncBrainCache(); }
      catch (error) { cacheError = error.message || "Brain cache sync failed"; }
    }
    await service.systemLogs?.write({
      level: failed.length ? "warn" : "info",
      area: "brain",
      event: "learning_queue_reviewed",
      message: `Brain Learning ${decision}: ${succeeded.length} succeeded, ${failed.length} failed.`,
      context: { decision, succeeded: succeeded.length, failed: failed.length },
    }).catch(() => {});
    json(res, failed.length && !succeeded.length ? 400 : 200, {
      ok: succeeded.length > 0,
      decision,
      succeeded,
      failed,
      cache,
      cacheError,
    });
  });
}
