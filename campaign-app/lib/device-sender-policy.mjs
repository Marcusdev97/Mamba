import fs from "node:fs/promises";
import path from "node:path";
import { normalizeSenderPhone } from "./device-identity.mjs";

function clean(value) {
  return String(value ?? "").trim();
}

function policyPath(dataDir) {
  return path.join(dataDir, "device-sender.json");
}

export async function loadDeviceSenderPolicy({ dataDir, env = {} } = {}) {
  const configured = normalizeSenderPhone(env.MAMBA_EXPECTED_SENDER_PHONE || process.env.MAMBA_EXPECTED_SENDER_PHONE);
  if (configured) return { expectedSenderPhone: configured, configured: true, source: "env" };
  try {
    const saved = JSON.parse(await fs.readFile(policyPath(dataDir), "utf8"));
    const phone = normalizeSenderPhone(saved?.expectedSenderPhone);
    if (phone) return { ...saved, expectedSenderPhone: phone, configured: true, source: "local-file" };
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Error(`无法读取本机 WhatsApp 绑定：${error.message}`);
  }
  return { expectedSenderPhone: "", configured: false, source: "none" };
}

export async function saveDeviceSenderPolicy({ dataDir, deviceId, expectedSenderPhone } = {}) {
  const phone = normalizeSenderPhone(expectedSenderPhone);
  if (!phone) throw new Error("Expected Sender Phone 格式不正确。");
  const value = {
    version: 1,
    deviceId: clean(deviceId),
    expectedSenderPhone: phone,
    updatedAt: new Date().toISOString(),
  };
  await fs.mkdir(dataDir, { recursive: true });
  const filePath = policyPath(dataDir);
  const temp = `${filePath}.tmp.${process.pid}`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temp, filePath);
  return { ...value, configured: true, source: "local-file" };
}

export function instanceSenderPhone(instance) {
  return normalizeSenderPhone(instance?.number || instance?.owner || instance?.senderPhone);
}

// Evolution 跑在这台电脑的 127.0.0.1；能从本机 Evolution 列出的 connection
// 就是本机 transport，不应该因为它不是 SQLite 的 primary sender 而被 BLOCKED。
// primary sender 仍留在 policy.expectedSenderPhone，负责客户群默认归属；这里仅把
// 实际存在的本机号码加入 Device scope，发送 checkpoint 会再记录真实 sender phone。
export function includeLocalInstancePhones(device, instances = []) {
  const phones = new Set((device?.senderPhones || []).map(normalizeSenderPhone).filter(Boolean));
  for (const instance of instances || []) {
    const phone = instanceSenderPhone(instance);
    if (phone) phones.add(phone);
  }
  if (device && typeof device === "object") device.senderPhones = [...phones];
  return (instances || []).map((instance) => ({
    ...instance,
    allowedOnThisDevice: true,
  }));
}

export function filterInstancesForDevice(instances, policy) {
  if (!policy?.configured) return (instances || []).slice();
  return (instances || []).filter((item) => instanceSenderPhone(item) === policy.expectedSenderPhone);
}

function slug(value) {
  return clean(value).toLowerCase().replace(/\.local$/i, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28);
}

export function nextDeviceInstanceName(items, device) {
  const prefix = slug(device?.name || device?.hostname || device?.id) || "mamba-device";
  const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_wa_(\\d{2})$`);
  const used = new Set((items || []).map((item) => clean(item?.name)).map((name) => {
    const match = name.match(pattern);
    return match ? Number(match[1]) : null;
  }).filter(Number.isInteger));
  let number = 1;
  while (used.has(number)) number += 1;
  return `${prefix}_wa_${String(number).padStart(2, "0")}`;
}
