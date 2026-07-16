import fs from "node:fs/promises";
import path from "node:path";

function runnerId(runner) {
  return String(runner?.state?.runId || "").trim();
}

export function runnerInstanceNames(runner) {
  const names = new Set();
  for (const item of runner?.state?.instances || []) {
    const name = typeof item === "string" ? item : item?.name;
    if (name) names.add(String(name));
  }
  for (const job of runner?.state?.assignments || []) {
    const name = job?.instanceKey || job?.instanceName;
    if (name) names.add(String(name));
  }
  return [...names];
}

export function instanceSetsOverlap(left, right) {
  const wanted = new Set((left || []).map(String));
  return (right || []).some((name) => wanted.has(String(name)));
}

export function createCampaignRunnerRegistry({ rootDir, fsImpl = fs } = {}) {
  const indexPath = path.join(rootDir, "campaign-data", "active-runs.json");
  const runners = new Map();
  let latestRunId = null;

  function register(runner, { latest = true } = {}) {
    const runId = runnerId(runner);
    if (!runId) throw new Error("Campaign runner 缺少 runId，无法登记。");
    runners.set(runId, runner);
    if (latest || !latestRunId) latestRunId = runId;
    return runner;
  }

  function get(runId = null) {
    const key = String(runId || "").trim() || latestRunId;
    return key ? runners.get(key) || null : null;
  }

  function list() {
    return [...runners.values()];
  }

  function setLatest(runId) {
    const key = String(runId || "").trim();
    if (key && runners.has(key)) latestRunId = key;
    return get();
  }

  function remove(runId) {
    const key = String(runId || "").trim();
    const removed = runners.delete(key);
    if (latestRunId === key) latestRunId = [...runners.keys()].at(-1) || null;
    return removed;
  }

  function entries() {
    return list().map((runner) => ({
      runId: runnerId(runner),
      projectId: String(runner.state?.projectId || runner.state?.campaignId || ""),
      project: String(runner.state?.project?.name || runner.state?.project || ""),
      status: String(runner.state?.status || ""),
      mode: runner.state?.mode === "LIVE" ? "LIVE" : "TEST",
      instanceNames: runnerInstanceNames(runner),
      updatedAt: String(runner.state?.updatedAt || new Date().toISOString()),
    }));
  }

  async function persist() {
    await fsImpl.mkdir(path.dirname(indexPath), { recursive: true });
    const value = { version: 1, latestRunId, runs: entries(), updatedAt: new Date().toISOString() };
    const temp = `${indexPath}.tmp.${process.pid}.${Date.now()}`;
    await fsImpl.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
    await fsImpl.rename(temp, indexPath);
    return value;
  }

  async function loadIndex() {
    try {
      const value = JSON.parse(await fsImpl.readFile(indexPath, "utf8"));
      return {
        latestRunId: String(value?.latestRunId || "") || null,
        runs: Array.isArray(value?.runs) ? value.runs : [],
      };
    } catch (error) {
      if (error?.code === "ENOENT") return { latestRunId: null, runs: [] };
      throw error;
    }
  }

  return { indexPath, register, get, list, setLatest, remove, entries, persist, loadIndex };
}
