import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditCustomerDatabaseRebuild, renderAuditMarkdown } from "../scripts/maintenance/audit-customer-database-rebuild.mjs";
import {
  MESSAGE_IDENTITY_CONFIRMATION,
  mergeDuplicateGroup,
  planDuplicateMessageRepair,
  repairDuplicateMessageIdentity,
} from "../scripts/maintenance/repair-duplicate-message-identity.mjs";
import { installBaseSchema, maskConnectionKey, pickCanonicalRow, resolveTextMismatch } from "../scripts/maintenance/lib/customer-database-inspection.mjs";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(appDir, "..");
const SQLITE = "/usr/bin/sqlite3";
const CONNECTION = "device-a::601133698121";

function sqlValue(value) {
  return value === null || value === undefined ? "NULL" : `'${String(value).replaceAll("'", "''")}'`;
}

function insertMessage(databasePath, row) {
  execFileSync(SQLITE, ["-batch", databasePath, `
INSERT INTO messages(row_id,id,conversation_id,connection_key,external_message_id,idempotency_key,
                     direction,text,message_type,source,flow_topic,template_key,sent_at,payload_json,created_at)
VALUES (${Number(row.rowId)},${sqlValue(row.id ?? `msg-${row.rowId}`)},${sqlValue(row.conversationId ?? "conv-1")},
        ${sqlValue(row.connectionKey ?? CONNECTION)},${sqlValue(row.externalMessageId)},${sqlValue(row.idempotencyKey ?? `idem-${row.rowId}`)},
        ${sqlValue(row.direction ?? "outbound")},${sqlValue(row.text ?? "hello")},${sqlValue(row.messageType ?? "text")},
        ${sqlValue(row.source ?? "phone")},${sqlValue(row.flowTopic ?? "")},${sqlValue(row.templateKey ?? null)},
        ${sqlValue(row.sentAt ?? "2026-08-01T00:00:00.000Z")},${sqlValue(JSON.stringify(row.payload ?? {}))},
        ${sqlValue(row.createdAt ?? "2026-08-01T00:00:00.000Z")});`]);
}

async function buildFixture() {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), "mamba-rebuild-tools-"));
  await fsp.mkdir(path.join(rootDir, "campaign-data", "runs"), { recursive: true });
  await fsp.writeFile(path.join(rootDir, "campaign-data", "active-runs.json"), JSON.stringify({ runs: [] }));
  // Migration checksum 与 base schema 都要对得上真实文件，所以直接指向 repo。
  await fsp.mkdir(path.join(rootDir, "campaign-app"), { recursive: true });
  await fsp.symlink(path.join(repoRoot, "campaign-app", "migrations"), path.join(rootDir, "campaign-app", "migrations"), "dir");
  await fsp.symlink(path.join(repoRoot, "docs"), path.join(rootDir, "docs"), "dir");

  const databasePath = path.join(rootDir, "campaign-data", "mamba.sqlite");
  installBaseSchema({ rootDir, databasePath, throughVersion: 303 });
  execFileSync(SQLITE, ["-batch", databasePath, `
INSERT INTO devices(device_key,device_name,created_at,updated_at) VALUES ('device-a','A','2026-08-01','2026-08-01'),('device-b','B','2026-08-01','2026-08-01');
INSERT INTO whatsapp_connections(connection_key,whatsapp_number,device_key,created_at,updated_at)
VALUES ('${CONNECTION}','601133698121','device-a','2026-08-01','2026-08-01'),
       ('device-b::60111222333','60111222333','device-b','2026-08-01','2026-08-01');
INSERT INTO contacts(contact_key,phone,created_at,updated_at) VALUES ('60999888777','60999888777','2026-08-01','2026-08-01');
INSERT INTO conversations(id,contact_key,connection_key,customer_phone,created_at,updated_at)
VALUES ('conv-1','60999888777','${CONNECTION}','60999888777','2026-08-01','2026-08-01'),
       ('conv-2','60999888777','device-b::60111222333','60999888777','2026-08-01','2026-08-01');`]);
  return { rootDir, databasePath };
}

const { rootDir, databasePath } = await buildFixture();

