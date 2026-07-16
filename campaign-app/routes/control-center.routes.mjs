import fs from "node:fs/promises";
import path from "node:path";
import { json } from "../lib/http.mjs";
import { listProjects } from "../knowledge_layer.mjs";

function dateKeyKL(value) {
  if (!value) return "";
  return new Date(value).toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" });
}

function dateMs(value) {
  const ms = new Date(value || 0).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function isStopped(record) {
  return record.stopFlag || ["Stop", "Not Interested", "Do Not Contact"].includes(record.status);
}

function hasReply(record) {
  return Boolean(record.lastReplyAt || record.lastReplyText || Number(record.replyCount || 0) > 0);
}

function appointmentStage(record) {
  const explicit = String(record.appointmentStatus || "").trim();
  if (explicit) return explicit;
  const values = [record.nextAction, record.status, record.aiCategory].join(" ").toLowerCase();
  return /appointment|book|showroom|viewing/.test(values) ? "Viewing Interest" : "";
}

function isDoneAction(value) {
  return ["", "-", "none", "done", "stop"].includes(String(value || "").trim().toLowerCase());
}

export function summarizeRecords(records, today) {
  const activeAppointments = new Set(["Viewing Interest", "Slot Offered", "Pending", "Confirmed"]);
  const todaySent = records.filter((record) => dateKeyKL(record.lastBlastAt || record.firstBlastAt) === today).length;
  const todayReplies = records.filter((record) => record.lastReplyAt && dateKeyKL(record.lastReplyAt) === today).length;
  const overdue = records.filter((record) => !isStopped(record) && record.followUpAt && dateKeyKL(record.followUpAt) < today).length;
  const dueToday = records.filter((record) => !isStopped(record) && record.followUpAt && dateKeyKL(record.followUpAt) === today).length;
  const appointments = records.filter((record) => !isStopped(record) && activeAppointments.has(appointmentStage(record))).length;
  const followUps = records.filter((record) => !isStopped(record) && (hasReply(record) || !isDoneAction(record.nextAction) || record.followUpAt)).length;
  return { totalCustomers: records.length, todaySent, todayReplies, overdue, dueToday, appointments, followUps };
}

export function recentActivity(records, limit = 8) {
  return records
    .map((record) => {
      const replyAt = dateMs(record.lastReplyAt);
      const blastAt = dateMs(record.lastBlastAt || record.firstBlastAt);
      const appointmentAt = dateMs(record.appointmentDate);
      const at = Math.max(replyAt, blastAt, appointmentAt);
      let type = "blast";
      let detail = record.lastFlowSent || "Campaign sent";
      if (appointmentAt && appointmentAt === at) {
        type = "appointment";
        detail = `${appointmentStage(record) || "Appointment"}${record.appointmentPlace ? ` · ${record.appointmentPlace}` : ""}`;
      } else if (replyAt && replyAt === at) {
        type = isStopped(record) ? "stop" : "reply";
        detail = record.lastReplyText || record.aiCategory || "Customer replied";
      }
      return {
        id: record.id,
        name: record.name || record.phone || "Unknown customer",
        phone: record.phone || "",
        project: record.project || "",
        type,
        detail: String(detail || "").slice(0, 180),
        status: record.status || record.aiCategory || "",
        at: at ? new Date(at).toISOString() : null,
      };
    })
    .filter((item) => item.at)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, limit);
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch { return fallback; }
}

export function campaignSummary(snapshot) {
  const state = snapshot?.state;
  if (!state) return null;
  const assignments = Array.isArray(state.assignments) ? state.assignments : [];
  const sent = assignments.filter((job) => job.status === "SENT").length;
  const failed = assignments.filter((job) => job.status === "FAILED").length;
  const skipped = assignments.filter((job) => /^SKIPPED|PART1_ONLY/.test(job.status || "")).length;
  return {
    runId: state.runId || "",
    project: state.project || state.campaignId || "Campaign",
    status: state.status || (snapshot.running ? "RUNNING" : "READY"),
    mode: state.mode || "",
    total: assignments.length,
    sent,
    failed,
    skipped,
    running: snapshot.running === true,
    stopped: snapshot.stopped === true,
    updatedAt: state.updatedAt || state.createdAt || null,
    instances: (state.instances || []).map((item) => item.name || item).filter(Boolean),
  };
}

async function whatsappHealth(runtime) {
  if (!runtime.whatsapp?.listInstances) return { ok: false, label: "Service unavailable", open: 0, total: 0 };
  try {
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2500));
    const instances = await Promise.race([runtime.whatsapp.listInstances(), timeout]);
    const open = instances.filter((item) => String(item.status || "").toUpperCase() === "OPEN").length;
    return { ok: open > 0, label: `${open}/${instances.length} connected`, open, total: instances.length };
  } catch (error) {
    return { ok: false, label: error.message === "timeout" ? "Health check timeout" : "Evolution offline", open: 0, total: 0 };
  }
}

