import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { json, text } from "../lib/http.mjs";

const HTML_ROUTES = {
  "/flow-1": "console.html",
  "/refresh": "refresh.html",
  "/lanes": "lanes.html",
  "/inbox": "inbox.html",
  "/control-center": "control-center.html",
  "/team-view": "team-view.html",
  "/next-flow": "next-flow.html",
  "/templates": "templates.html",
  "/lookup": "lookup.html",
  "/settings": "settings.html",
  "/logs": "logs.html",
  "/notion-sync": "notion-sync.html",
  "/conversations": "conversations.html",
  "/follow-up": "sales.html",
  "/sales": "sales.html",
  "/bot-rules": "bot-rules.html",
  "/brain-learning": "brain-learning.html",
  "/golden-ledger": "golden-ledger.html",
  "/flow-map": "flow-map.html",
  "/knowledge": "knowledge.html",
  "/project-brain": "project-brain.html",
  "/send": "send.html",
  "/dashboard": "dashboard.html",
  "/campaign-todo": "campaign-todo.html",
  "/remote-mamba": "remote-mamba.html",
  "/ai-changes": "ai-changes.html",
};

function walkFiles(dir, prefix = "") {
  let entries = [];
  try { entries = fsSync.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.flatMap((entry) => {
    const relative = path.posix.join(prefix, entry.name);
    const absolute = path.join(dir, entry.name);
    return entry.isDirectory() ? walkFiles(absolute, relative) : [{ relative, absolute }];
  });
}

export function createStaticSnapshot(appDir) {
  const html = new Map();
  for (const filename of new Set(Object.values(HTML_ROUTES))) {
    try { html.set(filename, fsSync.readFileSync(path.join(appDir, filename), "utf8")); } catch { /* route returns its normal read error */ }
  }
  const assets = new Map();
  for (const file of walkFiles(path.join(appDir, "assets"))) {
    try { assets.set(file.relative, fsSync.readFileSync(file.absolute)); } catch { /* missing asset stays a normal 404 */ }
  }
  return { html, assets };
}

async function serveHtml(res, appDir, filename, snapshot) {
  const html = snapshot?.html?.get(filename) ?? await fs.readFile(path.join(appDir, filename), "utf8");
  text(res, 200, html, "text/html; charset=utf-8");
}

async function serveAsset(res, runtime, url, snapshot) {
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
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
  };
  try {
    const body = snapshot?.assets?.get(rel) ?? await fs.readFile(filePath);
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

export function registerStaticRoutes(router, bootRuntime = null) {
  // HTML and bundled JS must come from the same server boot. Reading them from
  // disk on every refresh can pair a newly edited UI with an old in-memory API
  // router, which makes safe LIVE checks appear as 404 until restart.
  const snapshot = bootRuntime?.appDir ? createStaticSnapshot(bootRuntime.appDir) : null;
  router.use(async (req, res, runtime) => {
    const url = new URL(req.url, `http://${runtime.host}:${runtime.port}`);
    if (req.method !== "GET") return false;

    if (url.pathname === "/") {
      res.writeHead(302, { Location: "/control-center" });
      res.end();
      return true;
    }

    if (url.pathname === "/numbers") {
      res.writeHead(302, { Location: "/settings" });
      res.end();
      return true;
    }

    // Customer lookup remains a daily workspace. Identity conflict and merge
    // operations are exceptional maintenance, so the old duplicate page now
    // lands on the guarded Data Maintenance panel in Settings.
    if (url.pathname === "/customer-identity") {
      res.writeHead(302, { Location: "/settings?section=data-maintenance" });
      res.end();
      return true;
    }

    // Campaign Center is the single operator workspace for campaign setup and
    // execution. Preserve old bookmarks without keeping a duplicate UI alive.
    if (url.pathname === "/campaigns") {
      res.writeHead(302, { Location: "/send" });
      res.end();
      return true;
    }

    if (HTML_ROUTES[url.pathname]) {
      await serveHtml(res, runtime.appDir, HTML_ROUTES[url.pathname], snapshot);
      return true;
    }

    if (url.pathname.startsWith("/assets/")) {
      await serveAsset(res, runtime, url, snapshot);
      return true;
    }

    if (url.pathname.startsWith("/images/")) {
      await serveCampaignImage(res, runtime, url);
      return true;
    }

    return false;
  });
}
