#!/usr/bin/env node
// =============================================================================
// Mamba 数据库迁移:v2 (customers 混合表) → v3 (contacts + project_leads 双键)
//
// 做什么:
//   - 读旧库(schema v2)的 customers / devices / sender_accounts / conversations /
//     messages,按 docs/mamba-schema.sql (v3) 拆分重建到一个【新文件】。
//   - customers 一行 = "一个人 × 一个项目",拆成:
//       contacts       (按电话去重,承载 stop_flag / reply_count)
//       project_leads  (project_code:phone,承载 flow 序列状态)
//   - devices → devices(device_key);sender_accounts → whatsapp_connections。
//     Connection Key 使用 device_key::真实号码;wa_01 只迁为 instance_name。
//   - conversations / messages 按"人 + 连接"归档并去重。
//
// 安全:
//   - 默认 --dry-run:只对账、只出报告,不写任何数据。
//   - --apply 也【绝不改动原库】,只写一个新文件(默认 mamba.v3.sqlite)。
//   - apply 后自动跑 quick_check + foreign_key_check;任何一步失败即中止。
//
// 运行(在 Mamba 根目录):
//   node campaign-app/migrate_v2_to_v3.mjs                 # dry-run,默认库
//   node campaign-app/migrate_v2_to_v3.mjs --apply         # 生成 mamba.v3.sqlite
//   node campaign-app/migrate_v2_to_v3.mjs --db <旧库> --out <新库> --apply
//
// SQLite 驱动自动选择:优先系统 sqlite3(和线上代码一致),
// 找不到时回退 Node 内建 node:sqlite(Node ≥ 22.5)。
// =============================================================================

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { buildSenderKey } from "./lib/device-identity.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const SQLITE_CANDIDATES = [
  "/usr/bin/sqlite3",
  "/opt/homebrew/bin/sqlite3",
  "/usr/local/bin/sqlite3",
  "/opt/anaconda3/bin/sqlite3",
];

// ---------- 小工具 ----------
function nowIso() {
  return new Date().toISOString();
}

function normalizePhone(value) {
  let digits = String(value ?? "").replace(/\D/g, "");
  if (digits.startsWith("0")) digits = `60${digits.slice(1)}`;
  return /^\d{8,15}$/.test(digits) ? digits : "";
}

function clean(value) {
  return String(value ?? "").trim();
}

