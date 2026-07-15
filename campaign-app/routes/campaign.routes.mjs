import { httpError, json, readJson } from "../lib/http.mjs";

function requireCampaign(runtime) {
  if (!runtime.campaign) {
    throw httpError(500, "Campaign service 没有载入。请重启 Mamba server。");
  }
  return runtime.campaign;
}

// requested 支持两种形态 (向后兼容):
//   ["wa_01", "wa_02"]                        — 旧格式, 不限量
//   [{ name: "wa_01", max: 100 }, "wa_02"]    — 带 per-sender quota (max = 本批上限)
function selectedOpenInstances(open, requested) {
  if (!Array.isArray(requested) || !requested.length) return open;
  const wantedMax = new Map();
  for (const item of requested) {
    if (typeof item === "string") wantedMax.set(item, null);
    else if (item?.name) {
      const max = Number(item.max);
      wantedMax.set(String(item.name), Number.isFinite(max) && max > 0 ? max : null);
    }
  }
  const selected = open
    .filter((item) => wantedMax.has(item.name))
    .map((item) => ({ ...item, max: wantedMax.get(item.name) }));
  if (!selected.length) {
    throw httpError(400, "所选号码都不在线。请到 Settings 检查 Phone Health，确认号码是 OPEN。");
  }
  return selected;
}

function resolveSchedule(campaign, config, body) {
  const now = new Date();
  const defaultEnd = new Date(now);
  defaultEnd.setHours(21, 0, 0, 0);
  if (defaultEnd <= now) defaultEnd.setTime(now.getTime() + 60 * 60 * 1000);

  const startAt = campaign.resolveTime(body.startTime, now);
  const endAt = campaign.resolveTime(body.endTime, defaultEnd);
  if (endAt <= startAt) {
    throw httpError(400, "结束时间必须晚于开始时间。请检查 Start / End time。");
  }
  if (endAt.getTime() - startAt.getTime() <= config.delivery.partGapSeconds * 1000) {
    throw httpError(400, `发送时间窗必须长于 ${config.delivery.partGapSeconds} 秒。`);
  }
  return { startAt, endAt };
}

function selectLeads(campaign, project, mode, body) {
  if (mode === "TEST") {
    const leads = campaign.getTestLeads(body.testRecipients || undefined);
    if (!leads.length) {
      throw httpError(400, "TEST 模式请先填写至少一个测试收件人。格式: 名字, 电话, 语言。");
    }
    return leads;
  }

  const leadsCache = campaign.getLeadsCache();
  if (!leadsCache || leadsCache.projectId !== project.id || !leadsCache.leads.length) {
    throw httpError(400, `还没有导入 ${project.name} 的 leads，请先导入它的 Excel。`);
  }

  const limit = Number(body.leadCount);
  if (Number.isInteger(limit) && limit >= 1 && limit < leadsCache.leads.length) {
    return leadsCache.leads.slice(0, limit);
  }
  return leadsCache.leads;
}

function ensureRunnableStart(runner, body) {
  if (!runner || !runner.state) {
    throw httpError(400, "请先生成预览（prepare）。");
  }
  if (runner.running) {
    throw httpError(409, "campaign 已在运行。");
  }
  if (runner.state.mode === "LIVE" && body.optIn !== true) {
    throw httpError(400, "LIVE 模式需要先确认收件人已 opt-in。");
  }
}

function applyManualSkips(runner, skipIds) {
  const skipped = new Set((Array.isArray(skipIds) ? skipIds : []).map(String).filter(Boolean));
  if (!skipped.size) return 0;

  const jobs = runner.state.assignments || [];
  const matching = jobs.filter((job) => skipped.has(String(job.id)));
  const remaining = jobs.filter((job) => job.status === "QUEUED" && !skipped.has(String(job.id))).length;
  if (!remaining) {
    throw httpError(400, "你把全部收件人都设为不发送了。请至少保留 1 个收件人。");
  }

  let count = 0;
  for (const job of matching) {
    job.status = "SKIPPED_MANUAL";
    job.error = "手动跳过：本次不发送。";
    count += 1;
  }
  return count;
}

function markNotionSyncWaiting(runner) {
  if (runner?.state?.mode !== "LIVE" || runner.state.flowLabel) return;
  runner.state.notionSync = {
    status: "WAITING",
    stage: "campaign",
    message: "发送完成后将自动更新 Notion。",
    startedAt: null,
    finishedAt: null,
    error: null,
    updatedAt: new Date().toISOString(),
  };
}

function markFlowAdvanceWaiting(runner) {
  if (runner?.state?.mode !== "LIVE" || !runner.state.flowLabel) return false;
  runner.state.advanceDone = false;
  runner.state.advanceStatus = "WAITING";
  runner.state.advanceError = null;
  runner.state.advanceSummary = null;
  return true;
}