// ── 1. 纯合并规则 ────────────────────────────────────────────────────────────
{
  const rows = [
    { rowId: 10, source: "phone", messageType: "sticker", sentAt: "2026-08-01T00:00:05.000Z", createdAt: "2026-08-01T00:00:05.000Z", flowTopic: "", templateKey: null, payloadJson: JSON.stringify({ remoteJid: "jid-1", lid: "lid-1", mediaKind: "sticker", mime: "image/webp", runId: "" }) },
    { rowId: 3, source: "blast", messageType: "text", sentAt: "2026-08-01T00:00:00.000Z", createdAt: "2026-08-01T00:00:00.000Z", flowTopic: "Flow 1", templateKey: "tpl-1", payloadJson: JSON.stringify({ runId: "run-1", templateKey: "tpl-1", instanceName: "wa_01" }) },
  ];
  const merged = mergeDuplicateGroup(rows);
  assert.equal(merged.canonicalRowId, 3, "业务来源 blast 优先于 history 的 phone");
  assert.deepEqual(merged.removedRowIds, [10]);
  assert.equal(merged.fields.messageType, "sticker", "媒体类型胜过 text 降级值");
  assert.equal(merged.fields.flowTopic, "Flow 1");
  assert.equal(merged.fields.templateKey, "tpl-1");
  const payload = JSON.parse(merged.fields.payloadJson);
  assert.equal(payload.runId, "run-1", "空的 history runId 不得覆盖 Campaign 证据");
  assert.equal(payload.remoteJid, "jid-1", "history 的 provider 证据要补进 canonical row");
  assert.equal(payload.lid, "lid-1");
  assert.equal(payload.mime, "image/webp");
}

// ── 2. Delivery 证据只升不降 ─────────────────────────────────────────────────
{
  const rows = [
    { rowId: 1, source: "blast", messageType: "text", sentAt: "2026-08-01T00:00:00.000Z", createdAt: "2026-08-01T00:00:00.000Z", flowTopic: "", templateKey: null, payloadJson: JSON.stringify({ deliveryStatus: "READ", deliveryStatusRank: 4, deliveryUpdatedAt: "2026-08-01T01:00:00.000Z", readAt: "2026-08-01T01:00:00.000Z" }) },
    { rowId: 2, source: "phone", messageType: "text", sentAt: "2026-08-01T00:00:00.000Z", createdAt: "2026-08-01T00:00:00.000Z", flowTopic: "", templateKey: null, payloadJson: JSON.stringify({ deliveryStatus: "SERVER_ACK", deliveryStatusRank: 1, deliveryUpdatedAt: "2026-08-01T02:00:00.000Z", serverAckAt: "2026-08-01T00:30:00.000Z" }) },
  ];
  const payload = JSON.parse(mergeDuplicateGroup(rows).fields.payloadJson);
  assert.equal(payload.deliveryStatus, "READ", "时间较新的 SERVER_ACK 不得把 READ 降级");
  assert.equal(payload.serverAckAt, "2026-08-01T00:30:00.000Z", "低阶证据的时间戳仍要保留");
}

// ── 2b. 占位符文字判定 ───────────────────────────────────────────────────────
{
  // 模式 1：history 侧整条只有占位符，等于没记内容。
  const replyPlaceholder = resolveTextMismatch(["Do you want me to send you which one first?", "[reply]"]);
  assert.equal(replyPlaceholder.rule, "PLACEHOLDER_ONLY_TEXT");
  assert.equal(replyPlaceholder.text, "Do you want me to send you which one first?");

  // 模式 2：blast 侧是变量替换前的模板，history 侧才是客户实际收到的内容。
  const template = "Hi Cici 🙋!\n☀️ [Phone_Number]\n🎁 **First 50 registrations.**\n";
  const rendered = "Hi Cici 🙋!\n☀️ +60000000000\n🎁 **First 50 registrations.**\n";
  const unrendered = resolveTextMismatch([template, rendered]);
  assert.equal(unrendered.rule, "UNRENDERED_TEMPLATE_TEXT");
  assert.equal(unrendered.text, rendered, "必须取客户实际收到的那一版，而不是业务来源那一版");

  // 骨架对不上 = 真的是两条不同消息，不允许自动挑一边。
  assert.equal(resolveTextMismatch([template, "完全不同的另一条消息"]), null);
  // 两边都没有占位符的普通文字差异仍然是冲突。
  assert.equal(resolveTextMismatch(["版本 A", "版本 B"]), null);
  // 两边都是占位符时无从判断。
  assert.equal(resolveTextMismatch(["[reply]", "[media]"]), null);
  // 三种以上文字不在可判定范围内。
  assert.equal(resolveTextMismatch(["[reply]", "a", "b"]), null);
}

// ── 3. canonical 选择是确定的 ────────────────────────────────────────────────
{
  const rows = [
    { rowId: 9, source: "evolution", sentAt: "2026-08-01T00:00:02.000Z" },
    { rowId: 4, source: "evolution", sentAt: "2026-08-01T00:00:02.000Z" },
  ];
  assert.equal(pickCanonicalRow(rows).rowId, 4, "来源与时间相同时取最小 row_id");
  assert.equal(pickCanonicalRow([...rows].reverse()).rowId, 4, "输入顺序不影响结果");
}

