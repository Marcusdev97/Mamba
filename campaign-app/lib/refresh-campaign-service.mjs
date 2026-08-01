import crypto from "node:crypto";
import {
  DEFAULT_REFRESH_COOLDOWN_DAYS,
  evaluateRefreshLead,
  normalizeRefreshCooldownDays,
  REFRESH_TEMPLATE_FLOW,
  summarizeRefreshExclusions,
} from "../domain/refresh-campaign-eligibility.mjs";
import { isResumableJobStatus } from "../campaign_core.mjs";

function clean(value) {
  return String(value || "").trim();
}

function projectMatches(record, project) {
  const wanted = [project?.id, project?.name].map((value) => clean(value).toLowerCase()).filter(Boolean);
  const actual = [record?.projectCode, record?.project].map((value) => clean(value).toLowerCase()).filter(Boolean);
  return actual.some((value) => wanted.includes(value));
}

function tokenFor({ projectId, cooldownDays, eligible, excluded }) {
  const payload = {
    projectId,
    cooldownDays,
    eligible: eligible.map((item) => [item.phone, item.id, item.lastBlastAt]),
    excluded: excluded.map((item) => [item.phone, item.reason]),
  };
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function activeCampaignPhones(runners, ignoreRunId = "") {
  const phones = new Set();
  for (const runner of runners || []) {
    const state = runner?.state;
    if (!state || state.runId === ignoreRunId) continue;
    const isActive = runner.running
      || ["READY", "READY_TEST", "QUEUED_BATCH", "RUNNING", "STOPPED", "INTERRUPTED"].includes(state.status);
    if (!isActive) continue;
    for (const job of state.assignments || []) {
      if (isResumableJobStatus(job.status) || job.status === "QUEUED") {
        const phone = clean(job.lead?.phone);
        if (phone) phones.add(phone);
      }
    }
  }
  return phones;
}

export function createRefreshCampaignService({
  getProject,
  syncLeadStore,
  normalizePhone,
  loadSuppressedPhones,
  workInboxIgnore,
  conversationLog,
  listRunners,
  createLeadGroup,
  setLeadsCache,
  clock = () => new Date(),
} = {}) {
  if (!getProject || !syncLeadStore || !normalizePhone || !createLeadGroup || !setLeadsCache) {
    throw new Error("Refresh Campaign service 缺少必要 dependency。");
  }

  async function preview({ projectId, cooldownDays = DEFAULT_REFRESH_COOLDOWN_DAYS, ignoreRunId = "" } = {}) {
    const { project } = await getProject(projectId);
    const days = normalizeRefreshCooldownDays(cooldownDays);

    // Refresh 名单必须来自当下的 Notion mirror。读取失败就停止，不用旧名单猜。
    const store = await syncLeadStore({ force: true });
    const records = (store?.records || []).filter((record) => projectMatches(record, project));
    const phones = [...new Set(records.map((record) => normalizePhone(record.phone)).filter(Boolean))];
    const [suppressed, privateSnapshot, activity] = await Promise.all([
      loadSuppressedPhones ? loadSuppressedPhones() : Promise.resolve(new Set()),
      workInboxIgnore?.snapshot ? workInboxIgnore.snapshot() : Promise.resolve({ entries: [] }),
      conversationLog?.refreshActivity ? conversationLog.refreshActivity(phones) : Promise.resolve(new Map()),
    ]);
    const privatePhones = new Set((privateSnapshot?.entries || []).map((item) => normalizePhone(item.phone)).filter(Boolean));
    const activePhones = activeCampaignPhones(listRunners?.() || [], ignoreRunId);
    const seenPhones = new Set();
    const eligible = [];
    const excluded = [];
    const checkedAt = clock();

    for (const record of records) {
      const phone = normalizePhone(record.phone);
      const result = evaluateRefreshLead(record, {
        phone,
        now: checkedAt,
        cooldownDays: days,
        suppressedPhones: suppressed,
        privatePhones,
        activePhones,
        activity: activity.get(phone),
        seenPhones,
      });
      const item = {
        id: record.id || "",
        name: record.name || "there",
        phone,
        language: clean(record.language).toLowerCase() || "en",
        project: record.project || project.name,
        lastBlastAt: result.lastBlastAt || record.lastBlastAt || record.firstBlastAt || null,
        ageDays: result.ageDays ?? null,
        previousSender: record.senderInstance || "",
        reason: result.reason,
        detail: result.detail || "",
      };
      if (result.eligible) eligible.push(item);
      else excluded.push(item);
    }

    eligible.sort((left, right) => String(left.lastBlastAt).localeCompare(String(right.lastBlastAt)));
    const previewToken = tokenFor({
      projectId: project.id,
      cooldownDays: days,
      eligible,
      excluded,
    });
    return {
      project: { id: project.id, name: project.name },
      campaignType: "RECYCLE",
      templateFlow: REFRESH_TEMPLATE_FLOW,
      cooldownDays: days,
      checkedAt: checkedAt.toISOString(),
      sourceSyncedAt: store?.syncedAt || null,
      total: records.length,
      eligible,
      excluded,
      exclusionCounts: summarizeRefreshExclusions(excluded),
      previewToken,
    };
  }

  async function createBatch({ projectId, cooldownDays, previewToken, name = "" } = {}) {
    const report = await preview({ projectId, cooldownDays });
    if (!previewToken || previewToken !== report.previewToken) {
      const error = new Error("Refresh 名单已经改变。请重新检查名单后再建立 Campaign。");
      error.code = "REFRESH_PREVIEW_CHANGED";
      throw error;
    }
    if (!report.eligible.length) {
      const error = new Error("目前没有符合 Refresh 规则的客户。");
      error.code = "REFRESH_NO_ELIGIBLE_LEADS";
      throw error;
    }
    const stamp = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kuala_Lumpur",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(clock());
    const group = await createLeadGroup({
      projectCode: report.project.id,
      projectName: report.project.name,
      name: clean(name) || `${report.project.name} · Refresh ${report.cooldownDays}d · ${stamp}`,
      sourceType: "database",
      sourceName: `notion-refresh:${report.cooldownDays}d`,
      leads: report.eligible,
    });
    setLeadsCache({
      projectId: report.project.id,
      projectName: report.project.name,
      leadGroupId: group.id,
      leadGroupName: group.name,
      sourcePath: group.sourceName,
      leads: group.leads,
      rejected: report.excluded,
      campaignType: "RECYCLE",
      refreshCooldownDays: report.cooldownDays,
      refreshPreviewToken: report.previewToken,
      templateFlow: REFRESH_TEMPLATE_FLOW,
    });
    return { report, group };
  }

  async function assertPreparedRunner(runner) {
    if (runner?.state?.campaignType !== "RECYCLE") return { checked: false };
    const report = await preview({
      projectId: runner.state.projectId || runner.state.campaignId,
      cooldownDays: runner.state.refreshCooldownDays,
      ignoreRunId: runner.state.runId,
    });
    if (!runner.state.refreshPreviewToken || report.previewToken !== runner.state.refreshPreviewToken) {
      const error = new Error("Refresh 名单在预览后发生变化（可能有人回复、被 STOP 或刚被跟进）。请重新生成名单。");
      error.code = "REFRESH_PREVIEW_CHANGED";
      throw error;
    }
    const allowed = new Set(report.eligible.map((item) => item.phone));
    const unsafe = (runner.state.assignments || [])
      .filter((job) => isResumableJobStatus(job.status) && !allowed.has(normalizePhone(job.lead?.phone)));
    if (unsafe.length) {
      const error = new Error(`有 ${unsafe.length} 位客户已不符合 Refresh 规则。请重新生成名单。`);
      error.code = "REFRESH_RECIPIENT_BECAME_INELIGIBLE";
      throw error;
    }
    return { checked: true, report };
  }

  return { preview, createBatch, assertPreparedRunner };
}
