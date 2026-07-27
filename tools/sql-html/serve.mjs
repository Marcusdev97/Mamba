// SQL 面板 Server —— 让另一台电脑在同一个 Wi-Fi 下,实时看这台主机的数据库。
//
// 只读。开资料库时钉死 readOnly,是 SQLite 自己拒绝写入,不是这里自己判断的,
// 所以就算程式写错也弄不坏东西,更不会发出任何 WhatsApp 讯息。
// 另一台电脑在页面上做的增删改,只留在他自己的浏览器里(草稿 + 导出 SQL),
// 不会回写主机的 mamba.sqlite。
//
// 为什么要存取码:绑在区域网路上 = 同一个 Wi-Fi 的人都连得到,而这里面是客户
// 真实电话和对话内容。存取码不是强防护(区域网路上是明文 HTTP),但至少不会变成
// 「谁扫到这个 port 就能翻客户资料」。第一次启动自己产生一组,存在 .access-token,
// 之后每次开都用同一组,网址不用换。
//
//   node tools/sql-html/serve.mjs
//   node tools/sql-html/serve.mjs --port=8900
//   node tools/sql-html/serve.mjs --db=campaign-data/backups/xxx.sqlite
//   node tools/sql-html/serve.mjs --new-token     # 换一组存取码(旧网址立刻失效)
//   node tools/sql-html/serve.mjs --allow-upload  # 额外开 /upload,收另一台电脑的资料库
import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { buildSnapshot, renderPage, ROOT, DEFAULT_DB } from '../lib/snapshot.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const TOKEN_PATH = path.join(HERE, '.access-token');
const DEFAULT_PORT = 8900;

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const port = Number(arg('port')) || DEFAULT_PORT;
const dbPath = arg('db') ? path.resolve(ROOT, arg('db')) : DEFAULT_DB;
const rotate = process.argv.includes('--new-token');
// 预设纯只读。加 --allow-upload 才多开一个 /upload,让另一台电脑把它的库送过来。
const ALLOW_UPLOAD = process.argv.includes('--allow-upload');

async function loadToken() {
  if (!rotate) {
    try {
      const existing = (await fs.readFile(TOKEN_PATH, 'utf8')).trim();
      if (existing) return existing;
    } catch { /* 还没有就产生一组 */ }
  }
  const token = crypto.randomBytes(9).toString('base64url');
  await fs.writeFile(TOKEN_PATH, `${token}\n`, { mode: 0o600 });   // 只有这台电脑的这个使用者读得到
  return token;
}

// 存取码用等长比较,避免逐字元比对被试出来。
function tokenOk(given, expected) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((net) => net && net.family === 'IPv4' && !net.internal)
    .map((net) => net.address);
}

// 11 MB 的页面每次重新生成太浪费,所以按资料库的 mtime 快取:
// 数据库一有变动(app 写进去了)下次开就是新的,没变动就直接给快取。
let cache = null;
function page() {
  const stamp = `${statSync(dbPath).mtimeMs}:${statSync(dbPath).size}`;
  if (cache && cache.stamp === stamp) return cache;
  const t0 = Date.now();
  const snapshot = buildSnapshot({ dbPath });
  const html = renderPage(snapshot);
  cache = {
    stamp,
    html,
    gzip: zlib.gzipSync(html),      // 11 MB → 约 2 MB,Wi-Fi 上差很多
    rows: snapshot.payload.db.rows,
    ms: Date.now() - t0,
  };
  console.log(`[panel] 重新读了资料库:${cache.rows} 行,${cache.ms}ms,gzip 后 ${(cache.gzip.length / 1024 / 1024).toFixed(1)} MB`);
  return cache;
}

const errorPage = (code, message) => `<!doctype html><meta charset="utf-8">
<title>${code}</title><style>body{font:15px/1.6 -apple-system,"PingFang SC",sans-serif;margin:15vh auto;max-width:32em;padding:0 1.5em;color:#333}
h1{font-size:3em;margin:0;color:#bbb}</style><h1>${code}</h1><p>${message}</p>`;

