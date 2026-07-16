import { normalizeSenderPhone, senderKeyBelongsToDevice } from "./device-identity.mjs";

function clean(value) {
  return String(value ?? "").trim();
}

function sameDevice(value, device) {
  const wanted = new Set([device?.id, device?.name, device?.hostname]
    .map((item) => clean(item).toLowerCase())
    .filter(Boolean));
  return wanted.has(clean(value).toLowerCase());
}

function validPhoneFromSenderKey(value) {
  const parts = clean(value).split("::");
  if (parts.length !== 2) return "";
  return normalizeSenderPhone(parts[1]);
}

export function recordDeviceScope(record, { device = {}, senderPhones = device?.senderPhones || [] } = {}) {
  const explicitDevice = clean(record?.lastSentByDevice);
  const explicitPhone = normalizeSenderPhone(record?.lastSenderPhone);
  const senderKeys = [record?.assignedSenderKey, record?.lastSenderKey].map(clean).filter(Boolean);
  const allowedPhones = new Set((senderPhones || []).map(normalizeSenderPhone).filter(Boolean));
  const phoneAllowed = (phone) => !allowedPhones.size || allowedPhones.has(phone);

  // A valid key contains both the stable Device ID and the real sender phone.
  // Legacy values such as device::wa_01 are deliberately not accepted.
  if (senderKeys.some((key) => {
    const phone = validPhoneFromSenderKey(key);
    return senderKeyBelongsToDevice(key, device.id) && phone && phoneAllowed(phone);
  })) {
    return "local";
  }
  if (explicitDevice && explicitPhone && sameDevice(explicitDevice, device) && phoneAllowed(explicitPhone)) return "local";

  const hasCompleteRemoteKey = senderKeys.some((key) => validPhoneFromSenderKey(key));
  if ((explicitDevice && explicitPhone) || hasCompleteRemoteKey) return "remote";

  // Partial/old ownership is visible only in diagnostics, never in a device desk.
  if (explicitDevice || explicitPhone || senderKeys.length || clean(record?.senderInstance)) return "legacy";
  return "unassigned";
}

export function filterRecordsForDevice(records, scope) {
  const counts = { local: 0, legacy: 0, remote: 0, unassigned: 0 };
  const filtered = [];
  for (const record of records || []) {
    const owner = recordDeviceScope(record, scope);
    counts[owner] += 1;
    if (owner === "local") filtered.push(record);
  }
  return { records: filtered, counts };
}

export function requireLocalRecord(records, pageId, scope) {
  const wanted = clean(pageId).replace(/[^a-fA-F0-9]/g, "");
  return filterRecordsForDevice(records, scope).records.find((record) => (
    clean(record?.id).replace(/[^a-fA-F0-9]/g, "") === wanted
  )) || null;
}
