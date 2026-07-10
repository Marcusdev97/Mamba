import { httpError, json, readJson } from "../lib/http.mjs";

function requireFollowUp(runtime) {
  if (!runtime.followUp) {
    throw httpError(500, "Follow-Up service 没有载入。请重启 Mamba server。");
  }
  return runtime.followUp;
}

function clean(value) {
  return String(value ?? "").trim();
}

function pageId(id) {
  return String(id || "").replace(/[^a-fA-F0-9]/g, "");
}

function richText(value) {
  const text = String(value || "").slice(0, 1900);
  return { rich_text: text ? [{ text: { content: text } }] : [] };
}

function choiceValue(schema, name, option) {
  const type = schema?.[name]?.type;
  if (!option) return type === "status" ? { status: null } : { select: null };
  return type === "status" ? { status: { name: option } } : { select: { name: option } };
}

function dateOnlyKL(value = new Date()) {
  return new Date(value).toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" });
}

function dateMs(value) {
  const ms = new Date(value || 0).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function hoursSince(value, now = Date.now()) {
  const ms = dateMs(value);
  if (!ms) return Infinity;
  return (now - ms) / 36e5;
}

function isStop(record) {
  return record.stopFlag || ["Stop", "Not Interested", "Do Not Contact"].includes(record.status);
}

function isHot(record) {
  const values = [record.status, record.aiCategory, record.nextAction].join(" ").toLowerCase();
  return /warm|appointment|price|call|send price|interested|green|book/.test(values) && !isStop(record);
}

function isAppointment(record) {
  const values = [record.appointmentStatus, record.nextAction, record.status].join(" ").toLowerCase();
  return /appointment|book|showroom|viewing|confirmed|pending/.test(values) && !isStop(record);
}

function hasReply(record) {
  return Boolean(record.lastReplyText || record.lastReplyAt || Number(record.replyCount || 0) > 0);
}

function hasHumanAction(record) {
  const nextAction = clean(record.nextAction);
  const category = clean(record.aiCategory);
  return Boolean(nextAction && !["-", "None"].includes(nextAction))
    || Boolean(category && !["-", "Unknown"].includes(category))
    || Boolean(record.followUpAt)
    || isAppointment(record);
}

function isActionableLead(record) {
  return hasReply(record) || hasHumanAction(record) || isStop(record);
}

function isToday(record, today) {
  return record.followUpAt && dateOnlyKL(record.followUpAt) === today && !isStop(record);
}

function isOverdue(record, today) {
  return record.followUpAt && dateOnlyKL(record.followUpAt) < today && !isStop(record);
}

function reasonFor(record, now) {
  if (isStop(record)) return record.stopReason || "Stopped";
  if (record.followUpAt) {
    const day = dateOnlyKL(record.followUpAt);
    const today = dateOnlyKL(now);
    if (day < today) return `Overdue follow-up ${day}`;
    if (day === today) return "Follow-up today";
  }
  if (record.lastReplyText) return record.aiCategory || record.nextAction || "Customer replied";
  if (hoursSince(record.lastBlastAt || record.firstBlastAt, now) >= 24) return "No reply after blast";
  return record.nextAction || "Review";
}

function priorityFor(record, now) {
  const explicit = clean(record.priority);
  if (explicit) return explicit;
  if (isStop(record)) return "STOP";
  if (isAppointment(record)) return "HIGH";
  if (isHot(record)) return "HIGH";
  if (record.lastReplyText && hoursSince(record.lastReplyAt, now) <= 48) return "MED";
  if (record.followUpAt && dateOnlyKL(record.followUpAt) <= dateOnlyKL(now)) return "MED";
  return hasReply(record) ? "LOW" : "REVIEW";
}

function decorate(record, now = Date.now()) {
  const priority = priorityFor(record, now);
  return {
    ...record,
    priority,
    reason: reasonFor(record, now),
    bucket: isStop(record)
      ? "stop"
      : isOverdue(record, dateOnlyKL(now))
        ? "overdue"
        : isToday(record, dateOnlyKL(now))
          ? "today"
          : isAppointment(record)
            ? "appointment"
            : isHot(record)
              ? "hot"
              : "later",
  };
}

function summarize(records) {
  return {
    total: records.length,
    today: records.filter((record) => record.bucket === "today").length,
    overdue: records.filter((record) => record.bucket === "overdue").length,
    hot: records.filter((record) => record.bucket === "hot").length,
    appointment: records.filter((record) => record.bucket === "appointment").length,
    stop: records.filter((record) => record.bucket === "stop").length,
  };
}

function sortFollowUps(records) {
  const order = { overdue: 0, today: 1, appointment: 2, hot: 3, later: 4, stop: 5 };
  const priorityOrder = { HIGH: 0, MED: 1, LOW: 2, REVIEW: 3, STOP: 4 };
  return records.slice().sort((a, b) => {
    const byBucket = (order[a.bucket] ?? 9) - (order[b.bucket] ?? 9);
    if (byBucket) return byBucket;
    const byPriority = (priorityOrder[a.priority] ?? 9) - (priorityOrder[b.priority] ?? 9);
    if (byPriority) return byPriority;
    return String(b.lastReplyAt || b.lastBlastAt || "").localeCompare(String(a.lastReplyAt || a.lastBlastAt || ""));
  });
}

function applyFilters(records, filters) {
  const bucket = clean(filters.bucket);
  const project = clean(filters.project);
  const q = clean(filters.q).toLowerCase();
  return records.filter((record) => {
    if (bucket && record.bucket !== bucket) return false;
    if (project && record.project !== project) return false;
    if (q) {
      const haystack = [record.name, record.phone, record.project, record.reason, record.nextAction, record.lastReplyText].join(" ").toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

function actionPatch(schema, action, body) {
  const now = new Date().toISOString();
  const note = clean(body.note);
  const props = {};
  if (action === "call") {
    props["Next Action"] = choiceValue(schema, "Next Action", "Call");
    props.Status = choiceValue(schema, "Status", "Warm");
    props["AI Summary"] = richText(note || `Follow-up desk: call customer. Updated ${now}`);
  } else if (action === "send_price") {
    props["Next Action"] = choiceValue(schema, "Next Action", "Send Price");
    props.Status = choiceValue(schema, "Status", "Warm");
    props["AI Summary"] = richText(note || `Follow-up desk: send price details. Updated ${now}`);
  } else if (action === "book_appointment") {
    props["Next Action"] = choiceValue(schema, "Next Action", "Book Appointment");
    props.Status = choiceValue(schema, "Status", "Appointment");
    props["AI Summary"] = richText(note || `Follow-up desk: appointment follow-up. Updated ${now}`);
  } else if (action === "follow_up") {
    props["Next Action"] = choiceValue(schema, "Next Action", "Follow Up");
    props.Status = choiceValue(schema, "Status", "Follow Up");
    props["AI Summary"] = richText(note || `Follow-up desk: follow up later. Updated ${now}`);
  } else if (action === "done") {
    props["Next Action"] = choiceValue(schema, "Next Action", "Done");
    props["AI Summary"] = richText(note || `Follow-up desk: marked done. Updated ${now}`);
  } else if (action === "stop") {
    props.Status = choiceValue(schema, "Status", "Stop");
    props["Next Action"] = choiceValue(schema, "Next Action", "Stop");
    props["Stop Flag"] = { checkbox: true };
    props["Stop Reason"] = richText(note || "Manual stop from Follow-Up Desk");
  } else {
    throw httpError(400, "未知 follow-up action。");
  }
  if (schema?.["Reply Checked At"]) props["Reply Checked At"] = { date: { start: now } };
  return props;
}

export function registerFollowUpRoutes(router) {
  router.get("/api/follow-up", async (req, res, runtime) => {
    const followUp = requireFollowUp(runtime);
    const url = new URL(req.url, `http://${runtime.host}:${runtime.port}`);
    const filters = {
      bucket: url.searchParams.get("bucket") || "",
      project: url.searchParams.get("project") || "",
      q: url.searchParams.get("q") || "",
    };

    let cache = await followUp.readCache();
    let source = "cache";
    if (!cache.records.length && followUp.hasBlastDatabase) {
      const records = await followUp.queryNotionRows(undefined);
      cache = await followUp.writeCache(records);
      source = "notion";
    }

    const now = Date.now();
    const actionable = cache.records.filter(isActionableLead);
    const decorated = sortFollowUps(actionable.map((record) => decorate(record, now)));
    const filtered = applyFilters(decorated, filters);
    const projects = [...new Set(decorated.map((record) => record.project).filter(Boolean))].sort();
    json(res, 200, {
      ok: true,
      source,
      syncedAt: cache.syncedAt || null,
      summary: summarize(decorated),
      projects,
      count: filtered.length,
      records: filtered.slice(0, 500),
    });
  });

  router.post("/api/follow-up/action", async (req, res, runtime) => {
    const followUp = requireFollowUp(runtime);
    if (!followUp.hasBlastDatabase) throw httpError(400, "没有 Notion Blast Leads database 配置。");
    const body = await readJson(req);
    const id = pageId(body.id);
    const action = clean(body.action);
    if (!id) throw httpError(400, "缺少客户 Notion page id。");
    if (!action) throw httpError(400, "缺少 follow-up action。");

    const database = await followUp.notion("GET", `/databases/${followUp.blastDatabaseId}`);
    const schema = database?.properties || {};
    const properties = actionPatch(schema, action, body);
    await followUp.notion("PATCH", `/pages/${id}`, { properties });

    const refreshed = await followUp.queryNotionRows(undefined).catch(() => []);
    await followUp.writeCache(refreshed).catch(() => {});
    await followUp.systemLogs?.write({
      level: "info",
      area: "follow_up",
      event: "follow_up_action_saved",
      message: `Follow-up action saved: ${action}`,
      context: { pageId: id, action },
    }).catch(() => {});
    json(res, 200, { ok: true, action });
  });
}
