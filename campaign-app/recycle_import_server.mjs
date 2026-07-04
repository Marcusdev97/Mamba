// Simple local HTML importer for boss/recycle leads.
// Start with: node campaign-app/recycle_import_server.mjs

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { exec } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./campaign_core.mjs";
import { createNotionSync } from "./notion_sync.mjs";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(appDir, "..");
const HOST = "127.0.0.1";
const PORT = Number(process.env.RECYCLE_IMPORT_PORT ?? 8797);
const importDir = path.join(rootDir, "recycle-import");
const inboxDir = path.join(importDir, "inbox");
const processedDir = path.join(importDir, "processed");
const rejectedDir = path.join(importDir, "rejected");
const previewCache = new Map();

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function ensureDirs() {
  await fs.mkdir(inboxDir, { recursive: true });
  await fs.mkdir(processedDir, { recursive: true });
  await fs.mkdir(rejectedDir, { recursive: true });
}

function isImportFile(name) {
  return /\.(xlsx|xlsm|csv|tsv)$/i.test(name) && !name.startsWith("~$");
}

function safeFileName(name) {
  return path.basename(String(name ?? ""));
}

function cleanText(value) {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value).replace(/\s+/g, " ").trim();
}

function normalizePhone(value) {
  let digits = String(value ?? "").replace(/\D/g, "");
  if (digits.startsWith("0")) digits = `60${digits.slice(1)}`;
  return /^\d{8,15}$/.test(digits) ? digits : null;
}

function klDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuala_Lumpur",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function addDays(dateText, days) {
  const date = new Date(`${dateText}T00:00:00+08:00`);
  date.setDate(date.getDate() + days);
  return klDate(date);
}

