import { execFile } from "node:child_process";
import path from "node:path";

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
  normalizePhone,
  nfSelect,
  nfAddDaysKL,
  klDateTime,
  flowByLabel,
  flowStateAfter,
  execFileFn = execFile,
}) {
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

    runner.state.advanceDone = false;
    runner.state.advanceStatus = "RUNNING";
    runner.state.advanceError = null;
    runner.state.advanceSummary = null;
    await runner.saveState();
    runner.pushLog?.(`正在更新 Notion Flow 状态:${runner.state.flowLabel}…`);

    try {
      for (const job of runner.state.assignments) {
        if (!job.part1?.sentAt) continue;
        const phone = normalizePhone(job.lead?.phone);
        if (!phone) continue;

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
          continue;
        }
        if (page.properties?.["Stop Flag"]?.checkbox === true || nfSelect(page, "Sequence Status") !== "Running") {
          skippedSafety += 1;
          continue;
        }

        const currentNext = nfSelect(page, "Next Flow");
        if (currentNext === nextState.nextFlowLabel && nfSelect(page, "Last Flow Sent") === nextState.lastFlowLabel) {
          alreadyAdvanced += 1;
          continue;
        }
        if (currentNext !== runner.state.flowLabel) {
          flowMismatch += 1;
          continue;
        }
        const props = {
          "Last Flow Sent": { select: { name: nextState.lastFlowLabel } },
          "Next Flow": { select: { name: nextState.nextFlowLabel } },
          "Cohort Day": { select: { name: nextState.cohortDay } },
          "Last Blast At": { date: { start: job.part2?.sentAt ?? job.part1?.sentAt } },
        };
        if (nextState.nextFlowLabel === "Completed") {
          props["Sequence Status"] = { select: { name: "Completed" } };
          props["Flow Completed At"] = { date: { start: new Date().toISOString() } };
          props["Follow Up Due"] = { date: null };
        } else {
          props["Follow Up Due"] = { date: { start: nfAddDaysKL(nextState.dueDays) } };
        }

        await notion("PATCH", `/pages/${pageId(page.id)}`, { properties: props });
        advanced += 1;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const issueCount = notFound + flowMismatch;
      runner.state.advanceDone = issueCount === 0;
      runner.state.advanceStatus = issueCount ? "PARTIAL" : "SUCCEEDED";
      runner.state.advanceError = issueCount
        ? `${notFound} 个 Notion row 找不到，${flowMismatch} 个客户的 Next Flow 与本轮不一致。`
        : null;
      runner.state.advanceSummary = { advanced, alreadyAdvanced, skippedSafety, notFound, flowMismatch };
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
      runner.state.advanceDone = false;
      runner.state.advanceStatus = "FAILED";
      runner.state.advanceError = error.message;
      runner.state.advanceSummary = { advanced, alreadyAdvanced, skippedSafety, notFound, flowMismatch };
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

  async function autoNotionUpload(runner) {
    if (!runner?.runPath || runner?.state?.mode !== "LIVE" || runner.state.flowLabel) {
      return null;
    }

    const startedAt = new Date().toISOString();
    await saveNotionSync(runner, {
      status: "RUNNING",
      stage: "blast_leads",
      message: "正在把本轮发送结果更新到 Notion…",
      startedAt,
      finishedAt: null,
      error: null,
    });
    runner.pushLog?.("正在自动上传 blast 名单到 Notion…");

    try {
      const result = await new Promise((resolve, reject) => {
        execFileFn(
          process.execPath,
          [path.join(appDir, "notion_upload.mjs"), runner.runPath],
          { cwd: appDir, maxBuffer: 4 * 1024 * 1024 },
          (error, stdout, stderr) => {
            if (error) {
              error.uploadDetail = String(stderr || error.message || "Unknown Notion upload error").trim();
              reject(error);
              return;
            }
            resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
          },
        );
      });

      await saveNotionSync(runner, {
        status: "SUCCEEDED",
        message: "Notion 已更新完成，可以安全刷新或关闭页面。",
        finishedAt: new Date().toISOString(),
        error: null,
        output: result.stdout.trim().slice(-500) || null,
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
        message: "Notion 更新失败。发送结果仍保留在本机，请查看错误后手动补跑。",
        finishedAt: new Date().toISOString(),
        error: detail,
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
    if (!state || state.mode !== "LIVE" || !["COMPLETED", "STOPPED"].includes(state.status)) {
      return { recovered: false, reason: "not-a-finished-live-run" };
    }
    if (state.flowLabel) {
      if (state.advanceStatus === "SUCCEEDED") return { recovered: false, reason: "flow-already-synced" };
      await autoAdvanceFlow(runner);
      await creditSentCounts(runner);
      return { recovered: true, kind: "flow-advance", status: runner.state.advanceStatus };
    }
    if (state.notionSync?.status === "SUCCEEDED") return { recovered: false, reason: "notion-already-synced" };
    const result = await autoNotionUpload(runner);
    return { recovered: true, kind: "flow-1-upload", status: result?.status || null };
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
      if (!job.part1?.sentAt) continue;
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
    autoAdvanceFlow,
    autoNotionUpload,
    recoverPendingUpdates,
    incPageNumber,
    creditSentCounts,
    emptySnapshot,
    buildCsv,
  };
}
