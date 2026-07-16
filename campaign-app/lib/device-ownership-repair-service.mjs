function clean(value) {
  return String(value ?? "").trim();
}

export function normalizeOwnershipPhone(value) {
  let digits = String(value ?? "").replace(/\D/g, "");
  if (digits.startsWith("0")) digits = `60${digits.slice(1)}`;
  return /^\d{8,15}$/.test(digits) ? digits : null;
}

export function normalizeOwnershipDeviceId(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

export function ownershipConnectionKey(deviceId, senderPhone) {
  const device = normalizeOwnershipDeviceId(deviceId);
  const phone = normalizeOwnershipPhone(senderPhone);
  return device && phone ? `${device}::${phone}` : null;
}

function eventTime(value) {
  const ms = new Date(value || 0).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function newest(items) {
  return items.slice().sort((a, b) => eventTime(b.at) - eventTime(a.at))[0] || null;
}

function uniqueBy(items, keyOf) {
  const found = new Map();
  for (const item of items) {
    const key = keyOf(item);
    const previous = found.get(key);
    if (!previous || eventTime(item.at) > eventTime(previous.at)) found.set(key, item);
  }
  return [...found.values()];
}

function evidenceRecord({ phone, senderPhone, deviceId, instanceName, at, source, project = "", runId = "" }) {
  const customerPhone = normalizeOwnershipPhone(phone);
  const normalizedSender = normalizeOwnershipPhone(senderPhone);
  const connectionKey = ownershipConnectionKey(deviceId, normalizedSender);
  if (!customerPhone || !normalizedSender || !connectionKey) return null;
  return {
    phone: customerPhone,
    senderPhone: normalizedSender,
    connectionKey,
    instanceName: clean(instanceName),
    at: at || null,
    source,
    project: clean(project),
    runId: clean(runId),
  };
}

export function collectRunOwnershipEvidence(runStates, { deviceId } = {}) {
  const evidence = [];
  const expectedDeviceId = normalizeOwnershipDeviceId(deviceId);
  for (const raw of runStates || []) {
    const run = raw?.state || raw;
    if (!run || !Array.isArray(run.assignments)) continue;
    const recordedDeviceId = normalizeOwnershipDeviceId(run.deviceId || run.device?.id);
    // A local/synced run file is not proof that this computer sent it. Legacy
    // runs without an explicit Device ID must never be attributed automatically.
    if (!recordedDeviceId || recordedDeviceId !== expectedDeviceId) continue;
    const instances = new Map((run.instances || []).map((item) => {
      const name = clean(item?.name || item);
      return [name, normalizeOwnershipPhone(item?.owner || item?.number)];
    }));
    for (const job of run.assignments) {
      const sentAt = job?.part2?.sentAt || job?.part1?.sentAt || null;
      if (!sentAt) continue;
      const item = evidenceRecord({
        phone: job?.lead?.phone,
        senderPhone: instances.get(clean(job?.instanceName)),
        deviceId: recordedDeviceId,
        instanceName: job?.instanceName,
        at: sentAt,
        source: "campaign_run",
        project: run.project || run.campaignId,
        runId: run.runId,
      });
      if (item) evidence.push(item);
    }
  }
  return uniqueBy(evidence, (item) => `${item.phone}:${item.project}:${item.connectionKey}`);
}

export function collectChatOwnershipEvidence(messageSources, {
  resolvePhone,
  messageTime,
} = {}) {
  const evidence = [];
  for (const source of messageSources || []) {
    for (const message of source.messages || []) {
      if (message?.key?.fromMe !== true) continue;
      const phone = typeof resolvePhone === "function" ? resolvePhone(message) : null;
      const atMs = typeof messageTime === "function" ? Number(messageTime(message) || 0) : 0;
      const customerPhone = normalizeOwnershipPhone(phone);
      const senderPhone = normalizeOwnershipPhone(source.senderPhone);
      if (!customerPhone || !senderPhone) continue;
      evidence.push({
        phone: customerPhone,
        senderPhone,
        connectionKey: null,
        instanceName: clean(source.instanceName),
        at: atMs ? new Date(atMs).toISOString() : null,
        source: "whatsapp_outbound_sender_only",
        project: "",
        runId: "",
      });
    }
  }
  return uniqueBy(evidence, (item) => `${item.phone}:${item.senderPhone}`);
}

function existingOwnership(record) {
  const keys = [record?.assignedSenderKey, record?.lastSenderKey].map(clean).filter(Boolean);
  const device = clean(record?.lastSentByDevice);
  if (!device && !keys.length) return null;
  return {
    deviceId: device || null,
    keys,
    senderPhone: normalizeOwnershipPhone(record?.lastSenderPhone),
  };
}

function proposedOwnership(record, evidence, deviceId) {
  return {
    pageId: record.id,
    phone: normalizeOwnershipPhone(record.phone),
    project: clean(record.project),
    evidence: {
      source: evidence.source,
      at: evidence.at,
      runId: evidence.runId || null,
      instanceName: evidence.instanceName || null,
    },
    proposed: {
      lastSentByDevice: deviceId,
      lastSenderPhone: evidence.senderPhone,
      assignedSenderKey: evidence.connectionKey,
      lastSenderKey: evidence.connectionKey,
    },
  };
}

export function analyzeDeviceOwnership({
  device,
  records = [],
  runEvidence = [],
  chatEvidence = [],
  generatedAt = new Date().toISOString(),
  source = {},
} = {}) {
  const deviceId = clean(device?.id);
  if (!deviceId) throw new Error("Dry Run 缺少 Device ID。");

  const rowsByPhone = new Map();
  for (const record of records) {
    const phone = normalizeOwnershipPhone(record?.phone);
    if (!phone) continue;
    if (!rowsByPhone.has(phone)) rowsByPhone.set(phone, []);
    rowsByPhone.get(phone).push(record);
  }

  const runByPhone = new Map();
  for (const item of runEvidence) {
    if (!runByPhone.has(item.phone)) runByPhone.set(item.phone, []);
    runByPhone.get(item.phone).push(item);
  }
  const chatByPhone = new Map();
  for (const item of chatEvidence) {
    if (!chatByPhone.has(item.phone)) chatByPhone.set(item.phone, []);
    chatByPhone.get(item.phone).push(item);
  }

  const confirmed = [];
  const conflicts = [];
  const unresolved = [];
  const alreadyAssigned = [];
  const invalid = [];

  for (const record of records) {
    const phone = normalizeOwnershipPhone(record?.phone);
    if (!phone) {
      invalid.push({ pageId: record?.id || null, reason: "invalid_phone" });
      continue;
    }
    const ownership = existingOwnership(record);
    if (ownership) {
      alreadyAssigned.push({ pageId: record.id, phone, project: clean(record.project), ownership });
      continue;
    }

    const project = clean(record.project).toLowerCase();
    const projectRunEvidence = (runByPhone.get(phone) || []).filter((item) => {
      const evidenceProject = clean(item.project).toLowerCase();
      return !project || !evidenceProject || evidenceProject === project;
    });
    const runKeys = uniqueBy(projectRunEvidence, (item) => item.connectionKey);
    if (runKeys.length === 1) {
      confirmed.push(proposedOwnership(record, newest(projectRunEvidence), deviceId));
      continue;
    }
    if (runKeys.length > 1) {
      conflicts.push({
        pageId: record.id,
        phone,
        project: clean(record.project),
        reason: "multiple_run_senders",
        candidates: runKeys.map((item) => ({ connectionKey: item.connectionKey, at: item.at, source: item.source })),
      });
      continue;
    }

    const chatItems = chatByPhone.get(phone) || [];
    unresolved.push({
      pageId: record.id,
      phone,
      project: clean(record.project),
      reason: chatItems.length
        ? "whatsapp_history_cannot_prove_sending_device"
        : "no_explicit_device_run_evidence",
      observedSenderPhones: uniqueBy(chatItems, (item) => item.senderPhone).map((item) => item.senderPhone),
    });
  }

  return {
    version: 1,
    mode: "dry-run",
    generatedAt,
    safety: {
      notionWrites: 0,
      whatsappSends: 0,
      aiReplies: 0,
      overwritesExistingOwnership: 0,
    },
    device,
    source,
    summary: {
      totalRows: records.length,
      confirmedLocal: confirmed.length,
      alreadyAssigned: alreadyAssigned.length,
      conflicts: conflicts.length,
      unresolved: unresolved.length,
      invalid: invalid.length,
    },
    confirmed,
    conflicts,
    unresolved,
    alreadyAssigned,
    invalid,
  };
}

export function maskOwnershipPhone(value) {
  const phone = normalizeOwnershipPhone(value);
  if (!phone) return "-";
  return phone.length <= 6 ? phone : `${phone.slice(0, 3)}***${phone.slice(-4)}`;
}