function parseDateCell(value) {
  if (value instanceof Date) return klDate(value);
  const text = cleanText(value);
  if (!text) return "";
  let match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (match) return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  match = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
  if (match) {
    const year = match[3].length === 2 ? `20${match[3]}` : match[3];
    return `${year}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
  }
  return "";
}

function parseTimeCell(value) {
  if (value instanceof Date) {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kuala_Lumpur",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(value);
    return `${parts.find((p) => p.type === "hour")?.value}:${parts.find((p) => p.type === "minute")?.value}`;
  }
  if (typeof value === "number" && value > 0 && value < 1) {
    const minutes = Math.round(value * 24 * 60);
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  }
  const text = cleanText(value);
  const match = text.match(/^(\d{1,2})[:.](\d{2})\s*(am|pm)?$/i);
  if (!match) return "";
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const ampm = match[3]?.toLowerCase();
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return "";
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function findHeaderRow(values) {
  for (let i = 0; i < Math.min(values.length, 10); i += 1) {
    const row = values[i].map((cell) => cleanText(cell).toLowerCase());
    if (row.some((cell) => cell.includes("name") || cell.includes("nama")) &&
        row.some((cell) => cell.includes("phone") || cell.includes("mobile") || cell.includes("contact"))) {
      return i;
    }
  }
  return 0;
}

function findHeader(headers, patterns) {
  return headers.findIndex((header) => patterns.some((pattern) => header.includes(pattern)));
}

function pickRemark(row, knownIndexes) {
  let best = "";
  for (let i = 0; i < row.length; i += 1) {
    if (knownIndexes.has(i)) continue;
    const text = cleanText(row[i]);
    if (!text || parseTimeCell(row[i]) || normalizePhone(text)) continue;
    if (text.length > best.length) best = text;
  }
  return best;
}

function classifyLead({ remark, callTime }) {
  const text = remark.toLowerCase();
  const today = klDate();
  const hasCallActivity = Boolean(callTime || remark);

  if (!hasCallActivity) {
    return {
      leadStatus: "Not Called",
      recycleCategory: "Not Called",
      lastCallOutcome: "",
      nextAction: "Call Again",
      blastEligible: false,
      followUpDue: today,
    };
  }

  if (/(not available|wrong number|invalid|number not|cannot be reached|unreachable)/.test(text)) {
    return {
      leadStatus: "Invalid Number",
      recycleCategory: "Invalid Number",
      lastCallOutcome: /wrong number/.test(text) ? "Wrong Number" : "Invalid",
      nextAction: "No Action",
      blastEligible: false,
      followUpDue: "",
    };
  }

  if (/(already bought|bought|signed spa|\bspa\b)/.test(text)) {
    return {
      leadStatus: "Closed",
      recycleCategory: "Closed",
      lastCallOutcome: "Already Bought",
      nextAction: "No Action",
      blastEligible: false,
      followUpDue: "",
    };
  }

  if (/(direct close|close phone|hang up|not interested|reject)/.test(text)) {
    return {
      leadStatus: "Do Not Call",
      recycleCategory: "Do Not Call",
      lastCallOutcome: "Not Interested",
      nextAction: "Do Not Call",
      blastEligible: false,
      followUpDue: "",
    };
  }

  if (/(not looking|found|rented|rent|currently not looking)/.test(text)) {
    return {
      leadStatus: "Occasional Blast",
      recycleCategory: "Occasional Blast",
      lastCallOutcome: "Not Looking",
      nextAction: "Occasional Blast",
      blastEligible: true,
      followUpDue: addDays(today, 30),
    };
  }

  if (/(voicemail|voice mail|mail box|mailbox)/.test(text)) {
    return {
      leadStatus: "Call Again",
      recycleCategory: "Call Again",
      lastCallOutcome: "Voicemail Box",
      nextAction: "Call Again",
      blastEligible: false,
      followUpDue: addDays(today, 1),
    };
  }

  if (/(no answer|not pick|didn.?t pick|no pickup|missed)/.test(text)) {
    return {
      leadStatus: "Call Again",
      recycleCategory: "Call Again",
      lastCallOutcome: "No Answer",
      nextAction: "Call Again",
      blastEligible: false,
      followUpDue: addDays(today, 1),
    };
  }

  if (/(interested|details|price|pricing|viewing|brochure|send|whatsapp|wa\b)/.test(text)) {
    return {
      leadStatus: "Warm",
      recycleCategory: "Warm",
      lastCallOutcome: "Interested",
      nextAction: "Follow Up",
      blastEligible: false,
      followUpDue: addDays(today, 1),
    };
  }

  return {
    leadStatus: "Follow Up",
    recycleCategory: "Follow Up",
    lastCallOutcome: "Other",
    nextAction: "Follow Up",
    blastEligible: false,
    followUpDue: addDays(today, 1),
  };
}

async function loadRows(filePath) {
  const { FileBlob, SpreadsheetFile, Workbook } = await import("./xlsx_compat.mjs");
  const ext = path.extname(filePath).toLowerCase();
  let workbook;
  if (ext === ".csv") {
    const csvText = await fs.readFile(filePath, "utf8");
    workbook = await Workbook.fromCSV(csvText, { sheetName: "Sheet1" });
  } else if (ext === ".tsv") {
    const tsvText = await fs.readFile(filePath, "utf8");
    const csvText = tsvText.split(/\r?\n/).map((line) => line.split("\t").map((cell) => `"${cell.replaceAll('"', '""')}"`).join(",")).join("\n");
    workbook = await Workbook.fromCSV(csvText, { sheetName: "Sheet1" });
  } else {
    workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(filePath));
  }
  const sheet = workbook.worksheets.getItemAt(0);
  return sheet.getUsedRange(true)?.values ?? [];
}