function slugCode(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function truthy(value) {
  if (value === true) return true;
  const s = clean(value).toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "y" || s === "stop";
}

function parseJson(value, fallback) {
  try {
    const v = typeof value === "string" ? JSON.parse(value) : value;
    return v && typeof v === "object" ? v : fallback;
  } catch {
    return fallback;
  }
}

// 从 payload 里按多个可能的别名取值
function pick(payload, ...keys) {
  for (const key of keys) {
    if (payload && payload[key] != null && clean(payload[key]) !== "") return payload[key];
  }
  return "";
}

// SQL 字面量
function val(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function insertSql(table, row) {
  const cols = Object.keys(row);
  const vals = cols.map((c) => val(row[c]));
  return `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${vals.join(", ")});`;
}

// ---------- SQLite 适配器(CLI 或 node:sqlite) ----------
function runProcess(binary, args, input = "", timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    const err = [];
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`sqlite3 timeout ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out).toString("utf8").trim());
      else reject(new Error(Buffer.concat(err).toString("utf8").trim() || `sqlite3 exit ${code}`));
    });
    child.stdin.end(input);
  });
}

async function findCliBinary() {
  const candidates = [process.env.MAMBA_SQLITE3_PATH, ...SQLITE_CANDIDATES].filter(Boolean);
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {}
  }
  return "";
}

async function openDb(dbPath, { create = false } = {}) {
  const binary = await findCliBinary();
  if (binary) {
    if (!create && !fs.existsSync(dbPath)) throw new Error(`找不到数据库文件:${dbPath}`);
    return {
      kind: "cli",
      async query(sql) {
        const out = await runProcess(binary, ["-batch", "-json", dbPath], sql);
        return out ? JSON.parse(out) : [];
      },
      async exec(sql) {
        await runProcess(binary, ["-batch", dbPath], sql);
      },
      async close() {},
    };
  }
  // 回退 node:sqlite
  const { DatabaseSync } = await import("node:sqlite");
  if (!create && !fs.existsSync(dbPath)) throw new Error(`找不到数据库文件:${dbPath}`);
  const db = new DatabaseSync(dbPath);
  return {
    kind: "node",
    async query(sql) {
      return db.prepare(sql).all();
    },
    async exec(sql) {
      db.exec(sql);
    },
    async close() {
      db.close();
    },
  };
}

async function tableExists(db, name) {
  const rows = await db.query(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='${name}';`
  );
  return rows.length > 0;
}

async function readTable(db, name) {
  if (!(await tableExists(db, name))) return [];
  return db.query(`SELECT * FROM ${name};`);
}

// ---------- 项目 code 映射 ----------
async function loadProjectMap(projectsPath) {
  const map = new Map(); // display / alias(lower) -> code
  try {
    const raw = JSON.parse(await fsp.readFile(projectsPath, "utf8"));
    for (const p of raw?.projects || []) {
      const code = clean(p.id) || slugCode(p.name);
      if (!code) continue;
      map.set(clean(p.name).toLowerCase(), code);
      map.set(code.toLowerCase(), code);
    }
  } catch {}
  return map;
}

function projectCodeFor(display, map) {
  const key = clean(display).toLowerCase();
  if (map.has(key)) return map.get(key);
  const code = slugCode(display);
  return code || "unknown";
}

// ---------- 参数 ----------
function parseArgs(argv) {
  const args = {
    db: path.join(ROOT, "campaign-data", "mamba.sqlite"),
    out: "",
    schema: path.join(ROOT, "docs", "mamba-schema.sql"),
    projects: path.join(ROOT, "campaign-assets", "projects.json"),
    apply: false,
    force: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--dry-run") args.apply = false;
    else if (a === "--force") args.force = true;
    else if (a === "--db") args.db = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--schema") args.schema = argv[++i];
    else if (a === "--projects") args.projects = argv[++i];
  }
  if (!args.out) {
    const dir = path.dirname(args.db);
    args.out = path.join(dir, "mamba.v3.sqlite");
  }
  return args;
}

// =============================================================================
// 转换核心:把 v2 行 → v3 各表的内存结构
// =============================================================================
function buildPlan(v2, projectMap) {
  const report = {
    source: {},
    projects: 0,
    devices: 0,
    connections: 0,
    contacts: 0,
    projectLeads: 0,
    conversations: 0,
    messages: 0,
    skipped: { invalidPhone: 0, invalidProject: 0, orphanMessages: 0, duplicateMessages: 0 },
    collisions: [],
    samples: { collisions: [], invalid: [] },
  };
  const now = nowIso();

  const projects = new Map(); // code -> row
  const devices = new Map(); // device_key -> row
  const connections = new Map(); // connection_key -> row
  const senderToConn = new Map(); // device_key\0sender_phone -> global connection_key
  const contacts = new Map(); // phone -> row
  const leads = new Map(); // project_lead_key -> {row, updatedAt}
  const conversations = new Map(); // convKey -> {id,row}
  const convIdMap = new Map(); // old conv id -> kept conv id
  const messages = new Map(); // message id -> row

  const ensureProject = (display) => {
    const code = projectCodeFor(display, projectMap);
    if (!projects.has(code)) {
      projects.set(code, {
        project_code: code,
        project_name: clean(display) || code,
        aliases_json: JSON.stringify(clean(display) ? [clean(display)] : []),
        active: 1,
        created_at: now,
        updated_at: now,
      });
    }
    return code;
  };

  const ensureDevice = (deviceKey, name = "", hostname = "") => {
    const key = clean(deviceKey);
    if (!key) return null;
    if (!devices.has(key)) {
      devices.set(key, {
        device_key: key,
        device_name: clean(name),
        owner: "",
        hostname: clean(hostname),
        last_online_at: null,
        created_at: now,
        updated_at: now,
      });
    }
    return key;
  };

  // --- devices ---
  for (const d of v2.devices) ensureDevice(d.id, d.name, d.hostname);

  // --- sender_accounts → whatsapp_connections ---
  for (const s of v2.sender_accounts) {
    const senderPhone = normalizePhone(s.sender_phone);
    if (!senderPhone) continue;
    const deviceKey = ensureDevice(s.device_id);
    const connKey = buildSenderKey(deviceKey, senderPhone);
    if (!connKey) continue;
    if (!connections.has(connKey)) {
      connections.set(connKey, {
        connection_key: connKey,
        instance_name: clean(s.connection_name),
        whatsapp_number: senderPhone,
        owner: "",
        team: "",
        device_key: deviceKey,
        status: clean(s.status) === "BOUND" ? "OPEN" : "UNKNOWN",
        last_health_check: null,
        last_seen_at: null,
        created_at: now,
        updated_at: now,
      });
    }
    senderToConn.set(`${deviceKey}\u0000${senderPhone}`, connKey);
  }

  const connectionFor = (deviceKey, senderPhone) => {
    const exact = senderToConn.get(`${clean(deviceKey)}\u0000${normalizePhone(senderPhone)}`);
    if (exact) return exact;
    const suffix = `\u0000${normalizePhone(senderPhone)}`;
    const matches = [...senderToConn.entries()].filter(([key]) => key.endsWith(suffix));
    return matches.length === 1 ? matches[0][1] : null;
  };

  // --- customers → contacts + project_leads ---
  for (const c of v2.customers) {
    const phone = normalizePhone(c.phone);
    if (!phone) {
      report.skipped.invalidPhone++;
      if (report.samples.invalid.length < 10)
        report.samples.invalid.push({ reason: "phone", id: c.id, phone: c.phone });
      continue;
    }
    const projectDisplay = clean(c.project);
    if (!projectDisplay) {
      report.skipped.invalidProject++;
      if (report.samples.invalid.length < 10)
        report.samples.invalid.push({ reason: "project", id: c.id, phone });
      continue;
    }
    const code = ensureProject(projectDisplay);
    const payload = parseJson(c.payload_json, {});
    const senderPhone = normalizePhone(c.sender_phone);
    const deviceKey = devices.has(clean(c.device_id)) ? clean(c.device_id) : null;
    const connKey = connectionFor(deviceKey, senderPhone);

    // ---- contact(人级别聚合)----
    const stop = truthy(pick(payload, "stopFlag", "stop_flag")) ||
      clean(c.status).toUpperCase() === "STOP";
    const replyCount = Number(pick(payload, "replyCount", "reply_count") || 0) || 0;
    const existingContact = contacts.get(phone);
    if (!existingContact) {
      contacts.set(phone, {
        contact_key: phone,
        phone,
        display_name: clean(c.name),
        stop_flag: stop ? 1 : 0,
        stop_reason: stop ? clean(pick(payload, "stopReason")) : "",
        stop_at: stop ? (c.last_reply_at || now) : null,
        reply_count: replyCount,
        last_reply_text: clean(c.last_reply_text),
        last_reply_at: c.last_reply_at || null,
        created_at: c.created_at || now,
        updated_at: c.updated_at || now,
      });
    } else {
      if (!existingContact.display_name && clean(c.name)) existingContact.display_name = clean(c.name);
      if (stop) {
        existingContact.stop_flag = 1;
        if (!existingContact.stop_at) existingContact.stop_at = c.last_reply_at || now;
      }
      existingContact.reply_count = Math.max(existingContact.reply_count, replyCount);
      if ((c.last_reply_at || "") > (existingContact.last_reply_at || "")) {
        existingContact.last_reply_at = c.last_reply_at;
        existingContact.last_reply_text = clean(c.last_reply_text);
      }
    }

    // ---- project_lead(项目级别)----
    const leadKey = `${code}:${phone}`;
    const leadRow = {
      project_lead_key: leadKey,
      notion_page_id: clean(c.notion_page_id) || null,
      contact_key: phone,
      project_code: code,
      phone,
      name: clean(c.name),
      sequence_status: clean(c.sequence_status),
      status: clean(c.status),
      last_flow_sent: clean(pick(payload, "lastFlowSent", "last_flow_sent")),
      next_flow: clean(pick(payload, "nextFlow", "next_flow")),
      cohort_day: Number(pick(payload, "cohortDay", "cohort_day")) || null,
      follow_up_due: pick(payload, "followUpDue", "follow_up_due") || null,
      first_blast_at: pick(payload, "firstBlastAt", "first_blast_at") || null,
      last_blast_at: pick(payload, "lastBlastAt", "last_blast_at") || null,
      assigned_sender_key: connKey,
      last_sender_key: connKey,
      last_sender_phone: senderPhone,
      last_sent_by_device: deviceKey,
      campaign_run_id: null,
      send_lock: 0,
      locked_by_device: null,
      lock_until: null,
      ai_category: clean(pick(payload, "aiCategory", "ai_category")),
      ai_summary: clean(pick(payload, "aiSummary", "ai_summary")),
      priority: (clean(pick(payload, "priority")).toUpperCase().match(/^(HIGH|MED|LOW)$/) || [""])[0],
      follow_up_at: pick(payload, "followUpAt", "follow_up_at") || null,
      assigned_sales: clean(pick(payload, "assignedSales", "assigned_sales")),
      sales_notes: clean(pick(payload, "salesNotes", "sales_notes")),
      appointment_date: pick(payload, "appointmentDate") || null,
      appointment_time: clean(pick(payload, "appointmentTime")),
      appointment_place: clean(pick(payload, "appointmentPlace")),
      appointment_status: (clean(pick(payload, "appointmentStatus")).match(
        /^(Pending|Confirmed|Done|No Show)$/
      ) || [""])[0],
      payload_json: clean(c.payload_json) || "{}",
      source_updated_at: c.source_updated_at || null,
      created_at: c.created_at || now,
      updated_at: c.updated_at || now,
    };
    const prev = leads.get(leadKey);
    if (!prev) {
      leads.set(leadKey, { row: leadRow, updatedAt: c.updated_at || "", sourceId: c.id });
    } else {
      // 同一 (project, phone) 多行 = 冲突,保留 updated_at 最新的一行
      const collision = { project_lead_key: leadKey, keptId: prev.sourceId, droppedId: c.id };
      if ((c.updated_at || "") > (prev.updatedAt || "")) {
        collision.keptId = c.id;
        collision.droppedId = prev.sourceId;
        leads.set(leadKey, { row: leadRow, updatedAt: c.updated_at || "", sourceId: c.id });
      }
      report.collisions.push(collision);
      if (report.samples.collisions.length < 10)
        report.samples.collisions.push({ leadKey, phone, project: code });
    }
  }

  // --- conversations(按 contact + connection 去重)---
  for (const cv of v2.conversations) {
    const phone = normalizePhone(cv.customer_phone || cv.phone);
    if (!phone || !contacts.has(phone)) continue;
    const senderPhone = normalizePhone(cv.sender_phone);
    const connKey = connectionFor(cv.device_id, senderPhone);
    const convKey = `${phone}\u0000${connKey || ""}`;
    if (!conversations.has(convKey)) {
      const keptId = clean(cv.id) || `conv_${phone}_${connKey || "na"}`;
      conversations.set(convKey, {
        id: keptId,
        row: {
          id: keptId,
          contact_key: phone,
          connection_key: connKey,
          customer_phone: phone,
          last_message_at: cv.last_message_at || null,
          created_at: cv.created_at || now,
          updated_at: cv.updated_at || now,
        },
      });
    }
    convIdMap.set(clean(cv.id), conversations.get(convKey).id);
  }

  // --- messages(重映射 conversation_id)---
  for (const [messageIndex, m] of v2.messages.entries()) {
    const newConvId = convIdMap.get(clean(m.conversation_id));
    if (!newConvId) {
      report.skipped.orphanMessages++;
      continue;
    }
    let messageId = clean(m.id) || `legacy_message_${messageIndex + 1}`;
    while (!clean(m.id) && messages.has(messageId)) messageId = `${messageId}_duplicate`;
    if (messages.has(messageId)) {
      report.skipped.duplicateMessages++;
      continue;
    }
    const direction = clean(m.direction).toLowerCase();
    messages.set(messageId, {
      id: messageId,
      conversation_id: newConvId,
      direction: ["inbound", "outbound", "operator", "system"].includes(direction) ? direction : "system",
      text: clean(m.text),
      message_type: clean(m.message_type) || "text",
      source: clean(m.source) || "evolution",
      flow_topic: "",
      template_key: null,
      sent_at: m.sent_at || null,
      payload_json: clean(m.payload_json) || "{}",
      created_at: m.created_at || now,
    });
  }

  report.source = {
    customers: v2.customers.length,
    devices: v2.devices.length,
    sender_accounts: v2.sender_accounts.length,
    conversations: v2.conversations.length,
    messages: v2.messages.length,
  };
  report.projects = projects.size;
  report.devices = devices.size;
  report.connections = connections.size;
  report.contacts = contacts.size;
  report.projectLeads = leads.size;
  report.conversations = conversations.size;
  report.messages = messages.size;

  return {
    report,
    data: {
      projects: [...projects.values()],
      devices: [...devices.values()],
      connections: [...connections.values()],
      contacts: [...contacts.values()],
      leads: [...leads.values()].map((x) => x.row),
      conversations: [...conversations.values()].map((x) => x.row),
      messages: [...messages.values()],
    },
  };
}

// =============================================================================
// 写入新库(apply)
// =============================================================================
async function applyPlan(outDb, data) {
  // FK 安全顺序
  const order = [
    ["projects", data.projects],
    ["devices", data.devices],
    ["whatsapp_connections", data.connections],
    ["contacts", data.contacts],
    ["project_leads", data.leads],
    ["conversations", data.conversations],
    ["messages", data.messages],
  ];
  const stmts = ["PRAGMA foreign_keys=ON;", "BEGIN IMMEDIATE;"];
  for (const [table, rows] of order) {
    for (const row of rows) stmts.push(insertSql(table, row));
  }
  stmts.push("COMMIT;");
  await outDb.exec(stmts.join("\n"));
}

// =============================================================================
// 主流程
// =============================================================================
async function main() {
  const args = parseArgs(process.argv);
  const mode = args.apply ? "APPLY" : "DRY_RUN";
  console.log(`\n=== Mamba v2 → v3 迁移 [${mode}] ===`);
  console.log(`源库(只读):${args.db}`);
  console.log(`目标库(新建):${args.out}`);

  const src = await openDb(args.db, { create: false });
  console.log(`SQLite 驱动:${src.kind === "cli" ? "系统 sqlite3" : "node:sqlite"}`);

  const [{ user_version: sourceVersion = 0 } = {}] = await src.query("PRAGMA user_version;");
  if (Number(sourceVersion) >= 3) {
    await src.close();
    throw new Error(`源库已经是 schema v${sourceVersion},不需要运行 v2 → v3 迁移。`);
  }

  const v2 = {
    customers: await readTable(src, "customers"),
    devices: await readTable(src, "devices"),
    sender_accounts: await readTable(src, "sender_accounts"),
    conversations: await readTable(src, "conversations"),
    messages: await readTable(src, "messages"),
  };
  await src.close();

  const projectMap = await loadProjectMap(args.projects);
  const { report, data } = buildPlan(v2, projectMap);

  // 报告
  console.log("\n--- 对账报告 ---");
  console.log(`源:customers=${report.source.customers} devices=${report.source.devices} ` +
    `senders=${report.source.sender_accounts} conv=${report.source.conversations} msg=${report.source.messages}`);
  console.log(`拆分后:contacts=${report.contacts} project_leads=${report.projectLeads} ` +
    `projects=${report.projects} connections=${report.connections} devices=${report.devices}`);
  console.log(`对话:conversations=${report.conversations} messages=${report.messages}`);
  console.log(`跳过:无效电话=${report.skipped.invalidPhone} 无项目=${report.skipped.invalidProject} ` +
    `孤儿消息=${report.skipped.orphanMessages} 重复消息=${report.skipped.duplicateMessages}`);
  console.log(`冲突(同项目同号码多行):${report.collisions.length}`);
  if (report.samples.collisions.length)
    console.log("  冲突样本:", JSON.stringify(report.samples.collisions.slice(0, 5)));

  const reportDir = path.join(path.dirname(args.out), "migration-reports");
  await fsp.mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `v2_to_v3_${mode}_${nowIso().replace(/[:.]/g, "-")}.json`);
  await fsp.writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n报告已写:${reportPath}`);

  if (!args.apply) {
    console.log("\n[DRY-RUN] 未写入任何数据。确认无误后加 --apply 生成新库。\n");
    return;
  }

  // apply:目标必须不存在(除非 --force)
  if (fs.existsSync(args.out)) {
    if (!args.force) {
      throw new Error(`目标库已存在:${args.out}(加 --force 覆盖,或换 --out 路径)`);
    }
    await fsp.rm(args.out, { force: true });
    await fsp.rm(`${args.out}-wal`, { force: true }).catch(() => {});
    await fsp.rm(`${args.out}-shm`, { force: true }).catch(() => {});
  }

  const schema = await fsp.readFile(args.schema, "utf8");
  const outDb = await openDb(args.out, { create: true });
  console.log("\n建 v3 schema…");
  await outDb.exec(schema);
  console.log("写入数据…");
  await applyPlan(outDb, data);

  // 健康检查
  const [{ quick_check } = {}] = await outDb.query("PRAGMA quick_check;");
  const fk = await outDb.query("PRAGMA foreign_key_check;");
  const counts = {};
  for (const t of ["contacts", "project_leads", "projects", "whatsapp_connections",
    "devices", "conversations", "messages"]) {
    const [r] = await outDb.query(`SELECT COUNT(*) AS n FROM ${t};`);
    counts[t] = Number(r?.n ?? r?.["COUNT(*)"] ?? 0);
  }
  // 记一条 import_runs
  await outDb.exec(insertSql("import_runs", {
    id: `migrate_${nowIso().replace(/[:.]/g, "-")}`,
    source: "migrate:v2_to_v3",
    mode: "APPLY",
    status: fk.length === 0 && quick_check === "ok" ? "COMPLETED" : "PARTIAL",
    scanned_count: report.source.customers,
    imported_count: report.projectLeads,
    skipped_count: report.skipped.invalidPhone + report.skipped.invalidProject,
    failed_count: report.collisions.length,
    report_json: JSON.stringify(report),
    started_at: nowIso(),
    finished_at: nowIso(),
  }));
  await outDb.close();

  console.log("\n--- 写入结果 ---");
  console.log("行数:", JSON.stringify(counts));
  console.log("quick_check:", quick_check);
  console.log("foreign_key_check:", fk.length === 0 ? "ok(无违规)" : JSON.stringify(fk));
  if (quick_check !== "ok" || fk.length > 0) {
    throw new Error("健康检查未通过,请检查报告。");
  }
  console.log(`\n✅ 新库已生成:${args.out}`);
  console.log("原库未改动。确认新库无误后,再决定是否切换。\n");
}

main().catch((err) => {
  console.error("\n❌ 迁移失败:", err.message);
  process.exit(1);
});
