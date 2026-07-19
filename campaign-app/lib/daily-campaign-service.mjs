import fs from "node:fs/promises";
import path from "node:path";
import { trackerHeartbeatStatus } from "./tracker-reliability-service.mjs";

const ALLOWED_PROJECTS = ["Binastra", "Enlace"];
const WORK_START = "10:00";
const WORK_END = "21:00";
const WORK_START_MINUTES = 10 * 60;
const WORK_END_MINUTES = 21 * 60;
const SEND_FLOOR_SECONDS = 60;
const SAFE_DAILY_PER_SENDER = 150;
const MISSED_GRACE_DAYS = 3;
const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  mode: "TEST",
  time: WORK_START,
  projects: ALLOWED_PROJECTS,
  maxLeads: 5,
  requireDeepCheck: true,
  cadence: "24-day",
});

function cleanConfig(value = {}) {
  const hasSchedulerMode = Object.hasOwn(value, "schedulerMode");
  const requestedMode = String(hasSchedulerMode ? value.schedulerMode : value.mode || "").toUpperCase();
  let schedulerMode = "OFF";
  if (hasSchedulerMode) {
    schedulerMode = requestedMode === "LIVE" ? "LIVE" : requestedMode === "TEST" ? "TEST" : "OFF";
  } else if (value.enabled === true) {
    schedulerMode = requestedMode === "LIVE" ? "LIVE" : "TEST";
  } else if (value.enabled !== false && requestedMode === "LIVE") {
    schedulerMode = "LIVE";
  } else if (value.enabled !== false && requestedMode === "TEST") {
    schedulerMode = "TEST";
  }
  const projects = [...new Set((Array.isArray(value.projects) ? value.projects : DEFAULT_CONFIG.projects)
    .map(String)
    .filter((name) => ALLOWED_PROJECTS.includes(name)))];
  return {
    ...DEFAULT_CONFIG,
    enabled: schedulerMode !== "OFF",
    mode: schedulerMode === "LIVE" ? "LIVE" : "TEST",
    time: WORK_START,
    projects: projects.length ? projects : [...ALLOWED_PROJECTS],
    maxLeads: Math.min(5, Math.max(2, Number(value.maxLeads) || DEFAULT_CONFIG.maxLeads)),
    requireDeepCheck: value.requireDeepCheck !== false,
    cadence: "24-day",
  };
}

function klParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuala_Lumpur",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).reduce((out, part) => ({ ...out, [part.type]: part.value }), {});
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function minutesUntilLabel(minutes) {
  const safe = Math.max(0, Number(minutes) || 0);
  const hours = Math.floor(safe / 60);
  const mins = safe % 60;
  if (hours && mins) return `${hours}h ${mins}m`;
  if (hours) return `${hours}h`;
  return `${mins}m`;
}

function timeLabelFromMinutes(minutes) {
  const safe = Math.max(0, Number(minutes) || 0);
  const hour = String(Math.floor(safe / 60) % 24).padStart(2, "0");
  const minute = String(safe % 60).padStart(2, "0");
  return `${hour}:${minute}`;
}

function relativeDateLabel(today, dateKey) {
  if (!dateKey || dateKey === today) return "今天";
  if (dateKey === addDaysKL(today, 1)) return "明天";
  return dateKey;
}

