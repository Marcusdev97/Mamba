#!/usr/bin/env node

// Read-only Device Ownership repair scanner.
//
// This command deliberately does NOT contain an apply path. It reads the local
// Blast Leads cache, local Campaign Run files, and local Evolution chat history,
// then writes a report under ignored campaign-data/. It never PATCHes Notion and
// never calls a WhatsApp send endpoint.

import fs from "node:fs/promises";
import path from "node:path";
import { loadEnv, makeApi, listInstances, paths } from "./campaign_core.mjs";
import { createDeviceIdentity } from "./lib/device-identity.mjs";
import {
  analyzeDeviceOwnership,
  collectChatOwnershipEvidence,
  collectRunOwnershipEvidence,
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

async function scanEvolution(env, { pageSize, maxPages }) {
  const api = makeApi(env);
  const errors = [];
  let instances = [];
  try {
    instances = await listInstances(api);
  } catch (error) {
    errors.push(`无法读取 Evolution instances：${error.message}`);
    return { instances: [], messageSources: [], scans: [], errors, notices: [] };
  }

  const usable = instances.filter((item) => normalizeOwnershipPhone(item.number));
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

async function main() {
  if (!process.argv.includes("--dry-run") || process.argv.includes("--apply")) {
    throw new Error("安全保护：目前只支持 --dry-run，不支持 --apply。正确命令：node campaign-app/device_ownership_repair.mjs --dry-run");
  }
  const pageSize = argumentNumber("--page-size", 200);
  const maxPages = argumentNumber("--max-pages", 60);
  const offline = process.argv.includes("--offline");
  const scanChatObservations = process.argv.includes("--scan-chat-observations") && !offline;
  const generatedAt = new Date();

  console.log("Mamba Device Ownership Repair · DRY RUN");
  console.log("================================================");
  console.log("安全模式：不会发送 WhatsApp，不会修改 Notion，不会启动 AI 回复。\n");

  const env = await loadEnv();
  const device = createDeviceIdentity(env);
  const cache = await loadBlastCache();
  const runs = await loadRunStates();
  const evolution = !scanChatObservations
    ? { instances: [], messageSources: [], scans: [], errors: [], notices: [offline
      ? "使用 --offline，已跳过 Evolution Chat 扫描。"
      : "默认不扫描 WhatsApp Chat：历史 outbound 只能证明 sender phone，不能证明由哪台电脑发送。"] }
    : await scanEvolution(env, { pageSize, maxPages });

  const runEvidence = collectRunOwnershipEvidence(runs.states, { deviceId: device.id });
  const chatEvidence = collectChatOwnershipEvidence(evolution.messageSources, {
    resolvePhone,
    messageTime,
  });
  const normalizedDeviceId = normalizeOwnershipDeviceId(device.id);
  const runSourceSummary = runs.states.reduce((summary, run) => {
    const recorded = normalizeOwnershipDeviceId(run?.deviceId || run?.device?.id);
    if (!recorded) summary.ignoredLegacyWithoutDeviceId += 1;
    else if (recorded === normalizedDeviceId) summary.explicitLocalDeviceRuns += 1;
    else summary.otherDeviceRuns += 1;
    return summary;
  }, { explicitLocalDeviceRuns: 0, ignoredLegacyWithoutDeviceId: 0, otherDeviceRuns: 0 });
  const report = analyzeDeviceOwnership({
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

  const reportPath = path.join(paths.dataDir, "device-ownership", `dry-run-${timestampName(generatedAt)}.json`);
  await atomicWrite(reportPath, report);

  console.log("\nDry Run 结果");
  console.log("================================================");
  console.log(`Device ID          : ${device.id}${device.configured ? " (固定配置)" : " (由电脑名称自动产生，尚未固定)"}`);
  console.log(`Notion cache rows  : ${report.summary.totalRows}`);
  console.log(`旧 run 无 Device ID: ${runSourceSummary.ignoredLegacyWithoutDeviceId}（已忽略）`);
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
  console.log("这份报告位于 campaign-data（Git 已忽略），不会自动加入 commit。当前版本没有 Apply 功能。\n");
}

main().catch((error) => {
  console.error(`\nDry Run 无法完成：${error.message}`);
  process.exitCode = 1;
});
