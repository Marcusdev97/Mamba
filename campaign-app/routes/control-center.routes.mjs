import fs from "node:fs/promises";
import path from "node:path";
import { json } from "../lib/http.mjs";
import { listProjects } from "../knowledge_layer.mjs";
import { filterRecordsForDevice, recordDeviceScope } from "../lib/device-scope.mjs";

export { filterRecordsForDevice, recordDeviceScope } from "../lib/device-scope.mjs";

const LEARNING_HEALTH_TTL_MS = 120_000;
let learningHealthCache = { checkedAt: 0, key: "", value: null, promise: null };

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
  const pending = assignments.filter((job) => job.status === "QUEUED" || /^WAITING_PART\d+$/.test(job.status || "") || /^SENDING_PART\d+$/.test(job.status || "")).length;
  const processed = Math.max(0, assignments.length - pending);
  const nextAt = assignments
    .filter((job) => job.status === "QUEUED" && dateMs(job.scheduledAt) > Date.now())
    .map((job) => dateMs(job.scheduledAt))
    .sort((a, b) => a - b)[0] || null;
  const rawStatus = state.status || (snapshot.running ? "RUNNING" : "READY");
  const status = !snapshot.running && rawStatus === "COMPLETED" && pending > 0 ? "INCOMPLETE" : rawStatus;
  const instanceNames = [
    ...(Array.isArray(state.instances) ? state.instances.map((item) => item?.name || item) : []),
    ...assignments.map((job) => job.instanceName),
    ...Object.keys(state.perSender || {}),
  ].map((value) => String(value || "").trim()).filter(Boolean);
  return {
    runId: state.runId || "",
    project: state.project || state.campaignId || "Campaign",
    status,
    mode: state.mode || "",
    total: assignments.length,
    sent,
    failed,
    skipped,
    pending,
    processed,
    nextAt: nextAt ? new Date(nextAt).toISOString() : null,
    running: snapshot.running === true,
    stopped: snapshot.stopped === true,
    updatedAt: state.updatedAt || state.createdAt || null,
    instances: [...new Set(instanceNames)],
  };
}

async function whatsappHealth(runtime) {
  if (!runtime.whatsapp?.listInstances) return { ok: false, label: "Service unavailable", open: 0, total: 0 };
  try {
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2500));
    const allInstances = await Promise.race([runtime.whatsapp.listInstances(), timeout]);
    const instances = allInstances.filter((item) => item.allowedOnThisDevice !== false);
    const open = instances.filter((item) => String(item.status || "").toUpperCase() === "OPEN").length;
    return {
      ok: open > 0,
      label: `${open}/${instances.length} connected`,
      open,
      total: instances.length,
      blocked: allInstances.length - instances.length,
      instances: instances.map((item) => ({
        name: String(item.name || ""),
        number: String(item.number || ""),
        status: String(item.status || ""),
      })),
    };
  } catch (error) {
    return { ok: false, label: error.message === "timeout" ? "Health check timeout" : "Evolution offline", open: 0, total: 0 };
  }
}

function healthItem(id, label, state, detail, href = "") {
  const normalized = ["online", "warning", "offline", "idle"].includes(state) ? state : "offline";
  return { id, label, state: normalized, ok: normalized === "online", detail: String(detail || ""), href };
}