async function buildPreview(fileName) {
  const safeName = safeFileName(fileName);
  if (!isImportFile(safeName)) throw new Error("请选择 .xlsx, .xlsm, .csv, 或 .tsv 文件。");

  const filePath = path.join(inboxDir, safeName);
  const values = await loadRows(filePath);
  if (values.length < 2) throw new Error("这个文件没有足够的 rows。");

  const headerRow = findHeaderRow(values);
  const headers = values[headerRow].map((cell) => cleanText(cell).toLowerCase());
  const nameIndex = findHeader(headers, ["name", "nama", "名字"]);
  const phoneIndex = findHeader(headers, ["phone", "mobile", "contact", "tel", "号码"]);
  const dateIndex = findHeader(headers, ["date", "日期"]);
  const timeIndex = findHeader(headers, ["time", "时间"]);
  const remarkIndex = findHeader(headers, ["remark", "note", "comment", "outcome", "status"]);
  const resolvedNameIndex = nameIndex >= 0 ? nameIndex : 0;
  const resolvedPhoneIndex = phoneIndex >= 0 ? phoneIndex : 1;
  const today = klDate();
  const importedAt = new Date().toISOString();
  const sourceBatch = `${path.parse(safeName).name} ${today}`;
  const seen = new Set();
  const records = [];
  const rejected = [];

  for (let rowIndex = headerRow + 1; rowIndex < values.length; rowIndex += 1) {
    const row = values[rowIndex] ?? [];
    if (!row.some((cell) => cleanText(cell))) continue;

    const name = cleanText(row[resolvedNameIndex]) || "Unknown";
    const phone = normalizePhone(row[resolvedPhoneIndex]);
    const detectedTime = timeIndex >= 0 ? parseTimeCell(row[timeIndex]) : row.map(parseTimeCell).find(Boolean) || "";
    const known = new Set([resolvedNameIndex, resolvedPhoneIndex]);
    if (dateIndex >= 0) known.add(dateIndex);
    if (timeIndex >= 0) known.add(timeIndex);
    if (remarkIndex >= 0) known.add(remarkIndex);

    const remark = remarkIndex >= 0 ? cleanText(row[remarkIndex]) : pickRemark(row, known);
    const callDate = parseDateCell(dateIndex >= 0 ? row[dateIndex] : "") || (detectedTime || remark ? today : "");

    if (!phone) {
      rejected.push({ row: rowIndex + 1, name, reason: "invalid phone", rawPhone: cleanText(row[resolvedPhoneIndex]) });
      continue;
    }
    if (seen.has(phone)) {
      rejected.push({ row: rowIndex + 1, name, phone, reason: "duplicate in file" });
      continue;
    }
    seen.add(phone);

    const classification = classifyLead({ remark, callTime: detectedTime });
    const hasCallActivity = Boolean(detectedTime || remark);
    records.push({
      row: rowIndex + 1,
      name,
      phone,
      callDate,
      callTime: detectedTime,
      remark,
      hasCallActivity,
      sourceBatch,
      importedAt,
      importFile: safeName,
      aiSummary: remark ? `Call note: ${remark}` : "No call remark yet.",
      ...classification,
    });
  }

  const counts = {
    rows: records.length + rejected.length,
    valid: records.length,
    rejected: rejected.length,
    duplicates: rejected.filter((item) => item.reason === "duplicate in file").length,
    byStatus: {},
  };
  for (const record of records) {
    counts.byStatus[record.leadStatus] = (counts.byStatus[record.leadStatus] ?? 0) + 1;
  }

  return {
    id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
    fileName: safeName,
    filePath,
    headerRow: headerRow + 1,
    importedAt,
    sourceBatch,
    counts,
    records,
    rejected,
  };
}

async function moveProcessed(fileName) {
  const parsed = path.parse(fileName);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(processedDir, `${parsed.name}_${stamp}${parsed.ext}`);
  await fs.rename(path.join(inboxDir, fileName), target);
  return target;
}

async function saveRejected(preview) {
  if (!preview.rejected.length) return "";
  const parsed = path.parse(preview.fileName);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(rejectedDir, `${parsed.name}_${stamp}_rejected.json`);
  await fs.writeFile(target, `${JSON.stringify(preview.rejected, null, 2)}\n`);
  return target;
}

