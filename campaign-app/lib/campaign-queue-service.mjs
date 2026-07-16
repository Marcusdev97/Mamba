import fs from "node:fs/promises";
import path from "node:path";

function cleanItems(value) {
  return (Array.isArray(value) ? value : [])
    .filter((item) => item && item.runId && item.runPath)
    .map((item) => ({
      runId: String(item.runId),
      runPath: String(item.runPath),
      projectId: String(item.projectId || ""),
      project: String(item.project || ""),
      flowLabel: String(item.flowLabel || "Flow 1 - Project Template"),
      mode: item.mode === "LIVE" ? "LIVE" : "TEST",
      total: Number(item.total || 0),
      instanceNames: [...new Set((Array.isArray(item.instanceNames) ? item.instanceNames : []).map(String).filter(Boolean))],
      autoAdvance: item.autoAdvance === true,
      queuedAt: String(item.queuedAt || new Date().toISOString()),
    }));
}

export function createCampaignQueueService({ rootDir, fsImpl = fs } = {}) {
  const queuePath = path.join(rootDir, "campaign-data", "campaign-queue.json");
  let items = [];
  let hold = null;

  const ready = (async () => {
    try {
      const saved = JSON.parse(await fsImpl.readFile(queuePath, "utf8"));
      items = cleanItems(saved?.items);
      hold = saved?.hold && typeof saved.hold === "object" ? saved.hold : null;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  })();

  async function persist() {
    await ready;
    await fsImpl.mkdir(path.dirname(queuePath), { recursive: true });
    const temp = `${queuePath}.tmp.${process.pid}.${Date.now()}`;
    await fsImpl.writeFile(temp, `${JSON.stringify({ version: 1, items, hold, updatedAt: new Date().toISOString() }, null, 2)}\n`);
    await fsImpl.rename(temp, queuePath);
  }

  async function add(runner, { projectId, autoAdvance = false } = {}) {
    await ready;
    const runId = String(runner?.state?.runId || "");
    if (!runId || !runner?.runPath) throw new Error("无法排队：prepared campaign 缺少 runId/runPath。");
    if (items.some((item) => item.runId === runId)) {
      return { item: items.find((item) => item.runId === runId), position: items.findIndex((item) => item.runId === runId) + 1 };
    }
    const item = {
      runId,
      runPath: runner.runPath,
      projectId: String(projectId || runner.state.projectId || ""),
      project: String(runner.state.project || ""),
      flowLabel: String(runner.state.flowLabel || runner.state.templateFlow || "Flow 1 - Project Template"),
      mode: runner.state.mode === "LIVE" ? "LIVE" : "TEST",
      total: Number(runner.state.assignments?.length || 0),
      instanceNames: [...new Set((runner.state.assignments || []).map((job) => job.instanceKey || job.instanceName).filter(Boolean).map(String))],
      autoAdvance: autoAdvance === true,
      queuedAt: new Date().toISOString(),
    };
    items.push(item);
    await persist();
    return { item, position: items.length };
  }

  async function peek() {
    await ready;
    return items[0] || null;
  }

  async function remove(runId) {
    await ready;
    const before = items.length;
    items = items.filter((item) => item.runId !== String(runId));
    if (items.length !== before) await persist();
    return before !== items.length;
  }

  async function setHold(reason, runId = null) {
    await ready;
    const nextReason = reason ? String(reason) : null;
    const nextRunId = runId ? String(runId) : null;
    if (hold?.reason === nextReason && hold?.runId === nextRunId) return hold;
    hold = nextReason ? { reason: nextReason, runId: nextRunId, at: new Date().toISOString() } : null;
    await persist();
    return hold;
  }

  async function clearHold() {
    await ready;
    if (!hold) return;
    hold = null;
    await persist();
  }

  async function snapshot() {
    await ready;
    return {
      count: items.length,
      hold,
      items: items.map((item, index) => ({ ...item, position: index + 1 })),
    };
  }

  return { ready, add, peek, remove, setHold, clearHold, snapshot, queuePath };
}
