import { httpError, json, readJson } from "../lib/http.mjs";

function requireWhatsapp(runtime) {
  if (!runtime.whatsapp) {
    throw httpError(500, "WhatsApp service 没有载入。请重启 Mamba server。");
  }
  return runtime.whatsapp;
}

function readableEvolutionError(error, action) {
  const message = String(error?.message || "");
  if (message.includes("ECONNREFUSED") || message.includes("fetch failed")) {
    return `${action}失败: Evolution API 离线。请先启动 Evolution，然后回 Settings 点「刷新」。`;
  }
  if (message.includes("Unauthorized") || message.includes("401")) {
    return `${action}失败: Evolution API key 无效。请检查 evolution-pilot/.env 里的 EVOLUTION_API_KEY。`;
  }
  if (message.includes("timeout") || message.includes("ETIMEDOUT")) {
    return `${action}失败: Evolution API 没有及时回应。等几秒再试，或重启 Evolution。`;
  }
  return `${action}失败: ${message || "Evolution 没有返回明确原因。"}`;
}

function assertInstanceName(name) {
  if (!name) return;
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(name)) {
    throw httpError(400, "号码标签只能使用英文字母、数字、- 和 _，长度 2–64。建议使用 Device 前缀，例如 marcus-macbook_wa_01。");
  }
}

export function registerInstancesRoutes(router) {
  router.get("/api/instances", async (_req, res, runtime) => {
    const whatsapp = requireWhatsapp(runtime);
    try {
      const instances = await whatsapp.listInstances();
      json(res, 200, { ok: true, online: true, instances });
    } catch (error) {
      json(res, 200, {
        ok: true,
        online: false,
        error: readableEvolutionError(error, "读取号码列表"),
        instances: [],
      });
    }
  });

  router.post("/api/instance/create", async (req, res, runtime) => {
    const whatsapp = requireWhatsapp(runtime);
    const body = await readJson(req);
    let items;
    try {
      items = await whatsapp.listInstances();
    } catch (error) {
      throw httpError(503, readableEvolutionError(error, "创建号码"));
    }

    let name = String(body.name ?? "").trim();
    assertInstanceName(name);
    if (!name) name = whatsapp.nextInstanceName(items);
    if (items.some((item) => item.name === name)) {
      throw httpError(409, `${name} 已存在。请换一个标签，或先删除旧号码。`);
    }

    let result;
    try {
      result = await whatsapp.createInstance(name);
    } catch (error) {
      throw httpError(503, readableEvolutionError(error, `创建 ${name}`));
    }
    if (!result.qr) {
      throw httpError(502, `Evolution 已创建 ${name}，但没有返回二维码。请点刷新二维码，或重启 Evolution 再试。`);
    }
    json(res, 200, { ok: true, instanceName: name, qr: result.qr });
  });

  router.get("/api/instance/qr", async (req, res, runtime) => {
    const whatsapp = requireWhatsapp(runtime);
    const url = new URL(req.url, `http://${runtime.host}:${runtime.port}`);
    const name = String(url.searchParams.get("name") ?? "").trim();
    if (!name) throw httpError(400, "缺少号码标签 name。");
    assertInstanceName(name);

    let qr;
    try {
      qr = await whatsapp.instanceQr(name);
    } catch (error) {
      throw httpError(503, readableEvolutionError(error, `获取 ${name} 二维码`));
    }
    if (!qr) {
      throw httpError(404, `无法获取 ${name} 的二维码。这个号码可能已经 OPEN，或 Evolution 还没准备好。`);
    }
    json(res, 200, { ok: true, qr });
  });

  router.post("/api/instance/delete", async (req, res, runtime) => {
    const whatsapp = requireWhatsapp(runtime);
    const runner = runtime.getRunner?.();
    if (runner && runner.running) {
      throw httpError(409, "Campaign 正在运行，不能删除号码。请先停止 campaign，再回 Settings 删除。");
    }
    const body = await readJson(req);
    const name = String(body.name ?? "").trim();
    if (!name) throw httpError(400, "缺少号码标签 name。");
    assertInstanceName(name);

    try {
      await whatsapp.deleteInstance(name);
    } catch (error) {
      throw httpError(503, readableEvolutionError(error, `删除 ${name}`));
    }
    json(res, 200, { ok: true });
  });
}
