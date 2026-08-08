import path from "node:path";
import { fileURLToPath } from "node:url";
import { recentActiveRunState } from "./lib/sqlite-maintenance.mjs";
import {
  REBUILD_MIGRATIONS,
  appliedMigrations,
  assertToolPrerequisites,
  campaignEvidence,
  classifyAllDuplicateGroups,
  identityConflictCounts,
  integrityChecks,
  maintenanceArchiveDir,
  messageVolumeByConnection,
  migrationFileChecksums,
  notionMappingEvidence,
  orphanCounts,
  permissionEvidence,
  rowCounts,
  sqliteJson,
  summariseDuplicateClasses,
  tableNames,
  timestampSlug,
  writeReportFiles,
} from "./lib/customer-database-inspection.mjs";

const MIGRATION_BLOCKING_STATUSES = new Set(["RUNNING", "SENDING", "QUEUED", "QUEUED_BATCH"]);

const CORE_TABLES = Object.freeze([
  "contacts",
  "conversations",
  "messages",
  "project_leads",
  "projects",
  "whatsapp_connections",
  "devices",
  "lid_map",
  "campaign_runs",
  "send_jobs",
  "sync_jobs",
  "contact_permission_events",
  "templates",
  "lead_groups",
  "lead_group_members",
]);

/**
 * Migration 305 需要 (connection_key, external_message_id) 唯一，所以重复
 * message identity 必须先修好；306 之后每一层都建立在 305 的 customer_id 上。
 */
function migrationReadiness({ applied, files, duplicateGroups, activeRuns }) {
  const appliedVersions = new Set(applied.map((row) => row.version));
  const appliedByVersion = new Map(applied.map((row) => [row.version, row]));
  return REBUILD_MIGRATIONS.map((migration, index) => {
    const file = files.find((item) => item.version === migration.version);
    const previous = index === 0 ? 303 : REBUILD_MIGRATIONS[index - 1].version;
    const blockers = [];
    if (!file?.exists) blockers.push("migration_file_missing");
    if (!appliedVersions.has(previous)) blockers.push(`migration_${previous}_required`);
    if (activeRuns.length) blockers.push("active_campaigns");
    if (migration.version === 305 && duplicateGroups > 0) blockers.push("duplicate_message_identity");
    const record = appliedByVersion.get(migration.version) || null;
    const checksumMismatch = Boolean(record?.checksum && file?.checksum && record.checksum !== file.checksum);
    if (checksumMismatch) blockers.push("checksum_mismatch");
    return {
      version: migration.version,
      name: migration.name,
      applied: appliedVersions.has(migration.version),
      checksumMismatch,
      fileChecksum: file?.checksum || null,
      blockers: appliedVersions.has(migration.version) ? [] : blockers,
      ready: !appliedVersions.has(migration.version) && blockers.length === 0,
    };
  });
}

/**
 * 「真的在跑」和「账本没收尾」是两件事，必须分开报告。
 *
 * runtime state file 才代表现在有没有 Campaign 在发送；`campaign_runs` 里的
 * RUNNING／PARTIAL 可能只是旧 run 崩溃后没有写回 terminal status。两者都会挡住
 * migration（`featureMigrationPlan` 把两边合起来当 `active_campaigns`），但处理
 * 方式完全不同：前者要等它跑完，后者用 reconcile 工具修账本。
 */
function campaignRuntimeState(binary, databasePath, rootDir, present) {
  const runtimeRuns = recentActiveRunState(rootDir).activeRuns.map((item) => ({ source: "run_state", ...item }));
  const ledgerRuns = present.has("campaign_runs")
    ? sqliteJson(binary, databasePath, "SELECT run_id AS runId,status,mode,started_at AS startedAt FROM campaign_runs WHERE status IN ('RUNNING','SENDING','QUEUED','QUEUED_BATCH','PARTIAL') ORDER BY started_at DESC;")
      .map((item) => ({ source: "sqlite", ...item }))
    : [];
  const runtimeRunIds = new Set(runtimeRuns.map((item) => item.runId));
  return {
    runtimeRuns,
    staleLedgerRuns: ledgerRuns.filter((item) => !runtimeRunIds.has(item.runId)),
    // Migration 工具只把这几个 status 当成 active（见 lib/feature-migration.mjs）。
    // PARTIAL 虽然也没收尾，但不会挡住 migration，报告里不能把它算成阻塞。
    migrationBlockingRuns: [
      ...runtimeRuns,
      ...ledgerRuns.filter((item) => MIGRATION_BLOCKING_STATUSES.has(item.status)),
    ],
  };
}