// ── 4. 端到端：dry-run → apply → 幂等重跑 ────────────────────────────────────
insertMessage(databasePath, { rowId: 1, externalMessageId: "EXT-AUTO", source: "blast", messageType: "text", flowTopic: "Flow 1", payload: { runId: "run-1" } });
insertMessage(databasePath, { rowId: 2, externalMessageId: "EXT-AUTO", source: "phone", messageType: "image", payload: { remoteJid: "jid-1", mediaKind: "image" } });
insertMessage(databasePath, { rowId: 3, externalMessageId: "EXT-CONFLICT", source: "blast", text: "版本 A" });
insertMessage(databasePath, { rowId: 4, externalMessageId: "EXT-CONFLICT", source: "phone", text: "版本 B" });
insertMessage(databasePath, { rowId: 5, externalMessageId: "EXT-UNIQUE", source: "blast" });
// 同一个 provider message ID 出现在另一个 sender 上，是两条真实消息，不得跨连接合并。
insertMessage(databasePath, { rowId: 6, externalMessageId: "EXT-AUTO", connectionKey: "device-b::60111222333", conversationId: "conv-2", source: "blast" });
// blast 存的是替换前的模板，history 才是客户实际收到的内容。
insertMessage(databasePath, { rowId: 7, externalMessageId: "EXT-TEMPLATE", source: "blast", text: "Hi 🙋!\n☀️ [Phone_Number]\n🎁 **First 50.**", flowTopic: "Flow 2", payload: { runId: "run-2" } });
insertMessage(databasePath, { rowId: 8, externalMessageId: "EXT-TEMPLATE", source: "phone", text: "Hi 🙋!\n☀️ +60000000000\n🎁 **First 50.**", payload: { remoteJid: "jid-2" } });

{
  const dryRun = repairDuplicateMessageIdentity({ rootDir, databasePath });
  assert.equal(dryRun.mode, "dry-run");
  assert.equal(dryRun.plan.totals.duplicateGroups, 3);
  assert.equal(dryRun.plan.totals.mergeableGroups, 2);
  assert.equal(dryRun.plan.totals.conflictGroups, 1);
  assert.equal(dryRun.plan.conflicts[0].conflicts[0], "TEXT_MISMATCH");
  const serializedPlan = JSON.stringify(dryRun.plan);
  assert.ok(!serializedPlan.includes("版本 A"), "报告不得包含客户消息文字");
  assert.ok(!serializedPlan.includes("First 50"), "解析出来的正文也不得进入报告");
  assert.ok(!serializedPlan.includes("601133698121"), "报告不得包含完整号码");
  assert.equal(Number(execFileSync(SQLITE, ["-batch", databasePath, "SELECT COUNT(*) FROM messages;"], { encoding: "utf8" }).trim()), 8, "dry-run 不得修改资料");
}

assert.throws(
  () => repairDuplicateMessageIdentity({ rootDir, databasePath, apply: true }),
  (error) => error.code === "MESSAGE_IDENTITY_CONFIRMATION_REQUIRED",
  "apply 必须要求 confirmation token",
);

{
  // recentActiveRunState 以 run JSON 为准，registry 只是索引。
  await fsp.writeFile(path.join(rootDir, "campaign-data", "runs", "run_live.json"), JSON.stringify({
    runId: "run_live", status: "RUNNING", updatedAt: new Date().toISOString(), assignments: [],
  }));
  await fsp.writeFile(path.join(rootDir, "campaign-data", "active-runs.json"), JSON.stringify({
    runs: [{ runId: "run_live", status: "RUNNING", updatedAt: new Date().toISOString() }],
  }));
  assert.throws(
    () => repairDuplicateMessageIdentity({ rootDir, databasePath, apply: true, confirmation: MESSAGE_IDENTITY_CONFIRMATION }),
    (error) => error.code === "ACTIVE_CAMPAIGN_BLOCKS_MESSAGE_IDENTITY_REPAIR",
    "有 Campaign 在跑时必须拒绝合并",
  );
  await fsp.rm(path.join(rootDir, "campaign-data", "runs", "run_live.json"));
  await fsp.writeFile(path.join(rootDir, "campaign-data", "active-runs.json"), JSON.stringify({ runs: [] }));
}

