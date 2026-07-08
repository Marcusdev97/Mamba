export function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

export function text(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(body);
}

export async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

export function notFound(res) {
  json(res, 404, { ok: false, error: "Not found" });
}

export function methodNotAllowed(res) {
  json(res, 405, { ok: false, error: "Method not allowed" });
}

export function httpError(status, message, details = {}) {
  const error = new Error(message);
  error.statusCode = status;
  error.details = details;
  return error;
}

export function safeRoute(handler) {
  return async (req, res, runtime, params) => {
    try {
      await handler(req, res, runtime, params);
    } catch (error) {
      const status = error.statusCode || error.status || 500;
      if (status >= 500) console.error(error);
      else console.warn(`[route] ${status} ${error.message || "Request failed"}`);
      json(res, status, {
        ok: false,
        error: error.message || "Internal Server Error",
        ...(error.details && Object.keys(error.details).length ? { details: error.details } : {}),
      });
    }
  };
}

export function createRouter(runtime = {}) {
  const routes = new Map();

  return {
    get(pathname, handler) {
      routes.set(`GET ${pathname}`, handler);
    },
    post(pathname, handler) {
      routes.set(`POST ${pathname}`, handler);
    },
    route(method, pathname, handler) {
      routes.set(`${String(method).toUpperCase()} ${pathname}`, handler);
    },
    async dispatch(req, res) {
      const url = new URL(req.url, `http://${runtime.host || "127.0.0.1"}:${runtime.port || 8787}`);
      const handler = routes.get(`${req.method} ${url.pathname}`);
      if (!handler) return false;
      await safeRoute(handler)(req, res, runtime, {});
      return true;
    },
    async handler(req, res) {
      const url = new URL(req.url, `http://${runtime.host || "127.0.0.1"}:${runtime.port || 8787}`);
      const handler = routes.get(`${req.method} ${url.pathname}`);
      if (!handler) return notFound(res);
      return safeRoute(handler)(req, res, runtime, {});
    },
  };
}
