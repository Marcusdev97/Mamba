import { httpError, json, readJson } from "../lib/http.mjs";

function requireCampaign(runtime) {
  if (!runtime.campaign) {
    throw httpError(500, "Campaign service 没有载入。请重启 Mamba server。");
  }
  return runtime.campaign;
}

function selectedOpenInstances(open, requested) {
  if (!Array.isArray(requested) || !requested.length) return open;
  const wanted = new Set(requested);
  const selected = open.filter((item) => wanted.has(item.name));
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

export function registerCampaignRoutes(router) {
  router.post("/api/prepare", async (req, res, runtime) => {
    const campaign = requireCampaign(runtime);
    const currentRunner = campaign.getRunner();
    if (currentRunner && currentRunner.running) {
      throw httpError(409, "已有 campaign 正在运行，请先停止。");
    }

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
    campaign.setRunner(runner);
    try {
      await runner.prepare({ mode, startAt, endAt, instances, leads, project: project.name });
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

    json(res, 200, {
      ok: true,
      project: project.id,
      schedule: { start: campaign.formatTime(startAt), end: campaign.formatTime(endAt) },
      snapshot: runner.snapshot(),
    });
  });

  router.post("/api/start", async (req, res, runtime) => {
    const campaign = requireCampaign(runtime);
    const body = await readJson(req);
    const runner = campaign.getRunner();
    ensureRunnableStart(runner, body);

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
    try {
      await runner.saveState();
    } catch (error) {
      throw httpError(500, `保存 campaign 状态失败: ${error.message}`);
    }

    const autoAdvance = body.autoAdvance === true && runner.state.mode === "LIVE";
    runner.run()
      .then(() => (autoAdvance ? campaign.autoAdvanceFlow(runner) : null))
      .then(() => (autoAdvance ? campaign.creditSentCounts(runner) : null))
      .then(() => campaign.autoNotionUpload(runner))
      .catch((error) => runner.pushLog(`运行出错：${error.message}`));

    json(res, 200, { ok: true, snapshot: runner.snapshot() });
  });

  router.post("/api/resume", async (_req, res, runtime) => {
    const campaign = requireCampaign(runtime);
    const runner = campaign.getRunner();
    if (!runner || !runner.state) throw httpError(400, "没有可继续的 run。");
    if (runner.running) throw httpError(409, "campaign 已在运行。");

    const remaining = runner.state.assignments.filter((job) => job.status === "QUEUED").length;
    if (!remaining) throw httpError(400, "没有待发送的客户了（都已处理）。");

    runner.run()
      .then(() => campaign.autoNotionUpload(runner))
      .catch((error) => runner.pushLog(`运行出错：${error.message}`));
    json(res, 200, { ok: true, snapshot: runner.snapshot() });
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
