import { assertReviewerChecklist, buildResumePackage, evaluateFileScope, validateTaskContract } from "../domain/ai-change-tracking.mjs";

export function createAiChangeTrackingService({ repository, gitInspector = { snapshot: async () => ({ unavailable: true }) } } = {}) {
  if (!repository) throw new TypeError("AI Change Tracking repository is required.");
  const requireText = (value, field) => { const text=String(value||"").trim(); if(!text) throw Object.assign(new Error(`${field} is required.`),{code:"AI_CHANGE_INPUT_REQUIRED"}); return text; };
  async function create(input) { return repository.createTask(validateTaskContract(input)); }
  async function approve({ taskId, approvedBy }) { return repository.approveTask({ taskId:requireText(taskId,"taskId"), approvedBy:requireText(approvedBy,"approvedBy") }); }
  async function start({ taskId, stepId, actorId }) {
    const task = await repository.task(taskId); if (!task || !["APPROVED","IN_PROGRESS","BLOCKED"].includes(task.status)) throw Object.assign(new Error("Task must be human-approved before a step starts."),{code:"TASK_APPROVAL_REQUIRED"});
    if (task.status === "BLOCKED") throw Object.assign(new Error("Blocked task requires a new human approval before resume."),{code:"TASK_APPROVAL_REQUIRED"});
    const active=(await repository.steps(taskId)).find((step)=>step.status==="IN_PROGRESS"&&step.stepId!==stepId); if(active) throw Object.assign(new Error(`Step ${active.stepId} is already active.`),{code:"ONE_ACTIVE_STEP_ONLY"});
    return repository.startStep({taskId,stepId,actorId});
  }
  async function recordFile(input) {
    const detail=await repository.detail(input.taskId); const step=detail.steps.find((item)=>item.stepId===input.stepId);
    if(!step||step.status!=="IN_PROGRESS") throw Object.assign(new Error("File evidence requires the active step."),{code:"ACTIVE_STEP_REQUIRED"});
    const decision=evaluateFileScope({filePath:input.filePath,allowedFiles:detail.task.allowedFiles,protectedScope:detail.task.protectedScope,approvedProtectedPaths:input.approvedProtectedPaths||[]});
    const recorded=await repository.recordFile({...input,reason:requireText(input.reason,"reason"),scopeDecision:decision.decision});
    if(decision.decision==="SCOPE_DRIFT") { await repository.block({taskId:input.taskId,stepId:input.stepId,code:"SCOPE_DRIFT",message:`${input.filePath}: ${decision.reason}`,actorType:"SYSTEM"}); throw Object.assign(new Error(decision.reason),{code:"SCOPE_DRIFT"}); }
    return recorded;
  }
  async function recordTest(input) {
    const status=String(input.status||"").trim().toUpperCase(); if(!["PASSED","FAILED","SKIPPED"].includes(status)) throw Object.assign(new Error("Test status is invalid."),{code:"AI_CHANGE_TEST_INVALID"});
    const result=await repository.recordTest({...input,status,command:requireText(input.command,"command")});
    if(status==="FAILED") await repository.block({taskId:input.taskId,stepId:input.stepId,code:"TEST_FAILED",message:input.summary||input.command,actorType:"SYSTEM"});
    return result;
  }
  async function completeStep({taskId,stepId,commitSha}) {
    const detail=await repository.detail(taskId); const passed=detail.tests.some((test)=>test.stepId===stepId&&test.status==="PASSED"); const failed=detail.tests.some((test)=>test.stepId===stepId&&test.status==="FAILED");
    if(!passed||failed) throw Object.assign(new Error("Step requires a passing test and no failed tests."),{code:"STEP_TEST_EVIDENCE_REQUIRED"});
    return repository.completeStep({taskId,stepId,commitSha:requireText(commitSha,"commitSha")});
  }
  async function review({taskId,checklist,actorId}) { const detail=await repository.detail(taskId); if(detail.steps.some((step)=>step.status!=="COMPLETED")) throw Object.assign(new Error("All steps must be completed before review."),{code:"STEPS_INCOMPLETE"}); return repository.setReview({taskId,checklist:assertReviewerChecklist(checklist),actorId}); }
  async function complete({taskId,approvedBy}) { const task=await repository.task(taskId); if(task?.status!=="REVIEW") throw Object.assign(new Error("Task must pass review before completion."),{code:"TASK_REVIEW_REQUIRED"}); return repository.completeTask({taskId,actorId:requireText(approvedBy,"approvedBy")}); }
  async function rollback(input) { requireText(input.approvedBy,"approvedBy"); requireText(input.rollbackRef,"rollbackRef"); return repository.rollback({taskId:input.taskId,stepId:input.stepId,rollbackRef:input.rollbackRef,actorId:input.approvedBy}); }
  async function pause({taskId,stepId,condition,message,actorId=""}) { const allowed=["SCOPE_DRIFT","PROTECTED_FILE","TEST_FAILED","DATA_LOSS_RISK","DUPLICATE_SEND_RISK","REQUIREMENT_CONFLICT","LIVE_CAMPAIGN_ACTIVE"]; const code=String(condition||"").toUpperCase(); if(!allowed.includes(code)) throw Object.assign(new Error("Pause condition is invalid."),{code:"PAUSE_CONDITION_INVALID"}); return repository.block({taskId,stepId,code,message:requireText(message,"message"),actorType:"SYSTEM",actorId}); }
  async function resumePackage(taskId) { const detail=await repository.detail(taskId); const git=await gitInspector.snapshot().catch((error)=>({unavailable:true,error:error.message})); return buildResumePackage({...detail,git}); }
  return { schemaStatus:()=>repository.schemaStatus(), create, list:(q)=>repository.list(q), detail:(id)=>repository.detail(id), approve, start, recordFile, recordTest, completeStep, review, complete, rollback, pause, resumePackage };
}