// ---------------------------------------------------------------------------
// 上传:让另一台电脑把它的 mamba.sqlite 送过来(--allow-upload 才开)
//
// 存进 campaign-data/incoming/,绝不覆盖主机自己的 mamba.sqlite —— 两台电脑
// 同时写一个库是 ADR 明确否决的做法。收到之后主机这边自己决定怎么用。
// ---------------------------------------------------------------------------
const INCOMING = path.join(ROOT, 'campaign-data/incoming');
const MAX_UPLOAD = 512 * 1024 * 1024;
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'binary');

const uploadPage = (key) => `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>上传数据到主机</title>
<style>
 body{font:15px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;margin:8vh auto;max-width:34em;padding:0 1.5em;color:#1b1f24}
 h1{font-size:1.3em;margin:0 0 .2em} p.sub{color:#6b7280;margin:0 0 1.6em;font-size:.92em}
 ol{color:#444;padding-left:1.3em} li{margin:.5em 0} code{font-family:ui-monospace,Menlo,monospace;background:#f2f3f5;padding:.1em .4em;border-radius:4px;font-size:.9em}
 .drop{border:2px dashed #cbd0d8;border-radius:12px;padding:2em 1.5em;text-align:center;margin:1.5em 0;background:#fafbfc}
 .drop.on{border-color:#2563eb;background:#eef4ff}
 input[type=file]{width:100%}
 button{font:inherit;padding:.6em 1.4em;border-radius:8px;border:0;background:#2563eb;color:#fff;cursor:pointer;font-size:1em}
 button:disabled{background:#9aa4b2;cursor:default}
 .bar{height:8px;background:#e8eaee;border-radius:99px;overflow:hidden;margin:1em 0;display:none}
 .bar div{height:100%;width:0;background:#2563eb;transition:width .2s}
 .msg{margin-top:1em;padding:.9em 1.1em;border-radius:8px;display:none;white-space:pre-wrap}
 .ok{background:#e8f6ee;color:#1a7f4b} .bad{background:#fdeceb;color:#c0392b}
 .warn{background:#fff8e6;border-left:3px solid #e0a800;padding:.8em 1em;font-size:.9em;color:#5c4600;margin:1.5em 0}
</style>
<h1>把这台电脑的数据送到主机</h1>
<p class="sub">档案会存进主机的 <code>campaign-data/incoming/</code>,不会覆盖主机自己的资料库。</p>
<div class="warn"><strong>上传前先关掉这台电脑的 Mamba。</strong>程式还开着的话,最新的几笔可能还留在 <code>-wal</code> 档里没写进主库,传过去会少资料。</div>
<ol>
  <li>关掉这台电脑的 Mamba</li>
  <li>按下面的按钮,选 <code>Mamba/campaign-data/mamba.sqlite</code></li>
  <li>等进度条跑完</li>
</ol>
<div class="drop" id="drop">
  <input type="file" id="file" accept=".sqlite,.db,application/octet-stream">
  <p style="color:#6b7280;font-size:.88em;margin:.8em 0 0">也可以把档案直接拖到这个框里</p>
</div>
<button id="go" disabled>上传</button>
<div class="bar" id="bar"><div></div></div>
<div class="msg" id="msg"></div>
<script>
const key = ${JSON.stringify(key)};
const file = document.getElementById('file'), go = document.getElementById('go');
const bar = document.getElementById('bar'), fill = bar.firstElementChild, msg = document.getElementById('msg');
const drop = document.getElementById('drop');
const show = (text, cls) => { msg.textContent = text; msg.className = 'msg ' + cls; msg.style.display = 'block'; };
file.onchange = () => { go.disabled = !file.files.length; msg.style.display = 'none'; };
drop.ondragover = e => { e.preventDefault(); drop.classList.add('on'); };
drop.ondragleave = () => drop.classList.remove('on');
drop.ondrop = e => { e.preventDefault(); drop.classList.remove('on'); file.files = e.dataTransfer.files; file.onchange(); };
go.onclick = () => {
  const f = file.files[0];
  if (!f) return;
  go.disabled = true; bar.style.display = 'block'; show('上传中…', 'ok');
  // 用 XHR 而不是 fetch,因为要进度条
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/upload?key=' + encodeURIComponent(key) + '&name=' + encodeURIComponent(f.name));
  xhr.upload.onprogress = e => { if (e.lengthComputable) fill.style.width = (e.loaded / e.total * 100) + '%'; };
  xhr.onload = () => {
    go.disabled = false;
    try {
      const r = JSON.parse(xhr.responseText);
      if (r.ok) show('✅ 主机收到了\\n\\n' + r.detail, 'ok');
      else show('❌ ' + (r.error || '上传失败'), 'bad');
    } catch { show('❌ 主机回了看不懂的东西(HTTP ' + xhr.status + ')', 'bad'); }
  };
  xhr.onerror = () => { go.disabled = false; show('❌ 连不上主机,检查 Wi-Fi 和主机是不是还开着。', 'bad'); };
  xhr.send(f);
};
</script>`;

