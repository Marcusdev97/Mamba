// 页面用 server 直接吐 HTML，没有前端框架、没有打包步骤。
// 要求是「很简略，只要看清楚就好」—— 所以字大、行距宽、颜色只用来分「客户说的」
// 和「我们说的」，其他一律不加。

const ESCAPE = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ESCAPE[ch]);

// 时间一律显示本机时区，并且用「几天前」这种看一眼就懂的写法。
export function when(iso) {
  const ms = new Date(iso ?? "").getTime();
  if (!Number.isFinite(ms)) return "";
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  const date = new Date(ms).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
  if (days <= 0) return `今天 ${new Date(ms).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
  if (days === 1) return "昨天";
  if (days < 30) return `${days} 天前`;
  return date;
}

const STYLE = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 24px;
  background: #0f1115; color: #e8eaed;
  font: 16px/1.6 -apple-system, "PingFang SC", "Helvetica Neue", sans-serif;
}
.wrap { max-width: 860px; margin: 0 auto; }
h1 { font-size: 20px; margin: 0 0 4px; font-weight: 600; }
.sub { color: #8b93a1; font-size: 14px; margin-bottom: 24px; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 28px; }
.card { background: #171a21; border: 1px solid #242833; border-radius: 10px; padding: 16px; }
.card .n { font-size: 30px; font-weight: 600; line-height: 1.2; }
.card .l { color: #8b93a1; font-size: 13px; margin-top: 4px; }
.card.hot .n { color: #4ade80; }
nav { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
nav a {
  padding: 8px 14px; border-radius: 8px; text-decoration: none;
  background: #171a21; color: #b6bcc8; border: 1px solid #242833; font-size: 14px;
}
nav a.on { background: #4ade80; color: #0f1115; border-color: #4ade80; font-weight: 600; }
ul.list { list-style: none; padding: 0; margin: 0; }
ul.list li { border-bottom: 1px solid #1e222b; }
ul.list a { display: block; padding: 14px 4px; text-decoration: none; color: inherit; }
ul.list a:hover { background: #151821; }
.row1 { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
.nm { font-weight: 600; }
.ph { color: #6b7280; font-size: 13px; font-weight: 400; margin-left: 8px; }
.tm { color: #6b7280; font-size: 13px; white-space: nowrap; }
.pv { color: #98a0ad; font-size: 14px; margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pv.you::before { content: "你: "; color: #5b6472; }
.msg { margin: 14px 0; max-width: 78%; }
.msg .b { padding: 10px 14px; border-radius: 12px; white-space: pre-wrap; word-break: break-word; }
.msg.in .b { background: #1c2029; border-top-left-radius: 3px; }
.msg.out { margin-left: auto; }
.msg.out .b { background: #14532d; border-top-right-radius: 3px; }
.msg .t { color: #6b7280; font-size: 12px; margin-top: 4px; }
.msg.out .t { text-align: right; }
.empty { color: #6b7280; padding: 40px 0; text-align: center; }
.back { color: #8b93a1; text-decoration: none; font-size: 14px; display: inline-block; margin-bottom: 16px; }
.foot { color: #4b5563; font-size: 12px; margin-top: 40px; border-top: 1px solid #1e222b; padding-top: 14px; }
`;

function shell({ title, body, refresh = 0 }) {
  return `<!doctype html>
<html lang="zh"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ""}
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head><body><div class="wrap">${body}</div></body></html>`;
}

export function renderList({ stats, threads, filter, token, updatedAt }) {
  const q = (extra) => `?key=${encodeURIComponent(token)}${extra}`;
  const cards = [
    { n: stats.waiting ?? 0, l: "等你回", hot: true },
    { n: stats.replied ?? 0, l: "有回复的客户" },
    { n: stats.contacts ?? 0, l: "客户总数" },
    { n: stats.inbound ?? 0, l: "客户讯息数" },
  ].map((c) => `<div class="card${c.hot ? " hot" : ""}"><div class="n">${esc(c.n)}</div><div class="l">${esc(c.l)}</div></div>`).join("");

  const items = threads.length
    ? threads.map((t) => `<li><a href="/thread${q(`&phone=${encodeURIComponent(t.phone)}`)}">
        <div class="row1">
          <span class="nm">${esc(t.name || "未命名")}<span class="ph">${esc(t.phone)}</span></span>
          <span class="tm">${esc(when(t.lastAt))}</span>
        </div>
        <div class="pv${t.lastDirection === "outbound" ? " you" : ""}">${esc(t.lastText || "")}</div>
      </a></li>`).join("")
    : `<div class="empty">没有资料</div>`;

  return shell({
    title: filter === "waiting" ? "等你回的客户" : "全部对话",
    refresh: 60,
    body: `
<h1>Mamba 客户对话</h1>
<div class="sub">只读 · 资料来自主机 · ${esc(updatedAt)}</div>
<div class="cards">${cards}</div>
<nav>
  <a class="${filter === "waiting" ? "on" : ""}" href="/${q("&filter=waiting")}">等你回 (${esc(stats.waiting ?? 0)})</a>
  <a class="${filter === "all" ? "on" : ""}" href="/${q("&filter=all")}">全部回过的 (${esc(stats.replied ?? 0)})</a>
</nav>
<ul class="list">${items}</ul>
<div class="foot">这是只读画面，看得到但改不了，也不会发讯息。</div>`,
  });
}

export function renderThread({ contact, messages, token, phone }) {
  const q = `?key=${encodeURIComponent(token)}`;
  const body = messages.length
    ? messages.map((m) => `<div class="msg ${m.direction === "inbound" ? "in" : "out"}">
        <div class="b">${esc(m.text || "")}</div>
        <div class="t">${esc(when(m.sentAt))}${m.direction === "outbound" && m.source === "phone" ? " · 手机回的" : ""}</div>
      </div>`).join("")
    : `<div class="empty">这个客户还没有对话纪录</div>`;

  return shell({
    title: contact?.name || phone,
    body: `
<a class="back" href="/${q}">← 返回列表</a>
<h1>${esc(contact?.name || "未命名")}</h1>
<div class="sub">${esc(phone)} · 客户回过 ${esc(contact?.replyCount ?? 0)} 次</div>
${body}
<div class="foot">这是只读画面，看得到但改不了，也不会发讯息。</div>`,
  });
}

export function renderError({ code, message }) {
  return shell({
    title: `${code}`,
    body: `<h1>${esc(code)}</h1><div class="sub">${esc(message)}</div>`,
  });
}