async function learningQueueHealth(runtime, notionConfigured) {
  const service = runtime.brainLearning;
  const ids = [service?.aiReplyLogDbId, service?.goldenDbId, service?.objectionDbId].filter(Boolean);
  if (!notionConfigured) {
    return healthItem("learning", "Brain Learning Queue", "offline", "Notion token is not configured", "/brain-learning");
  }
  if (!service?.notion || ids.length !== 3) {
    return healthItem("learning", "Brain Learning Queue", "offline", "Learning database configuration is incomplete", "/brain-learning");
  }

  const key = ids.join(":");
  if (learningHealthCache.key === key && learningHealthCache.value && Date.now() - learningHealthCache.checkedAt < LEARNING_HEALTH_TTL_MS) {
    return learningHealthCache.value;
  }
  if (learningHealthCache.key === key && learningHealthCache.promise) return learningHealthCache.promise;

  learningHealthCache.key = key;
  learningHealthCache.promise = service.notion("POST", `/databases/${service.aiReplyLogDbId}/query`, { page_size: 1 })
    .then(() => healthItem("learning", "Brain Learning Queue", "online", "Notion learning source connected · review queue ready", "/brain-learning"))
    .catch((error) => healthItem("learning", "Brain Learning Queue", "offline", `Notion learning source unavailable · ${error.message}`, "/brain-learning"))
    .then((value) => {
      learningHealthCache = { checkedAt: Date.now(), key, value, promise: null };
      return value;
    });
  return learningHealthCache.promise;
}