function receiveUpload(req, res, url) {
  const json = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  // 档名只取基底名并洗掉奇怪字元,避免 ../ 之类的路径穿越
  const raw = path.basename(String(url.searchParams.get('name') || 'upload.sqlite'));
  const safe = raw.replace(/[^\w.\-]/g, '_').replace(/^\.+/, '') || 'upload.sqlite';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const target = path.join(INCOMING, `${stamp}_${safe}`);

  fsSync.mkdirSync(INCOMING, { recursive: true });
  const out = fsSync.createWriteStream(target);
  let size = 0, head = null, aborted = false;

  req.on('data', (chunk) => {
    if (aborted) return;
    if (!head) head = Buffer.from(chunk.subarray(0, 16));
    size += chunk.length;
    if (size > MAX_UPLOAD) {
      aborted = true;
      out.destroy(); req.destroy();
      fsSync.rmSync(target, { force: true });
      json(413, { ok: false, error: '档案太大(超过 512MB)。' });
    }
  });
  req.pipe(out);

  out.on('finish', () => {
    if (aborted) return;
    if (!head || !head.subarray(0, 16).equals(SQLITE_MAGIC)) {
      fsSync.rmSync(target, { force: true });
      return json(400, { ok: false, error: '这不是 SQLite 资料库档案。要传的是 campaign-data/mamba.sqlite。' });
    }
    try {
      // 只读打开确认没坏,顺便数几个关键表回报给对方
      const db = new DatabaseSync(target, { readOnly: true });
      const count = (t) => {
        try { return db.prepare(`SELECT count(*) AS n FROM "${t}"`).get().n; } catch { return 0; }
      };
      const stats = { contacts: count('contacts'), project_leads: count('project_leads'), messages: count('messages') };
      const device = (() => {
        try { return db.prepare('SELECT device_key, device_name FROM devices LIMIT 1').get(); } catch { return null; }
      })();
      db.close();
      // 只读打开 WAL 库也会产生 -shm/-wal,验证完就清掉,免得 incoming/ 一堆碎档
      for (const ext of ['-shm', '-wal']) fsSync.rmSync(target + ext, { force: true });
      const mb = (size / 1024 / 1024).toFixed(1);
      const detail = `${path.basename(target)}\n${mb} MB · ${stats.contacts} 位客户 · ${stats.project_leads} 条 leads · ${stats.messages} 则讯息` +
        (device ? `\n来自:${device.device_name || device.device_key}` : '');
      console.log(`\n[panel] ✅ 收到上传:${target}`);
      console.log(`        ${mb} MB · contacts ${stats.contacts} · project_leads ${stats.project_leads} · messages ${stats.messages}` +
        (device ? ` · 来自 ${device.device_name || device.device_key}` : ''));
      console.log(`        看它:  node tools/sql-html/serve.mjs --db=campaign-data/incoming/${path.basename(target)}`);
      console.log(`        合并到 Postgres:  node tools/pg/dump-data.mjs --db=campaign-data/incoming/${path.basename(target)} --if-newer\n`);
      json(200, { ok: true, detail });
    } catch (error) {
      fsSync.rmSync(target, { force: true });
      json(400, { ok: false, error: `档案读不开,可能传坏了:${error.message}` });
    }
  });
  out.on('error', (error) => {
    if (aborted) return;
    console.error(`[panel] 写入失败:${error.message}`);
    json(500, { ok: false, error: '主机写入失败,看主机的终端机讯息。' });
  });
}

