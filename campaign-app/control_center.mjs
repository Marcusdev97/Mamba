// Mamba | Control Center
//
// A tiny local web dashboard so you never have to hunt for .command files.
// It lists every launcher in launchers/ as a button; clicking a button
// opens that command for you (in Terminal, just like double-clicking it).
//
// A browser page can't run local commands by itself, so this small Node server
// does it: the page calls back here, and here we run macOS `open` on the file.

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(appDir, ".."); // the Mamba folder
const launcherDir = path.join(rootDir, "launchers");
const PORT = Number(process.env.CONTROL_PORT ?? 8810);
const HOST = "127.0.0.1";
const LOCAL_URL = `http://${HOST}:${PORT}`;
const CONSOLE_PORT = Number(process.env.CONSOLE_PORT ?? 8787);
const CONSOLE_URL = `http://${HOST}:${CONSOLE_PORT}`;
const SELF = "Mamba Control Center.command"; // don't list the launcher that started us
const HIDDEN_LAUNCHERS = new Set([
  "Set Notion Token.command", // Settings now owns Notion / Telegram token setup.
]);

// Design system (docs/MAMBA_UI_BIBLE.md) — inlined because this server has no /assets route.
const designCss = await fs.readFile(path.join(appDir, "assets", "mamba.css"), "utf8").catch(() => "");

// Nice labels/descriptions for the known launchers. Anything else found in the
// folder still shows up (under "其他"), so the panel always reflects reality.
// `order` sets the click-through sequence within a group (lower = earlier), so
// the daily flow reads top-to-bottom in the order you actually run it.
const KNOWN = {
  "Campaign Console.command":          { emoji: "📣", label: "① 首轮群发(Flow 1)", desc: "导入名单、设定时间、群发第一轮", group: "日常", order: 1 },
  "选人发下一轮.command":               { emoji: "📥", label: "② 选人发下一轮(Flow 2~10)", desc: "网页列出该发下一轮的人,勾选后直接发(发完自动推进到下一轮),还能顺手标「不发」", group: "日常", order: 2 },
  "Morning Follow-up Check.command":   { emoji: "☀️", label: "③ 早间跟进检查", desc: "结算回复、自动红旗退订的人、列出今天要跟进的人", group: "日常", order: 3 },
  "Update Notion Blast Leads.command": { emoji: "⬆️", label: "④ 上传 Blast 名单到 Notion(手动补跑)", desc: "群发完成后会自动上传;只有自动上传失败时才需要点这个补跑", group: "日常", order: 4 },
  "Sales Brain.command":               { emoji: "🧠", label: "⑤ Sales Brain(AI 回复)", desc: "客户回复自动分类:简单的回罐头、复杂的 AI 按盘起草丢 Telegram 给你批准。会连 tracker 一起启动", group: "日常", order: 5 },
  "Live Reply Tracker.command":        { emoji: "💬", label: "实时回复追踪(仅记录)", desc: "只记录回复、更新 Notion,不回复客户。开 Sales Brain 的话不用另外开这个", group: "日常", order: 6 },
  "Conversations.command":             { emoji: "💬", label: "Conversations", desc: "从 Notion 查看全部客户、latest reply、状态和下一步动作", group: "日常", order: 7 },
  "Follow Up Desk.command":            { emoji: "📋", label: "客户跟进台", desc: "今天该追谁、谁最热、谁要约、谁已经过期没跟进", group: "日常", order: 8 },
  "Flow Map.command":                  { emoji: "🧭", label: "Mamba Flow Map", desc: "看懂 blasting、大脑分类、Next Flow 和跟进追踪怎么串起来", group: "日常", order: 9 },
  "Bot Rules.command":                 { emoji: "🧠", label: "Bot Rules 大脑", desc: "自己改关键词 trigger,让 bot 分类 Warm / Cold / STOP / Spam", group: "设置 & 工具", order: 24 },
  "号码连接.command":                   { emoji: "📱", label: "⓪ Settings / Phone Setup", desc: "扫码上线 WhatsApp、查看连接健康、删除设备。Docker/Evolution/Console 没跑都会自动先启动", group: "日常", order: 0 },
  "模板 Flow 面板.command":             { emoji: "🗂", label: "模板 & Flow 面板", desc: "网页看整个自动序列 + 拉 Notion 模板,一眼看出哪个 flow 缺模板要改", group: "设置 & 工具", order: 25 },
  "查找客户.command":                   { emoji: "🔎", label: "查找客户", desc: "输入号码/名字,查这个客户在哪些项目、什么时候 blast 过、现在到哪个 flow、有没有回复 / STOP", group: "设置 & 工具", order: 26 },
  "Settings.command":                  { emoji: "⚙️", label: "Settings", desc: "直接填 Notion / Telegram token,保存到本机 .env", group: "设置 & 工具", order: 27 },
  "System Logs.command":               { emoji: "🧾", label: "System Logs", desc: "查看系统错误、timeout、Notion/Telegram/Evolution 问题记录", group: "设置 & 工具", order: 28 },
  "Import Recycle Leads.command":      { emoji: "♻️", label: "导入回收名单", desc: "从 Excel/CSV 导入回收 leads", group: "设置 & 工具", order: 50 },
  "Sync Templates.command":            { emoji: "🔄", label: "同步模板到 Notion", desc: "把话术模板同步到 Notion", group: "设置 & 工具", order: 50 },
  "Sync Cloudflare Assets.command":    { emoji: "☁️", label: "同步 Cloudflare 图片", desc: "把 assets/ 和 campaign 图片上传到 Cloudflare R2,给 AI 和其他电脑共用", group: "设置 & 工具", order: 49 },
  "Sync Suppression.command":          { emoji: "⛔", label: "同步全局 STOP 名单", desc: "从 Notion 同步所有项目的退订号码,发送前自动拦截", group: "设置 & 工具", order: 51 },
  "Sync Brain.command":                { emoji: "🧠", label: "同步 AI Brain Cache", desc: "同步知识库、成功对话、异议库到本地缓存", group: "设置 & 工具", order: 52 },
  "Fix Mac Block.command":             { emoji: "🛠", label: "修复 Mac 拦截", desc: "解除「unidentified developer」限制", group: "设置 & 工具", order: 50 },
};
const GROUP_ORDER = ["日常", "设置 & 工具", "其他"];

