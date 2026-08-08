export const AI_CHANGE_STATUSES = Object.freeze(["PLANNED", "APPROVED", "IN_PROGRESS", "TESTING", "BLOCKED", "REVIEW", "COMPLETED", "ROLLED_BACK", "CANCELLED"]);
export const AI_CHANGE_RISKS = Object.freeze(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export const DEFAULT_PROTECTED_SCOPE = Object.freeze([
  "campaign-data/mamba.sqlite", "campaign-data/runs/**", "evolution-pilot/.env",
  "campaign-app/campaign_core.mjs", "campaign-app/domain/send-eligibility.mjs",
  "campaign-app/lib/send-eligibility-service.mjs", "campaign-app/lib/campaign-run-service.mjs",
]);

function clean(value, max = 2000) { return String(value ?? "").trim().slice(0, max); }
function list(value, max = 100) { return Array.isArray(value) ? value.map((item) => clean(item)).filter(Boolean).slice(0, max) : []; }

export function validateTaskContract(input = {}) {
  const riskLevel = clean(input.riskLevel).toUpperCase();
  const contract = {
    taskId: clean(input.taskId, 120), title: clean(input.title, 240), goal: clean(input.goal),
    allowedScope: list(input.allowedScope), protectedScope: [...new Set([...DEFAULT_PROTECTED_SCOPE, ...list(input.protectedScope)])],
    allowedFiles: list(input.allowedFiles), acceptanceCriteria: list(input.acceptanceCriteria),
    riskLevel, branch: clean(input.branch, 240), promptVersion: clean(input.promptVersion, 120),
    aiModel: clean(input.aiModel, 120), rollbackPlan: clean(input.rollbackPlan),
    steps: Array.isArray(input.steps) ? input.steps.slice(0, 50).map((step) => ({ title: clean(step.title, 240), goal: clean(step.goal) })) : [],
  };
  const missing = ["title", "goal", "branch"].filter((key) => !contract[key]);
  if (!contract.allowedFiles.length) missing.push("allowedFiles");
  if (!contract.allowedScope.length) missing.push("allowedScope");
  if (!contract.acceptanceCriteria.length) missing.push("acceptanceCriteria");
  if (!contract.steps.length || contract.steps.some((step) => !step.title)) missing.push("steps");
  if (missing.length) throw Object.assign(new Error(`Task Contract missing: ${[...new Set(missing)].join(", ")}.`), { code: "TASK_CONTRACT_INVALID" });
  if (!AI_CHANGE_RISKS.includes(riskLevel)) throw Object.assign(new Error("riskLevel is invalid."), { code: "TASK_CONTRACT_INVALID" });
  return contract;
}

function globRegExp(glob) {
  const escaped = clean(glob).replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("**", "\u0000").replaceAll("*", "[^/]*").replaceAll("\u0000", ".*");
  return new RegExp(`^${escaped}$`);
}

export function matchesAnyPath(filePath, patterns = []) {
  const normalized = clean(filePath).replace(/^\.\//, "");
  return patterns.some((pattern) => globRegExp(pattern).test(normalized));
}

export function evaluateFileScope({ filePath, allowedFiles = [], protectedScope = DEFAULT_PROTECTED_SCOPE, approvedProtectedPaths = [] } = {}) {
  const normalized = clean(filePath).replace(/^\.\//, "");
  const isProtected = matchesAnyPath(normalized, protectedScope);
  if (isProtected && matchesAnyPath(normalized, approvedProtectedPaths)) return { decision: "PROTECTED_APPROVED", reason: "Protected path has explicit human approval." };
  if (isProtected) return { decision: "SCOPE_DRIFT", reason: "Protected path requires explicit human approval." };
  if (!matchesAnyPath(normalized, allowedFiles)) return { decision: "SCOPE_DRIFT", reason: "File is outside Task Contract allowed_files." };
  return { decision: "ALLOWED", reason: "File is within Task Contract allowed_files." };
}

export function assertReviewerChecklist(checklist = {}) {
  const required = ["requirementCoverage", "scope", "dataLoss", "duplicateSend", "tests", "rollback", "docs"];
  const failed = required.filter((key) => checklist[key] !== true);
  if (failed.length) throw Object.assign(new Error(`Reviewer checklist incomplete: ${failed.join(", ")}.`), { code: "REVIEW_CHECKLIST_INCOMPLETE" });
  return Object.fromEntries(required.map((key) => [key, true]));
}

export function buildResumePackage({ task, steps = [], events = [], files = [], tests = [], git = {} } = {}) {
  const currentStep = steps.find((step) => step.stepId === task?.currentStepId) || null;
  return { task, currentStep, steps, recentEvents: events.slice(-30), files, tests, git, nextAction: task?.status === "BLOCKED" ? "Resolve blocker and obtain approval before resuming." : currentStep ? `Continue: ${currentStep.title}` : "Approve the next planned step." };
}
