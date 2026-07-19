import crypto from "node:crypto";
import { syncBrainCache } from "../brain_cache_sync.mjs";
import { httpError, json, readJson } from "../lib/http.mjs";

const ACTIONS_ALLOWED = new Set(["Edited", "Sent As-Is"]);
const LEARNING_STATUSES = ["Pending", "Approved", "Rejected"];
const LEARNING_TYPES = ["Golden", "Objection"];
const GOLDEN_SCENARIOS = ["Price Objection", "Hesitation", "Comparing", "Loan Question", "Viewing Push", "Cold Reopen", "Angry", "Other"];
const CUSTOMER_TYPES = ["Own Stay", "Investor", "First Timer", "Unknown"];
const GOLDEN_OUTCOMES = ["Viewing Booked", "Booking", "Warm", "Lost"];
const LANGUAGES = ["EN", "ZH", "BM", "Mixed"];

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
  "Customer Type": { select: { options: CUSTOMER_TYPES.map((name) => ({ name })) } },
  Outcome: { select: { options: GOLDEN_OUTCOMES.map((name) => ({ name })) } },
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
    "Customer Type": select(CUSTOMER_TYPES.includes(clean(item.customerType)) ? clean(item.customerType) : "Unknown"),
    Outcome: select(GOLDEN_OUTCOMES.includes(clean(item.outcome)) ? clean(item.outcome) : "Warm"),
    "Golden Key": richText(key),
  };
}

function redactPrivateText(value, privateNames = []) {
  let result = String(value ?? "")
    .replace(/[\u200e\u200f\u202a-\u202e]/g, "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[EMAIL]")
    .replace(/https?:\/\/\S+|www\.\S+/gi, "[LINK]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, (matched) => {
      const digits = matched.replace(/\D/g, "");
      return digits.length >= 9 && digits.length <= 15 ? "[PHONE]" : matched;
    });
  for (const rawName of privateNames) {
    const name = clean(rawName);
    if (name.length < 2) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(escaped, "gi"), "[NAME]");
  }
  return result.trim();
}

function canonicalSpeaker(value, salesNames) {
  const speaker = clean(value).toLowerCase().replace(/\s+/g, " ");
  if (/^(customer|client|buyer|prospect|lead|客户|顾客|买家)$/.test(speaker)) return "CUSTOMER";
  if (/^(sales|agent|advisor|consultant|me|我|销售|顾问)$/.test(speaker)) return "SALES";
  if (salesNames.has(speaker)) return "SALES";
  return "";
}

function stripWhatsappTimestamp(value) {
  return String(value ?? "").replace(
    /^\s*\[?\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4},?\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s?[ap]m)?\]?\s*(?:[-–—]\s*)?/i,
    "",
  );
}

function inferLanguage(text) {
  const value = clean(text).toLowerCase();
  const hasZh = /[\u3400-\u9fff]/.test(value);
  const hasBm = /\b(saya|awak|anda|boleh|nak|mahu|harga|rumah|bilik|pinjaman|temujanji|terima kasih)\b/.test(value);
  const hasEn = /\b(the|this|can|price|project|unit|loan|viewing|available|thank|interested)\b/.test(value);
  const kinds = [hasZh, hasBm, hasEn].filter(Boolean).length;
  if (kinds > 1) return "Mixed";
  if (hasZh) return "ZH";
  if (hasBm) return "BM";
  return "EN";
}

function inferScenario(text) {
  const value = clean(text).toLowerCase();
  if (/angry|complain|投诉|生气|骗|scam|marah|tipu/.test(value)) return "Angry";
  if (/loan|bank|installment|monthly|贷款|供期|银行|pinjaman|ansuran/.test(value)) return "Loan Question";
  if (/viewing|appointment|site visit|看房|预约|参观|temujanji|lawatan/.test(value)) return "Viewing Push";
  if (/compare|versus| vs |比较|对比|banding/.test(value)) return "Comparing";
  if (/price|discount|rebate|package|贵|价格|折扣|优惠|harga|diskaun/.test(value)) return "Price Objection";
  if (/follow up|long time|still looking|之前|还在找|lama|masih cari/.test(value)) return "Cold Reopen";
  if (/think|consider|later|not sure|考虑|迟点|再看看|fikir|nanti/.test(value)) return "Hesitation";
  return "Other";
}