async function writeCampaignLog(runtime, level, event, message, context = {}) {
  if (!runtime.systemLogs) return;
  try {
    await runtime.systemLogs.write({ level, area: "campaign", event, message, context });
  } catch {
    // Logging is diagnostic only; campaign controls should continue working.
  }
}

export function campaignQueueBlockReason(runner) {
  const state = runner?.state;
  if (!state) return null;
  if (runner.running) return "当前 Campaign 仍在发送。";
  if (state.status === "STOPPED") return "当前 Campaign 已手动停止；请确认后再启动下一批。";
  if (["READY", "READY_TEST"].includes(state.status)) return "当前还有一个尚未启动的预览。";
  if (state.mode === "LIVE" && state.flowLabel && ["WAITING", "RUNNING"].includes(state.advanceStatus)) {
    return `当前 ${state.flowLabel} 仍在更新 Notion（${state.advanceStatus}）；完成后 Queue 会自动继续。`;
  }
  if (state.mode === "LIVE" && state.flowLabel && ["FAILED", "PARTIAL"].includes(state.advanceStatus)) {
    return `当前 ${state.flowLabel} 的 Notion Flow 推进状态是 ${state.advanceStatus}；请先修复，避免下一批与旧状态混在一起。`;
  }
  if (state.mode === "LIVE" && !state.flowLabel && ["WAITING", "RUNNING"].includes(state.notionSync?.status)) {
    return `当前 Flow 1 仍在更新 Notion（${state.notionSync.status}）；完成后 Queue 会自动继续。`;
  }
  if (state.mode === "LIVE" && !state.flowLabel && state.notionSync?.status === "FAILED") {
    return "当前 Flow 1 的 Notion 上传失败；请先补跑或确认后再启动下一批。";
  }
  return null;
}

async function restoreQueuedRunner(campaign, item) {
  try {
    return await campaign.restoreRunner({ runId: item.runId, projectId: item.projectId });
  } catch (error) {
    throw httpError(500, `恢复排队 Campaign 失败: ${error.message}`);
  }
}

function runCampaignInBackground(runtime, runner, autoAdvance, errorEvent = "campaign_run_error") {
  const campaign = requireCampaign(runtime);
  campaign.setRunner(runner);
  (async () => {
    try {
      await runner.run();
      if (autoAdvance) await campaign.autoAdvanceFlow(runner);
      if (autoAdvance) await campaign.creditSentCounts(runner);
      await campaign.autoNotionUpload(runner);
    } catch (error) {
      runner.pushLog(`运行出错：${error.message}`);
      await runner.systemLog?.("error", errorEvent, "Campaign background run failed.", { error: error.message });
    } finally {
      await startNextQueued(runtime).catch(async (error) => {
        await campaign.queue.setHold(`启动下一批失败: ${error.message}`, runner.state?.runId).catch(() => {});
        await writeCampaignLog(runtime, "error", "campaign_queue_start_failed", "Queued campaign failed to start.", {
          runId: runner.state?.runId ?? null,
          error: error.message,
        });
      });
    }
  })();
}

async function startNextQueued(runtime, { force = false } = {}) {
  const campaign = requireCampaign(runtime);
  const current = campaign.getRunner();
  if (current?.running) return null;
  const next = await campaign.queue.peek();
  if (!next) {
    await campaign.queue.clearHold();
    return null;
  }

  const reason = campaignQueueBlockReason(current);
  if (reason && !force) {
    await campaign.queue.setHold(reason, current?.state?.runId ?? null);
    return { held: true, reason };
  }

  const nextRunner = await restoreQueuedRunner(campaign, next);
  await campaign.queue.remove(next.runId);
  await campaign.queue.clearHold();
  nextRunner.pushLog(`Queue 接力启动: 前一批已结束，现在开始 ${next.project || next.projectId} · ${next.flowLabel}。`);
  await writeCampaignLog(runtime, "info", "campaign_queue_started", "Queued campaign started.", {
    runId: next.runId,
    project: next.project,
    flowLabel: next.flowLabel,
    forced: force,
  });
  runCampaignInBackground(runtime, nextRunner, next.autoAdvance, "campaign_queued_run_error");
  return { held: false, started: next };
}

async function resolveStartRunner(campaign, body) {
  const current = campaign.getRunner();
  const requestedRunId = String(body.runId || "").trim();
  if (!requestedRunId || current?.state?.runId === requestedRunId) return current;
  if (!body.project) throw httpError(400, "排队预览缺少 project，请重新生成预览。");
  return campaign.restoreRunner({ runId: requestedRunId, projectId: body.project });
}