export function auditCustomerDatabaseRebuild({
  rootDir,
  databasePath,
  binary = "/usr/bin/sqlite3",
} = {}) {
  assertToolPrerequisites(binary, databasePath);
  const present = tableNames(binary, databasePath);
  const applied = appliedMigrations(binary, databasePath);
  const files = migrationFileChecksums(rootDir);
  const campaignState = campaignRuntimeState(binary, databasePath, rootDir, present);

  const classified = present.has("messages") ? classifyAllDuplicateGroups(binary, databasePath) : [];
  const duplicates = {
    groups: classified.length,
    extraRows: classified.reduce((total, group) => total + group.rowCount - 1, 0),
    autoMergeable: classified.filter((group) => group.autoMergeable).length,
    conflicted: classified.filter((group) => !group.autoMergeable).length,
    classes: summariseDuplicateClasses(classified),
  };

  const report = {
    generatedAt: new Date().toISOString(),
    databasePath,
    readOnly: true,
    schema: {
      applied,
      highestApplied: applied.reduce((highest, row) => Math.max(highest, row.version), 0),
      rebuildMigrations: files.map(({ version, name, path: filePath, exists, checksum }) => ({ version, name, path: filePath, exists, checksum })),
      pending: files.filter((file) => !applied.some((row) => row.version === file.version)).map((file) => file.version),
    },
    runtime: {
      activeRuns: campaignState.runtimeRuns,
      staleLedgerRuns: campaignState.staleLedgerRuns,
      // 只有运行时空闲才可以做维护；账本没收尾用 reconcile 修，不需要等。
      safeForMaintenance: campaignState.runtimeRuns.length === 0,
      migrationBlockedByCampaigns: campaignState.migrationBlockingRuns.length > 0,
    },
    counts: rowCounts(binary, databasePath, CORE_TABLES),
    messageIdentity: duplicates,
    messageVolumeByConnection: present.has("messages") ? messageVolumeByConnection(binary, databasePath) : [],
    identityConflicts: identityConflictCounts(binary, databasePath),
    orphans: orphanCounts(binary, databasePath),
    permissions: permissionEvidence(binary, databasePath),
    campaigns: campaignEvidence(binary, databasePath),
    notionMapping: notionMappingEvidence(binary, databasePath),
    integrity: integrityChecks(binary, databasePath),
  };
  report.migrationReadiness = migrationReadiness({
    applied,
    files,
    duplicateGroups: duplicates.groups,
    activeRuns: campaignState.migrationBlockingRuns,
  });
  report.blockingIssues = collectBlockingIssues(report);
  return report;
}

function collectBlockingIssues(report) {
  const issues = [];
  if (!report.runtime.safeForMaintenance) issues.push({ code: "ACTIVE_CAMPAIGN", detail: `${report.runtime.activeRuns.length} run(s) still sending — 必须等它们跑完` });
  if (report.runtime.migrationBlockedByCampaigns) issues.push({ code: "STALE_CAMPAIGN_LEDGER", detail: `${report.runtime.staleLedgerRuns.length} run(s) 非 terminal 但运行时已空闲 — 用 reconcile-campaign-terminal-state 修` });
  if (report.messageIdentity.groups) issues.push({ code: "DUPLICATE_MESSAGE_IDENTITY", detail: `${report.messageIdentity.groups} group(s), ${report.messageIdentity.extraRows} extra row(s)` });
  if (report.integrity.quickCheck !== "ok") issues.push({ code: "QUICK_CHECK_FAILED", detail: report.integrity.quickCheck });
  if (report.integrity.foreignKeyViolations) issues.push({ code: "FOREIGN_KEY_VIOLATIONS", detail: String(report.integrity.foreignKeyViolations) });
  for (const orphan of Object.entries(report.orphans)) {
    if (Number(orphan[1]) > 0 && orphan[0] !== "conversationsWithoutMessages" && orphan[0] !== "contactsWithoutLeadOrConversation") {
      issues.push({ code: "ORPHAN_ROWS", detail: `${orphan[0]}=${orphan[1]}` });
    }
  }
  return issues;
}

function table(rows, headers) {
  const lines = [`| ${headers.join(" | ")} |`, `|${headers.map(() => "---").join("|")}|`];
  for (const row of rows) lines.push(`| ${row.join(" | ")} |`);
  return lines.join("\n");
}

