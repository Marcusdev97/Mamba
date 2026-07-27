import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { controlCenterApiUrl, fetchControlCenter } from "./routes/team-view.routes.mjs";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.dirname(appDir);
const dataDir = path.join(rootDir, "campaign-data");
const configPath = path.join(dataDir, "phone-view.json");
const DEFAULT_PORT = 8791;
const DEFAULT_MAMBA_PORT = 8787;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 90;
const requestsByAddress = new Map();

function clean(value) {
  return String(value ?? "").trim();
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store, private",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
  });
  res.end(body);
}

function localAddresses() {
  return Object.values(os.networkInterfaces())
    .flatMap((items) => items || [])
    .filter((item) => item.family === "IPv4" && !item.internal)
    .map((item) => item.address);
}

function tokenFrom(req) {
  const value = clean(req.headers.authorization);
  return value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() : "";
}

function tokenMatches(actual, expected) {
  const left = Buffer.from(clean(actual));
  const right = Buffer.from(clean(expected));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function allowedByRateLimit(address, now = Date.now()) {
  const key = clean(address) || "unknown";
  const current = requestsByAddress.get(key);
  if (!current || now - current.startedAt >= RATE_WINDOW_MS) {
    requestsByAddress.set(key, { startedAt: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= RATE_LIMIT;
}

export function sanitizeControlCenter(payload) {
  if (!payload || payload.ok === false) return null;
  const scope = payload.scope || {};
  const metrics = payload.metrics || {};
  const campaign = payload.campaign || null;
  return {
    generatedAt: payload.generatedAt || null,
    scope: {
      device: {
        id: clean(scope.device?.id),
        name: clean(scope.device?.name),
        hostname: clean(scope.device?.hostname),
      },
      senders: (scope.senders || []).map((sender) => ({
        name: clean(sender.name),
        number: clean(sender.number),
        status: clean(sender.status),
      })),
    },
    metrics: {
      todaySent: Number(metrics.todaySent || 0),
      todayReplies: Number(metrics.todayReplies || 0),
      followUps: Number(metrics.followUps || 0),
      appointments: Number(metrics.appointments || 0),
    },
    campaign: campaign ? {
      project: clean(campaign.project),
      status: clean(campaign.status),
      mode: clean(campaign.mode),
      total: Number(campaign.total || 0),
      sent: Number(campaign.sent || 0),
      failed: Number(campaign.failed || 0),
      skipped: Number(campaign.skipped || 0),
      pending: Number(campaign.pending || 0),
      processed: Number(campaign.processed || 0),
      running: campaign.running === true,
      stopped: campaign.stopped === true,
      updatedAt: campaign.updatedAt || null,
      instances: (campaign.instances || []).map(clean).filter(Boolean),
    } : null,
    health: (payload.health || []).map((item) => ({
      id: clean(item.id),
      label: clean(item.label),
      state: clean(item.state),
      detail: clean(item.detail),
    })),
    logs: {
      errorsToday: Number(payload.logs?.errorsToday || 0),
      warningsToday: Number(payload.logs?.warningsToday || 0),
    },
  };
}

async function loadConfig() {
  await fs.mkdir(dataDir, { recursive: true });
  let saved = {};
  try {
    saved = JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const config = {
    port: Number(saved.port || process.env.MAMBA_PHONE_VIEW_PORT || DEFAULT_PORT),
    mambaPort: Number(saved.mambaPort || process.env.CONSOLE_PORT || DEFAULT_MAMBA_PORT),
    accessToken: clean(saved.accessToken) || crypto.randomBytes(24).toString("base64url"),
    createdAt: saved.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(configPath, 0o600).catch(() => {});
  return config;
}

async function readTeamView(config) {
  const localBase = `http://127.0.0.1:${config.mambaPort}`;
  const localPromise = fetchControlCenter(`${localBase}/api/control-center`)
    .then((data) => ({
      kind: "local",
      connected: true,
      error: "",
      data: sanitizeControlCenter(data),
    }))
    .catch((error) => ({
      kind: "local",
      connected: false,
      error: clean(error?.message),
      data: null,
    }));

  const remotePromise = fetchControlCenter(`${localBase}/api/remote-mamba`, { timeoutMs: 2500 })
    .then(async (remotePayload) => {
      const remote = remotePayload.remote || {};
      if (remote.status !== "connected" || !remote.openUrl) {
        return {
          kind: "remote",
          connected: false,
          remoteName: clean(remote.config?.host) || "Remote Mac",
          error: clean(remote.error) || "Remote Mamba 尚未连接。",
          data: null,
        };
      }
      const data = await fetchControlCenter(controlCenterApiUrl(remote.openUrl));
      return {
        kind: "remote",
        connected: true,
        remoteName: clean(remote.config?.host) || "Remote Mac",
        error: "",
        data: sanitizeControlCenter(data),
      };
    })
    .catch((error) => ({
      kind: "remote",
      connected: false,
      remoteName: "Remote Mac",
      error: clean(error?.message),
      data: null,
    }));

  const [local, remote] = await Promise.all([localPromise, remotePromise]);
  return {
    ok: true,
    readOnly: true,
    generatedAt: new Date().toISOString(),
    devices: [local, remote],
  };
}

export function createPhoneViewServer(config) {
  return http.createServer(async (req, res) => {
    const address = req.socket.remoteAddress || "";
    if (!allowedByRateLimit(address)) {
      json(res, 429, { ok: false, error: "请求太频繁，请稍后再试。" });
      return;
    }

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, {
        ok: true,
        service: "Mamba Phone View",
        readOnly: true,
        authenticated: false,
      });
      return;
    }

    if (!tokenMatches(tokenFrom(req), config.accessToken)) {
      json(res, 401, { ok: false, error: "Mamba View 存取码不正确。" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/team-view") {
      try {
        json(res, 200, await readTeamView(config));
      } catch (error) {
        json(res, 503, { ok: false, error: `读取 Mamba 状态失败：${error.message}` });
      }
      return;
    }

    json(res, 404, { ok: false, error: "Phone View 只有只读状态接口。" });
  });
}

async function main() {
  const config = await loadConfig();
  const server = createPhoneViewServer(config);
  server.listen(config.port, "0.0.0.0", () => {
    const addresses = localAddresses();
    console.log("Mamba Phone View 已启动（只读）");
    for (const address of addresses) console.log(`  http://${address}:${config.port}`);
    console.log(`  Access Token 已安全保存在 ${configPath}`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
