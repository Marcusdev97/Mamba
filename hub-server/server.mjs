// Mamba 中央 Server —— 让另一台电脑在同一个 Wi-Fi 下看这台的客户对话。
//
// 只读。它开资料库时钉死 sqlite3 的 -readonly，所以就算程式写错也弄不坏东西，
// 更不会发出任何 WhatsApp 讯息。
//
// 为什么要存取码：绑在区域网路上 = 同一个 Wi-Fi 的人都连得到，而这里面是客户的
// 真实电话和对话内容。存取码不是什么强防护(区域网路上是明文 HTTP)，但至少不会
// 变成「谁扫到这个 port 就能翻客户资料」。第一次启动会自己产生一组，存在
// .access-token，之后每次开都用同一组，网址不用换。
//
//   node hub-server/server.mjs
//   node hub-server/server.mjs --port=8899
//   node hub-server/server.mjs --new-token     # 换一组存取码（旧网址立刻失效）

import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createReadOnlyDb } from "./lib/db.mjs";
import { renderList, renderThread, renderError } from "./lib/page.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATABASE_PATH = path.join(here, "..", "campaign-data", "mamba.sqlite");
const TOKEN_PATH = path.join(here, ".access-token");
const DEFAULT_PORT = 8899;

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const port = Number(arg("port")) || DEFAULT_PORT;
const rotate = process.argv.includes("--new-token");

async function loadToken() {
  if (!rotate) {
    try {
      const existing = (await fs.readFile(TOKEN_PATH, "utf8")).trim();
      if (existing) return existing;
    } catch { /* 还没有就产生一组 */ }
  }
  const token = crypto.randomBytes(9).toString("base64url");
  // 0600：只有这台电脑的这个使用者读得到。
  await fs.writeFile(TOKEN_PATH, `${token}\n`, { mode: 0o600 });
  return token;
}

// 存取码用等长比较，避免逐字元比对被试出来。
function tokenOk(given, expected) {
  const a = Buffer.from(String(given ?? ""));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((net) => net && net.family === "IPv4" && !net.internal)
    .map((net) => net.address);
}

const token = await loadToken();
const db = await createReadOnlyDb({ databasePath: DATABASE_PATH }).catch((error) => {
  console.error(`读不到资料库：${error.message}`);
  console.error(`预期位置：${DATABASE_PATH}`);
  process.exit(1);
});

function send(res, status, html) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    // 只读页面，不需要任何外部资源，也不该被别的站嵌进去。
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  res.end(html);
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, "http://hub.local");
  } catch {
    return send(res, 400, renderError({ code: 400, message: "网址格式不对。" }));
  }

  if (req.method !== "GET") {
    return send(res, 405, renderError({ code: 405, message: "这台 server 只读，不接受任何修改。" }));
  }
  if (url.pathname === "/favicon.ico") {
    res.writeHead(204).end();
    return;
  }
  if (!tokenOk(url.searchParams.get("key"), token)) {
    return send(res, 401, renderError({
      code: 401,
      message: "网址少了存取码，或存取码不对。跟主机那台要完整网址。",
    }));
  }

  try {
    if (url.pathname === "/thread") {
      const phone = String(url.searchParams.get("phone") ?? "").replace(/\D/g, "");
      if (!phone) return send(res, 400, renderError({ code: 400, message: "少了客户号码。" }));
      const { contact, messages } = await db.thread(phone);
      return send(res, 200, renderThread({ contact, messages, token, phone }));
    }
    if (url.pathname === "/") {
      const filter = url.searchParams.get("filter") === "all" ? "all" : "waiting";
      const [stats, threads] = await Promise.all([db.stats(), db.threads({ filter })]);
      return send(res, 200, renderList({
        stats,
        threads,
        filter,
        token,
        updatedAt: new Date().toLocaleString("zh-CN", { hour12: false }),
      }));
    }
    return send(res, 404, renderError({ code: 404, message: "没有这个页面。" }));
  } catch (error) {
    console.error(`[hub] ${url.pathname} 出错：${error.message}`);
    return send(res, 500, renderError({ code: 500, message: "读资料时出错，看主机的终端机讯息。" }));
  }
});

// 0.0.0.0 = 让同一个 Wi-Fi 的另一台电脑连得到。
server.listen(port, "0.0.0.0", () => {
  const addresses = lanAddresses();
  console.log("\nMamba 中央 Server（只读）已启动\n");
  console.log(`  资料库：${db.databasePath}`);
  console.log("\n在另一台电脑的浏览器打开：\n");
  for (const address of addresses) console.log(`  http://${address}:${port}/?key=${token}`);
  console.log(`\n这台自己看：\n\n  http://localhost:${port}/?key=${token}`);
  console.log("\n按 Control-C 停止。");
  if (!addresses.length) console.log("\n⚠ 抓不到区域网路 IP，可能没连上 Wi-Fi。");
});