function inferCustomerType(text) {
  const value = clean(text).toLowerCase();
  if (/invest|rental|rent out|roi|投资|出租|回报|pelaburan|sewa/.test(value)) return "Investor";
  if (/own stay|own use|stay myself|自住|自己住|duduk sendiri/.test(value)) return "Own Stay";
  if (/first home|first house|first property|首套|第一次买|rumah pertama/.test(value)) return "First Timer";
  return "Unknown";
}

function suggestedWhy(scenario, outcome) {
  const strategy = {
    "Price Objection": "没有急着降价，而是先确认客户真正关注的预算、户型和配套，再把话题带回下一步。",
    Hesitation: "先接住客户的犹豫，再用一个容易回答的问题降低回复门槛，让对话继续。",
    Comparing: "先理解客户的比较标准，再围绕适合度解释差异，没有直接贬低其他项目。",
    "Loan Question": "先确认贷款条件和预算范围，没有承诺审批结果，并给出清楚的下一步。",
    "Viewing Push": "把兴趣自然推进到明确的看房行动，同时让客户容易选择日期或时间。",
    "Cold Reopen": "重新打开旧对话时保持自然、简短，并提供了一个具体且容易回应的新信息。",
    Angry: "先承认客户感受和问题，没有争辩，再明确转人工处理。",
    Other: "回复紧贴客户的问题，语气自然，并用明确的下一步推动对话。",
  }[scenario] || "回复紧贴客户的问题，并用明确的下一步推动对话。";
  const result = {
    "Viewing Booked": "最终成功约到看房。",
    Booking: "最终推进到订购阶段。",
    Warm: "客户保持明确兴趣并愿意继续沟通。",
    Lost: "虽然没有成交，但这段处理方式仍有值得保留的部分。",
  }[outcome] || "";
  return `${strategy}${result}`;
}

