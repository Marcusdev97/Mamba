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
    try {
      for (const job of runner.state.assignments) {
        if (!job.part1?.sentAt) continue;
        const phone = normalizePhone(job.lead?.phone);
        if (!phone) continue;

        const query = await notion("POST", `/databases/${blastDatabaseId}/query`, {
          filter: { property: "Phone", phone_number: { equals: phone } },
          page_size: 1,
        });
        const page = query?.results?.[0];
        if (!page) continue;
        if (page.properties?.["Stop Flag"]?.checkbox === true) continue;
        if (nfSelect(page, "Sequence Status") !== "Running") continue;

        const currentNext = nfSelect(page, "Next Flow");
        if (runner.state.flowLabel && currentNext !== runner.state.flowLabel) continue;
        const sentFlow = flowByLabel(currentNext);
        if (!sentFlow) continue;
        const state = flowStateAfter(sentFlow.key);
        const props = {
          "Last Flow Sent": { select: { name: state.lastFlowLabel } },
          "Next Flow": { select: { name: state.nextFlowLabel } },
          "Cohort Day": { select: { name: state.cohortDay } },
          "Last Blast At": { date: { start: job.part2?.sentAt ?? job.part1?.sentAt } },
        };
        if (state.nextFlowLabel === "Completed") {
          props["Sequence Status"] = { select: { name: "Completed" } };
          props["Flow Completed At"] = { date: { start: new Date().toISOString() } };
          props["Follow Up Due"] = { date: null };
        } else {
          props["Follow Up Due"] = { date: { start: nfAddDaysKL(state.dueDays) } };
        }

        await notion("PATCH", `/pages/${pageId(page.id)}`, { properties: props });
        advanced += 1;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      runner.state.advanceDone = true;
      await runner.saveState();
      runner.pushLog?.(`Flow 状态已自动推进:${advanced} 人进入下一轮。`);
    } catch (error) {
      runner.state.advanceDone = true;
      await runner.saveState().catch(() => {});
      runner.pushLog?.(`自动推进 Flow 出错:${error.message}`);
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
    incPageNumber,
    creditSentCounts,
    emptySnapshot,
    buildCsv,
  };
}
