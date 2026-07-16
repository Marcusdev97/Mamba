import os from "node:os";

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

export function buildSenderKey(deviceId, instanceName) {
  const device = slug(deviceId);
  const instance = clean(instanceName);
  return device && instance ? `${device}::${instance}` : instance;
}

export function senderKeyBelongsToDevice(value, deviceId) {
  const key = clean(value).toLowerCase();
  const device = slug(deviceId).toLowerCase();
  return Boolean(key && device && key.startsWith(`${device}::`));
}
