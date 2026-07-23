#!/usr/bin/env node

import { loadEnv, listInstances, makeApi, paths } from "./campaign_core.mjs";
import { loadDeviceIdentity, normalizeSenderPhone } from "./lib/device-identity.mjs";
import { saveDeviceSenderPolicy } from "./lib/device-sender-policy.mjs";

const raw = process.argv.find((item) => item.startsWith("--phone="))?.slice("--phone=".length) || "";
const phone = normalizeSenderPhone(raw);
if (!phone) {
  console.error("号码格式不正确。用法：node campaign-app/device_sender_config.mjs --phone=60168568756");
  process.exit(1);
}

const env = await loadEnv();
const device = await loadDeviceIdentity(env, { dataDir: paths.dataDir });
const instances = await listInstances(makeApi(env));
const open = instances.filter((item) => String(item.status || "").toUpperCase() === "OPEN");
const matches = open.filter((item) => normalizeSenderPhone(item.number) === phone);
if (matches.length !== 1) {
  console.error(`无法绑定：号码 ${phone} 必须刚好有一个 OPEN connection，目前找到 ${matches.length} 个。`);
  console.error(`当前 OPEN：${open.map((item) => `${item.name}=${normalizeSenderPhone(item.number) || "unknown"}`).join(", ") || "none"}`);
  console.error("请先在 Settings 建立 Device 专属 connection 并扫码；不要复用另一台电脑的 wa_01。");
  process.exit(1);
}

await saveDeviceSenderPolicy({ dataDir: paths.dataDir, deviceId: device.id, expectedSenderPhone: phone });
console.log(`已绑定 Device ${device.id}`);
console.log(`SQLite 客户群主号码：${phone}`);
console.log(`Evolution connection：${matches[0].name}`);
const blocked = open.filter((item) => item !== matches[0]);
if (blocked.length) console.log(`其他本机 OPEN connection 仍可用于多号码发送：${blocked.map((item) => item.name).join(", ")}`);
console.log("请重新打开 Mamba，让发送、扫描与 Customer Desk 全部载入这个绑定。");
