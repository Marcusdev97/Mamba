import { execFile } from "node:child_process";

function clean(value) {
  return String(value ?? "").trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

function defaultDockerInfo({ timeoutMs = 2500 } = {}) {
  return new Promise((resolve, reject) => {
    execFile("docker", ["info", "--format", "{{.ServerVersion}}"], {
      timeout: timeoutMs,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(clean(stdout));
    });
  });
}

function dockerFailure(error) {
  const message = clean(error?.message || error || "Docker daemon did not answer");
  const commandMissing = error?.code === "ENOENT" || /not found/i.test(message);
  return {
    id: "docker",
    ok: false,
    state: commandMissing ? "warning" : "offline",
    code: commandMissing ? "DOCKER_CLI_UNAVAILABLE" : "DOCKER_DAEMON_OFFLINE",
    detail: commandMissing
      ? "Docker CLI 无法检查；Evolution 状态仍会独立验证。"
      : "Docker Engine 已停止；这不是 WhatsApp 号码 restriction。",
    technicalDetail: message,
  };
}

function instanceView(item) {
  return {
    name: clean(item?.name || item?.instanceName || item?.instance?.instanceName),
    number: clean(item?.number || item?.owner || item?.instance?.owner),
    status: upper(item?.status || item?.connectionStatus || item?.instance?.state || "UNKNOWN"),
    allowedOnThisDevice: item?.allowedOnThisDevice !== false,
  };
}

function instanceLayer(instances, requiredInstances = []) {
  const allowed = instances.filter((item) => item.allowedOnThisDevice);
  const required = [...new Set(requiredInstances.map(clean).filter(Boolean))];
  const byName = new Map(allowed.map((item) => [item.name, item]));
  const unavailable = required
    .map((name) => byName.get(name) || { name, status: "MISSING" })
    .filter((item) => item.status !== "OPEN");
  const notOpen = allowed.filter((item) => item.status !== "OPEN");
  const open = allowed.filter((item) => item.status === "OPEN");

  if (unavailable.length) {
    return {
      id: "whatsapp",
      ok: false,
      state: "offline",
      code: "WHATSAPP_INSTANCE_NOT_OPEN",
      detail: `Campaign 号码未连接：${unavailable.map((item) => `${item.name} (${item.status})`).join(", ")}`,
      open: open.length,
      total: allowed.length,
      unavailable,
    };
  }
  if (!allowed.length) {
    return {
      id: "whatsapp",
      ok: false,
      state: "warning",
      code: "WHATSAPP_INSTANCE_MISSING",
      detail: "Evolution 在线，但还没有这台电脑可用的 WhatsApp instance。",
      open: 0,
      total: 0,
      unavailable: [],
    };
  }
  if (notOpen.length) {
    return {
      id: "whatsapp",
      ok: false,
      state: "warning",
      code: "WHATSAPP_INSTANCE_PARTIAL",
      detail: `${open.length}/${allowed.length} OPEN；未连接：${notOpen.map((item) => `${item.name} (${item.status})`).join(", ")}`,
      open: open.length,
      total: allowed.length,
      unavailable: notOpen,
    };
  }
  return {
    id: "whatsapp",
    ok: true,
    state: "online",
    code: "WHATSAPP_INSTANCES_OPEN",
    detail: `${open.length}/${allowed.length} instances OPEN`,
    open: open.length,
    total: allowed.length,
    unavailable: [],
  };
}

export function createEvolutionHealthService({
  listInstances,
  dockerInfo = defaultDockerInfo,
  timeoutMs = 3000,
  clock = () => new Date(),
} = {}) {
  if (typeof listInstances !== "function") {
    throw new Error("Evolution health service requires listInstances().");
  }

  async function check({ requiredInstances = [] } = {}) {
    const [dockerResult, evolutionResult] = await Promise.allSettled([
      withTimeout(dockerInfo({ timeoutMs }), timeoutMs, "Docker health"),
      withTimeout(listInstances(), timeoutMs, "Evolution health"),
    ]);

    let docker = dockerResult.status === "fulfilled"
      ? {
          id: "docker",
          ok: true,
          state: "online",
          code: "DOCKER_DAEMON_ONLINE",
          detail: `Docker Engine online${clean(dockerResult.value) ? ` · ${clean(dockerResult.value)}` : ""}`,
        }
      : dockerFailure(dockerResult.reason);

    let instances = [];
    let evolution;
    let whatsapp;
    if (evolutionResult.status === "fulfilled") {
      instances = (Array.isArray(evolutionResult.value) ? evolutionResult.value : []).map(instanceView);
      evolution = {
        id: "evolution",
        ok: true,
        state: "online",
        code: "EVOLUTION_API_ONLINE",
        detail: "Evolution API online · authenticated",
      };
      whatsapp = instanceLayer(instances, requiredInstances);
      // A reachable Evolution API proves that its container host is running.
      // Do not turn the whole watchdog red merely because the Docker CLI is not
      // installed in PATH (for example, a Colima or remote Docker setup).
      if (!docker.ok) {
        docker = {
          ...docker,
          ok: true,
          state: "online",
          code: "DOCKER_HOST_INFERRED_ONLINE",
          detail: "Docker CLI 检查未完成，但 Evolution API 已证明 container host 正常在线。",
        };
      }
    } else {
      const message = clean(evolutionResult.reason?.message || evolutionResult.reason || "Evolution API did not answer");
      evolution = {
        id: "evolution",
        ok: false,
        state: "offline",
        code: /401|unauthorized/i.test(message) ? "EVOLUTION_AUTHENTICATION_FAILED" : "EVOLUTION_API_OFFLINE",
        detail: docker.ok
          ? "Docker 正常，但 Evolution API 没有回应。"
          : "Evolution API 没有回应；先恢复 Docker Engine。",
        technicalDetail: message,
      };
      whatsapp = {
        id: "whatsapp",
        ok: false,
        state: "offline",
        code: "WHATSAPP_INSTANCE_STATE_UNKNOWN",
        detail: "Evolution API 离线，暂时无法确认 wa_01 / wa_03 的连接状态。",
        open: 0,
        total: 0,
        unavailable: [],
      };
    }

    return {
      checkedAt: clock().toISOString(),
      docker,
      evolution,
      whatsapp,
      instances,
      requiredInstances: [...new Set(requiredInstances.map(clean).filter(Boolean))],
      healthy: docker.ok && evolution.ok && whatsapp.ok,
    };
  }

  return { check };
}

export { defaultDockerInfo, instanceLayer };