export function registerCampaignRoutes(router) {
  router.post("/api/prepare", async (req, res, runtime) => {
    const campaign = requireCampaign(runtime);
    const currentRunner = campaign.getRunner();
    const preparingBehindActiveRun = Boolean(currentRunner?.running);

    const body = await readJson(req);
    let project;
    let config;
    try {
      ({ project, config } = await campaign.getProject(body.project));
    } catch (error) {
      throw httpError(500, `读取 project 失败: ${error.message}`);
    }

    const mode = body.mode === "LIVE" ? "LIVE" : "TEST";
    let open;
    try {
      open = await campaign.openInstances();
    } catch (error) {
      throw httpError(503, `读取 WhatsApp Phone Health 失败: ${error.message}`);
    }
    if (!open.length) {
      throw httpError(400, "没有处于 OPEN 状态的 WhatsApp 号码，无法发送。请到 Settings 重新扫码或检查 Phone Health。");
    }
    const instances = selectedOpenInstances(open, body.instances);
    const { startAt, endAt } = resolveSchedule(campaign, config, body);
    const leads = selectLeads(campaign, project, mode, body);

    const runner = campaign.createRunner(config);
    runner.mirrorActiveState = !preparingBehindActiveRun;
    try {
      await runner.prepare({ mode, startAt, endAt, instances, leads, project: project.name });
      runner.state.projectId = project.id;
    } catch (error) {
      throw httpError(500, `生成 campaign 预览失败: ${error.message}`);
    }
    try {
      await campaign.applyNotionFlowTemplatesToState(runner.state, {
        projectName: project.name,
        flow: campaign.firstFlowLabel,
        markFlowRun: false,
        credit: false,
      });
    } catch (error) {
      throw httpError(502, `读取或套用 Notion Flow 1 模板失败: ${error.message}`);
    }
    try {
      await runner.saveState();
    } catch (error) {
      throw httpError(500, `保存 campaign 预览失败: ${error.message}`);
    }
    if (!preparingBehindActiveRun) campaign.setRunner(runner);

    json(res, 200, {
      ok: true,
      project: project.id,
      queueAvailable: preparingBehindActiveRun,
      schedule: { start: campaign.formatTime(startAt), end: campaign.formatTime(endAt) },
      snapshot: runner.snapshot(),
    });
  });

  router.post("/api/start", async (req, res, runtime) => {
    const campaign = requireCampaign(runtime);
    const body = await readJson(req);
    const activeRunner = campaign.getRunner();
    const runner = await resolveStartRunner(campaign, body);
    ensureRunnableStart(runner, body);
    const skippedCount = applyManualSkips(runner, body.skipIds);
    if (skippedCount) {
      runner.pushLog(`手动跳过 ${skippedCount} 个收件人，本轮不会发送给他们。`);
      await writeCampaignLog(runtime, "info", "manual_skip_recipients", "Recipients manually skipped before campaign start.", {
        runId: runner.state?.runId ?? null,
        project: runner.state?.project ?? null,
        mode: runner.state?.mode ?? null,
        skippedCount,
      });
    }

    if (runner.state.templateSource === "notion") {
      try {
        await campaign.applyNotionFlowTemplatesToState(runner.state, {
          projectName: runner.state.project,
          flow: runner.state.templateFlow || campaign.firstFlowLabel,
          overrides: body.overrides,
          markFlowRun: false,
          credit: false,
        });
      } catch (error) {
        throw httpError(502, `开始发送前读取或套用 Notion 模板失败: ${error.message}`);
      }
    } else {
      try {
        campaign.applyTemplateOverrides(runner.state, body.overrides, runner.config);
      } catch (error) {
        throw httpError(400, `模板内容套用失败: ${error.message}`);
      }
    }

    try {
      campaign.assertFirstConsoleRunUsesFlow1Only(runner.config, runner.state);
    } catch (error) {
      throw httpError(400, `模板安全检查失败: ${error.message}`);
    }
    markNotionSyncWaiting(runner);
    const autoAdvance = markFlowAdvanceWaiting(runner);
    try {
      await runner.saveState();
    } catch (error) {
      throw httpError(500, `保存 campaign 状态失败: ${error.message}`);
    }

    const existingQueue = await campaign.queue.snapshot();
    if ((activeRunner?.running && activeRunner !== runner) || existingQueue.count > 0) {
      runner.state.status = "QUEUED_BATCH";
      await runner.saveState();
      const queued = await campaign.queue.add(runner, { projectId: runner.state.projectId || body.project, autoAdvance });
      runner.pushLog(`已加入 Campaign Queue，第 ${queued.position} 位。`);
      await writeCampaignLog(runtime, "info", "campaign_queued", "Campaign batch added to queue.", {
        runId: runner.state.runId,
        project: runner.state.project,
        flowLabel: runner.state.flowLabel || runner.state.templateFlow,
        position: queued.position,
      });
      if (!activeRunner?.running) await startNextQueued(runtime);
      json(res, 200, { ok: true, queued: true, position: queued.position, queue: await campaign.queue.snapshot(), snapshot: runner.snapshot() });
      return;
    }

    runCampaignInBackground(runtime, runner, autoAdvance);
    json(res, 200, { ok: true, queued: false, snapshot: runner.snapshot() });
  });

  router.post("/api/resume", async (_req, res, runtime) => {
    const campaign = requireCampaign(runtime);
    const runner = campaign.getRunner();
    if (!runner || !runner.state) throw httpError(400, "没有可继续的 run。");
    if (runner.running) throw httpError(409, "campaign 已在运行。");

    const remaining = runner.state.assignments.filter((job) => job.status === "QUEUED").length;
    if (!remaining) throw httpError(400, "没有待发送的客户了（都已处理）。");

    markNotionSyncWaiting(runner);
    const autoAdvance = markFlowAdvanceWaiting(runner);
    await runner.saveState();

    runCampaignInBackground(runtime, runner, autoAdvance, "campaign_resume_error");
    json(res, 200, { ok: true, snapshot: runner.snapshot() });
  });

  router.post("/api/retry-failed", async (req, res, runtime) => {
    const campaign = requireCampaign(runtime);
    const body = await readJson(req);
    const runner = campaign.getRunner();
    if (!runner || !runner.state) throw httpError(400, "没有可补发的 run。");
    if (runner.running) throw httpError(409, "campaign 已在运行。");

    const failed = runner.state.assignments.filter((job) => job.status === "FAILED").length;
    if (!failed) throw httpError(400, "没有失败客户需要补发。");

    const queued = runner.retryFailedOnly();
    if (!queued) throw httpError(400, "没有失败客户需要补发。");
    runner.pushLog(`Retry Failed only: ${queued} 个失败客户已重新排队；已成功/手动跳过的客户不会重发。`);
    await writeCampaignLog(runtime, "info", "retry_failed_only", "Failed recipients queued for retry.", {
      runId: runner.state?.runId ?? null,
      project: runner.state?.project ?? null,
      mode: runner.state?.mode ?? null,
      queued,
    });
    markNotionSyncWaiting(runner);
    const autoAdvance = markFlowAdvanceWaiting(runner);
    await runner.saveState();

    runCampaignInBackground(runtime, runner, autoAdvance, "campaign_retry_failed_error");
    json(res, 200, { ok: true, retried: queued, snapshot: runner.snapshot() });
  });

  router.post("/api/stop", async (_req, res, runtime) => {
    const campaign = requireCampaign(runtime);
    const runner = campaign.getRunner();
    if (runner) runner.stop();
    json(res, 200, { ok: true });
  });

  router.get("/api/status", async (_req, res, runtime) => {
    const campaign = requireCampaign(runtime);
    const runner = campaign.getRunner();
    json(res, 200, runner ? runner.snapshot() : campaign.emptySnapshot());
  });

  router.get("/api/campaign-queue", async (_req, res, runtime) => {
    const campaign = requireCampaign(runtime);
    if (!campaign.getRunner()?.running) await startNextQueued(runtime);
    json(res, 200, { ok: true, queue: await campaign.queue.snapshot() });
  });

  router.post("/api/campaign-queue/cancel", async (req, res, runtime) => {
    const campaign = requireCampaign(runtime);
    const body = await readJson(req);
    const runId = String(body.runId || "").trim();
    if (!runId) throw httpError(400, "缺少要取消的 Queue runId。");
    const removed = await campaign.queue.remove(runId);
    if (!removed) throw httpError(404, "Queue 里找不到这批 Campaign。");
    await writeCampaignLog(runtime, "info", "campaign_queue_cancelled", "Queued campaign cancelled.", { runId });
    json(res, 200, { ok: true, queue: await campaign.queue.snapshot() });
  });

  router.post("/api/campaign-queue/release", async (_req, res, runtime) => {
    const campaign = requireCampaign(runtime);
    const result = await startNextQueued(runtime, { force: true });
    json(res, 200, { ok: true, result, queue: await campaign.queue.snapshot() });
  });

  router.get("/api/export", async (_req, res, runtime) => {
    const campaign = requireCampaign(runtime);
    const runner = campaign.getRunner();
    if (!runner || !runner.state) throw httpError(404, "没有可导出的 run。");
    res.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${runner.state.runId}.csv"`,
    });
    res.end(`\uFEFF${campaign.buildCsv(runner.state)}`);
  });
}
