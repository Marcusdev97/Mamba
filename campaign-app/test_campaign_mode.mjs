// 每个号码各自一个发送模式的测试。
//
// 800 客户分 3 群、3 个号码各跑各的节奏 —— 老号 crazy、新号保守。所以核心要守：
// 号码之间互不影响、没设过的用预设、旧的单一 mode 档要能平滑迁移。

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCampaignModeService, deliveryForMode, MODE_ORDER, isValidMode } from "./lib/campaign-mode-service.mjs";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-mode-"));
const svc = createCampaignModeService({ dataDir, clock: () => new Date("2026-07-23T00:00:00Z") });

// --- 没设过 = 预设普通 ---
assert.equal(await svc.getMode("wa_01"), "normal", "没设过的号码用预设");
assert.equal(await svc.getMode(""), "normal", "空号码名也回预设，不炸");

// --- 每号各自设，互不影响 ---
await svc.setMode("wa_01", "crazy");
await svc.setMode("wa_02", "conservative");
assert.equal(await svc.getMode("wa_01"), "crazy");
assert.equal(await svc.getMode("wa_02"), "conservative");
assert.equal(await svc.getMode("wa_03"), "normal", "没碰过的第三个号码仍是预设");

// --- 节奏值跟着 mode 走 ---
const crazy = await svc.deliveryForInstance("wa_01");
assert.deepEqual(crazy.contactGapSeconds, { min: 20, max: 30 }, "crazy 是 20-30s");
const cons = await svc.deliveryForInstance("wa_02");
assert.deepEqual(cons.contactGapSeconds, { min: 90, max: 150 }, "保守是 90-150s");
assert.ok(crazy.minBlastGapSeconds < cons.minBlastGapSeconds, "crazy 的硬底线比保守短");

// --- 存到本机、重开还在（换一个 service 实例读同一个档）---
const reopened = createCampaignModeService({ dataDir });
assert.equal(await reopened.getMode("wa_01"), "crazy", "重开后 wa_01 还是 crazy");
assert.equal(await reopened.getMode("wa_02"), "conservative");

// --- snapshot：UI 要拿到「每个号码现在选什么」+ 没设过的补预设 ---
const snap = await svc.snapshot(["wa_01", "wa_02", "wa_03", "wa_04"]);
const byName = Object.fromEntries(snap.instances.map((i) => [i.instance, i]));
assert.equal(byName.wa_01.mode, "crazy");
assert.equal(byName.wa_01.explicit, true, "设过的标 explicit");
assert.equal(byName.wa_04.mode, "normal");
assert.equal(byName.wa_04.explicit, false, "没设过的标非 explicit（用的是预设）");
assert.equal(snap.modes.length, 3, "三个模式的目录都在");
assert.deepEqual(snap.modes.map((m) => m.key), MODE_ORDER);

// --- 乱值挡下来 ---
await assert.rejects(() => svc.setMode("wa_01", "turbo"), /不认识的发送模式/);
await assert.rejects(() => svc.setMode("", "crazy"), /哪个号码/);
assert.equal(isValidMode("normal"), true);
assert.equal(isValidMode("turbo"), false);

// --- 从旧的 v1 单一 mode 档迁移（以前每台电脑一个）---
const legacyDir = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-mode-v1-"));
await fs.writeFile(path.join(legacyDir, "campaign-mode.json"), JSON.stringify({ version: 1, mode: "crazy" }));
const migrated = createCampaignModeService({ dataDir: legacyDir });
assert.equal(await migrated.getMode("wa_09"), "crazy", "旧的单一 mode 当作所有号码的预设兜底");
// 迁移后单独设某个号码，其他仍走旧预设
await migrated.setMode("wa_09", "conservative");
assert.equal(await migrated.getMode("wa_09"), "conservative");
assert.equal(await migrated.getMode("wa_10"), "crazy", "没单独设的还是沿用旧 mode 当预设");

// --- deliveryForMode 对未知 mode 要回预设，不炸 ---
assert.deepEqual(deliveryForMode("nonsense").contactGapSeconds, deliveryForMode("normal").contactGapSeconds);

// --- applyModeDelivery：套进 config 后，campaign_core 真的用到的节奏函数要跟着变 ---
// 这是第②块的核心保证：选了 mode，发送节奏必须真的改，而且形状要对得上
// contactGapRange / partGapRange / campaignPacing 的期望。
const { applyModeDelivery } = await import("./lib/campaign-mode-service.mjs");
const { contactGapRange, partGapRange, campaignPacing } = await import("./lib/campaign-schedule.mjs");

const baseConfig = { delivery: { replyLookbackDays: 7, resendCooldownDays: 5 } };

const crazyCfg = applyModeDelivery(baseConfig, "crazy");
assert.equal(crazyCfg.campaignMode, "crazy", "要记下用了哪个 mode");
assert.deepEqual(contactGapRange(crazyCfg), { minSeconds: 20, maxSeconds: 30 }, "crazy 客户间隔 20-30s");
assert.deepEqual(partGapRange(crazyCfg), { minSeconds: 4, maxSeconds: 8 }, "crazy part 间隔要对，形状转换正确");
assert.equal(campaignPacing(crazyCfg).floorMs, 45000, "crazy 硬底线 45s");
assert.equal(crazyCfg.delivery.replyLookbackDays, 7, "其他 delivery 设定不能被覆盖掉");
assert.equal(crazyCfg.delivery.resendCooldownDays, 5, "防重发冷却要保留");

const consCfg = applyModeDelivery(baseConfig, "conservative");
assert.deepEqual(contactGapRange(consCfg), { minSeconds: 90, maxSeconds: 150 }, "保守 90-150s");
assert.ok(campaignPacing(consCfg).floorMs > campaignPacing(crazyCfg).floorMs, "保守比 crazy 慢");

// 原 config 不能被改动（回的是新物件）
assert.equal(baseConfig.delivery.contactGapSeconds, undefined, "applyModeDelivery 不可以改到原 config");

// 未知 mode → 退回普通，不炸
assert.deepEqual(contactGapRange(applyModeDelivery(baseConfig, "nonsense")), { minSeconds: 45, maxSeconds: 75 });

await fs.rm(dataDir, { recursive: true, force: true });
await fs.rm(legacyDir, { recursive: true, force: true });
console.log("✅ all campaign mode tests passed");
