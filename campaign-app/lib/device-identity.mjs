import os from "node:os";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

function clean(value) {
  return String(value ?? "").trim();
}

function slug(value) {
  return clean(value)
    .toLowerCase()
    .replace(/\.local$/i, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function createDeviceIdentity(env = {}, hostname = os.hostname()) {
  const host = clean(hostname) || "mamba-device";
  const name = clean(env.MAMBA_DEVICE_NAME || process.env.MAMBA_DEVICE_NAME) || host;
  const configuredId = clean(env.MAMBA_DEVICE_ID || process.env.MAMBA_DEVICE_ID);
  const id = slug(configuredId || name || host) || "mamba-device";
  return {
    id,
    name,
    hostname: host,
    configured: Boolean(configuredId),
  };
}

export async function loadDeviceIdentity(env = {}, { dataDir, hostname = os.hostname() } = {}) {
  const configured = createDeviceIdentity(env, hostname);
  if (configured.configured || !dataDir) return { ...configured, source: configured.configured ? "env" : "hostname" };

  const filePath = path.join(dataDir, "device-identity.json");
  try {
    const saved = JSON.parse(await fs.readFile(filePath, "utf8"));
    const id = slug(saved?.id);
    if (id) {
      return {
        id,
        name: clean(saved?.name) || configured.name,
        hostname: clean(hostname) || configured.hostname,
        configured: true,
        source: "local-file",
      };
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Error(`无法读取本机 Device ID：${error.message}`);
  }

  const identity = {
    id: `mamba-${crypto.randomUUID()}`,
    name: configured.name,
    hostname: configured.hostname,
    configured: true,
    source: "local-file",
    createdAt: new Date().toISOString(),
  };
  await fs.mkdir(dataDir, { recursive: true });
  const temp = `${filePath}.tmp.${process.pid}`;
  await fs.writeFile(temp, `${JSON.stringify(identity, null, 2)}\n`);
  await fs.rename(temp, filePath);
  return identity;
}

export function normalizeSenderPhone(value) {
  let digits = clean(value).replace(/\D/g, "");
  if (digits.startsWith("0")) digits = `60${digits.slice(1)}`;
  return /^\d{8,15}$/.test(digits) ? digits : "";
}

export function senderPhoneForInstance(instances, instanceName) {
  const wanted = clean(instanceName);
  const instance = (instances || []).find((item) => clean(item?.name || item) === wanted);
  return normalizeSenderPhone(instance?.number || instance?.owner || instance?.phone);
}

export function buildSenderKey(deviceId, senderPhone) {
  const device = slug(deviceId);
  const phone = normalizeSenderPhone(senderPhone);
  return device && phone ? `${device}::${phone}` : "";
}

export function senderKeyBelongsToDevice(value, deviceId) {
  const key = clean(value).toLowerCase();
  const device = slug(deviceId).toLowerCase();
  return Boolean(key && device && key.startsWith(`${device}::`));
}
