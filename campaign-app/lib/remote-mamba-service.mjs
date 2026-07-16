import fs from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";

const DEFAULT_CONFIG = Object.freeze({
  host: "",
  username: "",
  localPort: 18787,
  remotePort: 8787,
  restartWatchdog: true,
});

function cleanHost(value) {
  const host = String(value || "").trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(host) || host.includes("..")) {
    throw new Error("远程 Mac 名称格式不对。请填写 Tailscale 机器名、MagicDNS 名称或 IP 地址。");
  }
  return host;
}

function cleanUsername(value) {
  const username = String(value || "").trim();
  if (!/^[A-Za-z_][A-Za-z0-9._-]{0,63}$/.test(username)) {
    throw new Error("Mac 用户名格式不对。请填写远程 Mac 登录账号的短用户名。");
  }
  return username;
}

function cleanPort(value, label, { disallow = [] } = {}) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label}必须是 1 至 65535 的整数。`);
  }
  if (disallow.includes(port)) {
    throw new Error(`${label}不能使用 ${port}，这个端口正在给本机 Mamba 使用。建议保留 18787。`);
  }
  return port;
}

export function validateRemoteMambaConfig(input = {}, { consolePort = 8787 } = {}) {
  return {
    host: cleanHost(input.host),
    username: cleanUsername(input.username),
    localPort: cleanPort(input.localPort ?? DEFAULT_CONFIG.localPort, "本机映射端口", { disallow: [Number(consolePort)] }),
    remotePort: cleanPort(input.remotePort ?? DEFAULT_CONFIG.remotePort, "远程 Mamba 端口"),
    restartWatchdog: input.restartWatchdog !== false,
  };
}

function readableSshError(stderr, fallback = "SSH 连接失败。") {
  const message = String(stderr || "").trim();
  if (/permission denied|publickey/i.test(message)) {
    return "SSH 身份验证失败。请先在 Terminal 用 SSH Key 成功登录一次远程 Mac；网页不会保存或代填密码。";
  }
  if (/host key verification failed/i.test(message)) {
    return "远程 Mac 身份验证失败。请先在 Terminal SSH 登录一次，确认这台 Mac 的 host key。";
  }
  if (/could not resolve hostname|name or service not known/i.test(message)) {
    return "找不到远程 Mac。请确认两台电脑的 Tailscale 在线，并检查机器名称。";
  }
  if (/connection refused/i.test(message)) {
    return "远程 Mac 拒绝 SSH 连接。请在远程 Mac 开启「系统设置 > 通用 > 共享 > 远程登录」。";
  }
  if (/address already in use|cannot listen to port/i.test(message)) {
    return "本机映射端口已被占用。请换一个端口，例如 18788。";
  }
  if (/operation timed out|connection timed out|no route to host/i.test(message)) {
    return "连接远程 Mac 超时。请确认远程 Mac 已开机、没有睡眠，而且 Tailscale 在线。";
  }
  return message ? `${fallback} ${message.split("\n").at(-1)}` : fallback;
}

function defaultProbe(url) {
  return fetch(url, { signal: AbortSignal.timeout(1800) })
    .then((response) => response.ok)
    .catch(() => false);
}

function defaultExecFile(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 15_000, maxBuffer: 128 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export function createRemoteMambaService({
  rootDir,
  consolePort = 8787,
  sshPath = "/usr/bin/ssh",
  spawnProcess = spawn,
  execFileAsync = defaultExecFile,
  probe = defaultProbe,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const configPath = path.join(rootDir, "campaign-data", "remote-mamba.json");
  let config = { ...DEFAULT_CONFIG };
  let loaded = false;
  let tunnel = null;
  let stderr = "";
  let state = {
    status: "disconnected",
    startedAt: null,
    connectedAt: null,
    error: "",
    warning: "",
    pid: null,
  };

  async function loadConfig() {
    if (loaded) return config;
    loaded = true;
    try {
      const saved = JSON.parse(await fs.readFile(configPath, "utf8"));
      config = { ...DEFAULT_CONFIG, ...saved };
    } catch (error) {
      if (error?.code !== "ENOENT") state.warning = `读取远程设置失败: ${error.message}`;
    }
    return config;
  }

  async function saveConfig(next) {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  }

  function snapshot() {
    const localPort = Number(config.localPort || DEFAULT_CONFIG.localPort);
    return {
      config: { ...config },
      status: state.status,
      startedAt: state.startedAt,
      connectedAt: state.connectedAt,
      error: state.error,
      warning: state.warning,
      pid: state.pid,
      openUrl: `http://127.0.0.1:${localPort}/control-center`,
    };
  }

  function sshBaseArgs() {
    return [
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=10",
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=3",
    ];
  }

  async function wakeWatchdog(next) {
    const target = `${next.username}@${next.host}`;
    try {
      await execFileAsync(sshPath, [
        ...sshBaseArgs(),
        target,
        "launchctl kickstart -k gui/$(id -u)/com.mamba.watchdog",
      ]);
      return "";
    } catch (error) {
      return readableSshError(error?.stderr || error?.message, "远程 Watchdog 未能启动。");
    }
  }

  function stop({ preserveMessage = false } = {}) {
    const child = tunnel;
    tunnel = null;
    if (child && !child.killed) child.kill("SIGTERM");
    state = {
      status: "disconnected",
      startedAt: null,
      connectedAt: null,
      error: preserveMessage ? state.error : "",
      warning: preserveMessage ? state.warning : "",
      pid: null,
    };
    return snapshot();
  }

  async function connect(input = {}) {
    await loadConfig();
    const next = validateRemoteMambaConfig({ ...config, ...input }, { consolePort });
    stop();
    config = next;
    await saveConfig(config);
    stderr = "";
    state = {
      status: "connecting",
      startedAt: new Date().toISOString(),
      connectedAt: null,
      error: "",
      warning: "",
      pid: null,
    };

    if (next.restartWatchdog) state.warning = await wakeWatchdog(next);

    const target = `${next.username}@${next.host}`;
    const args = [
      ...sshBaseArgs(),
      "-N", "-T",
      "-o", "ExitOnForwardFailure=yes",
      "-L", `127.0.0.1:${next.localPort}:127.0.0.1:${next.remotePort}`,
      target,
    ];
    const child = spawnProcess(sshPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    tunnel = child;
    state.pid = child.pid || null;
    child.stderr?.on?.("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-8000);
    });
    child.once?.("error", (error) => {
      if (tunnel !== child) return;
      tunnel = null;
      state.status = "error";
      state.pid = null;
      state.error = readableSshError(error.message);
    });
    child.once?.("exit", (code) => {
      if (tunnel !== child) return;
      tunnel = null;
      state.status = "error";
      state.pid = null;
      state.error = readableSshError(stderr, `SSH 映射已经停止 (exit ${code ?? "unknown"})。`);
    });

    const url = `http://127.0.0.1:${next.localPort}/api/status`;
    for (let attempt = 0; attempt < 15; attempt += 1) {
      if (tunnel !== child || state.status === "error") break;
      if (await probe(url)) {
        state.status = "connected";
        state.connectedAt = new Date().toISOString();
        state.error = "";
        return snapshot();
      }
      await delay(800);
    }

    if (tunnel === child && !child.killed) child.kill("SIGTERM");
    tunnel = null;
    state.status = "error";
    state.pid = null;
    const tunnelError = readableSshError(stderr, "SSH 已连接，但远程 Mamba 在指定端口没有回应。");
    state.error = state.warning ? `${tunnelError} ${state.warning}` : tunnelError;
    throw new Error(state.error);
  }

  return {
    async snapshot() {
      await loadConfig();
      if (state.status === "connected") {
        const online = await probe(`http://127.0.0.1:${config.localPort}/api/status`);
        if (!online) {
          state.status = "error";
          state.error = "映射仍存在，但远程 Mamba 没有回应。远程程序可能已经停止。";
        }
      }
      return snapshot();
    },
    connect,
    stop,
  };
}