{
  const applied = repairDuplicateMessageIdentity({ rootDir, databasePath, apply: true, confirmation: MESSAGE_IDENTITY_CONFIRMATION });
  assert.equal(applied.merged, 2);
  assert.equal(applied.verification.quickCheck, "ok");
  assert.equal(applied.verification.foreignKeyViolations, 0);
  assert.equal(applied.verification.removed, 2);
  assert.equal(applied.verification.remainingMergeableGroups, 0);
  assert.equal(applied.verification.remainingConflictGroups, 1, "冲突 group 必须原样保留等人工处理");
  assert.ok(fs.existsSync(applied.backupPath), "apply 前必须有备份");
  assert.ok(fs.existsSync(path.join(applied.archive.dir, "removed-rows.jsonl")), "被移除的 row 必须归档");

  const canonical = JSON.parse(execFileSync(SQLITE, ["-batch", "-json", databasePath,
    "SELECT message_type AS messageType, flow_topic AS flowTopic, payload_json AS payloadJson FROM messages WHERE row_id=1;"], { encoding: "utf8" }));
  assert.equal(canonical[0].messageType, "image");
  assert.equal(canonical[0].flowTopic, "Flow 1");
  const payload = JSON.parse(canonical[0].payloadJson);
  assert.equal(payload.runId, "run-1");
  assert.equal(payload.remoteJid, "jid-1");

  const crossConnection = execFileSync(SQLITE, ["-batch", databasePath,
    "SELECT COUNT(*) FROM messages WHERE external_message_id='EXT-AUTO';"], { encoding: "utf8" }).trim();
  assert.equal(Number(crossConnection), 2, "另一个 sender 上的同 ID 消息必须保留");

  // 未渲染的模板不得成为「客户收到了什么」的正式记录。
  const templateGroup = JSON.parse(execFileSync(SQLITE, ["-batch", "-json", databasePath,
    "SELECT row_id AS rowId, text, flow_topic AS flowTopic, payload_json AS payloadJson FROM messages WHERE external_message_id='EXT-TEMPLATE';"], { encoding: "utf8" }));
  assert.equal(templateGroup.length, 1);
  assert.equal(templateGroup[0].rowId, 7, "canonical row 仍由业务来源决定");
  assert.ok(!templateGroup[0].text.includes("[Phone_Number]"), "占位符不得留在正文里");
  assert.ok(templateGroup[0].text.includes("+60000000000"), "正文必须是客户实际收到的渲染结果");
  assert.equal(templateGroup[0].flowTopic, "Flow 2", "Campaign 元数据仍取 canonical row");
  assert.equal(JSON.parse(templateGroup[0].payloadJson).remoteJid, "jid-2", "history 证据仍要合并进来");
}

{
  const rerun = repairDuplicateMessageIdentity({ rootDir, databasePath });
  assert.equal(rerun.plan.totals.mergeableGroups, 0, "重跑必须是 0 changes");
  assert.equal(rerun.plan.totals.conflictGroups, 1);
}

// ── 5. Audit 只读、不含 PII、能识别 stale ledger ─────────────────────────────
{
  execFileSync(SQLITE, ["-batch", databasePath, `
INSERT INTO projects(project_code,project_name,created_at,updated_at) VALUES ('demo','Demo','2026-08-01','2026-08-01');
INSERT INTO campaign_runs(run_id,project_code,mode,status,requested_count,sent_count,failed_count,started_at)
VALUES ('run_stale','demo','LIVE','RUNNING',5,5,0,'2026-08-01T00:00:00.000Z');
UPDATE contacts SET stop_flag=1, display_name='Someone' WHERE contact_key='60999888777';`]);

  const report = auditCustomerDatabaseRebuild({ rootDir, databasePath });
  assert.equal(report.readOnly, true);
  assert.equal(report.runtime.activeRuns.length, 0, "运行时空闲");
  assert.equal(report.runtime.staleLedgerRuns.length, 1, "账本里的 RUNNING 要单独报告");
  assert.equal(report.runtime.safeForMaintenance, true, "stale 账本不该阻止维护");
  assert.ok(report.blockingIssues.some((issue) => issue.code === "STALE_CAMPAIGN_LEDGER"));
  assert.equal(report.permissions.stoppedContacts, 1);
  assert.equal(report.schema.highestApplied, 303);
  assert.deepEqual(report.schema.pending, [304, 305, 306, 307, 308, 309, 310]);
  assert.equal(report.migrationReadiness.find((item) => item.version === 305).blockers.includes("duplicate_message_identity"), true);

  const serialized = JSON.stringify(report) + renderAuditMarkdown(report);
  assert.ok(!serialized.includes("60999888777"), "audit 不得输出客户号码");
  assert.ok(!serialized.includes("601133698121"), "audit 不得输出发送号码");
  assert.ok(!serialized.includes("版本 A"), "audit 不得输出消息文字");
}

assert.equal(maskConnectionKey("device-a::601133698121"), "device-a::…8121");
assert.equal(maskConnectionKey(""), "(none)");

// planDuplicateMessageRepair 只读：确认它不会改动资料
{
  const before = execFileSync(SQLITE, ["-batch", databasePath, "SELECT COUNT(*) FROM messages;"], { encoding: "utf8" }).trim();
  planDuplicateMessageRepair({ rootDir, databasePath });
  assert.equal(execFileSync(SQLITE, ["-batch", databasePath, "SELECT COUNT(*) FROM messages;"], { encoding: "utf8" }).trim(), before);
}

await fsp.rm(rootDir, { recursive: true, force: true });
console.log("✅ Customer database rebuild tool tests passed");
