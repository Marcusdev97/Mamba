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

function dateValue(value) {
  const cleanValue = clean(value);
  if (!cleanValue) return { date: null };
  const parsed = new Date(cleanValue);
  if (Number.isNaN(parsed.getTime())) throw httpError(400, `日期时间格式不对: ${cleanValue}`);
  return { date: { start: parsed.toISOString() } };
}

function choiceValue(schema, name, option) {
  const type = schema?.[name]?.type;
  if (!option) return type === "status" ? { status: null } : { select: null };
  return type === "status" ? { status: { name: option } } : { select: { name: option } };
}

function textOrChoiceValue(schema, name, value) {
  const type = schema?.[name]?.type;
  if (type === "select" || type === "status") return choiceValue(schema, name, clean(value));
  return richText(value);
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

const APPOINTMENT_STAGES = ["Viewing Interest", "Slot Offered", "Pending", "Confirmed", "Attended", "No Show", "Cancelled"];
const ACTIVE_APPOINTMENT_STAGES = new Set(["Viewing Interest", "Slot Offered", "Pending", "Confirmed"]);

export function appointmentStageFor(record) {
  const explicit = clean(record.appointmentStatus);
  const matched = APPOINTMENT_STAGES.find((stage) => stage.toLowerCase() === explicit.toLowerCase());
  if (matched) return matched;
  const values = [record.nextAction, record.status, record.aiCategory].join(" ").toLowerCase();
  if (/appointment|book|showroom|viewing/.test(values)) return "Viewing Interest";
  return "";
}

function isAppointment(record) {
  return ACTIVE_APPOINTMENT_STAGES.has(appointmentStageFor(record)) && !isStop(record);
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
  const appointmentStage = appointmentStageFor(record);
  return {
    ...record,
    priority,
    appointmentStage,
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
  const pipeline = Object.fromEntries(APPOINTMENT_STAGES.map((stage) => [stage, 0]));
  for (const record of records) {
    if (record.appointmentStage) pipeline[record.appointmentStage] += 1;
  }
  return {
    total: records.length,
    today: records.filter((record) => record.bucket === "today").length,
    overdue: records.filter((record) => record.bucket === "overdue").length,
    hot: records.filter((record) => record.bucket === "hot").length,
    appointment: records.filter((record) => record.appointmentStage === "Confirmed").length,
    stop: records.filter((record) => record.bucket === "stop").length,
    appointmentPipeline: pipeline,
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
  const appointmentStage = clean(filters.appointmentStage);
  return records.filter((record) => {
    if (bucket && record.bucket !== bucket) return false;
    if (project && record.project !== project) return false;
    if (appointmentStage && record.appointmentStage !== appointmentStage) return false;
    if (q) {
      const haystack = [record.name, record.phone, record.project, record.reason, record.nextAction, record.lastReplyText].join(" ").toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

const APPOINTMENT_SCHEMA = {
  "Follow Up At": { date: {} },
  "Priority": { select: { options: [{ name: "HIGH", color: "red" }, { name: "MED", color: "yellow" }, { name: "LOW", color: "gray" }] } },
  "Appointment Date": { date: {} },
  "Appointment Time": { rich_text: {} },
  "Appointment Place": { rich_text: {} },
  "Appointment Status": { select: { options: APPOINTMENT_STAGES.map((name) => ({ name })) } },
  "Assigned Sales": { rich_text: {} },
  "Sales Notes": { rich_text: {} },
};

const APPOINTMENT_SCHEMA_TYPES = {
  "Follow Up At": ["date"],
  "Priority": ["select", "status"],
  "Appointment Date": ["date"],
  "Appointment Time": ["rich_text"],
  "Appointment Place": ["rich_text"],
  "Appointment Status": ["select", "status"],
  "Assigned Sales": ["rich_text", "select", "status"],
  "Sales Notes": ["rich_text"],
};

async function ensureAppointmentSchema(followUp, database) {
  const schema = database?.properties || {};
  const wrong = Object.entries(APPOINTMENT_SCHEMA)
    .filter(([name]) => schema[name] && !APPOINTMENT_SCHEMA_TYPES[name].includes(schema[name].type))
    .map(([name]) => name);
  if (wrong.length) throw httpError(400, `Notion Appointment 字段类型不对: ${wrong.join(", ")}。请先在 Conversations 检查 Schema Health。`);
  const missing = Object.fromEntries(Object.entries(APPOINTMENT_SCHEMA).filter(([name]) => !schema[name]));
  if (!Object.keys(missing).length) return database;
  await followUp.notion("PATCH", `/databases/${followUp.blastDatabaseId}`, { properties: missing });
  return followUp.notion("GET", `/databases/${followUp.blastDatabaseId}`);
}

export function actionPatch(schema, action, body) {
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
    if (schema?.["Appointment Status"]) props["Appointment Status"] = choiceValue(schema, "Appointment Status", "Viewing Interest");
    props["AI Summary"] = richText(note || `Follow-up desk: appointment follow-up. Updated ${now}`);
  } else if (action === "save_appointment") {
    const stage = clean(body.appointmentStatus);
    if (!APPOINTMENT_STAGES.includes(stage)) throw httpError(400, "请选择正确的 Appointment Stage。");
    if (["Pending", "Confirmed", "Attended"].includes(stage) && !clean(body.appointmentDate)) {
      throw httpError(400, `${stage} 必须填写 Appointment Date。`);
    }
    props["Appointment Status"] = choiceValue(schema, "Appointment Status", stage);
    if (clean(body.appointmentDate)) props["Appointment Date"] = dateValue(`${clean(body.appointmentDate)}T00:00:00+08:00`);
    if (body.appointmentTime !== undefined) props["Appointment Time"] = richText(body.appointmentTime);
    if (body.appointmentPlace !== undefined) props["Appointment Place"] = richText(body.appointmentPlace);
    if (body.assignedSales !== undefined) props["Assigned Sales"] = textOrChoiceValue(schema, "Assigned Sales", body.assignedSales);
    if (body.note !== undefined) props["Sales Notes"] = richText(body.note);
    if (body.followUpAt) props["Follow Up At"] = dateValue(body.followUpAt);
    props.Priority = choiceValue(schema, "Priority", ["Viewing Interest", "Slot Offered", "Pending", "Confirmed"].includes(stage) ? "HIGH" : "MED");
    props.Status = choiceValue(schema, "Status", stage === "Cancelled" ? "Follow Up" : "Appointment");
    const nextAction = stage === "Confirmed" ? "Appointment Confirmed"
      : stage === "Attended" ? "Done"
        : ["No Show", "Cancelled"].includes(stage) ? "Follow Up"
          : "Book Appointment";
    props["Next Action"] = choiceValue(schema, "Next Action", nextAction);
    if (schema?.["Sequence Status"]) props["Sequence Status"] = choiceValue(schema, "Sequence Status", "Human Takeover");
    props["AI Summary"] = richText(note || `Appointment pipeline: ${stage}. Updated ${now}`);
  } else if (action === "follow_up") {
    if (!clean(body.followUpAt)) throw httpError(400, "Follow Up 必须选择下一次跟进日期与时间。");
    props["Next Action"] = choiceValue(schema, "Next Action", "Follow Up");
    props.Status = choiceValue(schema, "Status", "Follow Up");
    if (schema?.["Follow Up At"]) props["Follow Up At"] = dateValue(body.followUpAt);
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
      appointmentStage: url.searchParams.get("appointmentStage") || "",
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

    let database = await followUp.notion("GET", `/databases/${followUp.blastDatabaseId}`);
    if (["book_appointment", "save_appointment", "follow_up"].includes(action)) {
      database = await ensureAppointmentSchema(followUp, database);
    }
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
