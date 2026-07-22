// 清掉卡住的 campaign run。
//
// 为什么需要这支：conflictingRunner 会因为一个 READY / STOPPED / INTERRUPTED 的旧 run
// 一直占着 WhatsApp 号码的「车道」，导致新的 campaign 一律 409「这个号码正在跑另一批」。
// UI 上没有任何地方能清掉它 —— /api/stop 只停「正在跑的」，停不了一个从没启动的预览。
//
// 做的事：把旧 run 标成 CANCELLED（run 档 + active-runs.json 两边），
// assignments 原封不动保留 —— 已经发出去的纪录是查帐依据，绝对不能删。
//
//   node campaign-app/clear_stale_runs.mjs                     # 只看，不改
//   node campaign-app/clear_stale_runs.mjs --apply             # 清掉没发过的
//   node campaign-app/clear_stale_runs.mjs --apply --include-sent   # 连发过的也清(小心)
//   node campaign-app/clear_stale_runs.mjs --apply --run-id=run_xxx # 只清一个
//   node campaign-app/clear_stale_runs.mjs --min-age-hours=0    # 不限年龄

import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { paths } from "./campaign_core.mjs";

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const value = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? "";

const apply = has("--apply");
const includeSent = has("--include-sent");
const onlyRunId = value("run-id");
const minAgeHours = Number(value("min-age-hours") || 6);

// 这些状态代表「这批已经结案」，不会再占车道。
const TERMINAL = new Set(["COMPLETED", "STOPPED", "CANCELLED", "FAILED"]);

const dataDir = paths.dataDir;
const registryPath = path.join(dataDir, "active-runs.json");

async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return fallback; }
}

// 控制台在跑的话，它记忆体里还握着这些 runner，persistRunners() 会把我们的修改覆盖回去。
function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.setTimeout(700);
    socket.on("connect", () => { socket.destroy(); resolve(true); });
    socket.on("timeout", () => { socket.destroy(); resolve(false); });
    socket.on("error", () => resolve(false));
  });
}

const registry = await readJson(registryPath);
if (!registry?.runs?.length) {
  console.log("active-runs.json 里没有任何 run，没东西要清。");
  process.exit(0);
}

const nowMs = Date.now();
const candidates = [];
for (const entry of registry.runs) {
  if (TERMINAL.has(entry.status)) continue;
  if (onlyRunId && entry.runId !== onlyRunId) continue;
  const ageHours = (nowMs - new Date(entry.updatedAt || 0).getTime()) / 3_600_000;
  const runFile = path.join(dataDir, "runs", `${entry.runId}.json`);
  const run = await readJson(runFile);
  const assignments = run?.assignments ?? [];
  const sent = assignments.filter((job) => job.part1?.sentAt || job.part1?.messageId || job.part2?.sentAt || job.part2?.messageId).length;
  candidates.push({ entry, runFile, run, total: assignments.length, sent, ageHours });
}

if (!candidates.length) {
  console.log(`没有卡住的 run（${onlyRunId ? `找不到 ${onlyRunId}，或它已经结案` : "全部都已经是终态"}）。`);
  process.exit(0);
}

console.log(`卡住的 run：${candidates.length} 个\n`);
const doable = [];
for (const item of candidates) {
  const tooYoung = item.ageHours < minAgeHours;
  const hasSent = item.sent > 0;
  const blocked = tooYoung || (hasSent && !includeSent);
  const reason = tooYoung
    ? `跳过：只过了 ${item.ageHours.toFixed(1)} 小时（门槛 ${minAgeHours}h，怕清到正在用的）`
    : hasSent && !includeSent
      ? `跳过：已经发出去 ${item.sent} 条，要清请加 --include-sent`
      : "可清";
  console.log(`  ${item.entry.runId}`);
  console.log(`    ${item.entry.status} · ${item.entry.mode} · ${item.entry.projectId} · ${item.ageHours.toFixed(1)} 小时前`);
  console.log(`    客户 ${item.total} 个 · 真的发出去 ${item.sent} 条`);
  console.log(`    → ${reason}\n`);
  if (!blocked) doable.push(item);
}

if (!apply) {
  console.log(`--- 只是预览，没有改任何东西。要真的清掉这 ${doable.length} 个，加 --apply ---`);
  process.exit(0);
}
if (!doable.length) {
  console.log("没有可清的（都被上面的理由挡下）。");
  process.exit(0);
}

if (await portInUse(8787)) {
  console.log("\n⚠️ Mamba 控制台(8787)还在跑。它记忆体里握着这些 run，会把清理覆盖回去。");
  console.log("   请先关掉 server（和 watchdog），再跑一次这支。");
  process.exit(1);
}

// 备份：出事随时能还原
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = path.join(dataDir, "backups", `stale-runs-${stamp}`);
await fs.mkdir(backupDir, { recursive: true });
await fs.copyFile(registryPath, path.join(backupDir, "active-runs.json"));
for (const item of doable) {
  if (item.run) await fs.copyFile(item.runFile, path.join(backupDir, path.basename(item.runFile)));
}
console.log(`\n已备份到 ${backupDir}`);

const nowIso = new Date().toISOString();
const note = `Cancelled by clear_stale_runs at ${nowIso}: stale ${minAgeHours}h+ run holding the sender lane.`;

for (const item of doable) {
  // run 档：只动状态，assignments 原样留着（已发纪录是查帐依据）
  if (item.run) {
    item.run.status = "CANCELLED";
    item.run.endAt = item.run.endAt || nowIso;
    item.run.updatedAt = nowIso;
    item.run.cancelNote = note;
    const tmp = `${item.runFile}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(item.run, null, 2)}\n`);
    await fs.rename(tmp, item.runFile);
  }
  const target = registry.runs.find((r) => r.runId === item.entry.runId);
  if (target) { target.status = "CANCELLED"; target.updatedAt = nowIso; }
  console.log(`  ✓ ${item.entry.runId} → CANCELLED（${item.total} 个客户的纪录保留，发过的 ${item.sent} 条没有动）`);
}

registry.updatedAt = nowIso;
const registryTmp = `${registryPath}.tmp`;
await fs.writeFile(registryTmp, `${JSON.stringify(registry, null, 2)}\n`);
await fs.rename(registryTmp, registryPath);

console.log(`\n清掉 ${doable.length} 个。重新启动 Mamba 之后，号码车道就放开了。`);