export function renderAuditMarkdown(report) {
  const readiness = report.migrationReadiness.map((item) => [
    item.version,
    item.name,
    item.applied ? "applied" : item.ready ? "ready" : "blocked",
    item.blockers.join(", ") || "—",
  ]);
  const duplicateRows = report.messageIdentity.classes.map((item) => [
    item.direction,
    item.sourcePair,
    item.groups,
    item.autoMergeable,
    item.conflicted,
    Object.entries(item.upgradeCodes).map(([code, count]) => `${code}=${count}`).join(", ") || "—",
    Object.entries(item.conflictCodes).map(([code, count]) => `${code}=${count}`).join(", ") || "—",
  ]);
  const countRows = Object.entries(report.counts).map(([name, value]) => [name, value]);
  const orphanRows = Object.entries(report.orphans).map(([name, value]) => [name, value]);
  const identityRows = Object.entries(report.identityConflicts).map(([name, value]) => [name, value]);

  return `# Customer Database Rebuild Audit

> 生成时间：${report.generatedAt}
>
> 模式：只读（read-only），不修改任何资料。
>
> 本报告只包含数量、hash、code 与 row ID，不含电话、姓名或消息内容。

## 1. 阻塞问题

${report.blockingIssues.length
    ? table(report.blockingIssues.map((issue) => [issue.code, issue.detail]), ["Code", "Detail"])
    : "没有阻塞问题。"}

## 2. Schema 状态

- 已应用最高版本：\`${report.schema.highestApplied}\`
- 待应用：${report.schema.pending.length ? report.schema.pending.join(", ") : "无"}

${table(readiness, ["Version", "Name", "Status", "Blockers"])}

## 3. 运行状态

- 真正在发送的 run（runtime state）：${report.runtime.activeRuns.length}
- 账本未收尾但运行时已空闲的 run：${report.runtime.staleLedgerRuns.length}
- 可安全维护：${report.runtime.safeForMaintenance ? "是" : "否"}
- 未结束的 send job：${report.campaigns.totals.openSendJobs ?? 0}

> Migration 会同时被这两类 run 挡住。前者要等它跑完；后者用
> \`reconcile-campaign-terminal-state.mjs\` 把 terminal status 写回账本。

## 4. Message Identity

- 重复 group：${report.messageIdentity.groups}
- 多余 row：${report.messageIdentity.extraRows}
- 可自动合并：${report.messageIdentity.autoMergeable}
- 需人工判断：${report.messageIdentity.conflicted}

${duplicateRows.length ? table(duplicateRows, ["Direction", "Source pair", "Groups", "Auto", "Conflict", "Upgrade codes", "Conflict codes"]) : "没有重复 message identity。"}

## 5. 数量

${table(countRows, ["Table", "Rows"])}

## 6. Orphan

${table(orphanRows, ["Check", "Count"])}

## 7. Identity 冲突

${table(identityRows, ["Check", "Count"])}

## 8. 许可证据

- STOP 联系人：${report.permissions.stoppedContacts}（digest \`${report.permissions.stopDigest.digest.slice(0, 16)}…\`）
- Permission events：${report.permissions.permissionEvents}（digest \`${report.permissions.permissionEventDigest.digest.slice(0, 16)}…\`）

${report.permissions.byCategory.length
    ? table(report.permissions.byCategory.map((row) => [row.category, row.action, row.events, row.contacts]), ["Category", "Action", "Events", "Contacts"])
    : "没有 permission event。"}

## 9. Campaign 证据

${table(report.campaigns.runsByStatus.map((row) => [row.status, row.mode, row.runs]), ["Status", "Mode", "Runs"])}

- requested 合计：${report.campaigns.totals.requested}
- sent 合计：${report.campaigns.totals.sent}
- failed 合计：${report.campaigns.totals.failed}

## 10. Notion mapping

${table(Object.entries(report.notionMapping).map(([name, value]) => [name, value]), ["Check", "Count"])}

## 11. 完整性

- \`PRAGMA quick_check\`：${report.integrity.quickCheck}
- Foreign key violations：${report.integrity.foreignKeyViolations}
`;
}

function parseArgs(argv) {
  const args = { root: "", db: "", out: "", quiet: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") args.root = argv[index += 1] || "";
    else if (arg.startsWith("--root=")) args.root = arg.slice("--root=".length);
    else if (arg === "--db") args.db = argv[index += 1] || "";
    else if (arg.startsWith("--db=")) args.db = arg.slice("--db=".length);
    else if (arg === "--out") args.out = argv[index += 1] || "";
    else if (arg.startsWith("--out=")) args.out = arg.slice("--out=".length);
    else if (arg === "--quiet") args.quiet = true;
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
    const report = auditCustomerDatabaseRebuild({ rootDir, databasePath });
    const markdown = renderAuditMarkdown(report);
    const outputDir = args.out
      ? path.resolve(args.out)
      : path.join(maintenanceArchiveDir(rootDir), "audits");
    const written = writeReportFiles({
      outputDir,
      baseName: `customer-database-audit-${timestampSlug(new Date(report.generatedAt))}`,
      report,
      markdown,
    });
    if (!args.quiet) console.log(markdown);
    console.log(`\nJSON: ${written.jsonPath}\nMarkdown: ${written.markdownPath}`);
    if (report.blockingIssues.length) process.exitCode = 2;
  } catch (error) {
    console.error(`[${error.code || "CUSTOMER_DATABASE_AUDIT_FAILED"}] ${error.message}`);
    process.exitCode = 1;
  }
}