export function prepareGoldenImport(input = {}) {
  const raw = String(input.rawConversation ?? input.conversationText ?? "").replace(/\r\n?/g, "\n").trim();
  if (!raw) throw new Error("请贴上成功案例的 WhatsApp 对话。");
  const salesNames = new Set(String(input.salesName || "").split(/[,，\n]/).map((name) => clean(name).toLowerCase()).filter(Boolean));
  const privateNames = String(input.privateNames || "").split(/[,，\n]/).map(clean).filter(Boolean);
  const ignored = /messages and calls are end-to-end encrypted|security code changed|created group|added you|您与此商家的对话|信息和通话均经过端到端加密/i;
  const messages = [];
  const unresolved = new Set();
  for (const originalLine of raw.split("\n")) {
    const line = stripWhatsappTimestamp(originalLine).trim();
    if (!line || ignored.test(line)) continue;
    const matched = line.match(/^([^:：]{1,60})[:：]\s*(.*)$/);
    if (matched) {
      const speaker = canonicalSpeaker(matched[1], salesNames);
      if (speaker) {
        messages.push({ speaker, text: matched[2] });
        continue;
      }
      if (/^[\p{L}\p{M} ._'\-]{2,60}$/u.test(matched[1])) {
        if (salesNames.size) {
          messages.push({ speaker: "CUSTOMER", text: matched[2] });
          continue;
        }
        unresolved.add(clean(matched[1]));
        messages.push({ speaker: `PARTICIPANT_${[...unresolved].indexOf(clean(matched[1])) + 1}`, text: matched[2] });
        continue;
      }
    }
    if (messages.length) messages[messages.length - 1].text += `\n${line}`;
    else messages.push({ speaker: "UNASSIGNED", text: line });
  }
  const conversationText = messages
    .map((message) => `${message.speaker}: ${redactPrivateText(message.text, privateNames)}`)
    .join("\n")
    .slice(0, 50000);
  const customerTurns = messages.filter((message) => message.speaker === "CUSTOMER");
  const salesTurns = messages.filter((message) => message.speaker === "SALES");
  const customerText = redactPrivateText(customerTurns.at(-1)?.text || "", privateNames);
  const responseText = redactPrivateText(salesTurns.at(-1)?.text || "", privateNames);
  const scenario = GOLDEN_SCENARIOS.includes(clean(input.scenario)) ? clean(input.scenario) : inferScenario(conversationText);
  const outcome = GOLDEN_OUTCOMES.includes(clean(input.outcome)) ? clean(input.outcome) : "Warm";
  const customerType = CUSTOMER_TYPES.includes(clean(input.customerType)) ? clean(input.customerType) : inferCustomerType(conversationText);
  const language = LANGUAGES.includes(clean(input.language)) ? clean(input.language) : inferLanguage(conversationText);
  const project = clean(input.project);
  const warnings = [];
  if (unresolved.size) warnings.push(`无法自动分辨 ${[...unresolved].join("、")} 是客户还是销售；请填写“你的聊天名称”，或在预览中改成 CUSTOMER / SALES。`);
  if (!customerText || !responseText) warnings.push("必须至少找到一段 CUSTOMER 和一段 SALES 对话，才能正式导入。");
  if (raw.length > 50000) warnings.push("对话超过 Notion 安全长度，预览只保留前 50,000 字符。");
  warnings.push("系统已隐藏明显的电话、电邮、链接和你填写的客户姓名；保存前仍请人工检查一次对话正文。 ");
  const item = {
    project,
    route: scenario,
    scenario,
    outcome,
    customerType,
    language,
    customerText,
    responseText,
    conversationText,
    note: clean(input.note) || suggestedWhy(scenario, outcome),
    action: "Historical Import",
    learningType: "Golden",
  };
  return {
    item,
    warnings,
    participants: [...unresolved],
    key: learningKeyFor(item),
    stats: { messages: messages.length, customerTurns: customerTurns.length, salesTurns: salesTurns.length },
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

async function refreshBrainCache(service) {
  return typeof service.syncBrainCache === "function" ? service.syncBrainCache() : syncBrainCache();
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

  router.post("/api/brain-learning/import/preview", async (req, res, runtime) => {
    const service = requireLearning(runtime);
    const body = await readJson(req);
    let prepared;
    try {
      prepared = prepareGoldenImport(body);
    } catch (error) {
      throw httpError(400, error.message || "成功案例无法整理。");
    }
    let duplicate = false;
    let duplicateCheckError = "";
    try {
      const keys = await existingKeys(service, service.goldenDbId, "Golden Key");
      duplicate = keys.has(prepared.key);
    } catch (error) {
      duplicateCheckError = error.message || "Notion duplicate check failed";
      prepared.warnings.push(`暂时无法检查 Notion 重复记录：${duplicateCheckError}`);
    }
    json(res, 200, {
      ok: true,
      ...prepared,
      duplicate,
      duplicateCheckError,
    });
  });

  router.post("/api/brain-learning/import", async (req, res, runtime) => {
    const service = requireLearning(runtime);
    const body = await readJson(req);
    let prepared;
    try {
      prepared = prepareGoldenImport(body);
    } catch (error) {
      throw httpError(400, error.message || "成功案例无法整理。");
    }
    const item = prepared.item;
    if (!item.project) throw httpError(400, "请选择或填写这个成功案例所属的 Project。");
    if (!item.customerText || !item.responseText || !/^CUSTOMER:/m.test(item.conversationText) || !/^SALES:/m.test(item.conversationText)) {
      throw httpError(400, "对话必须同时包含 CUSTOMER 和 SALES。请回到预览修正双方身份。");
    }
    if (item.conversationText.length < 20) throw httpError(400, "对话内容太短，暂时不适合作为成功案例。");

    await ensureProperties(service, service.goldenDbId, GOLDEN_SCHEMA);
    const keys = await existingKeys(service, service.goldenDbId, "Golden Key");
    if (keys.has(prepared.key)) {
      json(res, 409, {
        ok: false,
        duplicate: true,
        key: prepared.key,
        error: "这段成功案例已经存在，没有重复写入。",
      });
      return;
    }

    let page;
    try {
      page = await service.notion("POST", "/pages", {
        parent: { database_id: service.goldenDbId },
        properties: goldenProperties(item, prepared.key),
      });
    } catch (error) {
      throw httpError(502, `Notion 写入失败：${error.message || "unknown error"}`);
    }

    let cache = null;
    let cacheError = "";
    try { cache = await refreshBrainCache(service); }
    catch (error) { cacheError = error.message || "Brain cache sync failed"; }
    await service.systemLogs?.write({
      level: cacheError ? "warn" : "info",
      area: "brain",
      event: "golden_conversation_imported",
      message: `Imported historical Golden Conversation for ${item.project}.`,
      context: {
        project: item.project,
        scenario: item.scenario,
        outcome: item.outcome,
        customerType: item.customerType,
        language: item.language,
        goldenKey: prepared.key,
        cacheError,
      },
    }).catch(() => {});
    json(res, 201, {
      ok: true,
      created: true,
      key: prepared.key,
      pageId: pageId(page?.id),
      pageUrl: page?.url || "",
      cache,
      cacheError,
    });
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
      try { cache = await refreshBrainCache(service); }
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