const token = await loadToken();
try {
  statSync(dbPath);
} catch {
  console.error(`读不到资料库:${dbPath}`);
  process.exit(1);
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://panel.local');
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(errorPage(400, '网址格式不对。'));
  }

  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    // 页面自带 inline script/style,除此之外不该载入任何外部资源,也不该被别的站嵌进去。
    'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };

  if (req.method !== 'GET' && !(ALLOW_UPLOAD && req.method === 'POST' && url.pathname === '/upload')) {
    res.writeHead(405, headers);
    return res.end(errorPage(405, '这台 server 只读,不接受任何修改。'));
  }
  if (url.pathname === '/favicon.ico') return res.writeHead(204).end();
  if (!tokenOk(url.searchParams.get('key'), token)) {
    res.writeHead(401, headers);
    return res.end(errorPage(401, '网址少了存取码,或存取码不对。跟主机那台要完整网址。'));
  }

  if (ALLOW_UPLOAD && url.pathname === '/upload') {
    // 上传页需要 fetch 回自己,所以放宽 connect-src(其余照旧)
    const upHeaders = { ...headers, 'Content-Security-Policy': headers['Content-Security-Policy'].replace("default-src 'none'", "default-src 'none'; connect-src 'self'") };
    if (req.method === 'GET') {
      res.writeHead(200, upHeaders);
      return res.end(uploadPage(url.searchParams.get('key')));
    }
    return receiveUpload(req, res, url);
  }

  if (url.pathname !== '/') {
    res.writeHead(404, headers);
    return res.end(errorPage(404, '没有这个页面。'));
  }

  try {
    const p = page();
    const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    res.writeHead(200, gz ? { ...headers, 'Content-Encoding': 'gzip' } : headers);
    res.end(gz ? p.gzip : p.html);
  } catch (error) {
    console.error(`[panel] 出错:${error.message}`);
    res.writeHead(500, headers);
    res.end(errorPage(500, '读资料时出错,看主机的终端机讯息。'));
  }
});

// 0.0.0.0 = 让同一个 Wi-Fi 的另一台电脑连得到。
server.listen(port, '0.0.0.0', () => {
  const addresses = lanAddresses();
  console.log('\nMamba SQL 面板 Server(只读)已启动\n');
  console.log(`  资料库:${dbPath}`);
  console.log('\n在另一台电脑的浏览器打开:\n');
  for (const address of addresses) console.log(`  http://${address}:${port}/?key=${token}`);
  if (ALLOW_UPLOAD) {
    console.log('\n那台电脑要「上传资料」的话,用这条:\n');
    for (const address of addresses) console.log(`  http://${address}:${port}/upload?key=${token}`);
    console.log(`\n收到的档案会放在 campaign-data/incoming/,不会覆盖这台的资料库。`);
  }
  console.log(`\n这台自己看:\n\n  http://localhost:${port}/?key=${token}`);
  console.log('\n第一次开会比较慢(要读整个资料库),之后资料库没变就是秒开。');
  console.log('按 Control-C 停止。');
  if (!addresses.length) console.log('\n⚠ 抓不到区域网路 IP,可能没连上 Wi-Fi。');
});
