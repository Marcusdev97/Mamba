import { httpError, json, readJson } from "../lib/http.mjs";

function requireRemoteMamba(runtime) {
  if (!runtime.remoteMamba) {
    throw httpError(500, "Remote Mamba 服务没有载入。请重启 Mamba server。");
  }
  return runtime.remoteMamba;
}

export function registerRemoteMambaRoutes(router) {
  router.get("/api/remote-mamba", async (_req, res, runtime) => {
    json(res, 200, { ok: true, remote: await requireRemoteMamba(runtime).snapshot() });
  });

  router.post("/api/remote-mamba/connect", async (req, res, runtime) => {
    const body = await readJson(req);
    try {
      const remote = await requireRemoteMamba(runtime).connect(body);
      json(res, 200, { ok: true, remote });
    } catch (error) {
      throw httpError(400, `无法连接 Remote Mamba: ${error.message}`);
    }
  });

  router.post("/api/remote-mamba/stop", async (_req, res, runtime) => {
    json(res, 200, { ok: true, remote: requireRemoteMamba(runtime).stop() });
  });
}
