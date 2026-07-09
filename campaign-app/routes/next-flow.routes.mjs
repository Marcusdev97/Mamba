import { httpError, json, readJson } from "../lib/http.mjs";

function requireNextFlow(runtime) {
  if (!runtime.nextFlow) {
    throw httpError(500, "Next-flow service 没有载入。请重启 Mamba server。");
  }
  return runtime.nextFlow;
}

function requireBlastDatabase(nextFlow) {
  if (!nextFlow.blastDatabaseId) {
    throw httpError(400, "没有 Notion Blast Leads database 配置。请到 Settings 检查 Notion。");
  }
}

function pageId(id) {
  return String(id || "").replace(/[^a-fA-F0-9]/g, "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function queryLeadPage(nextFlow, phone) {
  const data = await nextFlow.notion("POST", `/databases/${nextFlow.blastDatabaseId}/query`, {
    filter: { property: "Phone", phone_number: { equals: phone } },
    page_size: 1,
  });
  return data?.results?.[0] || null;
}

function replyProps(nextFlow, reply, at, text, reasonSuffix = "") {
  const props = {
    Status: { select: { name: reply.status } },
    "Sequence Status": { select: { name: reply.sequenceStatus } },
    "Next Action": { select: { name: reply.nextAction } },
    "AI Category": { select: { name: reply.aiCategory } },
    "Last Reply At": { date: { start: new Date(at).toISOString() } },
    "Last Reply Text": { rich_text: [{ text: { content: (text || "").slice(0, 1900) } }] },
    "Reply Checked At": { date: { start: new Date().toISOString() } },
    "AI Summary": { rich_text: [{ text: { content: `[${reply.signal}] ${reply.route} · 建议:${reply.suggestedReply}` } }] },
  };
  if (reply.stopFlag) {
    props["Stop Flag"] = { checkbox: true };
    props["Stop Reason"] = { rich_text: [{ text: { content: `Auto: ${reply.route}${reasonSuffix}` } }] };
  }
  return props;
}

async function writeReplyToNotion(nextFlow, page, reply, at, text, reasonSuffix = "") {
  await nextFlow.notion("PATCH", `/pages/${pageId(page.id)}`, {
    properties: replyProps(nextFlow, reply, at, text, reasonSuffix),
  });
}

async function creditReplyMetrics(nextFlow, state, phone, signal) {
  const job = state.assignments.find((item) => nextFlow.normalizePhone(item.lead?.phone) === phone);
  let credits = job?.tplCredit;
  if (!credits) {
    const language = String(job?.language || "en").toUpperCase();
    const templates = (state.creditByLang || {})[language] || Object.values(state.creditByLang || {})[0] || {};
    credits = [(templates.p1 || [])[0], (templates.p2 || [])[0]]
      .filter((item) => item && item.pageId)
      .map((item) => ({ pageId: item.pageId, imagePageId: item.imagePageId }));
  }

  for (const part of credits || []) {
    if (!part?.pageId) continue;
    await nextFlow.incPageNumber(part.pageId, "Response Count", 1);
    if (signal === "GREEN") await nextFlow.incPageNumber(part.pageId, "Warm Count", 1);
    else if (signal === "RED") await nextFlow.incPageNumber(part.pageId, "Stop Count", 1);

    if (part.imagePageId) {
      await nextFlow.incPageNumber(part.imagePageId, "Response Count", 1);
      if (signal === "GREEN") await nextFlow.incPageNumber(part.imagePageId, "Warm Count", 1);
      else if (signal === "RED") await nextFlow.incPageNumber(part.imagePageId, "Stop Count", 1);
    }
  }
}

async function latestInboundReplies(nextFlow, instances, leadsByPhone, sinceForLead) {
  const inbound = new Map();
  for (const instance of instances) {
    let response;
    try {
      response = await nextFlow.api(`/chat/findMessages/${encodeURIComponent(instance.name)}`, {
        method: "POST",
        body: JSON.stringify({ where: {} }),
      });
    } catch {
      continue;
    }

    for (const message of nextFlow.collectMessageObjects(response)) {
      if (message?.key?.fromMe) continue;
      const phone = nextFlow.phoneFromJid(message?.key?.remoteJid);
      const lead = phone && leadsByPhone.get(phone);
      if (!lead) continue;

      const at = nextFlow.messageTime(message);
      const sinceMs = sinceForLead(lead);
      if (at < sinceMs) continue;

      const previous = inbound.get(phone);
      if (!previous || at > previous.at) {
        inbound.set(phone, { at, text: nextFlow.extractText(message) });
      }
    }
  }
  return inbound;
}

async function loadOpenInstances(nextFlow) {
  try {
    return await nextFlow.openInstances();
  } catch (error) {
    throw httpError(503, `读取 WhatsApp Phone Health 失败: ${error.message}`);
  }
}

export function registerNextFlowRoutes(router) {
  router.post("/api/next-flow/scan-replies", async (_req, res, runtime) => {
    const nextFlow = requireNextFlow(runtime);
    const runner = nextFlow.getRunner();
    if (!runner || !runner.state) {
      json(res, 200, { ok: true, replies: [] });
      return;
    }
    requireBlastDatabase(nextFlow);

    const state = runner.state;
    state.repliesSeen = state.repliesSeen || {};
    const startMs = new Date(state.startAt || Date.now()).getTime();
    const runPhones = new Map();
    for (const job of state.assignments || []) {
      const phone = nextFlow.normalizePhone(job.lead?.phone);
      if (phone) runPhones.set(phone, job.lead?.name || phone);
    }

    let instances;
    try {
      instances = await nextFlow.openInstances();
    } catch {
      json(res, 200, { ok: true, replies: Object.values(state.repliesSeen), evoOffline: true });
      return;
    }

    const leadsByPhone = new Map([...runPhones.entries()].map(([phone, name]) => [phone, { phone, name }]));
    const inbound = await latestInboundReplies(nextFlow, instances, leadsByPhone, () => startMs);
    for (const [phone, event] of inbound) {
      if (state.repliesSeen[phone]) continue;
      const verdict = nextFlow.classifyReplyText(event.text);
      const record = {
        phone,
        name: runPhones.get(phone),
        signal: verdict.signal,
        route: verdict.route,
        status: verdict.status,
        text: (event.text || "").slice(0, 80),
      };
      state.repliesSeen[phone] = record;

      try {
        const page = await queryLeadPage(nextFlow, phone);
        if (page) await writeReplyToNotion(nextFlow, page, verdict, event.at, event.text);
      } catch {
        // Keep the in-memory reply record even when Notion is temporarily unavailable.
      }

      try {
        await creditReplyMetrics(nextFlow, state, phone, verdict.signal);
      } catch {
        // Reply analytics are best-effort; sending state must keep moving.
      }
    }

    json(res, 200, { ok: true, replies: Object.values(state.repliesSeen) });
  });

  router.get("/api/next-flow/list", async (_req, res, runtime) => {
    const nextFlow = requireNextFlow(runtime);
    if (!nextFlow.blastDatabaseId) {
      json(res, 200, { ok: true, leads: [] });
      return;
    }

    const today = nextFlow.klTodayKL();
    const filter = { and: [
      { property: "Sequence Status", select: { equals: "Running" } },
      { property: "Follow Up Due", date: { on_or_before: today } },
      { property: "Stop Flag", checkbox: { equals: false } },
      { property: "Status", select: { does_not_equal: "Stop" } },
      { property: "Status", select: { does_not_equal: "Not Interested" } },
      { property: "Status", select: { does_not_equal: "Appointment" } },
      { property: "Status", select: { does_not_equal: "Invalid" } },
    ] };

    const leads = [];
    let cursor;
    try {
      do {
        const body = { filter, page_size: 100 };
        if (cursor) body.start_cursor = cursor;
        const data = await nextFlow.notion("POST", `/databases/${nextFlow.blastDatabaseId}/query`, body);
        for (const page of data?.results ?? []) {
          const phone = nextFlow.normalizePhone(nextFlow.nfPhone(page, "Phone"));
          const next = nextFlow.nfSelect(page, "Next Flow");
          if (!phone || !next || next === "Completed") continue;
          leads.push({
            pageId: page.id,
            name: nextFlow.nfTitle(page, "Name") || phone,
            phone,
            project: nextFlow.nfSelect(page, "Project") || "Unknown",
            nextFlow: next,
            cohortDay: nextFlow.nfSelect(page, "Cohort Day"),
            lastReply: nextFlow.nfText(page, "Last Reply Text"),
            lastBlastAt: page?.properties?.["Last Blast At"]?.date?.start || null,
          });
        }
        cursor = data?.has_more ? data?.next_cursor : null;
      } while (cursor);
    } catch (error) {
      throw httpError(502, `读取 Notion Next Flow 名单失败: ${error.message}`);
    }

    const skipped = [];
    let evoOffline = false;
    if (leads.length) {
      let instances = [];
      try {
        instances = await loadOpenInstances(nextFlow);
      } catch {
        evoOffline = true;
      }

      if (!evoOffline && instances.length) {
        const byPhone = new Map(leads.map((lead) => [lead.phone, lead]));
        const inbound = await latestInboundReplies(nextFlow, instances, byPhone, (lead) =>
          lead.lastBlastAt ? new Date(lead.lastBlastAt).getTime() : Date.now() - 7 * 864e5);

        for (const [phone, event] of inbound) {
          const lead = byPhone.get(phone);
          const verdict = nextFlow.classifyReplyText(event.text);
          skipped.push({
            name: lead.name,
            phone,
            signal: verdict.signal,
            route: verdict.route,
            text: (event.text || "").slice(0, 80),
          });
          try {
            await writeReplyToNotion(nextFlow, { id: lead.pageId }, verdict, event.at, event.text, "(picker 开单前检测)");
            await sleep(200);
          } catch {
            // Notion write failed, but the picker still removes this lead to avoid a wrong send.
          }
        }

        if (skipped.length) {
          const skipPhones = new Set(skipped.map((item) => item.phone));
          for (let i = leads.length - 1; i >= 0; i -= 1) {
            if (skipPhones.has(leads[i].phone)) leads.splice(i, 1);
          }
        }
      } else {
        evoOffline = true;
      }
    }

    json(res, 200, { ok: true, today, leads, skipped, evoOffline });
  });

  router.post("/api/next-flow/redflag", async (req, res, runtime) => {
    const nextFlow = requireNextFlow(runtime);
    requireBlastDatabase(nextFlow);
    const body = await readJson(req);
    const ids = Array.isArray(body.pageIds) ? body.pageIds : [];
    let done = 0;

    for (const id of ids) {
      try {
        await nextFlow.notion("PATCH", `/pages/${pageId(id)}`, { properties: {
          "Stop Flag": { checkbox: true },
          "Sequence Status": { select: { name: "Stopped" } },
          "Stop Reason": { rich_text: [{ text: { content: "Manual: marked 不发 in picker" } }] },
        } });
        done += 1;
        await sleep(200);
      } catch {
        // Skip a failed page and report the successful count.
      }
    }

    json(res, 200, { ok: true, flagged: done });
  });

  router.post("/api/next-flow/load", async (req, res, runtime) => {
    const nextFlow = requireNextFlow(runtime);
    const runner = nextFlow.getRunner();
    if (runner && runner.running) throw httpError(409, "campaign 正在运行，请先停止。");

    const body = await readJson(req);
    let project;
    try {
      ({ project } = await nextFlow.getProject(body.project));
    } catch (error) {
      throw httpError(500, `读取 project 失败: ${error.message}`);
    }

    const incoming = Array.isArray(body.leads) ? body.leads : [];
    const seen = new Set();
    const leads = [];
    for (const item of incoming) {
      const phone = nextFlow.normalizePhone(item.phone);
      if (!phone || seen.has(phone)) continue;
      seen.add(phone);
      leads.push({
        id: `pick_${String(leads.length + 1).padStart(5, "0")}`,
        name: String(item.name ?? "").trim() || "there",
        phone,
      });
    }
    if (!leads.length) throw httpError(400, "没有可发送的选中客户。");

    nextFlow.setLeadsCache({ projectId: project.id, leads, rejected: [], sourcePath: "(next-flow picker)" });
    json(res, 200, { ok: true, project: project.id, loaded: leads.length });
  });

  router.post("/api/next-flow/set-flow", async (req, res, runtime) => {
    const nextFlow = requireNextFlow(runtime);
    requireBlastDatabase(nextFlow);
    const body = await readJson(req);
    const targetFlow = String(body.nextFlow ?? "").trim();
    const target = nextFlow.flowByLabel(targetFlow);
    if (!target) throw httpError(400, `未知的 Next Flow: ${targetFlow}`);
    const previous = nextFlow.flowSequence.find((flow) => flow.next === target.key);

    const raw = Array.isArray(body.phones) ? body.phones : String(body.phones ?? "").split(/[\s,;]+/);
    const phones = [...new Set(raw.map(nextFlow.normalizePhone).filter(Boolean))];
    if (!phones.length) throw httpError(400, "没有有效的电话号码。");

    const props = {
      "Next Flow": { select: { name: target.label } },
      "Sequence Status": { select: { name: "Running" } },
      "Cohort Day": { select: { name: previous ? previous.cohortDay : "Day 0" } },
      "Follow Up Due": { date: { start: nextFlow.klTodayKL() } },
    };
    if (previous) props["Last Flow Sent"] = { select: { name: previous.label } };

    let set = 0;
    let skippedStop = 0;
    const notFound = [];
    for (const phone of phones) {
      const page = await queryLeadPage(nextFlow, phone);
      if (!page) {
        notFound.push(phone);
        continue;
      }
      if (page.properties?.["Stop Flag"]?.checkbox === true) {
        skippedStop += 1;
        continue;
      }
      await nextFlow.notion("PATCH", `/pages/${pageId(page.id)}`, { properties: props });
      set += 1;
      await sleep(220);
    }

    json(res, 200, {
      ok: true,
      nextFlow: target.label,
      set,
      skippedStop,
      notFound: notFound.length,
      notFoundSample: notFound.slice(0, 15),
    });
  });

  router.post("/api/next-flow/set-group", async (req, res, runtime) => {
    const nextFlow = requireNextFlow(runtime);
    requireBlastDatabase(nextFlow);
    const body = await readJson(req);
    const projectName = String(body.projectName ?? "").trim();
    const fromFlow = String(body.fromFlow ?? "").trim();
    const toFlow = String(body.toFlow ?? "").trim();
    const target = nextFlow.flowByLabel(toFlow);
    if (!projectName || !fromFlow) throw httpError(400, "缺少 projectName / fromFlow。");
    if (!target) throw httpError(400, `未知的目标 Flow: ${toFlow}`);
    const previous = nextFlow.flowSequence.find((flow) => flow.next === target.key);

    const props = {
      "Next Flow": { select: { name: target.label } },
      "Sequence Status": { select: { name: "Running" } },
      "Cohort Day": { select: { name: previous ? previous.cohortDay : "Day 0" } },
      "Follow Up Due": { date: { start: nextFlow.klTodayKL() } },
    };
    if (previous) props["Last Flow Sent"] = { select: { name: previous.label } };

    let cursor;
    let set = 0;
    let skippedStop = 0;
    do {
      const query = await nextFlow.notion("POST", `/databases/${nextFlow.blastDatabaseId}/query`, {
        filter: { and: [
          { property: "Project", select: { equals: projectName } },
          { property: "Next Flow", select: { equals: fromFlow } },
          { property: "Sequence Status", select: { equals: "Running" } },
        ] },
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      });
      for (const page of query?.results ?? []) {
        if (page.properties?.["Stop Flag"]?.checkbox === true) {
          skippedStop += 1;
          continue;
        }
        await nextFlow.notion("PATCH", `/pages/${pageId(page.id)}`, { properties: props });
        set += 1;
        await sleep(200);
      }
      cursor = query?.has_more ? query?.next_cursor : null;
    } while (cursor);

    json(res, 200, { ok: true, from: fromFlow, to: target.label, set, skippedStop });
  });

  router.post("/api/next-flow/preview-template", async (req, res, runtime) => {
    const nextFlow = requireNextFlow(runtime);
    requireBlastDatabase(nextFlow);
    const body = await readJson(req);
    const projectName = String(body.projectName ?? "").trim();
    const flow = String(body.flow ?? "").trim();
    if (!projectName || !flow) throw httpError(400, "缺少 projectName / flow。");

    let languages;
    try {
      languages = await nextFlow.fetchFlowTemplates(projectName, flow);
    } catch (error) {
      throw httpError(502, `读取 Notion 模板失败: ${error.message}`);
    }
    json(res, 200, { ok: true, projectName, flow, languages });
  });

  router.post("/api/next-flow/apply-templates", async (req, res, runtime) => {
    const nextFlow = requireNextFlow(runtime);
    requireBlastDatabase(nextFlow);
    const runner = nextFlow.getRunner();
    if (!runner || !runner.state) throw httpError(400, "请先 prepare。");
    if (runner.running) throw httpError(409, "campaign 正在运行。");

    const body = await readJson(req);
    const projectName = String(body.projectName ?? "").trim();
    const flow = String(body.flow ?? "").trim();
    if (!projectName || !flow) throw httpError(400, "缺少 projectName 或 flow。");

    let result;
    try {
      result = await nextFlow.applyNotionFlowTemplatesToState(runner.state, {
        projectName,
        flow,
        markFlowRun: true,
        credit: true,
      });
    } catch (error) {
      throw httpError(502, `套用 Notion 模板失败: ${error.message}`);
    }

    try {
      await runner.saveState();
    } catch (error) {
      throw httpError(500, `保存 next-flow 预览失败: ${error.message}`);
    }

    const sample = runner.state.assignments[0];
    json(res, 200, {
      ok: true,
      flow,
      project: projectName,
      languages: Object.keys(result.byLang),
      overridden: result.overridden,
      twoPart: Object.values(result.byLang).some((value) =>
        value.parts && Object.keys(value.parts).filter((part) => (value.parts[part] || []).length).length >= 2),
      sample: sample ? String(sample.part1Text || "").slice(0, 120) : "",
    });
  });
}
