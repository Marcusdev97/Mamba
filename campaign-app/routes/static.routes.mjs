import fs from "node:fs/promises";
import path from "node:path";
import { json, text } from "../lib/http.mjs";

const HTML_ROUTES = {
  "/": "console.html",
  "/control-center": "control-center.html",
  "/next-flow": "next-flow.html",
  "/templates": "templates.html",
  "/lookup": "lookup.html",
  "/settings": "settings.html",
  "/logs": "logs.html",
  "/conversations": "conversations.html",
  "/follow-up": "follow-up.html",
  "/bot-rules": "bot-rules.html",
  "/brain-learning": "brain-learning.html",
  "/flow-map": "flow-map.html",
  "/knowledge": "knowledge.html",
  "/project-brain": "project-brain.html",
  "/send": "send.html",
  "/campaign-todo": "campaign-todo.html",
  "/remote-mamba": "remote-mamba.html",
};

async function serveHtml(res, appDir, filename) {
  const html = await fs.readFile(path.join(appDir, filename), "utf8");
  text(res, 200, html, "text/html; charset=utf-8");
}

async function serveAsset(res, runtime, url) {
  const rel = decodeURIComponent(url.pathname.slice("/assets/".length));
  if (rel.includes("..")) {
    json(res, 400, { ok: false, error: "Bad asset path." });
    return;
  }
  const filePath = path.join(runtime.appDir, "assets", rel);
  const types = {
    ".css": "text/css; charset=utf-8",
    ".woff2": "font/woff2",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
  };
  try {
    const body = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": types[path.extname(filePath)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(body);
  } catch {
    text(res, 404, "Asset not found");
  }
}

async function serveCampaignImage(res, runtime, url) {
  const filename = decodeURIComponent(url.pathname.slice("/images/".length)).replace(/[^A-Za-z0-9._-]/g, "_");
  try {
    const body = await fs.readFile(path.join(runtime.paths.rootDir, "campaign-assets", "images", filename));
    const ext = (filename.split(".").pop() || "").toLowerCase();
    const contentType = ext === "png" ? "image/png"
      : ext === "gif" ? "image/gif"
      : ext === "webp" ? "image/webp"
      : ext === "mp4" ? "video/mp4"
      : ext === "mov" ? "video/quicktime"
      : "image/jpeg";
    res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-cache" });
    res.end(body);
  } catch {
    text(res, 404, "Image not found");
  }
}

export function registerStaticRoutes(router) {
  router.use(async (req, res, runtime) => {
    const url = new URL(req.url, `http://${runtime.host}:${runtime.port}`);
    if (req.method !== "GET") return false;

    if (url.pathname === "/numbers") {
      res.writeHead(302, { Location: "/settings" });
      res.end();
      return true;
    }

    if (HTML_ROUTES[url.pathname]) {
      await serveHtml(res, runtime.appDir, HTML_ROUTES[url.pathname]);
      return true;
    }

    if (url.pathname.startsWith("/assets/")) {
      await serveAsset(res, runtime, url);
      return true;
    }

    if (url.pathname.startsWith("/images/")) {
      await serveCampaignImage(res, runtime, url);
      return true;
    }

    return false;
  });
}
