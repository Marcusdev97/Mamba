import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyFlowAdvanceState } from "../../campaign-app/flow_sequence.mjs";
import {
  backupSqliteDatabase,
  clean,
  readJson,
  sqlText,
} from "./lib/sqlite-maintenance.mjs";

function sqliteJson(binary, databasePath, sql, { readOnly = true } = {}) {
  const output = execFileSync(binary, [
    ...(readOnly ? ["-readonly"] : []),
    "-batch",
    "-json",
    databasePath,
    sql,
  ], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  return clean(output) ? JSON.parse(output) : [];
}

function normalizePhone(value) {
  return clean(value).replace(/\D/g, "");
}

function completedPhones(run) {
  return [...new Set((run?.assignments || [])
    .filter((job) => job?.status === "SENT" && job?.part1?.sentAt)
    .map((job) => normalizePhone(job?.lead?.phone))
    .filter(Boolean))];
}

function loadJobs(binary, databasePath, jobIds) {
  const ids = jobIds.map(Number).filter(Number.isInteger);
  if (!ids.length) return [];
  return sqliteJson(binary, databasePath, `
SELECT id, entity_type AS entityType, entity_id AS entityId, status,
       attempt_count AS attemptCount, last_error_code AS errorCode,
       last_error_message AS errorMessage, payload_json AS payloadJson
FROM sync_jobs WHERE id IN (${ids.join(",")})
ORDER BY id;`);
}

function localLeadStates(binary, databasePath, projectCode, phones) {
  if (!projectCode || !phones.length) return [];
  return sqliteJson(binary, databasePath, `
SELECT phone, last_flow_sent AS lastFlowSent, next_flow AS nextFlow,
       sequence_status AS sequenceStatus, notion_page_id AS notionPageId
FROM project_leads
WHERE project_code=${sqlText(projectCode)}
  AND phone IN (${phones.map(sqlText).join(",")});`);
}

function inspectJob({ binary, databasePath, rootDir, job }) {
  let payload = {};
  try { payload = JSON.parse(job.payloadJson || "{}"); } catch { /* reported below */ }
  const runId = clean(job.entityId || payload.runId);
  const run = readJson(path.join(rootDir, "campaign-data", "runs", `${path.basename(runId)}.json`), null);
  const projectCode = clean(run?.projectId || run?.campaignId || payload.projectId);
  const sentFlowLabel = clean(run?.flowLabel || payload.flowLabel);
  const phones = completedPhones(run);
  const rows = localLeadStates(binary, databasePath, projectCode, phones);
  const byPhone = new Map(rows.map((row) => [normalizePhone(row.phone), row]));
  const states = phones.map((phone) => {
    const row = byPhone.get(phone);
    const classification = row
      ? classifyFlowAdvanceState({
          sentFlowLabel,
          currentLastFlowLabel: clean(row.lastFlowSent),
          currentNextFlowLabel: clean(row.nextFlow),
        })
      : "MISSING_LOCAL_LEAD";
    return { phone, classification, row: row || null };
  });
  const counts = states.reduce((result, item) => {
    result[item.classification] = (result[item.classification] || 0) + 1;
    return result;
  }, {});
  const invalid = states.filter((item) => !["ALREADY_SYNCED", "SUPERSEDED"].includes(item.classification));
  const eligible = (
    job.entityType === "campaign_run"
    && job.status === "FAILED"
    && run
    && ["COMPLETED", "STOPPED"].includes(clean(run.status).toUpperCase())
    && clean(job.errorCode) === "SYNC_FAILED"
    && Number(run?.advanceSummary?.notFound || 0) === 0
    && Number(run?.advanceSummary?.flowMismatch || 0) > 0
    && phones.length > 0
    && invalid.length === 0
  );
  return {
    jobId: Number(job.id),
    runId,
    status: job.status,
    runStatus: clean(run?.status),
    projectCode,
    sentFlowLabel,
    sentCustomers: phones.length,
    stateCounts: counts,
    invalidSamples: invalid.slice(0, 8).map((item) => ({
      phone: item.phone,
      classification: item.classification,
      lastFlowSent: item.row?.lastFlowSent || "",
      nextFlow: item.row?.nextFlow || "",
    })),
    eligible,
  };
}

export function resolveSupersededFlowSync({
  rootDir,
  databasePath,
  jobIds,
  apply = false,
  binary = "/usr/bin/sqlite3",
} = {}) {
  if (!fs.existsSync(binary)) throw new Error(`找不到 sqlite3：${binary}`);
  if (!fs.existsSync(databasePath)) throw new Error(`找不到数据库：${databasePath}`);
  const requestedIds = [...new Set((jobIds || []).map(Number).filter(Number.isInteger))];
  if (!requestedIds.length) throw new Error("至少需要一个 --job <id>。");
  const jobs = loadJobs(binary, databasePath, requestedIds);
  const foundIds = new Set(jobs.map((job) => Number(job.id)));
  const missingJobIds = requestedIds.filter((id) => !foundIds.has(id));
  const inspections = jobs.map((job) => inspectJob({ binary, databasePath, rootDir, job }));
  const report = {
    mode: apply ? "apply" : "dry-run",
    databasePath,
    requestedJobIds: requestedIds,
    missingJobIds,
    jobs: inspections,
  };
  if (!apply) return report;
  if (missingJobIds.length || inspections.some((item) => !item.eligible)) {
    const error = new Error("有任务无法证明已被后续 Flow 取代；拒绝更新队列。");
    error.code = "SUPERSEDED_FLOW_NOT_PROVEN";
    error.report = report;
    throw error;
  }

  const backupPath = backupSqliteDatabase({
    binary,
    rootDir,
    databasePath,
    prefix: "before-superseded-flow-sync-resolution",
  });
  const now = new Date().toISOString();
  const statements = ["BEGIN IMMEDIATE;"];
  for (const item of inspections) {
    const message = `${item.sentFlowLabel}: ${item.sentCustomers} 位客户已处于相同或更后的有效 Flow 状态；旧任务由后续 Campaign 取代。`;
    statements.push(`
UPDATE sync_jobs SET
  status='COMPLETED',
  last_error_code='SUPERSEDED_FLOW_STATE',
  last_error_message=${sqlText(message)},
  updated_at=${sqlText(now)}
WHERE id=${item.jobId} AND status='FAILED' AND last_error_code='SYNC_FAILED';`);
  }
  statements.push("COMMIT;");
  sqliteJson(binary, databasePath, statements.join("\n"), { readOnly: false });
  const verification = loadJobs(binary, databasePath, requestedIds).map((job) => ({
    jobId: Number(job.id),
    status: job.status,
    errorCode: job.errorCode,
  }));
  return {
    ...report,
    backupPath,
    applied: inspections.length,
    verification,
    quickCheck: sqliteJson(binary, databasePath, "PRAGMA quick_check;")[0]?.quick_check || "unknown",
  };
}

function parseArgs(argv) {
  const args = { apply: false, root: "", db: "", jobIds: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--dry-run") args.apply = false;
    else if (arg === "--root") args.root = argv[index += 1] || "";
    else if (arg.startsWith("--root=")) args.root = arg.slice("--root=".length);
    else if (arg === "--db") args.db = argv[index += 1] || "";
    else if (arg.startsWith("--db=")) args.db = arg.slice("--db=".length);
    else if (arg === "--job") args.jobIds.push(argv[index += 1] || "");
    else if (arg.startsWith("--job=")) args.jobIds.push(arg.slice("--job=".length));
    else throw new Error(`不支持的参数：${arg}`);
  }
  return args;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const rootDir = path.resolve(args.root || defaultRoot);
  const databasePath = path.resolve(args.db || path.join(rootDir, "campaign-data", "mamba.sqlite"));
  try {
    console.log(JSON.stringify(resolveSupersededFlowSync({
      rootDir,
      databasePath,
      jobIds: args.jobIds,
      apply: args.apply,
    }), null, 2));
  } catch (error) {
    if (error.report) console.error(JSON.stringify(error.report, null, 2));
    console.error(error.message);
    process.exitCode = 1;
  }
}
