import fs from "node:fs/promises";
import path from "node:path";

function cleanPending(value) {
  const rows = Array.isArray(value?.items) ? value.items : Array.isArray(value) ? value : [];
  return rows.filter((item) => item?.event?.id).map((item) => ({
    event: item.event,
    attempts: Math.max(0, Number(item.attempts) || 0),
    lastError: String(item.lastError || ""),
    queuedAt: item.queuedAt || new Date().toISOString(),
    updatedAt: item.updatedAt || item.queuedAt || new Date().toISOString(),
  }));
}

export function createTrackerReliabilityService({
  trackerDir,
  fsImpl = fs,
  clock = () => new Date(),
  processId = process.pid,
} = {}) {
  if (!trackerDir) throw new Error("trackerDir is required");
  const heartbeatPath = path.join(trackerDir, "heartbeat.json");
  const pendingPath = path.join(trackerDir, "pending_notion_replies.json");
  const pending = new Map();
  let writeChain = Promise.resolve();
  let lastHeartbeat = null;

  async function atomicWrite(filePath, value) {
    await fsImpl.mkdir(path.dirname(filePath), { recursive: true });
    const temp = `${filePath}.tmp.${processId}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
    await fsImpl.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
    await fsImpl.rename(temp, filePath);
  }

  function serializeWrite(task) {
    writeChain = writeChain.catch(() => {}).then(task);
    return writeChain;
  }

  async function init() {
    await fsImpl.mkdir(trackerDir, { recursive: true });
    try {
      const saved = cleanPending(JSON.parse(await fsImpl.readFile(pendingPath, "utf8")));
      for (const item of saved) pending.set(String(item.event.id), item);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    try {
      lastHeartbeat = JSON.parse(await fsImpl.readFile(heartbeatPath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return snapshot();
  }

  async function persistPending() {
    const payload = {
      version: 1,
      updatedAt: clock().toISOString(),
      count: pending.size,
      items: [...pending.values()],
    };
    await serializeWrite(() => atomicWrite(pendingPath, payload));
    return payload;
  }

  async function enqueue(event, { attempts = 0, lastError = "" } = {}) {
    if (!event?.id) return null;
    const id = String(event.id);
    const previous = pending.get(id);
    const now = clock().toISOString();
    const item = {
      event,
      attempts: Math.max(0, Number(attempts) || 0),
      lastError: String(lastError || ""),
      queuedAt: previous?.queuedAt || now,
      updatedAt: now,
    };
    pending.set(id, item);
    await persistPending();
    return item;
  }

  async function remove(id) {
    const removed = pending.delete(String(id || ""));
    if (removed) await persistPending();
    return removed;
  }

  async function heartbeat({ startedAt, lastReplyAt = null, webhookMode = "forwarded" } = {}) {
    lastHeartbeat = {
      version: 1,
      service: "reply-tracker",
      pid: processId,
      startedAt: startedAt || null,
      heartbeatAt: clock().toISOString(),
      lastReplyAt: lastReplyAt || null,
      webhookMode,
      pendingNotionReplies: pending.size,
    };
    await serializeWrite(() => atomicWrite(heartbeatPath, lastHeartbeat));
    return lastHeartbeat;
  }

  function snapshot() {
    return {
      heartbeat: lastHeartbeat,
      pendingCount: pending.size,
      pending: [...pending.values()],
      paths: { heartbeatPath, pendingPath },
    };
  }

  return { init, enqueue, remove, heartbeat, snapshot, values: () => [...pending.values()] };
}

export function trackerHeartbeatStatus(heartbeat, { now = new Date(), maxAgeMs = 120_000 } = {}) {
  const heartbeatMs = new Date(heartbeat?.heartbeatAt || 0).getTime();
  const lastReplyMs = new Date(heartbeat?.lastReplyAt || 0).getTime();
  const ageMs = Number.isFinite(heartbeatMs) && heartbeatMs > 0 ? Math.max(0, now.getTime() - heartbeatMs) : null;
  const lastReplyAgeMs = Number.isFinite(lastReplyMs) && lastReplyMs > 0 ? Math.max(0, now.getTime() - lastReplyMs) : null;
  return {
    heartbeatAt: heartbeat?.heartbeatAt || null,
    heartbeatAgeSeconds: ageMs === null ? null : Math.round(ageMs / 1000),
    lastReplyAt: heartbeat?.lastReplyAt || null,
    lastReplyAgeMinutes: lastReplyAgeMs === null ? null : Math.round(lastReplyAgeMs / 60000),
    pendingNotionReplies: Math.max(0, Number(heartbeat?.pendingNotionReplies) || 0),
    fresh: ageMs !== null && ageMs <= maxAgeMs,
  };
}
