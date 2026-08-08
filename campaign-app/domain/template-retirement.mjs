import { isTerminalCampaignRunStatus } from "./campaign-model.mjs";

export function normalizeTemplatePageId(value) {
  return String(value ?? "").replace(/[^a-fA-F0-9]/g, "").toLowerCase();
}

function assignmentTemplateIds(assignment = {}) {
  return [
    assignment.part1Variant,
    assignment.part2Variant,
    ...(assignment.extraParts || []).map((part) => part?.variant),
    ...(assignment.tplCredit || []).map((credit) => credit?.pageId),
  ].map(normalizeTemplatePageId).filter(Boolean);
}

export function findUnfinishedTemplateUsage({ pageId, runners = [] } = {}) {
  const target = normalizeTemplatePageId(pageId);
  if (!target) return null;

  for (const runner of runners || []) {
    const state = runner?.state;
    if (!state) continue;
    const status = String(state.status || "").trim().toUpperCase();
    const isUnfinished = runner.running === true || !isTerminalCampaignRunStatus(status);
    if (!isUnfinished) continue;

    const ids = [
      ...(state.assignments || []).flatMap(assignmentTemplateIds),
      ...(state.creditPlan || []).map((credit) => normalizeTemplatePageId(credit?.pageId)),
    ];
    if (ids.includes(target)) {
      return {
        runId: String(state.runId || ""),
        status: status || (runner.running ? "RUNNING" : "UNKNOWN"),
        mode: state.mode === "LIVE" ? "LIVE" : "TEST",
      };
    }
  }
  return null;
}

export function decideTemplateRetirement({ pageId, runners = [] } = {}) {
  const normalizedPageId = normalizeTemplatePageId(pageId);
  if (!normalizedPageId) return { allowed: false, code: "TEMPLATE_PAGE_ID_REQUIRED" };
  const usage = findUnfinishedTemplateUsage({ pageId: normalizedPageId, runners });
  if (usage) return { allowed: false, code: "TEMPLATE_USED_BY_UNFINISHED_CAMPAIGN", usage };
  return { allowed: true, code: "TEMPLATE_RETIRE_ALLOWED", pageId: normalizedPageId };
}
