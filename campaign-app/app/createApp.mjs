import fs from "node:fs/promises";
import path from "node:path";
import { createRouter, json, notFound, text } from "../lib/http.mjs";
import { registerImportRoutes } from "../routes/import.routes.mjs";
import { registerInstancesRoutes } from "../routes/instances.routes.mjs";
import { registerProjectsRoutes } from "../routes/projects.routes.mjs";
import { registerSettingsRoutes } from "../routes/settings.routes.mjs";

const HTML_ROUTES = {
  "/": "console.html",
  "/next-flow": "next-flow.html",
  "/templates": "templates.html",
  "/lookup": "lookup.html",
  "/settings": "settings.html",
};

async function serveHtml(res, appDir, filename) {
  const html = await fs.readFile(path.join(appDir, filename), "utf8");
  text(res, 200, html, "text/html; charset=utf-8");
}

async function serveAsset(req, res, runtime, url) {
  const rel = decodeURIComponent(url.pathname.slice("/assets/".length));
  if (rel.includes("..")) {
    json(res, 400, { ok: false, error: "Bad path" });
    return;
  }
  const fp = path.join(runtime.appDir, "assets", rel);
  const types = {
    ".css": "text/css; charset=utf-8",
    ".woff2": "font/woff2",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
  };
  try {
    const buf = await fs.readFile(fp);
    res.writeHead(200, { "Content-Type": types[path.extname(fp)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(buf);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

async function serveCampaignImage(res, runtime, url) {
  const fname = decodeURIComponent(url.pathname.slice("/images/".length)).replace(/[^A-Za-z0-9._-]/g, "_");
  try {
    const buf = await fs.readFile(path.join(runtime.paths.rootDir, "campaign-assets", "images", fname));
    const ext = (fname.split(".").pop() || "").toLowerCase();
    const contentType = ext === "png" ? "image/png"
      : ext === "gif" ? "image/gif"
      : ext === "webp" ? "image/webp"
      : ext === "mp4" ? "video/mp4"
      : ext === "mov" ? "video/quicktime"
      : "image/jpeg";
    res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-cache" });
    res.end(buf);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}

function exportCsv(res, runtime) {
  const runner = runtime.getRunner?.();
  if (!runner || !runner.state) {
    json(res, 404, { ok: false, error: "没有可导出的 run。" });
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${runner.state.runId}.csv"`,
  });
  res.end("﻿" + runtime.buildCsv(runner.state));
}

export function createApp(runtime) {
  const router = createRouter(runtime);
  registerSettingsRoutes(router);
  registerProjectsRoutes(router);
  registerInstancesRoutes(router);
  registerImportRoutes(router);

  return async function app(req, res) {
    try {
      const url = new URL(req.url, `http://${runtime.host}:${runtime.port}`);
      const key = `${req.method} ${url.pathname}`;

      if (req.method === "GET" && url.pathname === "/numbers") {
        res.writeHead(302, { Location: "/settings" });
        res.end();
        return;
      }

      if (req.method === "GET" && HTML_ROUTES[url.pathname]) {
        await serveHtml(res, runtime.appDir, HTML_ROUTES[url.pathname]);
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/assets/")) {
        await serveAsset(req, res, runtime, url);
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/images/")) {
        await serveCampaignImage(res, runtime, url);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/export") {
        exportCsv(res, runtime);
        return;
      }

      if (await router.dispatch(req, res)) {
        return;
      }

      const handler = runtime.handlers?.[key];
      if (!handler) {
        notFound(res);
        return;
      }
      await handler(req, res);
    } catch (error) {
      json(res, 400, { ok: false, error: error.message });
    }
  };
}