function flowRank(label, sequence = []) {
  const index = sequence.findIndex((flow) => flow.label === label);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

function klDateMs(dateKey) {
  const text = String(dateKey || "").slice(0, 10);
  const ms = new Date(`${text}T00:00:00+08:00`).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function addDaysKL(dateKey, days) {
  const ms = klDateMs(dateKey);
  if (ms === null) return null;
  const next = new Date(ms + (Number(days) || 0) * 86400000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuala_Lumpur",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(next);
}

function dueAgeDays(lead, today) {
  const due = lead.nextDueDate || lead.followUpDue || lead.dueDate || "";
  if (!due) return 0;
  const todayMs = klDateMs(today);
  const dueMs = klDateMs(due);
  if (todayMs === null || dueMs === null) return 0;
  return Math.floor((todayMs - dueMs) / 86400000);
}

function hasReply(lead) {
  return Boolean(lead.lastReply || lead.lastReplyText || lead.lastReplyAt || Number(lead.replyCount || 0) > 0);
}

function isStopped(lead) {
  const status = String(lead.status || lead.sequenceStatus || "").toLowerCase();
  return lead.stopFlag === true || /stop|not interested|do not contact|appointment|invalid/.test(status);
}

function isAutomaticFlow(label) {
  return Boolean(label) && label !== "Completed";
}

function isScheduledFlow(label, sequence = []) {
  return isAutomaticFlow(label) && flowRank(label, sequence) !== Number.MAX_SAFE_INTEGER;
}

function normalizePhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("60")) return digits;
  if (digits.startsWith("0")) return `60${digits.slice(1)}`;
  return digits;
}

function firstFlow(flowSequence = []) {
  return Array.isArray(flowSequence) && flowSequence.length
    ? flowSequence[0]
    : { key: "flow_1", label: "Flow 1 - Project Template", next: null, dueDays: null, cohortDay: "Day 0" };
}

function flowByLabel(flowSequence = [], label) {
  return (Array.isArray(flowSequence) ? flowSequence : []).find((flow) => flow.label === label) || null;
}

function flowByKey(flowSequence = [], key) {
  return (Array.isArray(flowSequence) ? flowSequence : []).find((flow) => flow.key === key) || null;
}

function dueSort(a, b, config, flowSequence) {
  const projectRank = new Map(config.projects.map((name, index) => [name, index]));
  return (b.dueAgeDays || 0) - (a.dueAgeDays || 0)
    || flowRank(a.nextFlow, flowSequence) - flowRank(b.nextFlow, flowSequence)
    || (projectRank.get(a.project) ?? 999) - (projectRank.get(b.project) ?? 999)
    || String(a.lastBlastAt || "").localeCompare(String(b.lastBlastAt || ""))
    || String(a.phone || "").localeCompare(String(b.phone || ""));
}

function isoAtKL(dateKey, minutes) {
  const hour = String(Math.floor(minutes / 60)).padStart(2, "0");
  const minute = String(minutes % 60).padStart(2, "0");
  return new Date(`${dateKey}T${hour}:${minute}:00+08:00`).toISOString();
}

function shiftPlanningWindow(shift) {
  if (!shift || shift.mode === "OFF" || shift.stoppedToday) return { startMinutes: WORK_START_MINUTES, remainingMinutes: 0 };
  const startMinutes = Math.max(WORK_START_MINUTES, Math.min(shift.minutes ?? WORK_START_MINUTES, WORK_END_MINUTES));
  const remainingMinutes = Math.max(0, WORK_END_MINUTES - startMinutes);
  return { startMinutes, remainingMinutes };
}

function capacityFor({ mode, shift, instances = [], testRecipients = [] } = {}) {
  const { remainingMinutes } = shiftPlanningWindow(shift);
  const senderCount = Math.max(1, Array.isArray(instances) ? instances.length : 0);
  const timeCapacityPerSender = Math.floor((remainingMinutes * 60) / SEND_FLOOR_SECONDS);
  const safeCapacityPerSender = Math.min(timeCapacityPerSender, SAFE_DAILY_PER_SENDER);
  const liveCapacity = safeCapacityPerSender * senderCount;
  const testCapacity = Math.min(Math.max(0, testRecipients.length), liveCapacity || testRecipients.length);
  return {
    senderCount,
    sendFloorSeconds: SEND_FLOOR_SECONDS,
    safeDailyPerSender: SAFE_DAILY_PER_SENDER,
    timeCapacityPerSender,
    safeCapacityPerSender,
    total: mode === "TEST" ? testCapacity : liveCapacity,
  };
}

function scheduleSlots({ count, shift, random = Math.random } = {}) {
  const safeCount = Math.max(0, Number(count) || 0);
  if (!safeCount || !shift?.today) return [];
  const { startMinutes, remainingMinutes } = shiftPlanningWindow(shift);
  const windowSeconds = Math.max(0, remainingMinutes * 60);
  const averageSeconds = safeCount > 0 ? windowSeconds / safeCount : 0;
  const jitterSeconds = Math.min(Math.max(0, averageSeconds * 0.3), 180);
  const slots = [];
  let cursorSeconds = startMinutes * 60;
  for (let index = 0; index < safeCount; index += 1) {
    const minutes = Math.min(WORK_END_MINUTES, Math.floor(cursorSeconds / 60));
    slots.push(isoAtKL(shift.today, minutes));
    const jitter = ((random() * 2) - 1) * (jitterSeconds / 2);
    cursorSeconds += Math.max(SEND_FLOOR_SECONDS, averageSeconds + jitter);
  }
  return slots;
}

function workPreview({ mode, shift, batch, automationPlan, instances = [] } = {}) {
  const employees = (Array.isArray(instances) ? instances : []).map((item, index) => ({
    name: String(item.name || `员工 ${index + 1}`),
    phone: String(item.number || item.owner || ""),
  }));
  const planned = Number(automationPlan?.plannedCount || batch?.leads?.length || 0);
  const senderCount = Math.max(1, employees.length);
  const isWorkingNow = shift?.status === "on-shift";
  const startDate = isWorkingNow ? shift.today : shift?.nextStartDate || shift?.today;
  const startMinutes = isWorkingNow
    ? Math.max(WORK_START_MINUTES, Math.min(Number(shift?.minutes || WORK_START_MINUTES), WORK_END_MINUTES))
    : WORK_START_MINUTES;
  const sendMinutes = planned > 0 ? Math.ceil((planned * SEND_FLOOR_SECONDS) / 60 / senderCount) : 0;
  const finishMinutes = Math.min(WORK_END_MINUTES, startMinutes + sendMinutes);
  const overflow = startMinutes + sendMinutes > WORK_END_MINUTES;
  const dayLabel = relativeDateLabel(shift?.today, startDate);
  const startTime = timeLabelFromMinutes(startMinutes);
  const finishTime = planned > 0 ? timeLabelFromMinutes(finishMinutes) : "-";
  const primaryEmployee = employees[0] || null;
  return {
    mode,
    status: mode === "OFF" ? "off" : isWorkingNow ? "working" : "queued",
    title: mode === "OFF" ? "未开工" : isWorkingNow ? "正在做工" : `${dayLabel}开工`,
    employeeLabel: employees.length > 1
      ? `${employees[0].name} +${employees.length - 1}`
      : primaryEmployee?.name || "没有员工在线",
    primaryEmployee,
    employees,
    senderCount: employees.length,
    startDate,
    startLabel: mode === "OFF" ? "-" : `${dayLabel} ${startTime}`,
    finishLabel: planned > 0 ? `${dayLabel} ${finishTime}` : "-",
    offAtLabel: `${dayLabel} ${WORK_END}`,
    sendCount: planned,
    project: batch?.project || "",
    flow: batch?.flow || "",
    totalDue: Number(batch?.totalDue || planned || 0),
    overflow,
    detail: batch
      ? `${batch.project} · ${batch.flow}`
      : "没有到期 Flow。",
  };
}

function groupFirstBatch(leads, limit, config, flowSequence) {
  const groups = new Map();
  for (const lead of leads) {
    const key = `${lead.project}\u0000${lead.nextFlow}`;
    if (!groups.has(key)) groups.set(key, { project: lead.project, flow: lead.nextFlow, leads: [] });
    groups.get(key).leads.push(lead);
  }
  const projectRank = new Map(config.projects.map((name, index) => [name, index]));
  const ordered = [...groups.values()].sort((a, b) =>
    flowRank(a.flow, flowSequence) - flowRank(b.flow, flowSequence)
      || (projectRank.get(a.project) ?? 999) - (projectRank.get(b.project) ?? 999)
      || b.leads.length - a.leads.length);
  const batch = ordered[0] || null;
  if (!batch) return null;
  return { ...batch, totalDue: batch.leads.length, leads: batch.leads.slice(0, limit) };
}

export function buildAutomationPlan({
  leads = [],
  config,
  flowSequence = [],
  mode = "OFF",
  shift,
  instances = [],
  testRecipients = [],
  random = Math.random,
} = {}) {
  const today = shift?.today || klParts().date;
  const eligible = (Array.isArray(leads) ? leads : [])
    .filter((lead) => config.projects.includes(lead.project))
    .filter((lead) => isScheduledFlow(lead.nextFlow, flowSequence))
    .filter((lead) => !hasReply(lead) && !isStopped(lead))
    .map((lead) => ({ ...lead, dueAgeDays: dueAgeDays(lead, today) }))
    .filter((lead) => lead.dueAgeDays >= 0 && lead.dueAgeDays <= MISSED_GRACE_DAYS)
    .sort((a, b) => dueSort(a, b, config, flowSequence));
  const expired = (Array.isArray(leads) ? leads : [])
    .filter((lead) => config.projects.includes(lead.project))
    .filter((lead) => isScheduledFlow(lead.nextFlow, flowSequence))
    .map((lead) => ({ ...lead, dueAgeDays: dueAgeDays(lead, today) }))
    .filter((lead) => lead.dueAgeDays > MISSED_GRACE_DAYS).length;
  const capacity = capacityFor({ mode, shift, instances, testRecipients });
  const limit = Math.min(capacity.total, Math.max(0, Number(config.maxLeads) || capacity.total));
  const batch = groupFirstBatch(eligible, limit, config, flowSequence);
  const plannedCount = batch?.leads?.length || 0;
  const slots = scheduleSlots({ count: mode === "TEST" ? Math.min(testRecipients.length, plannedCount || testRecipients.length) : plannedCount, shift, random });
  return {
    mode,
    today,
    capacity,
    eligibleCount: eligible.length,
    expiredCount: expired,
    plannedCount,
    deferredCount: Math.max(0, eligible.length - plannedCount),
    batch,
    slots,
    nextAt: slots[0] || null,
    floorSeconds: SEND_FLOOR_SECONDS,
    graceDays: MISSED_GRACE_DAYS,
  };
}

export function selectDailyBatch(leads, config, flowSequence = []) {
  const shift = { mode: "TEST", today: klParts().date, minutes: WORK_START_MINUTES, stoppedToday: false };
  return buildAutomationPlan({
    leads,
    config,
    flowSequence,
    mode: "TEST",
    shift,
    instances: [{ name: "local" }],
    testRecipients: Array.from({ length: config.maxLeads || DEFAULT_CONFIG.maxLeads }, (_, index) => ({ name: `test_${index + 1}` })),
    random: () => 0.5,
  }).batch;
}

function gate(key, ok, label, detail) {
  return { key, ok: ok === true, label, detail: String(detail || "") };
}

export function createDailyCampaignService({
  rootDir,
  flowSequence = [],
  replyServices,
  openInstances,
  getRunner,
  queue,
  fetchDuePlan,
  executeTest,
  getTestLeads,
  systemLogs,
  postOps,
  clock = () => new Date(),
  fsImpl = fs,
} = {}) {
  const configPath = path.join(rootDir, "campaign-data", "daily-campaign.json");
  const testCohortPath = path.join(rootDir, "campaign-data", "daily-test-cohort.json");
  const trackerPath = path.join(rootDir, "campaign-data", "tracker", "heartbeat.json");
  let config = { ...DEFAULT_CONFIG, projects: [...ALLOWED_PROJECTS] };
  let state = { lastAttemptDate: null, stoppedDate: null, lastRun: null, lastCheck: null };
  let timer = null;
  let running = false;

  const ready = (async () => {
    try {
      const saved = JSON.parse(await fsImpl.readFile(configPath, "utf8"));
      config = cleanConfig(saved?.config || saved);
      state = { ...state, ...(saved?.state || {}) };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  })();

  async function persist() {
    await ready;
    await fsImpl.mkdir(path.dirname(configPath), { recursive: true });
    const temp = `${configPath}.tmp.${process.pid}.${Date.now()}`;
    await fsImpl.writeFile(temp, `${JSON.stringify({ version: 1, config, state, updatedAt: clock().toISOString() }, null, 2)}\n`);
    await fsImpl.rename(temp, configPath);
  }

  async function readTestCohort() {
    await ready;
    try {
      const saved = JSON.parse(await fsImpl.readFile(testCohortPath, "utf8"));
      return Array.isArray(saved?.recipients) ? saved : { version: 1, recipients: [] };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      return { version: 1, recipients: [] };
    }
  }

  async function writeTestCohort(recipients) {
    await fsImpl.mkdir(path.dirname(testCohortPath), { recursive: true });
    const temp = `${testCohortPath}.tmp.${process.pid}.${Date.now()}`;
    const payload = { version: 1, recipients, updatedAt: clock().toISOString() };
    await fsImpl.writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`);
    await fsImpl.rename(temp, testCohortPath);
    return payload;
  }

  async function syncTestCohort(today) {
    const recipients = testRecipients();
    const saved = await readTestCohort();
    const savedByPhone = new Map((saved.recipients || []).map((item) => [normalizePhone(item.phone), item]));
    const first = firstFlow(flowSequence);
    const project = config.projects[0] || ALLOWED_PROJECTS[0];
    const nextRecipients = recipients
      .map((recipient) => {
        const phone = normalizePhone(recipient.phone);
        if (!phone) return null;
        const existing = savedByPhone.get(phone);
        if (existing) {
          return {
            ...existing,
            id: existing.id || `test_${phone}`,
            name: recipient.name,
            phone,
            language: recipient.language || existing.language || "en",
            project: existing.project || project,
            status: existing.status || "active",
            nextFlow: existing.nextFlow || first.label,
            nextDueDate: existing.nextDueDate || today,
          };
        }
        return {
          id: `test_${phone}`,
          name: recipient.name,
          phone,
          language: recipient.language || "en",
          project,
          status: "active",
          currentFlow: null,
          nextFlow: first.label,
          nextDueDate: today,
          createdAt: clock().toISOString(),
        };
      })
      .filter(Boolean);
    const changed = JSON.stringify(nextRecipients) !== JSON.stringify(saved.recipients || []);
    if (changed) await writeTestCohort(nextRecipients);
    return nextRecipients;
  }

  function testCohortLeads(cohort = []) {
    return (Array.isArray(cohort) ? cohort : []).map((item) => ({
      id: item.id,
      name: item.name,
      phone: item.phone,
      language: item.language || "en",
      project: item.project || config.projects[0] || ALLOWED_PROJECTS[0],
      status: item.status || "active",
      sequenceStatus: item.sequenceStatus || "",
      nextFlow: item.nextFlow,
      nextDueDate: item.nextDueDate,
      currentFlow: item.currentFlow || null,
      isTestLead: true,
    }));
  }

  async function advanceTestCohort(sentLeads = [], today = klParts(clock()).date) {
    const sentPhones = new Set((Array.isArray(sentLeads) ? sentLeads : []).map((lead) => normalizePhone(lead.phone)).filter(Boolean));
    if (!sentPhones.size) return null;
    const saved = await readTestCohort();
    const nextRecipients = (saved.recipients || []).map((item) => {
      const phone = normalizePhone(item.phone);
      if (!sentPhones.has(phone)) return item;
      const sentFlow = flowByLabel(flowSequence, item.nextFlow) || firstFlow(flowSequence);
      const nextFlow = sentFlow.next ? flowByKey(flowSequence, sentFlow.next) : null;
      const nextDueDate = nextFlow ? addDaysKL(today, sentFlow.dueDays) : null;
      return {
        ...item,
        phone,
        currentFlow: sentFlow.label,
        nextFlow: nextFlow ? nextFlow.label : "Completed",
        nextDueDate,
        status: nextFlow ? "active" : "completed",
        lastSentAt: clock().toISOString(),
        updatedAt: clock().toISOString(),
      };
    });
    return writeTestCohort(nextRecipients);
  }

  async function trackerSnapshot() {
    try {
      const data = JSON.parse(await fsImpl.readFile(trackerPath, "utf8"));
      return trackerHeartbeatStatus(data, { now: clock(), maxAgeMs: 120_000 });
    } catch {
      return trackerHeartbeatStatus(null, { now: clock(), maxAgeMs: 120_000 });
    }
  }

  function currentMode() {
    if (!config.enabled) return "OFF";
    return config.mode === "LIVE" ? "LIVE" : "TEST";
  }

  function shiftSnapshot(nowDate = clock()) {
    const now = klParts(nowDate);
    const stoppedToday = state.stoppedDate === now.date;
    const mode = currentMode();
    const open = mode !== "OFF" && !stoppedToday && now.minutes >= WORK_START_MINUTES && now.minutes <= WORK_END_MINUTES;
    const status = mode === "OFF" || stoppedToday
      ? "closed"
      : open
        ? "on-shift"
        : "off-shift";
    const nextStartDate = stoppedToday || now.minutes > WORK_END_MINUTES ? addDaysKL(now.date, 1) : now.date;
    const minutesUntilStart = stoppedToday
      ? (24 * 60) - now.minutes + WORK_START_MINUTES
      : now.minutes < WORK_START_MINUTES
      ? WORK_START_MINUTES - now.minutes
      : now.minutes > WORK_END_MINUTES
        ? (24 * 60) - now.minutes + WORK_START_MINUTES
        : 0;
    const remainingMinutes = open ? Math.max(0, WORK_END_MINUTES - now.minutes) : 0;
    return {
      status,
      mode,
      now: now.time,
      today: now.date,
      minutes: now.minutes,
      workStart: WORK_START,
      workEnd: WORK_END,
      offAt: WORK_END,
      stoppedToday,
      nextStartDate,
      nextStartTime: WORK_START,
      minutesUntilStart,
      remainingMinutes,
      remainingLabel: open
        ? minutesUntilLabel(remainingMinutes)
        : minutesUntilStart
          ? `${nextStartDate === now.date ? "今天" : "明天"} ${WORK_START}`
          : "0m",
    };
  }

  function cohortSummary(leads = []) {
    const buckets = (Array.isArray(flowSequence) ? flowSequence : []).map((flow) => ({
      key: flow.key,
      label: flow.label,
      day: flow.cohortDay || flow.label,
      count: 0,
    }));
    const byLabel = new Map(buckets.map((bucket) => [bucket.label, bucket]));
    const summary = { total: 0, buckets, completed: 0, replied: 0, stopped: 0, unknown: 0 };
    for (const lead of Array.isArray(leads) ? leads : []) {
      summary.total += 1;
      const nextFlow = String(lead.nextFlow || "").trim();
      const status = String(lead.status || lead.sequenceStatus || "").toLowerCase();
      if (lead.stopFlag || /stop|not interested|do not contact/.test(status)) {
        summary.stopped += 1;
        continue;
      }
      if (lead.lastReplyAt || lead.lastReplyText || Number(lead.replyCount || 0) > 0 || /replied|human takeover/.test(status)) {
        summary.replied += 1;
        continue;
      }
      if (!nextFlow || nextFlow === "Completed") {
        summary.completed += 1;
        continue;
      }
      const bucket = byLabel.get(nextFlow);
      if (bucket) bucket.count += 1;
      else summary.unknown += 1;
    }
    return summary;
  }

  function testRecipients() {
    return (getTestLeads?.() || []).map((lead) => ({
      name: String(lead.name || ""),
      phone: String(lead.phone || ""),
      language: String(lead.language || "en"),
    }));
  }

  function progressSummary({ automationPlan, batch, today } = {}) {
    const lastRunToday = state.lastRun?.at && klParts(new Date(state.lastRun.at)).date === today;
    const lastBatch = lastRunToday ? state.lastRun?.batch : null;
    const sent = lastRunToday && state.lastRun?.status === "STARTED_TEST"
      ? Number(lastBatch?.leads?.length || 0)
      : 0;
    const failed = lastRunToday && state.lastRun?.status === "ERROR" ? 1 : 0;
    const planned = Number(automationPlan?.plannedCount || batch?.leads?.length || 0);
    return {
      planned,
      sent,
      pending: Math.max(0, planned - sent),
      failed,
      deferred: Number(automationPlan?.deferredCount || 0),
      capacity: Number(automationPlan?.capacity?.total || 0),
      lastRun: state.lastRun || null,
    };
  }

  function repliesToHandleSummary(tracker = {}, cohort = {}) {
    const manual = Number(tracker.manualReviewNotionReplies || 0);
    const pendingNotion = Number(tracker.pendingNotionReplies || 0);
    const replied = Number(cohort.replied || 0);
    return {
      total: Math.max(manual, pendingNotion, replied),
      manual,
      pendingNotion,
      replied,
    };
  }

  async function check({ deep = false } = {}) {
    await ready;
    const gates = [];
    const runner = getRunner?.();
    const queueState = await queue?.snapshot?.().catch(() => ({ count: 0, hold: null })) || { count: 0, hold: null };
    const services = await replyServices?.status?.().catch(() => ({ tracker: false, brain: false })) || { tracker: false, brain: false };
    const tracker = await trackerSnapshot();
    let instances = [];
    let instanceError = "";
    try {
      instances = await openInstances();
    } catch (error) {
      instanceError = error.message || String(error);
    }

    let plan = null;
    let planError = "";
    try {
      plan = await fetchDuePlan({ deep: deep === true });
    } catch (error) {
      planError = error.message || String(error);
    }
    const safety = plan?.whatsappCheck || {};
    const leads = plan?.leads || [];
    const shift = shiftSnapshot();
    const recipients = testRecipients();
    const mode = currentMode();
    const testCohort = mode === "TEST" ? await syncTestCohort(shift.today) : [];
    const planningLeads = mode === "TEST" ? testCohortLeads(testCohort) : leads;
    const automationPlan = buildAutomationPlan({
      leads: planningLeads,
      config,
      flowSequence,
      mode,
      shift,
      instances,
      testRecipients: recipients,
    });
    const batch = automationPlan.batch;
    gates.push(gate("mode", mode === "TEST", mode === "OFF" ? "总开关关闭" : mode === "LIVE" ? "LIVE 安全锁" : "TEST 模式", mode === "OFF"
      ? "Campaign Automations 已关闭，不会发送。"
      : mode === "LIVE"
        ? "LIVE 入口先保留，但真实客户自动发送还未接上；目前不会发送。"
        : `只会发给 TEST 名单：${recipients.map((lead) => lead.name).join(" / ") || "尚未设置"}。`));
    gates.push(gate("shift", shift.status === "on-shift", "10:00–21:00 值班窗口", shift.stoppedToday
      ? "今天已提前放工；明天 10:00 再继续。"
      : shift.status === "on-shift"
        ? `现在 ${shift.now}，距离 21:00 还有 ${shift.remainingLabel}。`
        : `现在 ${shift.now}，窗口外一律不发送。`));
    gates.push(gate("runner", !runner?.running, "Campaign 空闲", runner?.running ? "当前仍有 Campaign 在发送。" : "没有进行中的发送。"));
    gates.push(gate("queue", Number(queueState.count || 0) === 0 && !queueState.hold, "Queue 空闲", queueState.hold?.reason || `${queueState.count || 0} 个排队任务。`));
    gates.push(gate("tracker_service", services.tracker === true, "Tracker 在线", services.tracker ? "回复监听服务在线。" : "Tracker 离线。"));
    const brainRequired = services.brainEnabled !== false;
    gates.push(gate(
      "brain_service",
      !brainRequired || services.brain === true,
      brainRequired ? "Brain 在线" : "Brain 已关闭",
      brainRequired
        ? (services.brain ? "分类与通知服务在线。" : "Brain 离线。")
        : "目前是 Tracker-only：会记录回复，但不会自动回复客户。",
    ));
    gates.push(gate("phone", instances.length > 0, "WhatsApp OPEN", instanceError || `${instances.length} 个发送号码在线。`));
    const lastReplyDetail = tracker.lastReplyAt
      ? `最后客户回复 ${tracker.lastReplyAgeMinutes} 分钟前`
      : "尚未收到客户回复";
    gates.push(gate("tracker_heartbeat", tracker.fresh, "Tracker Heartbeat", tracker.fresh
      ? `服务 ${tracker.heartbeatAgeSeconds} 秒前回报；${lastReplyDetail}。没有新回复不算故障。${tracker.pendingNotionReplies ? ` 待补写 Notion ${tracker.pendingNotionReplies} 条。` : ""}`
      : "Tracker Heartbeat 已超过 2 分钟或尚未建立。请重启 Campaign Console。"));
    if (deep) {
      gates.push(gate("reply_scan", safety.safeToSend === true, "深度回复检查", safety.safeToSend
        ? `深度检查通过，来源 ${safety.scanSource || "Evolution"}。`
        : "深度检查未通过；不会启动自动 TEST。"));
    }
    gates.push(gate("notion", Boolean(plan) && !planError, "Notion 名单可读", planError || `找到 ${plan?.leads?.length || 0} 位到期客户。`));
    gates.push(gate("batch", Boolean(batch), "当天批次", batch
      ? `${batch.project} · ${batch.flow} · 取 ${batch.leads.length}/${batch.totalDue} 人。`
      : "Binastra / Enlace 今天没有可发送的自动 Flow。"));

    const result = {
      ok: true,
      ready: gates.every((item) => item.ok),
      checkedAt: clock().toISOString(),
      deep: deep === true,
      config,
      schedulerMode: mode,
      shift,
      gates,
      services,
      tracker,
      instances: instances.map((item) => ({ name: item.name, number: item.number || item.owner || "" })),
      queue: queueState,
      batch,
      automationPlan,
      cohort: cohortSummary(planningLeads),
      liveCohort: mode === "TEST" ? cohortSummary(leads) : null,
      testCohort,
      testRecipients: recipients,
      progress: progressSummary({ automationPlan, batch, today: shift.today }),
      workPreview: workPreview({ mode, shift, batch, automationPlan, instances }),
      repliesToHandle: repliesToHandleSummary(tracker, cohortSummary(planningLeads)),
      source: plan?.whatsappCheck?.scanSource || (deep ? "evolution-deep" : "tracker"),
    };
    state.lastCheck = result;
    await persist();
    return result;
  }

  async function notify(text) {
    if (!postOps) return;
    await postOps(text).catch(() => {});
  }

  async function runTest({ scheduled = false } = {}) {
    await ready;
    if (running) throw new Error("Next Campaign TEST 已在准备中。请不要重复点击。");
    running = true;
    const today = klParts(clock()).date;
    try {
      const readiness = await check({ deep: config.requireDeepCheck });
      if (!readiness.ready) {
        const reasons = readiness.gates.filter((item) => !item.ok).map((item) => item.detail || item.label);
        state.lastAttemptDate = scheduled ? today : state.lastAttemptDate;
        state.lastRun = { at: clock().toISOString(), status: "HOLD", scheduled, reasons };
        await persist();
        await systemLogs?.write({ level: "warn", area: "daily-campaign", event: "launch_held", message: "Daily TEST launch was held by safety gates.", context: { reasons } }).catch(() => {});
        await notify(`⏸ <b>Next Campaign TEST HOLD</b>\n${reasons.join("\n")}`);
        return { ok: false, status: "HOLD", readiness, reasons };
      }
      const result = await executeTest({ batch: readiness.batch, plan: readiness.automationPlan, instances: readiness.instances, maxLeads: config.maxLeads });
      await advanceTestCohort(readiness.batch?.leads || [], today);
      state.lastAttemptDate = scheduled ? today : state.lastAttemptDate;
      state.lastRun = { at: clock().toISOString(), status: "STARTED_TEST", scheduled, batch: readiness.batch, result };
      await persist();
      await systemLogs?.write({ level: "info", area: "daily-campaign", event: "test_started", message: "Daily Next Campaign TEST started.", context: { project: readiness.batch.project, flow: readiness.batch.flow, due: readiness.batch.totalDue } }).catch(() => {});
      await notify(`🧪 <b>Campaign Automations TEST 已启动</b>\n项目: ${readiness.batch.project}\nFlow: ${readiness.batch.flow}\n计划: ${readiness.automationPlan?.plannedCount || readiness.batch.leads.length}\n顺延: ${readiness.automationPlan?.deferredCount || 0}`);
      return { ok: true, status: "STARTED_TEST", readiness, result };
    } catch (error) {
      state.lastAttemptDate = scheduled ? today : state.lastAttemptDate;
      state.lastRun = { at: clock().toISOString(), status: "ERROR", scheduled, error: error.message || String(error) };
      await persist().catch(() => {});
      await systemLogs?.write({ level: "error", area: "daily-campaign", event: "test_failed", message: "Daily Next Campaign TEST failed.", context: { error: error.message || String(error) } }).catch(() => {});
      await notify(`❌ <b>Next Campaign TEST 失败</b>\n${error.message || String(error)}`);
      throw error;
    } finally {
      running = false;
    }
  }

  async function tick() {
    await ready;
    if (!config.enabled || config.mode !== "TEST" || running) return;
    const now = klParts(clock());
    if (state.stoppedDate === now.date) return;
    const scheduledMinutes = Number(config.time.slice(0, 2)) * 60 + Number(config.time.slice(3));
    if (now.minutes < scheduledMinutes || now.minutes > scheduledMinutes + 15) return;
    if (state.lastAttemptDate === now.date) return;
    await runTest({ scheduled: true }).catch(() => {});
  }

  function start(intervalMs = 30000) {
    if (timer) return timer;
    timer = setInterval(() => tick().catch(() => {}), intervalMs);
    timer.unref?.();
    tick().catch(() => {});
    return timer;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  async function update(next) {
    await ready;
    config = cleanConfig({ ...config, ...(next || {}) });
    if (config.enabled) state.stoppedDate = null;
    await persist();
    return snapshot();
  }

  async function stopForToday() {
    await ready;
    const today = klParts(clock()).date;
    state.stoppedDate = today;
    state.lastRun = { at: clock().toISOString(), status: "SHIFT_STOPPED", scheduled: false, reasons: ["今天已提前放工；自动任务顺延到明天。"] };
    await persist();
    await systemLogs?.write({ level: "info", area: "daily-campaign", event: "shift_stopped", message: "Campaign Automations shift stopped for today.", context: { date: today } }).catch(() => {});
    await notify(`⏹ <b>Campaign Automations 已提前放工</b>\n今天不会继续自动发送，明天 10:00 再检查。`);
    return snapshot();
  }

  function cadenceSummary() {
    const flows = Array.isArray(flowSequence) ? flowSequence : [];
    const days = flows.map((flow) => flow.cohortDay).filter(Boolean);
    const lastDay = days.length ? Number(String(days[days.length - 1]).replace(/[^0-9]/g, "")) : 0;
    return {
      flowCount: flows.length,
      totalDays: Number.isFinite(lastDay) ? lastDay : 0,
      days,
      labels: flows.map((flow) => flow.label),
    };
  }

  async function snapshot() {
    await ready;
    const shift = shiftSnapshot();
    const mode = currentMode();
    const testCohort = mode === "TEST" ? await syncTestCohort(shift.today) : [];
    return { ok: true, config, schedulerMode: mode, shift, state, running, allowedProjects: ALLOWED_PROJECTS, cadence: cadenceSummary(), testRecipients: testRecipients(), testCohort };
  }

  return { ready, start, stop, tick, check, runTest, update, stopForToday, snapshot, configPath };
}