export function registerControlCenterRoutes(router) {
  router.get("/api/control-center", async (_req, res, runtime) => {
    const root = runtime.paths.rootDir;
    const today = dateKeyKL(new Date());
    const cache = await runtime.followUp?.readCache?.().catch(() => ({ syncedAt: null, records: [] }))
      ?? { syncedAt: null, records: [] };
    const records = Array.isArray(cache.records) ? cache.records : [];
    const metrics = summarizeRecords(records, today);
    const pendingBrain = await readJson(path.join(root, "campaign-data", "brain", "pending.json"), { pending: {} });
    const aiPending = Object.keys(pendingBrain.pending || {}).length;
    const settings = runtime.settings?.snapshot?.() || {};
    const runner = runtime.campaign?.getRunner?.();
    const runnerSnapshot = runner?.snapshot?.() || runtime.campaign?.emptySnapshot?.() || null;
    const activeRun = runnerSnapshot?.state
      ? runnerSnapshot
      : { running: false, stopped: false, state: await readJson(path.join(root, "campaign-data", "active-run.json"), null) };
    const campaign = campaignSummary(activeRun);
    const whatsapp = await whatsappHealth(runtime);
    const logs = await runtime.systemLogs?.list?.({ limit: 80, date: today }).catch(() => []) || [];
    const errorsToday = logs.filter((entry) => entry.level === "error").length;
    const warningsToday = logs.filter((entry) => entry.level === "warn").length;
    const cacheAgeMinutes = cache.syncedAt ? Math.max(0, Math.round((Date.now() - dateMs(cache.syncedAt)) / 60000)) : null;
    const activeBrain = listProjects();
    const replyServices = await runtime.replyServices?.status?.().catch(() => ({ tracker: false, brain: false }))
      || { tracker: false, brain: false };
    const watchdog = await readJson(path.join(root, "campaign-data", "watchdog", "status.json"), null);
    const watchdogAgeSeconds = watchdog?.heartbeatAt
      ? Math.max(0, Math.round((Date.now() - dateMs(watchdog.heartbeatAt)) / 1000))
      : null;
    const watchdogFresh = watchdogAgeSeconds !== null && watchdogAgeSeconds <= 120;

    const queue = [
      { id: "overdue", label: "Overdue follow-ups", count: metrics.overdue, tone: "red", href: "/follow-up?bucket=overdue" },
      { id: "today", label: "Follow up today", count: metrics.dueToday, tone: "amber", href: "/follow-up?bucket=today" },
      { id: "brain", label: "AI replies awaiting review", count: aiPending, tone: "purple", href: "/brain-learning" },
      { id: "appointments", label: "Active appointments", count: metrics.appointments, tone: "blue", href: "/follow-up?bucket=appointment" },
    ];
    if (campaign) {
      queue.splice(2, 0, {
        id: "campaign",
        label: `${campaign.project} · ${campaign.status}`,
        count: campaign.total ? `${campaign.sent}/${campaign.total}` : campaign.status,
        tone: campaign.failed ? "red" : campaign.running ? "green" : "blue",
        href: "/send",
      });
    }

    json(res, 200, {
      ok: true,
      generatedAt: new Date().toISOString(),
      today,
      metrics: { ...metrics, aiPending },
      cache: { syncedAt: cache.syncedAt || null, ageMinutes: cacheAgeMinutes, stale: cacheAgeMinutes === null || cacheAgeMinutes > 60 },
      campaign,
      queue,
      recent: recentActivity(records),
      brain: { activeProjects: activeBrain.length, provider: settings.brain?.provider || "rules" },
      health: [
        { id: "server", label: "Mamba Server", ok: true, detail: `Online · port ${runtime.port}` },
        { id: "whatsapp", label: "WhatsApp (Evolution)", ok: whatsapp.ok, detail: whatsapp.label },
        { id: "notion", label: "Notion Cache", ok: Boolean(settings.notion?.configured && cache.syncedAt && cacheAgeMinutes <= 60), detail: cache.syncedAt ? `Synced ${cacheAgeMinutes} min ago${cacheAgeMinutes > 60 ? " · stale" : ""}` : "No local snapshot" },
        { id: "telegram", label: "Telegram Approval", ok: Boolean(settings.telegram?.botConfigured && settings.telegram?.chatConfigured), detail: settings.telegram?.chatConfigured ? "Bot and chat configured" : "Setup incomplete" },
        { id: "tracker", label: "Reply Tracker", ok: replyServices.tracker, detail: replyServices.tracker ? "Listening for inbound replies" : "Offline · replies will not reach Notion or Telegram" },
        { id: "brain", label: "Sales Brain", ok: replyServices.brain, detail: replyServices.brain ? `${settings.brain?.provider || "rules"} · Telegram alerts online` : "Offline · Telegram alerts unavailable" },
        { id: "watchdog", label: "Remote Watchdog", ok: watchdogFresh, detail: watchdogFresh ? `${watchdog.deviceName || "This Mac"} · checked ${watchdogAgeSeconds}s ago` : "Not installed or heartbeat is stale" },
      ],
      logs: { errorsToday, warningsToday },
    });
  });
}
