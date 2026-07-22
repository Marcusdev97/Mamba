import { execFile } from "node:child_process";
import path from "node:path";
import { isResumableJobStatus } from "../campaign_core.mjs";
import { buildSenderKey, senderPhoneForInstance } from "./device-identity.mjs";

function pageId(id) {
  return String(id || "").replace(/[^a-fA-F0-9]/g, "");
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function createCampaignRunService({
  appDir,
  blastDatabaseId,
  notion,
  localDatabase,
  deviceIdentity = {},
  normalizePhone,
  nfSelect,
  nfAddDaysKL,
  klDateTime,
  flowByLabel,
  flowStateAfter,
  execFileFn = execFile,
}) {
  function klDateAfter(iso, days) {
    if (!Number.isFinite(Number(days))) return null;
    const date = new Date(iso || Date.now());
    if (!Number.isFinite(date.getTime())) return null;
    const shifted = new Date(date.getTime() + Number(days) * 86400000);
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kuala_Lumpur",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(shifted).reduce((result, part) => {
      result[part.type] = part.value;
      return result;
    }, {});
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  function latestSentAt(job) {
    return [
      job?.part1?.sentAt,
      job?.part2?.sentAt,
      ...(job?.extraParts || []).map((part) => part?.sentInfo?.sentAt),
    ].filter(Boolean).sort().at(-1) || null;
  }

  function completedForFlow(state, job) {
    if (job?.status !== "SENT" || !job?.part1?.sentAt) return false;
    // 新 run 必须有逐客户 SQLite commit 证据；旧 run 没有这个模式旗标，
    // 继续按历史 SENT 状态恢复，避免升级后无法补旧账。
    return state?.localCheckpointMode !== "PER_CUSTOMER_V1"
      || job?.localCheckpoint?.status === "SUCCEEDED";
  }

  function deferredNotionJob(state) {
    const runId = state?.runId || "";
    const flowLabel = state?.flowLabel || "";
    const suffix = flowLabel ? "flow_advance" : "flow1_upload";
    return {
      entityType: "campaign_run",
      entityId: runId,
      idempotencyKey: `LOCAL_TO_NOTION:campaign_run:${runId}:${suffix}`,
      payload: {
        runId,
        projectId: state?.projectId || state?.campaignId || "",
        project: typeof state?.project === "string" ? state.project : state?.project?.name || "",
        flowLabel,
        autoAdvance: Boolean(flowLabel),
        reason: "customer_checkpoint",
      },
    };
  }

  async function checkpointCompletedCustomer(runner, job) {
    const state = runner?.state;
    if (!localDatabase || !state || state.mode !== "LIVE" || job?.status !== "SENT" || !job?.part1?.sentAt) {
      return { recorded: 0, reason: "not_completed_live_customer" };
    }
    const flow = flowByLabel(state.flowLabel || state.templateFlow);
    const after = flow ? flowStateAfter(flow.key) : null;
    if (!flow || !after) throw new Error(`无法识别客户完成的 Flow: ${state.flowLabel || state.templateFlow || "(empty)"}`);
    const senderPhone = senderPhoneForInstance(state.instances, job.instanceName);
    const sentAt = latestSentAt(job) || job.part1.sentAt;
    const result = await localDatabase.recordCampaignFlowProgress({
      runId: state.runId,
      projectCode: state.projectId || state.campaignId,
      projectName: typeof state.project === "string" ? state.project : state.project?.name,
      flowLabel: flow.label,
      nextFlow: after.nextFlowLabel,
      cohortDay: after.cohortDay,
      sequenceStatus: after.nextFlowLabel === "Completed" ? "Completed" : "Running",
      mode: state.mode,
      runStatus: "RUNNING",
      deviceId: state.deviceId || deviceIdentity.id || "",
      startedAt: state.startAt || state.createdAt || null,
      finishedAt: null,
      assignments: [{
        phone: normalizePhone(job.lead?.phone),
        name: job.lead?.name || "",
        instanceName: job.instanceName || "",
        senderPhone,
        senderKey: buildSenderKey(state.deviceId, senderPhone),
        part1SentAt: job.part1?.sentAt || null,
        part2SentAt: job.part2?.sentAt || null,
        sentAt,
        dueDate: after.nextFlowLabel === "Completed" ? null : klDateAfter(sentAt, after.dueDays),
      }],
      // Flow 状态与 Notion 待办在同一个 SQLite transaction 里 commit。
      // 任何一边写失败都不能继续下一位客户。
      notionSyncJob: deferredNotionJob(state),
    });
    if (Number(result.recorded || 0) !== 1) {
      const error = new Error(`客户 ${job.lead?.name || job.lead?.phone || ""} 的本机 Flow 没有完整写入，Campaign 已暂停。`);
      error.code = "LOCAL_CUSTOMER_CHECKPOINT_INCOMPLETE";
      throw error;
    }
    job.localCheckpoint = {
      status: "SUCCEEDED",
      flowLabel: flow.label,
      nextFlow: after.nextFlowLabel,
      committedAt: new Date().toISOString(),
    };
    const completed = state.assignments.filter((item) => item?.localCheckpoint?.status === "SUCCEEDED").length;
    const remaining = state.assignments.some((item) => isResumableJobStatus(item.status));
    state.localAdvance = {
      status: remaining ? "RUNNING" : "SUCCEEDED",
      recorded: completed,
      total: state.assignments.length,
      flowLabel: flow.label,
      nextFlow: after.nextFlowLabel,
      updatedAt: new Date().toISOString(),
    };
    if (state.flowLabel) {
      state.advanceStatus = "WAITING";
      state.advanceDone = false;
    } else {
      state.notionSync = {
        ...(state.notionSync || {}),
        status: "WAITING",
        stage: "queued",
        message: "SQLite 已保存；等待晚上 22:00 或手动同步 Notion。",
        updatedAt: new Date().toISOString(),
      };
    }
    await runner.saveState();
    runner.pushLog?.(`SQLite 已完成 ${job.lead?.name || job.lead?.phone} · ${flow.label} → ${after.nextFlowLabel}；Notion 已排队。`);
    return { ...result, checkpoint: job.localCheckpoint };
  }

  // Actual provider acknowledgements are the source of truth. Persist them to
  // SQLite before any Notion query/PATCH so a STOP, crash or timeout cannot put
  // already-contacted customers back into the old Flow.
  async function recordLocalFlowProgress(runner, sentFlow = null, nextState = null) {
    const state = runner?.state;
    const flow = sentFlow || flowByLabel(state?.flowLabel || state?.templateFlow);
    const after = nextState || (flow ? flowStateAfter(flow.key) : null);
    if (!localDatabase || !state || state.mode !== "LIVE" || !flow || !after) {
      return { recorded: 0, reason: "not_live_flow_run" };
    }
    const sentFlowLabel = flow.label || state.flowLabel || after.lastFlowLabel || "";
    const assignments = (state.assignments || []).filter((job) => completedForFlow(state, job)).map((job) => {
      const senderPhone = senderPhoneForInstance(state.instances, job.instanceName);
      const sentAt = latestSentAt(job) || job.part1.sentAt;
      return {
        phone: normalizePhone(job.lead?.phone),
        name: job.lead?.name || "",
        instanceName: job.instanceName || "",
        senderPhone,
        senderKey: buildSenderKey(state.deviceId, senderPhone),
        part1SentAt: job.part1?.sentAt || null,
        part2SentAt: job.part2?.sentAt || null,
        sentAt,
        dueDate: after.nextFlowLabel === "Completed" ? null : klDateAfter(sentAt, after.dueDays),
      };
    });
    const runStatus = state.status === "COMPLETED"
      ? "COMPLETED"
      : state.status === "FAILED"
        ? "FAILED"
        : state.status === "STOPPED"
          ? "STOPPED"
          : "PARTIAL";
    state.localAdvance = {
      status: "RUNNING",
      recorded: 0,
      total: assignments.length,
      flowLabel: sentFlowLabel,
      nextFlow: after.nextFlowLabel,
      updatedAt: new Date().toISOString(),
    };
    await runner.saveState();
    const result = await localDatabase.recordCampaignFlowProgress({
      runId: state.runId,
      projectCode: state.projectId || state.campaignId,
      projectName: typeof state.project === "string" ? state.project : state.project?.name,
      flowLabel: sentFlowLabel,
      nextFlow: after.nextFlowLabel,
      cohortDay: after.cohortDay,
      sequenceStatus: after.nextFlowLabel === "Completed" ? "Completed" : "Running",
      mode: state.mode,
      runStatus,
      deviceId: state.deviceId || deviceIdentity.id || "",
      startedAt: state.startAt || state.createdAt || null,
      finishedAt: state.endAt || null,
      assignments,
      notionSyncJob: deferredNotionJob(state),
    });
    if (Number(result.recorded || 0) < assignments.length) {
      const error = new Error(`本机 Flow 只记到 ${result.recorded || 0}/${assignments.length} 位已发送客户；Notion 同步已暂停。`);
      error.code = "LOCAL_FLOW_WRITE_INCOMPLETE";
      throw error;
    }
    state.localAdvance = {
      status: "SUCCEEDED",
      recorded: result.recorded || 0,
      total: assignments.length,
      skipped: result.skipped || 0,
      flowLabel: sentFlowLabel,
      nextFlow: after.nextFlowLabel,
      updatedAt: new Date().toISOString(),
    };
    await runner.saveState();
    return result;
  }

  async function autoAdvanceFlow(runner) {
    if (!blastDatabaseId || !runner?.state?.assignments) return;
    let advanced = 0;
    let alreadyAdvanced = 0;
    let skippedSafety = 0;
    let notFound = 0;
    let flowMismatch = 0;
    const sentFlow = flowByLabel(runner.state.flowLabel);
    if (!sentFlow) throw new Error(`无法识别已发送 Flow: ${runner.state.flowLabel || "(empty)"}`);
    const nextState = flowStateAfter(sentFlow.key);
    const notionJobs = runner.state.assignments.filter((job) => completedForFlow(runner.state, job) && normalizePhone(job.lead?.phone));
    let notionCurrent = 0;

    runner.state.advanceDone = false;
    runner.state.advanceStatus = "RUNNING";
    runner.state.advanceError = null;
    runner.state.advanceSummary = null;
    runner.state.advanceProgress = {
      status: "WAITING",
      current: 0,
      total: notionJobs.length,
      currentItem: null,
      updatedAt: new Date().toISOString(),
    };
    await runner.saveState();
    runner.pushLog?.(`正在把 ${runner.state.flowLabel} 发送结果先写进本机资料库…`);

    try {
      const local = await recordLocalFlowProgress(runner, sentFlow, nextState);
      runner.pushLog?.(`本机 Flow 状态已保存:${local.recorded || 0} 人。现在同步 Notion…`);
      runner.state.advanceProgress.status = "RUNNING";
      runner.state.advanceProgress.updatedAt = new Date().toISOString();
      await runner.saveState();
      for (const job of runner.state.assignments) {
        if (!completedForFlow(runner.state, job)) continue;
        const phone = normalizePhone(job.lead?.phone);
        if (!phone) continue;
        let outcome = "CHECKING";
        try {
          const query = await notion("POST", `/databases/${blastDatabaseId}/query`, {
            filter: runner.state.project
              ? { and: [
                  { property: "Phone", phone_number: { equals: phone } },
                  { property: "Project", select: { equals: runner.state.project } },
                ] }
              : { property: "Phone", phone_number: { equals: phone } },
            page_size: 1,
          });
          const page = query?.results?.[0];
          if (!page) {
            notFound += 1;
            outcome = "NOT_FOUND";
            continue;
          }
          if (page.properties?.["Stop Flag"]?.checkbox === true || nfSelect(page, "Sequence Status") !== "Running") {
            skippedSafety += 1;
            outcome = "SKIPPED_SAFETY";
            continue;
          }

          const currentNext = nfSelect(page, "Next Flow");
          if (currentNext === nextState.nextFlowLabel && nfSelect(page, "Last Flow Sent") === nextState.lastFlowLabel) {
            alreadyAdvanced += 1;
            outcome = "ALREADY_SYNCED";
            continue;
          }
          if (currentNext !== runner.state.flowLabel) {
            flowMismatch += 1;
            outcome = "FLOW_MISMATCH";
            continue;
          }
          const senderPhone = senderPhoneForInstance(runner.state.instances, job.instanceName);
          // An old restored run must not inherit the identity of the computer that
          // happens to process it. Only an ID persisted in the run is trustworthy.
          const senderKey = buildSenderKey(runner.state.deviceId, senderPhone);
          const props = {
            "Last Flow Sent": { select: { name: nextState.lastFlowLabel } },
            "Next Flow": { select: { name: nextState.nextFlowLabel } },
            "Cohort Day": { select: { name: nextState.cohortDay } },
            "Last Blast At": { date: { start: job.part2?.sentAt ?? job.part1?.sentAt } },
            "Sender Instance": { select: { name: job.instanceName || "Unknown" } },
            "Campaign Run ID": { rich_text: [{ text: { content: runner.state.runId || "" } }] },
          };
          if (senderKey) {
            props["Assigned Sender Key"] = { rich_text: [{ text: { content: senderKey } }] };
            props["Last Sender Key"] = { rich_text: [{ text: { content: senderKey } }] };
          }
          if (runner.state.deviceId) props["Last Sent By Device"] = { rich_text: [{ text: { content: runner.state.deviceId } }] };
          if (senderKey && senderPhone) props["Last Sender Phone"] = { phone_number: senderPhone };
          if (nextState.nextFlowLabel === "Completed") {
            props["Sequence Status"] = { select: { name: "Completed" } };
            props["Flow Completed At"] = { date: { start: new Date().toISOString() } };
            props["Follow Up Due"] = { date: null };
          } else {
            props["Follow Up Due"] = { date: { start: nfAddDaysKL(nextState.dueDays) } };
          }

          await notion("PATCH", `/pages/${pageId(page.id)}`, { properties: props });
          advanced += 1;
          outcome = "SYNCED";
          await new Promise((resolve) => setTimeout(resolve, 250));
        } finally {
          notionCurrent += 1;
          runner.state.advanceProgress = {
            ...runner.state.advanceProgress,
            status: "RUNNING",
            current: notionCurrent,
            total: notionJobs.length,
            currentItem: { name: job.lead?.name || phone, phone, outcome },
            updatedAt: new Date().toISOString(),
          };
          await runner.saveState();
        }
      }
      const issueCount = notFound + flowMismatch;
      runner.state.advanceDone = issueCount === 0;
      runner.state.advanceStatus = issueCount ? "PARTIAL" : "SUCCEEDED";
      runner.state.advanceError = issueCount
        ? `${notFound} 个 Notion row 找不到，${flowMismatch} 个客户的 Next Flow 与本轮不一致。`
        : null;
      runner.state.advanceSummary = { advanced, alreadyAdvanced, skippedSafety, notFound, flowMismatch };
      runner.state.advanceProgress = {
        ...runner.state.advanceProgress,
        status: issueCount ? "PARTIAL" : "SUCCEEDED",
        current: notionCurrent,
        total: notionJobs.length,
        finishedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await runner.saveState();
      if (issueCount) {
        runner.pushLog?.(`Flow 状态只完成一部分:推进 ${advanced}，已推进 ${alreadyAdvanced}，找不到 ${notFound}，Flow 不一致 ${flowMismatch}。`);
        await runner.systemLog?.("warn", "flow_advance_partial", "Notion Flow advance completed partially.", {
          flowLabel: runner.state.flowLabel,
          ...runner.state.advanceSummary,
        });
      } else {
        runner.pushLog?.(`Flow 状态已自动推进:${advanced} 人进入下一轮${alreadyAdvanced ? `，${alreadyAdvanced} 人之前已推进` : ""}。`);
        await runner.systemLog?.("info", "flow_advance_succeeded", "Notion Flow advance completed.", {
          flowLabel: runner.state.flowLabel,
          ...runner.state.advanceSummary,
        });
      }
    } catch (error) {
      if (runner.state.localAdvance?.status !== "SUCCEEDED") {
        runner.state.localAdvance = {
          ...(runner.state.localAdvance || {}),
          status: "FAILED",
          error: error.message,
          updatedAt: new Date().toISOString(),
        };
      }
      runner.state.advanceDone = false;
      runner.state.advanceStatus = "FAILED";
      runner.state.advanceError = error.message;
      runner.state.advanceSummary = { advanced, alreadyAdvanced, skippedSafety, notFound, flowMismatch };
      runner.state.advanceProgress = {
        ...(runner.state.advanceProgress || {}),
        status: "FAILED",
        error: error.message,
        finishedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await runner.saveState().catch(() => {});
      runner.pushLog?.(`自动推进 Flow 失败:${error.message}`);
      await runner.systemLog?.("error", "flow_advance_failed", "Notion Flow advance failed.", {
        flowLabel: runner.state.flowLabel,
        error: error.message,
        ...runner.state.advanceSummary,
      });
      throw error;
    }
  }

  async function saveNotionSync(runner, patch) {
    const previous = runner?.state?.notionSync || {};
    runner.state.notionSync = {
      ...previous,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    try {
      await runner.saveState();
    } catch (error) {
      runner.pushLog?.(`保存 Notion 更新状态失败:${error.message}`);
    }
    return runner.state.notionSync;
  }

  async function autoNotionUpload(runner, { allowPartial = false } = {}) {
    if (!runner?.runPath || runner?.state?.mode !== "LIVE" || runner.state.flowLabel) {
      return null;
    }
    const pending = (runner.state.assignments || []).filter((job) => isResumableJobStatus(job.status)).length;
    if (pending && !allowPartial) {
      runner.pushLog?.(`Notion 收尾已暂停：本轮仍有 ${pending} 个客户未处理。先恢复发送，避免把半完成批次当成已结束。`);
      return { status: "BLOCKED", reason: "unfinished-campaign", pending };
    }

    const startedAt = new Date().toISOString();
    await saveNotionSync(runner, {
      status: "RUNNING",
      stage: "blast_leads",
      message: "正在把本轮发送结果更新到 Notion…",
      startedAt,
      finishedAt: null,
      error: null,
      progress: {
        status: "RUNNING",
        current: 0,
        total: (runner.state.assignments || []).filter((job) => completedForFlow(runner.state, job) && normalizePhone(job.lead?.phone)).length,
        currentItem: null,
      },
    });
    runner.pushLog?.("正在自动上传 blast 名单到 Notion…");

    try {
      const result = await new Promise((resolve, reject) => {
        let streamBuffer = "";
        let progressSave = Promise.resolve();
        const child = execFileFn(
          process.execPath,
          [path.join(appDir, "notion_upload.mjs"), runner.runPath],
          { cwd: appDir, maxBuffer: 4 * 1024 * 1024 },
          async (error, stdout, stderr) => {
            await progressSave.catch(() => {});
            if (error) {
              error.uploadDetail = String(stderr || error.message || "Unknown Notion upload error").trim();
              reject(error);
              return;
            }
            resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
          },
        );
        child?.stdout?.setEncoding?.("utf8");
        child?.stdout?.on?.("data", (chunk) => {
          streamBuffer += String(chunk || "");
          const lines = streamBuffer.split(/\r?\n/);
          streamBuffer = lines.pop() || "";
          for (const line of lines) {
            if (!line.startsWith("MAMBA_PROGRESS ")) continue;
            try {
              const progress = JSON.parse(line.slice("MAMBA_PROGRESS ".length));
              progressSave = progressSave.then(() => saveNotionSync(runner, {
                progress: {
                  ...progress,
                  currentItem: progress.name || progress.phone
                    ? { name: progress.name || progress.phone, phone: progress.phone || null, outcome: progress.outcome || null }
                    : null,
                },
              }));
            } catch { /* Human-readable upload output must not break the campaign. */ }
          }
        });
      });

      await saveNotionSync(runner, {
        status: "SUCCEEDED",
        message: "Notion 已更新完成，可以安全刷新或关闭页面。",
        finishedAt: new Date().toISOString(),
        error: null,
        output: result.stdout.trim().slice(-500) || null,
        progress: {
          ...(runner.state.notionSync?.progress || {}),
          status: "SUCCEEDED",
          finishedAt: new Date().toISOString(),
        },
      });
      runner.pushLog?.("Blast 名单已自动上传到 Notion ✅");
      await runner.systemLog?.("info", "notion_upload_succeeded", "Campaign results uploaded to Notion.", {
        finishedAt: runner.state.notionSync.finishedAt,
      });
      return runner.state.notionSync;
    } catch (error) {
      const detail = String(error.uploadDetail || error.message || "Unknown Notion upload error").trim().slice(0, 500);
      await saveNotionSync(runner, {
        status: "FAILED",
        message: "Notion 没有收到本轮更新，但 WhatsApp 发送结果已安全保留在本机。",
        finishedAt: new Date().toISOString(),
        error: detail,
        progress: {
          ...(runner.state.notionSync?.progress || {}),
          status: "FAILED",
          error: detail,
          finishedAt: new Date().toISOString(),
        },
      });
      runner.pushLog?.(`自动上传 Notion 失败:${detail} —— 可在控制台点「上传 Blast 名单到 Notion(手动补跑)」`);
      await runner.systemLog?.("error", "notion_upload_failed", "Campaign results failed to upload to Notion.", {
        error: detail,
        finishedAt: runner.state.notionSync.finishedAt,
      });
      return runner.state.notionSync;
    }
  }

  async function recoverPendingUpdates(runner) {
    const state = runner?.state;
    if (!state || state.mode !== "LIVE" || state.status !== "COMPLETED") {
      return { recovered: false, reason: "not-a-finished-live-run" };
    }
    const pending = (state.assignments || []).filter((job) => isResumableJobStatus(job.status)).length;
    if (pending) return { recovered: false, reason: "unfinished-campaign", pending };
    if (state.flowLabel && state.advanceStatus === "SUCCEEDED") {
      return { recovered: false, reason: "flow-already-synced" };
    }
    if (!state.flowLabel && state.notionSync?.status === "SUCCEEDED") {
      return { recovered: false, reason: "notion-already-synced" };
    }

    // 服务重启只补齐 SQLite 与 outbox，不直接碰 Notion。这样 Flow 1 与
    // Flow 2-10 都遵守同一条规则：晚上 22:00 或用户手动触发才上传。
    const local = await recordLocalFlowProgress(runner);
    if (state.flowLabel) {
      state.advanceStatus = "WAITING";
      state.advanceDone = false;
    } else {
      state.notionSync = {
        ...(state.notionSync || {}),
        status: "WAITING",
        stage: "queued",
        message: "SQLite 已恢复完成；等待晚上 22:00 或手动同步 Notion。",
        updatedAt: new Date().toISOString(),
      };
    }
    await runner.saveState();
    return {
      recovered: true,
      kind: state.flowLabel ? "flow-advance-queued" : "flow-1-upload-queued",
      status: "WAITING",
      recorded: local.recorded || 0,
    };
  }

  async function incPageNumber(pageIdValue, prop, delta) {
    if (!pageIdValue || !delta) return;
    const id = pageId(pageIdValue);
    try {
      const page = await notion("GET", `/pages/${id}`);
      const current = Number(page?.properties?.[prop]?.number ?? 0);
      await notion("PATCH", `/pages/${id}`, { properties: { [prop]: { number: current + delta } } });
    } catch {
      // Best-effort analytics; never block sending because a counter update failed.
    }
  }

  async function creditSentCounts(runner) {
    if (!runner?.state || runner.state.credited) return;
    runner.state.credited = true;
    const byLang = runner.state.creditByLang || {};
    const tally = {};

    for (const job of runner.state.assignments) {
      if (!completedForFlow(runner.state, job)) continue;
      let credits = job.tplCredit;
      if (!credits) {
        const language = String(job.language || "en").toUpperCase();
        const templates = byLang[language] || byLang[Object.keys(byLang)[0]] || {};
        credits = [(templates.p1 || [])[0], (templates.p2 || [])[0]]
          .filter((item) => item && item.pageId)
          .map((item) => ({ pageId: item.pageId, imagePageId: item.imagePageId }));
      }
      for (const credit of credits) {
        if (credit?.pageId) {
          tally[credit.pageId] = tally[credit.pageId] || { count: 0, imagePageId: credit.imagePageId };
          tally[credit.pageId].count += 1;
        }
      }
    }

    for (const [templatePageId, value] of Object.entries(tally)) {
      await incPageNumber(templatePageId, "Sent Count", value.count);
      if (value.imagePageId) await incPageNumber(value.imagePageId, "Sent Count", value.count);
    }
    try {
      await runner.saveState();
    } catch {
      // Ignore save failures here; the run itself has already completed.
    }
    runner.pushLog?.(`已更新 Sent Count(${Object.keys(tally).length} 个模板)。`);
  }

  function emptySnapshot() {
    return { running: false, stopped: false, state: null, log: [] };
  }

  function buildCsv(state) {
    const headers = ["name", "phone", "instance", "language", "status", "scheduled_time", "part1_sent_at", "part2_sent_at", "error"];
    const rows = state.assignments.map((job) => [
      job.lead.name,
      job.lead.phone,
      job.instanceName,
      job.language,
      job.status,
      klDateTime(job.scheduledAt),
      klDateTime(job.part1?.sentAt),
      klDateTime(job.part2?.sentAt),
      job.error ?? "",
    ]);
    return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
  }

  return {
    recordLocalFlowProgress,
    checkpointCompletedCustomer,
    autoAdvanceFlow,
    autoNotionUpload,
    recoverPendingUpdates,
    incPageNumber,
    creditSentCounts,
    emptySnapshot,
    buildCsv,
  };
}