export function registerControlCenterRoutes(router) {
  router.post("/api/reply-tracker/refresh", async (_req, res, runtime) => {
    if (!runtime.replyServices?.refreshTracker) {
      json(res, 503, { ok: false, error: "Reply Tracker 管理器尚未加载，请重启 Mamba 后再试。" });
      return;
    }
    const result = await runtime.replyServices.refreshTracker().catch((error) => ({
      ok: false,
      error: error.message,
      tracker: false,
      trackerState: "closed",
    }));
    json(res, result.ok ? 200 : 503, result);
  });

  router.get("/api/control-center", async (_req, res, runtime) => {
    const root = runtime.paths.rootDir;
    const today = dateKeyKL(new Date());
    const cache = (
      await runtime.followUp?.syncCache?.({ force: false }).catch(() => null)
      || await runtime.followUp?.readCache?.().catch(() => ({ syncedAt: null, records: [] }))
    ) ?? { syncedAt: null, records: [] };
    const allRecords = Array.isArray(cache.records) ? cache.records : [];
    const whatsapp = await whatsappHealth(runtime);
    const device = runtime.device || { id: "this-device", name: "This device", hostname: "" };
    const localScope = filterRecordsForDevice(allRecords, {
      device,
    });
    const records = localScope.records;
    const metrics = summarizeRecords(records, today);
    const settings = runtime.settings?.snapshot?.() || {};
    const brainEnabled = settings.brain?.enabled === true;
    const pendingBrain = await readJson(path.join(root, "campaign-data", "brain", "pending.json"), { pending: {} });
    const storedBrainPending = Object.values(pendingBrain.pending || {}).filter((item) =>
      item?.event?.instanceName !== "simulate" && Number(item?.tgMessageId || 0) > 0).length;
    const aiPending = brainEnabled ? storedBrainPending : 0;
    const runner = runtime.campaign?.getRunner?.();
    const runnerSnapshot = runner?.snapshot?.() || runtime.campaign?.emptySnapshot?.() || null;
    const activeRun = runnerSnapshot?.state
      ? runnerSnapshot
      : { running: false, stopped: false, state: await readJson(path.join(root, "campaign-data", "active-run.json"), null) };
    const campaign = campaignSummary(activeRun);
    const logs = await runtime.systemLogs?.list?.({ limit: 1000, date: today }).catch(() => []) || [];
    const errorsToday = logs.filter((entry) => entry.level === "error").length;
    const warningsToday = logs.filter((entry) => entry.level === "warn").length;
    const cacheAgeMinutes = cache.syncedAt ? Math.max(0, Math.round((Date.now() - dateMs(cache.syncedAt)) / 60000)) : null;
    const activeBrain = listProjects();
    const replyServices = await runtime.replyServices?.status?.().catch(() => ({ tracker: false, brain: false, brainEnabled: settings.brain?.enabled === true }))
      || { tracker: false, brain: false, brainEnabled: settings.brain?.enabled === true };
    const trackerDetails = replyServices.tracker
      ? await runtime.replyServices?.trackerDetails?.().catch(() => null)
      : null;
    const notionReplyQueue = trackerDetails?.notionQueue || { pendingMessages: 0, manualReviewMessages: 0, pendingPhones: 0 };
    const learning = await learningQueueHealth(runtime, Boolean(settings.notion?.configured));
    const scheduler = await runtime.dailyCampaign?.snapshot?.().catch((error) => ({ error: error.message })) || null;
    const schedulerMode = scheduler?.schedulerMode || (!scheduler?.config?.enabled ? "OFF" : scheduler?.config?.mode || "TEST");
    const shiftLabel = scheduler?.shift?.status === "on-shift"
      ? `on shift until ${scheduler.shift.workEnd}`
      : scheduler?.shift?.stoppedToday
        ? "stopped for today"
        : scheduler?.shift?.status === "off-shift"
          ? `off shift · ${scheduler.shift.workStart}-${scheduler.shift.workEnd}`
          : "closed";
    const watchdog = await readJson(path.join(root, "campaign-data", "watchdog", "status.json"), null);
    const watchdogAgeSeconds = watchdog?.heartbeatAt
      ? Math.max(0, Math.round((Date.now() - dateMs(watchdog.heartbeatAt)) / 1000))
      : null;
    const watchdogFresh = watchdogAgeSeconds !== null && watchdogAgeSeconds <= 120;

    const queue = [
      { id: "overdue", label: "Overdue follow-ups", count: metrics.overdue, tone: "red", href: "/follow-up?bucket=overdue" },
      { id: "today", label: "Follow up today", count: metrics.dueToday, tone: "amber", href: "/follow-up?bucket=today" },
      { id: "appointments", label: "Active appointments", count: metrics.appointments, tone: "blue", href: "/follow-up?bucket=appointment" },
    ];
    if (brainEnabled && aiPending) {
      queue.splice(2, 0, { id: "brain", label: "AI replies awaiting approval", count: aiPending, tone: "purple", href: "/brain-learning" });
    }
    if (notionReplyQueue.pendingMessages) {
      queue.splice(2, 0, {
        id: "notion-replies",
        label: notionReplyQueue.manualReviewMessages
          ? "Notion replies need manual review"
          : "Notion replies waiting to sync",
        count: notionReplyQueue.manualReviewMessages || notionReplyQueue.pendingMessages,
        tone: notionReplyQueue.manualReviewMessages ? "red" : "amber",
        href: "/logs",
      });
    }
    if (campaign) {
      queue.splice(2, 0, {
        id: "campaign",
        label: `${campaign.project} · ${campaign.status}`,
        count: campaign.pending ? `${campaign.sent} sent · ${campaign.pending} pending` : campaign.total ? `${campaign.sent}/${campaign.total}` : campaign.status,
        tone: campaign.failed ? "red" : campaign.running ? "green" : "blue",
        href: "/send",
      });
    }

    json(res, 200, {
      ok: true,
      generatedAt: new Date().toISOString(),
      today,
      scope: {
        mode: "device",
        device,
        senders: whatsapp.instances || [],
        localRecords: records.length,
        sharedRecords: allRecords.length,
        legacyRecords: localScope.counts.legacy,
        remoteRecords: localScope.counts.remote,
        unassignedRecords: localScope.counts.unassigned,
        telegram: runtime.telegramHub?.enabled ? "global" : "local-config",
      },
      metrics: { ...metrics, aiPending, storedBrainPending },
      cache: { syncedAt: cache.syncedAt || null, ageMinutes: cacheAgeMinutes, stale: cacheAgeMinutes === null || cacheAgeMinutes > 60 },
      campaign,
      queue,
      recent: recentActivity(records),
      brain: { enabled: brainEnabled, activeProjects: activeBrain.length, provider: settings.brain?.provider || "rules", storedPending: storedBrainPending },
      health: [
        healthItem("server", "Mamba Server", "online", `Online · port ${runtime.port}`),
        healthItem("whatsapp", "WhatsApp (Evolution)", whatsapp.ok ? "online" : "offline", whatsapp.label, "/settings"),
        healthItem(
          "notion",
          cache.source === "sqlite" ? "SQLite Customer Store" : "Notion Customer Cache",
          !settings.notion?.configured ? "offline" : cache.syncedAt && cacheAgeMinutes <= 60 ? "online" : "warning",
          !settings.notion?.configured ? "Notion token is not configured" : cache.syncedAt ? `Synced ${cacheAgeMinutes} min ago${cacheAgeMinutes > 60 ? " · refresh recommended" : ""}` : "Connected, but no customer snapshot is available",
          "/conversations",
        ),
        healthItem(
          "telegram",
          "Global Telegram Hub",
          runtime.telegramHub?.enabled ? "online" : settings.telegram?.botConfigured && settings.telegram?.chatConfigured ? "warning" : "offline",
          runtime.telegramHub?.enabled ? "Shared inbox receives alerts from every Mamba device" : settings.telegram?.botConfigured && settings.telegram?.chatConfigured ? "Legacy Telegram is configured; shared inbox Hub is incomplete" : "Telegram Hub token or inbox destination is missing",
          "/settings",
        ),
        healthItem(
          "tracker",
          "Reply Tracker",
          !replyServices.tracker ? "offline" : notionReplyQueue.manualReviewMessages ? "warning" : "online",
          !replyServices.tracker
            ? replyServices.trackerState === "blocked"
              ? `已关闭 · 检测到端口 ${replyServices.portConflicts?.join(", ") || replyServices.preferredPort || 8798} 被其他服务占用；点击刷新可自动改用其他端口`
              : "已关闭 · 客户回复不会进入 Notion 或 Telegram；点击刷新可自动启动"
            : notionReplyQueue.manualReviewMessages
              ? `已开启 · 动态端口 ${replyServices.trackerPort} · ${notionReplyQueue.manualReviewMessages} 条回复需要人工检查`
              : notionReplyQueue.pendingMessages
                ? `已开启 · 动态端口 ${replyServices.trackerPort} · ${notionReplyQueue.pendingMessages} 条回复等待 Notion 重试`
                : `已开启 · 动态端口 ${replyServices.trackerPort} · 正在监听客户回复${replyServices.portConflicts?.length ? ` · 已避开占用端口 ${replyServices.portConflicts.join(", ")}` : ""}`,
          notionReplyQueue.pendingMessages ? "/logs" : undefined,
        ),
        healthItem(
          "brain",
          brainEnabled ? "Sales Brain" : "Sales Brain (Manual Off)",
          brainEnabled ? (replyServices.brain ? "online" : "offline") : "online",
          brainEnabled
            ? (replyServices.brain ? `${settings.brain?.provider || "rules"} · classification and alerts online` : "Classification and Telegram alerts are unavailable")
            : "Tracker-only mode · replies are recorded, but Mamba will not reply to customers",
        ),
        learning,
        healthItem(
          "scheduler",
          "Campaign Automations",
          !scheduler || scheduler.error ? "offline" : schedulerMode === "OFF" ? "idle" : schedulerMode === "LIVE" ? "warning" : "online",
          !scheduler || scheduler.error ? scheduler?.error || "Automation service is unavailable" : `${schedulerMode} · ${shiftLabel}`,
          "/campaign-todo",
        ),
        healthItem("watchdog", "Remote Watchdog", watchdogFresh ? "online" : "warning", watchdogFresh ? `${watchdog.deviceName || "This Mac"} · checked ${watchdogAgeSeconds}s ago` : "Optional protection is not installed or heartbeat is stale", "/remote-mamba"),
      ],
      logs: { errorsToday, warningsToday },
    });
  });
}
