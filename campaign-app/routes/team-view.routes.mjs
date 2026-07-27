import { json } from "../lib/http.mjs";

const DEFAULT_TIMEOUT_MS = 5000;

function clean(value) {
  return String(value ?? "").trim();
}

export function controlCenterApiUrl(openUrl) {
  const parsed = new URL(clean(openUrl));
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") {
    throw new Error("Remote Mamba 只允许读取本机安全映射。");
  }
  parsed.pathname = "/api/control-center";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

export async function fetchControlCenter(url, {
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || `HTTP ${response.status}`);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function unavailableDevice(kind, error, extra = {}) {
  return {
    kind,
    connected: false,
    error: clean(error?.name === "AbortError" ? "读取状态超时。" : error?.message || error),
    data: null,
    ...extra,
  };
}

export function registerTeamViewRoutes(router) {
  router.get("/api/team-view", async (_req, res, runtime) => {
    const localUrl = `http://127.0.0.1:${runtime.port}/api/control-center`;
    const remoteState = await runtime.remoteMamba?.snapshot?.().catch((error) => ({
      status: "error",
      error: error.message,
      openUrl: "",
      config: {},
    })) || {
      status: "disconnected",
      error: "",
      openUrl: "",
      config: {},
    };

    const localPromise = fetchControlCenter(localUrl)
      .then((data) => ({
        kind: "local",
        connected: true,
        error: "",
        openUrl: "/control-center",
        data,
      }))
      .catch((error) => unavailableDevice("local", error, { openUrl: "/control-center" }));

    let remotePromise;
    if (remoteState.status === "connected" && remoteState.openUrl) {
      try {
        const remoteApiUrl = controlCenterApiUrl(remoteState.openUrl);
        remotePromise = fetchControlCenter(remoteApiUrl)
          .then((data) => ({
            kind: "remote",
            connected: true,
            error: "",
            openUrl: remoteState.openUrl,
            data,
          }))
          .catch((error) => unavailableDevice("remote", error, {
            openUrl: remoteState.openUrl,
            remoteStatus: remoteState.status,
            remoteName: remoteState.config?.host || "Remote Mac",
          }));
      } catch (error) {
        remotePromise = Promise.resolve(unavailableDevice("remote", error, {
          openUrl: "/remote-mamba",
          remoteStatus: "error",
          remoteName: remoteState.config?.host || "Remote Mac",
        }));
      }
    } else {
      remotePromise = Promise.resolve(unavailableDevice("remote", remoteState.error || "Remote Mamba 尚未连接。", {
        openUrl: "/remote-mamba",
        remoteStatus: remoteState.status,
        remoteName: remoteState.config?.host || "Remote Mac",
      }));
    }

    const [local, remote] = await Promise.all([localPromise, remotePromise]);
    json(res, 200, {
      ok: true,
      generatedAt: new Date().toISOString(),
      readOnly: true,
      refreshSeconds: 15,
      devices: [local, remote],
    });
  });
}
