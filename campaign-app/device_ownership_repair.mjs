#!/usr/bin/env node

// Device Ownership repair scanner and explicitly confirmed legacy migration.
// Preview never writes Notion. Apply accepts only a recent locally generated
// claim-preview report and never calls a WhatsApp send endpoint.

import fs from "node:fs/promises";
import path from "node:path";
import { loadEnv, makeApi, listInstances, paths } from "./campaign_core.mjs";
import { loadDeviceIdentity } from "./lib/device-identity.mjs";
import { createNotionService } from "./lib/notion-service.mjs";
import {
  analyzeDeviceOwnership,
  analyzeTrustedConnectionClaim,
  collectChatOwnershipEvidence,
  collectRunOwnershipEvidence,
  collectTrustedConnectionEvidence,
  collectTrustedLegacyRunEvidence,
  maskOwnershipPhone,
  normalizeOwnershipDeviceId,
  normalizeOwnershipPhone,
} from "./lib/device-ownership-repair-service.mjs";
import { collectMessageObjects, messageTime } from "./morning_followup.mjs";
import { resolvePhone } from "./reply_intake.mjs";
import { fetchInstanceMessagesDeep } from "./routes/next-flow.routes.mjs";

function argumentNumber(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value < 1) throw new Error(`${name} 必须是大于 0 的数字。`);
  return Math.floor(value);
}

function argumentValue(name) {
  const exact = process.argv.find((item) => item.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1).trim();
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
}

function timestampName(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw new Error(`无法读取 ${filePath}: ${error.message}`);
  }
}

async function loadRunStates() {
  const runDir = path.join(paths.dataDir, "runs");
  const files = (await fs.readdir(runDir).catch(() => []))
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(runDir, name));
  const activePath = path.join(paths.dataDir, "active-run.json");
  const active = await readJson(activePath, null);
  const states = [];
  const seen = new Set();
  for (const filePath of files) {
    const value = await readJson(filePath, null);
    const state = value?.state || value;
    if (!state) continue;
    const key = String(state.runId || filePath);
    if (seen.has(key)) continue;
    seen.add(key);
    states.push(state);
  }
  if (active) {
    const state = active.state || active;
    const key = String(state.runId || activePath);
    if (!seen.has(key)) states.push(state);
  }
  return { states, filesRead: states.length };
}

async function loadBlastCache() {
  const filePath = path.join(paths.dataDir, "blast_leads_cache.json");
  const cache = await readJson(filePath, null);
  if (!cache || !Array.isArray(cache.records) || !cache.records.length) {
    throw new Error("找不到可用的 Blast Leads cache。请先在 Mamba 的 Customer Search / Follow-Up 点击 Sync Notion Cache，再重新运行 Dry Run。");
  }
  return { filePath, syncedAt: cache.syncedAt || null, records: cache.records };
}