async function listTasks() {
  const files = (await fs.readdir(launcherDir).catch(() => []))
    .filter((f) => f.endsWith(".command") && f !== SELF && !HIDDEN_LAUNCHERS.has(f));
  return files
    .map((file) => {
      const meta = KNOWN[file] ?? { emoji: "▶️", label: file.replace(/\.command$/, ""), desc: "", group: "其他", order: 100 };
      return { file, order: 100, ...meta };
    })
    .sort((a, b) => {
      const g = GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group);
      if (g !== 0) return g;
      if (a.order !== b.order) return a.order - b.order;
      return a.label.localeCompare(b.label);
    });
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return {}; }
}

async function ensureCampaignConsole() {
  try {
    const response = await fetch(`${CONSOLE_URL}/`, { signal: AbortSignal.timeout(1200) });
    if (response.ok) return true;
  } catch {
    // Start it below.
  }
  const child = execFile(process.execPath, [path.join(appDir, "server.mjs")], {
    cwd: rootDir,
    env: { ...process.env, MAMBA_AUTO_OPEN: "0" },
  });
  child.unref?.();
  await new Promise((resolve) => setTimeout(resolve, 2200));
  return true;
}

function page() {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mamba 控制台</title>
<style>${designCss}</style>
<style>
  .wrap { max-width: 920px; padding: 32px 20px 60px; }
  h1 { margin: 0 0 4px; font-size: 26px; }
  .sub { color: var(--muted); margin-bottom: 26px; }
  h2 { font-size: 15px; text-transform: uppercase; letter-spacing: .06em; color: var(--blue); margin: 28px 0 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 14px; }
  .card { appearance: none; width: 100%; border-radius: 14px; cursor: pointer; text-align: left; color: inherit; font-family: inherit; font-size: inherit; margin-bottom: 0;
    transition: border-color var(--t-fast) var(--ease), transform var(--t-fast) var(--ease); }
  .card:hover { border-color: var(--green); transform: translateY(-2px); }
  .card:active { transform: translateY(0); }
  .emoji { font-size: 22px; }
  .label { font-weight: 700; margin: 8px 0 4px; font-size: 15px; }
  .desc { color: var(--muted); font-size: 13px; line-height: 1.4; }
</style>
</head>
<body>
<div class="wrap">
  <h1>🐍 Mamba 控制台</h1>
  <div class="sub">点一下就能开,不用再找文件。每个按钮会帮你打开对应的程序窗口。</div>
  <div id="groups"></div>
</div>
<div class="toast" id="toast"></div>
<script>
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  let toastTimer;
  function toast(msg, isErr) {
    const t = document.getElementById("toast");
    t.textContent = msg; t.className = "toast show" + (isErr ? " err" : "");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = "toast"), 2600);
  }
  async function run(file, label) {
    try {
      const res = await fetch("/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file }) });
      const data = await res.json().catch(() => ({}));
      if (!data.ok) throw new Error(data.error || ("HTTP " + res.status));
      toast("已打开:" + label);
    } catch (e) { toast("打开失败:" + e.message, true); }
  }
  async function load() {
    const res = await fetch("/api/tasks");
    const data = await res.json();
    const groups = {};
    for (const t of data.tasks) (groups[t.group] = groups[t.group] || []).push(t);
    const order = ["日常", "设置 & 工具", "其他"];
    const root = document.getElementById("groups");
    root.innerHTML = order.filter((g) => groups[g]).map((g) => \`
      <h2>\${esc(g)}</h2>
      <div class="grid">\${groups[g].map((t) => \`
        <button class="card" onclick='run(\${JSON.stringify(t.file)}, \${JSON.stringify(t.label)})'>
          <div class="emoji">\${t.emoji}</div>
          <div class="label">\${esc(t.label)}</div>
          <div class="desc">\${esc(t.desc)}</div>
        </button>\`).join("")}</div>\`).join("");
  }
  load();
</script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, LOCAL_URL);
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(page());
      return;
    }
    if (req.method === "GET" && ["/logs", "/settings", "/lookup", "/templates", "/next-flow", "/conversations", "/follow-up", "/bot-rules", "/flow-map"].includes(url.pathname)) {
      await ensureCampaignConsole();
      res.writeHead(302, { Location: `${CONSOLE_URL}${url.pathname}` });
      res.end();
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/tasks") {
      json(res, 200, { ok: true, tasks: await listTasks() });
      return;
    }
    if (req.method === "POST" && url.pathname === "/run") {
      const body = await readBody(req);
      const file = String(body.file ?? "");
      // Safety: only allow launching a .command that actually exists in launchers/.
      const allowed = (await listTasks()).some((t) => t.file === file);
      if (!allowed) { json(res, 400, { ok: false, error: "未知的命令文件。" }); return; }
      const fullPath = path.join(launcherDir, file);
      execFile("/usr/bin/open", [fullPath], (error) => {
        if (error) console.log(`Failed to open ${file}: ${error.message}`);
      });
      console.log(`Opened: ${file}`);
      json(res, 200, { ok: true });
      return;
    }
    json(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    json(res, 400, { ok: false, error: error.message });
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.log(`控制台已经在 ${PORT} 端口运行了。想看最新界面:lsof -ti tcp:${PORT} | xargs kill 然后重开。`);
    process.exit(0);
  }
  throw error;
});

server.listen(PORT, HOST, () => {
  console.log("Mamba | Control Center");
  console.log("======================");
  console.log(`Dashboard: ${LOCAL_URL}`);
  console.log("Keep this window open while you use the panel. Close it to stop.");
  if (process.env.MAMBA_AUTO_OPEN !== "0") execFile("/usr/bin/open", [LOCAL_URL], () => {});
});