const handlers = {
  "GET /api/files": async (_req, res) => {
    await ensureDirs();
    const entries = await fs.readdir(inboxDir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile() || !isImportFile(entry.name)) continue;
      const stat = await fs.stat(path.join(inboxDir, entry.name));
      files.push({ name: entry.name, size: stat.size, modifiedAt: stat.mtime.toISOString() });
    }
    files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    json(res, 200, { ok: true, inboxDir, processedDir, rejectedDir, files });
  },

  "POST /api/preview": async (req, res) => {
    const body = await readBody(req);
    const preview = await buildPreview(body.fileName);
    previewCache.set(preview.id, preview);
    json(res, 200, {
      ok: true,
      previewId: preview.id,
      fileName: preview.fileName,
      headerRow: preview.headerRow,
      sourceBatch: preview.sourceBatch,
      counts: preview.counts,
      sample: preview.records.slice(0, 80),
      rejected: preview.rejected.slice(0, 30),
    });
  },

  "POST /api/import": async (req, res) => {
    const body = await readBody(req);
    const preview = previewCache.get(String(body.previewId ?? ""));
    if (!preview) throw new Error("Preview 已过期，请重新 preview 一次。");

    const env = await loadEnv();
    const sync = await createNotionSync({ env });
    if (!sync.enabled) throw new Error("Notion sync is OFF. 请先运行 Set Notion Token.command。");

    const result = { created: 0, updated: 0, protectedDoNotCall: 0, failed: 0, errors: [] };
    for (const record of preview.records) {
      try {
        const item = await sync.upsertRecycleLead(record);
        if (item.action === "created") result.created += 1;
        if (item.action === "updated") result.updated += 1;
        if (item.protectedDoNotCall) result.protectedDoNotCall += 1;
      } catch (error) {
        result.failed += 1;
        result.errors.push({ row: record.row, name: record.name, phone: record.phone, error: error.message });
        if (result.errors.length >= 10) break;
      }
    }

    if (result.failed > 0) {
      json(res, 500, { ok: false, error: "有 records 上传失败，文件暂时留在 inbox。", result });
      return;
    }

    const rejectedPath = await saveRejected(preview);
    const processedPath = await moveProcessed(preview.fileName);
    previewCache.delete(preview.id);
    json(res, 200, { ok: true, result, rejectedPath, processedPath });
  },
};