async function atomicWrite(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp.${process.pid}`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temp, filePath);
}

async function scanEvolution(env, { pageSize, maxPages, onlyOpen = false }) {
  const api = makeApi(env);
  const errors = [];
  let instances = [];
  try {
    instances = await listInstances(api);
  } catch (error) {
    errors.push(`无法读取 Evolution instances：${error.message}`);
    return { instances: [], messageSources: [], scans: [], errors, notices: [] };
  }

  const usable = instances.filter((item) => normalizeOwnershipPhone(item.number)
    && (!onlyOpen || String(item.status || "").toUpperCase() === "OPEN"));
  const messageSources = [];
  const scans = [];
  for (const instance of usable) {
    process.stdout.write(`扫描 ${instance.name} (${maskOwnershipPhone(instance.number)}) 的 outbound Chat... `);
    try {
      const result = await fetchInstanceMessagesDeep({ api, collectMessageObjects, messageTime }, instance.name, 0, {
        pageSize,
        maxPages,
        retryAttempts: 3,
        retryDelayMs: 400,
      });
      const outbound = result.messages.filter((message) => message?.key?.fromMe === true);
      messageSources.push({
        instanceName: instance.name,
        senderPhone: instance.number,
        messages: outbound,
      });
      scans.push({
        instanceName: instance.name,
        senderPhoneMasked: maskOwnershipPhone(instance.number),
        status: instance.status,
        pagesRead: result.pagesRead,
        messagesRead: result.messages.length,
        outboundMessages: outbound.length,
        totalReported: result.totalReported,
        truncated: result.truncated,
      });
      console.log(`${outbound.length} 条 outbound，${result.pagesRead} 页${result.truncated ? "（达到扫描上限）" : ""}`);
    } catch (error) {
      const message = `${instance.name}: ${error.message}`;
      errors.push(message);
      scans.push({
        instanceName: instance.name,
        senderPhoneMasked: maskOwnershipPhone(instance.number),
        status: instance.status,
        error: error.message,
      });
      console.log(`失败：${error.message}`);
    }
  }
  return { instances, messageSources, scans, errors, notices: [] };
}

function ownershipProperty(schema, name, value) {
  const type = schema?.[name]?.type;
  if (!type) throw new Error(`Notion 缺少 ${name} 字段。请先在 Customer Desk 检查 Schema Health。`);
  if (type === "rich_text") return { rich_text: [{ text: { content: String(value) } }] };
  if (type === "select") return { select: { name: String(value).slice(0, 100) } };
  if (type === "status") return { status: { name: String(value).slice(0, 100) } };
  if (type === "phone_number") return { phone_number: String(value) };
  throw new Error(`${name} 字段类型不支持：${type}`);
}

function notionPropertyValue(property) {
  if (!property) return "";
  if (property.type === "phone_number") return String(property.phone_number || "").trim();
  if (property.type === "select") return String(property.select?.name || "").trim();
  if (property.type === "status") return String(property.status?.name || "").trim();
  if (property.type === "rich_text") return (property.rich_text || []).map((item) => item.plain_text || item.text?.content || "").join("").trim();
  return "";
}

async function applyClaimReport({ env, device, reportPath }) {
  const ownershipDir = path.resolve(paths.dataDir, "device-ownership");
  const resolvedReport = path.resolve(reportPath);
  if (!resolvedReport.startsWith(`${ownershipDir}${path.sep}`)) {
    throw new Error("安全保护：--report 必须是本机 campaign-data/device-ownership 内的 Preview 报告。");
  }
  const report = await readJson(resolvedReport, null);
  if (!report || report.mode !== "claim-preview" || !Array.isArray(report.confirmed)) {
    throw new Error("这不是有效的 claim-preview 报告，拒绝写入 Notion。");
  }
  if (normalizeOwnershipDeviceId(report.device?.id) !== normalizeOwnershipDeviceId(device.id)) {
    throw new Error(`报告属于另一台 Device（${report.device?.id || "unknown"}），当前是 ${device.id}。`);
  }
  const ageMs = Date.now() - new Date(report.generatedAt || 0).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > 24 * 60 * 60 * 1000) {
    throw new Error("Preview 报告已超过 24 小时，请重新扫描后再 Apply。");
  }
  const confirmedDevice = argumentValue("--confirm-device");
  if (confirmedDevice !== device.id) {
    throw new Error(`安全保护：请加上 --confirm-device=${device.id}，明确确认当前 Device。`);
  }

  const notionConfig = await readJson(path.join(paths.dataDir, "notion_config.json"), null);
  const databaseId = String(notionConfig?.databases?.blastLeads || "").replace(/[^a-fA-F0-9]/g, "");
  if (!databaseId) throw new Error("notion_config.json 缺少 Blast Leads database ID。");
  const { notion } = createNotionService({ env });
  const database = await notion("GET", `/databases/${databaseId}`);
  const schema = database?.properties || {};
  const cache = await loadBlastCache();
  const recordsById = new Map(cache.records.map((record) => [String(record.id || "").replace(/-/g, ""), record]));
  const applied = [];
  const failed = [];

  console.log(`准备写入 ${report.confirmed.length} 条确定归属；不会发送 WhatsApp，不会启动 AI。`);
  for (const item of report.confirmed) {
    const pageId = String(item.pageId || "").replace(/[^a-fA-F0-9]/g, "");
    try {
      if (pageId.length !== 32) throw new Error("Notion page ID 不合法");
      const proposed = item.proposed || {};
      const livePage = await notion("GET", `/pages/${pageId}`);
      const liveOwnership = {
        lastSentByDevice: notionPropertyValue(livePage?.properties?.["Last Sent By Device"]),
        lastSenderPhone: normalizeOwnershipPhone(notionPropertyValue(livePage?.properties?.["Last Sender Phone"])) || "",
        assignedSenderKey: notionPropertyValue(livePage?.properties?.["Assigned Sender Key"]),
        lastSenderKey: notionPropertyValue(livePage?.properties?.["Last Sender Key"]),
      };
      const occupied = Object.values(liveOwnership).some(Boolean);
      const alreadyMatches = occupied
        && liveOwnership.lastSentByDevice === proposed.lastSentByDevice
        && liveOwnership.lastSenderPhone === proposed.lastSenderPhone
        && liveOwnership.assignedSenderKey === proposed.assignedSenderKey
        && liveOwnership.lastSenderKey === proposed.lastSenderKey;
      if (occupied && !alreadyMatches) {
        const error = new Error("Preview 后 Ownership 已被另一台 Device 或流程修改；已拒绝覆盖。请重新 Preview。");
        error.code = "OWNERSHIP_CHANGED_AFTER_PREVIEW";
        throw error;
      }
      const properties = {
        "Last Sent By Device": ownershipProperty(schema, "Last Sent By Device", proposed.lastSentByDevice),
        "Last Sender Phone": ownershipProperty(schema, "Last Sender Phone", proposed.lastSenderPhone),
        "Assigned Sender Key": ownershipProperty(schema, "Assigned Sender Key", proposed.assignedSenderKey),
        "Last Sender Key": ownershipProperty(schema, "Last Sender Key", proposed.lastSenderKey),
      };
      if (!alreadyMatches) await notion("PATCH", `/pages/${pageId}`, { properties });
      const cached = recordsById.get(pageId);
      if (cached) Object.assign(cached, proposed);
      applied.push({ pageId: item.pageId, phone: item.phone, project: item.project, proposed, alreadyMatched: alreadyMatches });
      await new Promise((resolve) => setTimeout(resolve, 250));
    } catch (error) {
      failed.push({
        pageId: item.pageId,
        phone: item.phone,
        project: item.project,
        errorCode: error.code || (/401|token|unauthorized/i.test(error.message) ? "NOTION_AUTH_FAILED"
          : /429|rate/i.test(error.message) ? "NOTION_RATE_LIMITED"
            : /page ID/i.test(error.message) ? "INVALID_PAGE_ID"
              : "OWNERSHIP_WRITE_FAILED"),
        error: error.message,
        solution: "检查 Notion token、Blast Leads sharing 和 Schema Health，然后重新 Preview；已经成功的 rows 不会被覆盖。",
      });
    }
  }

  await atomicWrite(cache.filePath, {
    syncedAt: new Date().toISOString(),
    count: cache.records.length,
    records: cache.records,
  });
  const result = {
    version: 1,
    mode: "claim-apply-result",
    generatedAt: new Date().toISOString(),
    sourceReport: resolvedReport,
    device,
    safety: { whatsappSends: 0, aiReplies: 0, overwritesExistingOwnership: 0 },
    summary: { requested: report.confirmed.length, applied: applied.length, failed: failed.length },
    applied,
    failed,
    sensitive: "This ignored local report contains customer phone numbers and Notion page ids. Do not commit it.",
  };
  const resultPath = path.join(ownershipDir, `claim-apply-${timestampName()}.json`);
  await atomicWrite(resultPath, result);
  console.log(`\nApply 完成：成功 ${applied.length}，失败 ${failed.length}。`);
  console.log(`结果报告：${resultPath}`);
  if (failed.length) {
    console.log("失败项目已记录 errorCode、原始错误和解决方法；请不要重复全量 Apply。");
    process.exitCode = 2;
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const apply = process.argv.includes("--apply");
  const claimCurrentConnections = process.argv.includes("--claim-current-connections");
  if (dryRun === apply) throw new Error("请选择其中一个模式：--dry-run 或 --apply。");
  const pageSize = argumentNumber("--page-size", 200);
  const maxPages = argumentNumber("--max-pages", 60);
  const offline = process.argv.includes("--offline");
  const scanChatObservations = process.argv.includes("--scan-chat-observations") && !offline;
  const generatedAt = new Date();

  const env = await loadEnv();
  const device = await loadDeviceIdentity(env, { dataDir: paths.dataDir });
  if (apply) {
    const reportPath = argumentValue("--report");
    if (!reportPath) throw new Error("Apply 缺少 --report=/完整路径/claim-preview-....json");
    await applyClaimReport({ env, device, reportPath });
    return;
  }

  console.log(claimCurrentConnections
    ? "Mamba Device Ownership Repair · AUTHORIZED CLAIM PREVIEW"
    : "Mamba Device Ownership Repair · DRY RUN");
  console.log("================================================");
  console.log("安全模式：不会发送 WhatsApp，不会修改 Notion，不会启动 AI 回复。\n");

  const cache = await loadBlastCache();
  const runs = await loadRunStates();
  const evolution = claimCurrentConnections
    ? await scanEvolution(env, { pageSize, maxPages, onlyOpen: true })
    : !scanChatObservations
    ? { instances: [], messageSources: [], scans: [], errors: [], notices: [offline
      ? "使用 --offline，已跳过 Evolution Chat 扫描。"
      : "默认不扫描 WhatsApp Chat：历史 outbound 只能证明 sender phone，不能证明由哪台电脑发送。"] }
    : await scanEvolution(env, { pageSize, maxPages });

  if (claimCurrentConnections && !evolution.messageSources.length) {
    throw new Error(`没有可用于 Claim 的 OPEN WhatsApp connection。${evolution.errors.join(" | ")}`);
  }
  const runEvidence = claimCurrentConnections
    ? collectTrustedLegacyRunEvidence(runs.states, { deviceId: device.id, currentConnections: evolution.messageSources })
    : collectRunOwnershipEvidence(runs.states, { deviceId: device.id });
  const chatEvidence = claimCurrentConnections
    ? collectTrustedConnectionEvidence(evolution.messageSources, { deviceId: device.id, resolvePhone, messageTime })
    : collectChatOwnershipEvidence(evolution.messageSources, { resolvePhone, messageTime });
  const normalizedDeviceId = normalizeOwnershipDeviceId(device.id);
  const runSourceSummary = runs.states.reduce((summary, run) => {
    const recorded = normalizeOwnershipDeviceId(run?.deviceId || run?.device?.id);
    if (!recorded) summary.ignoredLegacyWithoutDeviceId += 1;
    else if (recorded === normalizedDeviceId) summary.explicitLocalDeviceRuns += 1;
    else summary.otherDeviceRuns += 1;
    return summary;
  }, { explicitLocalDeviceRuns: 0, ignoredLegacyWithoutDeviceId: 0, otherDeviceRuns: 0 });
  const analyzer = claimCurrentConnections ? analyzeTrustedConnectionClaim : analyzeDeviceOwnership;
  const report = analyzer({
    device,
    records: cache.records,
    runEvidence,
    chatEvidence,
    generatedAt: generatedAt.toISOString(),
    source: {
      blastCache: { path: cache.filePath, syncedAt: cache.syncedAt, rows: cache.records.length },
      campaignRuns: { filesRead: runs.filesRead, ...runSourceSummary, evidence: runEvidence.length },
      evolution: {
        instances: evolution.instances.map((item) => ({
          name: item.name,
          status: item.status,
          senderPhoneMasked: maskOwnershipPhone(item.number),
        })),
        scans: evolution.scans,
        evidence: chatEvidence.length,
        errors: evolution.errors,
        notices: evolution.notices,
      },
    },
  });
  report.sensitive = "This ignored local report contains customer phone numbers and Notion page ids. Do not commit it.";

  const reportPath = path.join(paths.dataDir, "device-ownership", `${claimCurrentConnections ? "claim-preview" : "dry-run"}-${timestampName(generatedAt)}.json`);
  await atomicWrite(reportPath, report);

  console.log(claimCurrentConnections ? "\nClaim Preview 结果" : "\nDry Run 结果");
  console.log("================================================");
  console.log(`Device ID          : ${device.id}${device.configured ? " (固定配置)" : " (由电脑名称自动产生，尚未固定)"}`);
  console.log(`Notion cache rows  : ${report.summary.totalRows}`);
  console.log(`旧 run 无 Device ID: ${runSourceSummary.ignoredLegacyWithoutDeviceId}${claimCurrentConnections ? "（仅在号码与当前 connection 相同且有 sentAt 时采用）" : "（已忽略）"}`);
  console.log(`确定属于本机       : ${report.summary.confirmedLocal}`);
  console.log(`已经有 Ownership   : ${report.summary.alreadyAssigned}`);
  console.log(`存在冲突           : ${report.summary.conflicts}`);
  console.log(`无法确认           : ${report.summary.unresolved}`);
  console.log(`无效电话号码       : ${report.summary.invalid}`);
  console.log(`Notion writes      : ${report.safety.notionWrites}`);
  console.log(`WhatsApp sends     : ${report.safety.whatsappSends}`);

  if (!device.configured) {
    console.log("\n⚠️  当前 MAMBA_DEVICE_ID 没有固定配置。Dry Run 可以查看，但未来 Apply 前必须先设定固定 Device ID。");
  }
  if (evolution.errors.length) {
    console.log("\n⚠️  Evolution 扫描有未完成项目：");
    for (const error of evolution.errors) console.log(`   - ${error}`);
  }
  if (evolution.notices.length) {
    console.log("\n说明：");
    for (const notice of evolution.notices) console.log(`   - ${notice}`);
  }
  if (report.conflicts.length) {
    console.log("\n前 5 个冲突（号码已遮罩）：");
    for (const item of report.conflicts.slice(0, 5)) {
      console.log(`   - ${maskOwnershipPhone(item.phone)} · ${item.project || "No project"} · ${item.reason}`);
    }
  }
  console.log(`\n报告已保存：${reportPath}`);
  if (claimCurrentConnections) {
    console.log("确认报告数量和冲突后，才可以用 --apply --report=... --confirm-device=... 写入。\n");
  } else {
    console.log("这份报告位于 campaign-data（Git 已忽略），不会自动加入 commit。普通 Dry Run 不能 Apply。\n");
  }
}

main().catch((error) => {
  console.error(`\nDevice Ownership 无法完成：${error.message}`);
  process.exitCode = 1;
});
