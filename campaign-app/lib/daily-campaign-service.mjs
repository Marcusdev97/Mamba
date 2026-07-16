import fs from "node:fs/promises";
import path from "node:path";
import { trackerHeartbeatStatus } from "./tracker-reliability-service.mjs";

const ALLOWED_PROJECTS = ["Binastra", "Enlace"];
const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  mode: "TEST",
  time: "10:00",
  projects: ALLOWED_PROJECTS,
  maxLeads: 5,
  requireDeepCheck: true,
  cadence: "18-day",
  includeConditionalFlows: false,
});

function cleanTime(value) {
  const text = String(value || "").trim();
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(text) ? text : DEFAULT_CONFIG.time;
}

function cleanConfig(value = {}) {
  const projects = [...new Set((Array.isArray(value.projects) ? value.projects : DEFAULT_CONFIG.projects)
    .map(String)
    .filter((name) => ALLOWED_PROJECTS.includes(name)))];
  return {
    ...DEFAULT_CONFIG,
    enabled: value.enabled === true,
    mode: "TEST",
    time: cleanTime(value.time),
    projects: projects.length ? projects : [...ALLOWED_PROJECTS],
    maxLeads: Math.min(5, Math.max(2, Number(value.maxLeads) || DEFAULT_CONFIG.maxLeads)),
    requireDeepCheck: value.requireDeepCheck !== false,
    cadence: "18-day",
    includeConditionalFlows: false,
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

function flowRank(label, sequence = []) {
  const index = sequence.findIndex((flow) => flow.label === label);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

export function selectDailyBatch(leads, config, flowSequence = []) {
  const groups = new Map();
  for (const lead of Array.isArray(leads) ? leads : []) {
    if (!config.projects.includes(lead.project)) continue;
    if (!lead.nextFlow || ["Flow 5 - Furnished List", "Flow 9 - Rental"].includes(lead.nextFlow)) continue;
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
  return { ...batch, totalDue: batch.leads.length, leads: batch.leads.slice(0, config.maxLeads) };
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
  systemLogs,
  postOps,
  clock = () => new Date(),
  fsImpl = fs,
} = {}) {
  const configPath = path.join(rootDir, "campaign-data", "daily-campaign.json");
  const trackerPath = path.join(rootDir, "campaign-data", "tracker", "heartbeat.json");
  let config = { ...DEFAULT_CONFIG, projects: [...ALLOWED_PROJECTS] };
  let state = { lastAttemptDate: null, lastRun: null, lastCheck: null };
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

  async function trackerSnapshot() {
    try {
      const data = JSON.parse(await fsImpl.readFile(trackerPath, "utf8"));
      return trackerHeartbeatStatus(data, { now: clock(), maxAgeMs: 120_000 });
    } catch {
      return trackerHeartbeatStatus(null, { now: clock(), maxAgeMs: 120_000 });
    }
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
    const batch = selectDailyBatch(plan?.leads || [], config, flowSequence);

    gates.push(gate("mode", config.mode === "TEST", "TEST-only", "自动任务目前禁止 LIVE。"));
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
      gates,
      services,
      tracker,
      instances: instances.map((item) => ({ name: item.name, number: item.number || item.owner || "" })),
      queue: queueState,
      batch,
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
      const result = await executeTest({ batch: readiness.batch, instances: readiness.instances, maxLeads: config.maxLeads });
      state.lastAttemptDate = scheduled ? today : state.lastAttemptDate;
      state.lastRun = { at: clock().toISOString(), status: "STARTED_TEST", scheduled, batch: readiness.batch, result };
      await persist();
      await systemLogs?.write({ level: "info", area: "daily-campaign", event: "test_started", message: "Daily Next Campaign TEST started.", context: { project: readiness.batch.project, flow: readiness.batch.flow, due: readiness.batch.totalDue } }).catch(() => {});
      await notify(`🧪 <b>Next Campaign TEST 已启动</b>\n项目: ${readiness.batch.project}\nFlow: ${readiness.batch.flow}\n到期: ${readiness.batch.totalDue}\n测试上限: ${config.maxLeads}`);
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
    await persist();
    return snapshot();
  }

  async function snapshot() {
    await ready;
    return { ok: true, config, state, running, allowedProjects: ALLOWED_PROJECTS };
  }

  return { ready, start, stop, tick, check, runTest, update, snapshot, configPath };
}