const html = String.raw`<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Mamba Recycle Import</title>
<style>
  :root { --bg:#0f1115; --panel:#181b21; --panel2:#20252e; --line:#303642; --text:#eceff4; --muted:#9aa3b2; --green:#25d366; --yellow:#f5b342; --red:#ff6666; --blue:#4a9eff; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; font-size:14px; }
  .wrap { max-width:1100px; margin:0 auto; padding:24px 18px 60px; }
  header { display:flex; justify-content:space-between; gap:16px; align-items:flex-start; margin-bottom:18px; }
  h1 { font-size:20px; margin:0 0 4px; }
  .sub, .muted { color:var(--muted); }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:16px; margin-bottom:14px; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
  @media (max-width:850px){ .grid{grid-template-columns:1fr;} header{display:block;} }
  h2 { font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.8px; margin:0 0 12px; }
  button, select { border:1px solid var(--line); background:var(--panel2); color:var(--text); border-radius:10px; padding:10px 13px; font-weight:650; font-size:14px; }
  button { cursor:pointer; }
  button.primary { background:var(--green); border-color:var(--green); color:#04220f; }
  button:disabled { opacity:.45; cursor:not-allowed; }
  select { width:100%; margin-bottom:12px; }
  .path { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; background:#0c0e12; border:1px solid var(--line); border-radius:10px; padding:10px; overflow:auto; font-size:12px; }
  .chips { display:flex; flex-wrap:wrap; gap:8px; margin:10px 0; }
  .chip { background:var(--panel2); border:1px solid var(--line); border-radius:10px; padding:9px 11px; min-width:110px; }
  .chip b { display:block; font-size:19px; margin-bottom:1px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th,td { border-bottom:1px solid var(--line); padding:8px 9px; text-align:left; vertical-align:top; }
  th { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.5px; }
  .tag { display:inline-block; border-radius:999px; padding:2px 8px; font-size:11px; font-weight:750; }
  .s-Warm { background:rgba(37,211,102,.16); color:var(--green); }
  .s-Follow,.s-Call { background:rgba(245,179,66,.18); color:var(--yellow); }
  .s-Occasional { background:rgba(74,158,255,.16); color:var(--blue); }
  .s-Do,.s-Invalid { background:rgba(255,102,102,.16); color:var(--red); }
  .s-Closed,.s-Not { background:#2a2f39; color:var(--muted); }
  .err { color:var(--red); margin-top:10px; white-space:pre-wrap; }
  .ok { color:var(--green); margin-top:10px; white-space:pre-wrap; }
  .hidden { display:none; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>Mamba | Recycle Leads Importer</h1>
      <div class="sub">Excel 放进 inbox，然后 Preview，确认后才上传 Notion。</div>
    </div>
    <button onclick="loadFiles()">刷新文件</button>
  </header>

  <div class="grid">
    <div class="card">
      <h2>Step 1 · 选择 Excel</h2>
      <div class="muted" style="margin-bottom:7px">Inbox folder</div>
      <div class="path" id="inboxPath">Loading...</div>
      <div style="height:12px"></div>
      <select id="fileSelect"></select>
      <button class="primary" id="previewBtn" onclick="previewFile()">Preview</button>
      <div class="err" id="fileErr"></div>
    </div>

    <div class="card">
      <h2>Step 2 · Preview Summary</h2>
      <div id="emptyState" class="muted">还没有 preview。</div>
      <div id="summary" class="hidden">
        <div class="chips" id="chips"></div>
        <div class="muted" id="batchText"></div>
        <div style="margin-top:12px">
          <button class="primary" id="importBtn" onclick="confirmImport()">Confirm Upload to Notion</button>
        </div>
        <div class="ok" id="importOk"></div>
        <div class="err" id="importErr"></div>
      </div>
    </div>
  </div>

  <div class="card hidden" id="previewCard">
    <h2>Preview Rows</h2>
    <table>
      <thead><tr><th>Row</th><th>Name</th><th>Phone</th><th>Status</th><th>Outcome</th><th>Next</th><th>Time</th><th>Remark</th></tr></thead>
      <tbody id="previewBody"></tbody>
    </table>
  </div>

  <div class="card hidden" id="rejectedCard">
    <h2>Rejected Rows</h2>
    <table>
      <thead><tr><th>Row</th><th>Name</th><th>Phone</th><th>Reason</th></tr></thead>
      <tbody id="rejectedBody"></tbody>
    </table>
  </div>
</div>

<script>
let currentPreviewId = "";

async function api(path, options = {}) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || JSON.stringify(data));
  return data;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}

function statusClass(status) {
  return "s-" + String(status || "Not").split(" ")[0];
}

function chip(label, value) {
  return '<div class="chip"><b>' + esc(value) + '</b><span class="muted">' + esc(label) + '</span></div>';
}

async function loadFiles() {
  document.getElementById("fileErr").textContent = "";
  const data = await api("/api/files").catch((err) => {
    document.getElementById("fileErr").textContent = err.message;
    return null;
  });
  if (!data) return;
  document.getElementById("inboxPath").textContent = data.inboxDir;
  const sel = document.getElementById("fileSelect");
  if (!data.files.length) {
    sel.innerHTML = '<option value="">No Excel found in inbox</option>';
    document.getElementById("previewBtn").disabled = true;
    return;
  }
  sel.innerHTML = data.files.map((f) => '<option value="' + esc(f.name) + '">' + esc(f.name) + '</option>').join("");
  document.getElementById("previewBtn").disabled = false;
}

async function previewFile() {
  const fileName = document.getElementById("fileSelect").value;
  document.getElementById("fileErr").textContent = "";
  document.getElementById("importOk").textContent = "";
  document.getElementById("importErr").textContent = "";
  if (!fileName) return;
  document.getElementById("previewBtn").disabled = true;
  try {
    const data = await api("/api/preview", { method: "POST", body: JSON.stringify({ fileName }) });
    currentPreviewId = data.previewId;
    document.getElementById("emptyState").classList.add("hidden");
    document.getElementById("summary").classList.remove("hidden");
    document.getElementById("previewCard").classList.remove("hidden");
    document.getElementById("batchText").textContent = "Batch: " + data.sourceBatch + " · Header row: " + data.headerRow;

    const chips = [
      chip("Valid", data.counts.valid),
      chip("Rejected", data.counts.rejected),
      chip("Duplicates", data.counts.duplicates),
      ...Object.entries(data.counts.byStatus).map(([k, v]) => chip(k, v)),
    ];
    document.getElementById("chips").innerHTML = chips.join("");
    document.getElementById("previewBody").innerHTML = data.sample.map((r) => '<tr><td>' + r.row + '</td><td>' + esc(r.name) + '</td><td>' + esc(r.phone) + '</td><td><span class="tag ' + statusClass(r.leadStatus) + '">' + esc(r.leadStatus) + '</span></td><td>' + esc(r.lastCallOutcome) + '</td><td>' + esc(r.nextAction) + '</td><td>' + esc(r.callTime || r.callDate) + '</td><td>' + esc(r.remark) + '</td></tr>').join("");

    if (data.rejected.length) {
      document.getElementById("rejectedCard").classList.remove("hidden");
      document.getElementById("rejectedBody").innerHTML = data.rejected.map((r) => '<tr><td>' + r.row + '</td><td>' + esc(r.name) + '</td><td>' + esc(r.phone || r.rawPhone || "") + '</td><td>' + esc(r.reason) + '</td></tr>').join("");
    } else {
      document.getElementById("rejectedCard").classList.add("hidden");
      document.getElementById("rejectedBody").innerHTML = "";
    }
  } catch (err) {
    document.getElementById("fileErr").textContent = err.message;
  } finally {
    document.getElementById("previewBtn").disabled = false;
  }
}

async function confirmImport() {
  if (!currentPreviewId) return;
  if (!confirm("Confirm upload these previewed leads to Mamba | Recycle Leads?")) return;
  const btn = document.getElementById("importBtn");
  btn.disabled = true;
  document.getElementById("importOk").textContent = "Uploading to Notion...";
  document.getElementById("importErr").textContent = "";
  try {
    const data = await api("/api/import", { method: "POST", body: JSON.stringify({ previewId: currentPreviewId }) });
    const r = data.result;
    document.getElementById("importOk").textContent = "Done. Created: " + r.created + " · Updated: " + r.updated + " · Protected Do Not Call: " + r.protectedDoNotCall + "\\nFile moved to processed.";
    currentPreviewId = "";
    await loadFiles();
  } catch (err) {
    document.getElementById("importOk").textContent = "";
    document.getElementById("importErr").textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

loadFiles();
</script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const key = `${req.method} ${url.pathname}`;
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    const handler = handlers[key];
    if (!handler) {
      json(res, 404, { ok: false, error: "Not found" });
      return;
    }
    await handler(req, res);
  } catch (error) {
    json(res, 500, { ok: false, error: error.message });
  }
});

await ensureDirs();
server.on("error", (error) => {
  console.error("Could not start Recycle Leads Importer.");
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Close the other importer window and try again.`);
  } else if (error.code === "EPERM") {
    console.error(`macOS blocked access to ${HOST}:${PORT}. Try opening the command again from Finder.`);
  } else {
    console.error(error.message);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log("MAMBA RECYCLE LEADS IMPORTER");
  console.log("============================");
  console.log(`Inbox: ${inboxDir}`);
  console.log(`Open:  ${url}`);
  console.log("");
  console.log("Put your Excel file into inbox, preview it, then confirm upload.");
  if (process.env.NO_OPEN !== "1") exec(`open ${url}`);
});
