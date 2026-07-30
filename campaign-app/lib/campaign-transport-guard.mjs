function clean(value) {
  return String(value ?? "").trim();
}

function runnerInstances(runner) {
  const names = new Set();
  for (const job of runner?.state?.assignments || []) {
    const name = clean(job?.instanceName || job?.instanceKey);
    if (name) names.add(name);
  }
  if (!names.size) {
    for (const item of runner?.state?.instances || []) {
      const name = clean(typeof item === "string" ? item : item?.name);
      if (name) names.add(name);
    }
  }
  return [...names];
}

export function transportFailure(snapshot, requiredInstances = []) {
  if (!snapshot?.docker?.ok && snapshot?.docker?.state !== "warning") {
    return {
      code: snapshot?.docker?.code || "DOCKER_DAEMON_OFFLINE",
      message: "Docker Engine 已离线，Campaign 已安全暂停。启动 Docker 后请人工确认再继续。",
      layer: "docker",
    };
  }
  if (!snapshot?.evolution?.ok) {
    return {
      code: snapshot?.evolution?.code || "EVOLUTION_API_OFFLINE",
      message: "Evolution API 已离线，Campaign 已安全暂停。系统不会自动续发。",
      layer: "evolution",
    };
  }
  const byName = new Map((snapshot.instances || []).map((item) => [clean(item.name), item]));
  const unavailable = requiredInstances
    .map(clean)
    .filter(Boolean)
    .map((name) => byName.get(name) || { name, status: "MISSING" })
    .filter((item) => clean(item.status).toUpperCase() !== "OPEN");
  if (unavailable.length) {
    return {
      code: "WHATSAPP_INSTANCE_NOT_OPEN",
      message: `Campaign 号码掉线：${unavailable.map((item) => `${item.name} (${item.status})`).join(", ")}。已安全暂停，不会自动续发。`,
      layer: "instance",
      unavailable,
    };
  }
  return null;
}

export function createCampaignTransportGuard({
  healthService,
  listRunners,
  systemLogs = null,
  postOps = null,
  intervalMs = 15_000,
  failureThreshold = 2,
} = {}) {
  if (!healthService?.check) throw new Error("Campaign transport guard requires a health service.");
  if (typeof listRunners !== "function") throw new Error("Campaign transport guard requires listRunners().");

  const failures = new Map();
  let timer = null;
  let checking = false;
  let lastSnapshot = null;

  async function writeLog(level, event, message, context) {
    await systemLogs?.write?.({ level, area: "whatsapp", event, message, context }).catch(() => {});
  }

  async function interrupt(runner, failure, count) {
    const runId = clean(runner?.state?.runId);
    const changed = await runner.interruptForTransportFailure?.({
      code: failure.code,
      message: failure.message,
      layer: failure.layer,
      checkedAt: lastSnapshot?.checkedAt,
    });
    if (!changed) return false;

    failures.delete(runId);
    await writeLog("error", "campaign_transport_interrupted", "Campaign paused after its WhatsApp transport became unhealthy.", {
      runId,
      project: runner?.state?.project || null,
      mode: runner?.state?.mode || null,
      code: failure.code,
      layer: failure.layer,
      consecutiveFailures: count,
      instances: runnerInstances(runner),
    });
    if (postOps) {
      await postOps(
        `⛔ Mamba 已安全暂停 Campaign\nRun: ${runId}\n原因: ${failure.message}\n不会自动重连或继续发送，请检查后人工恢复。`,
      ).catch(() => {});
    }
    return true;
  }

  async function tick() {
    if (checking) return { skipped: "already_checking" };
    const runners = listRunners().filter((runner) => runner?.running === true && runner?.state?.status === "RUNNING");
    if (!runners.length) {
      failures.clear();
      return { checked: false, activeRuns: 0, snapshot: lastSnapshot };
    }

    checking = true;
    try {
      const required = [...new Set(runners.flatMap(runnerInstances))];
      lastSnapshot = await healthService.check({ requiredInstances: required });
      const interrupted = [];
      for (const runner of runners) {
        const runId = clean(runner.state?.runId);
        const failure = transportFailure(lastSnapshot, runnerInstances(runner));
        if (!failure) {
          failures.delete(runId);
          continue;
        }
        const count = (failures.get(runId) || 0) + 1;
        failures.set(runId, count);
        if (count >= failureThreshold && await interrupt(runner, failure, count)) {
          interrupted.push({ runId, code: failure.code });
        }
      }
      return { checked: true, activeRuns: runners.length, interrupted, snapshot: lastSnapshot };
    } finally {
      checking = false;
    }
  }

  function start() {
    if (timer) return;
    tick().catch(() => {});
    timer = setInterval(() => tick().catch(() => {}), intervalMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    failures.clear();
  }

  function snapshot() {
    return {
      running: Boolean(timer),
      intervalMs,
      failureThreshold,
      lastSnapshot,
      pendingFailures: Object.fromEntries(failures),
    };
  }

  return { start, stop, tick, snapshot };
}
