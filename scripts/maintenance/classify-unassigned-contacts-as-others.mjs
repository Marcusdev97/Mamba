import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  backupSqliteDatabase,
  clean,
  readJson,
  recentActiveRunState,
  sqlText,
} from "./lib/sqlite-maintenance.mjs";

function sqlNullable(value) {
  return clean(value) ? sqlText(value) : "NULL";
}

function parseArgs(argv) {
  const result = {
    apply: false,
    db: "",
    root: "",
    limit: 25,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") result.apply = true;
    else if (arg === "--dry-run") result.apply = false;
    else if (arg === "--db") result.db = argv[index += 1] || "";
    else if (arg.startsWith("--db=")) result.db = arg.slice("--db=".length);
    else if (arg === "--root") result.root = argv[index += 1] || "";
    else if (arg.startsWith("--root=")) result.root = arg.slice("--root=".length);
    else if (arg === "--limit") result.limit = Number(argv[index += 1]);
    else if (arg.startsWith("--limit=")) result.limit = Number(arg.slice("--limit=".length));
    else throw new Error(`不支持的参数：${arg}`);
  }
  if (!Number.isFinite(result.limit) || result.limit < 0) {
    throw new Error("--limit 必须是 0 或正数。");
  }
  result.limit = Math.min(200, Math.trunc(result.limit));
  return result;
}

function sqliteJson(binary, databasePath, sql, { readOnly = true } = {}) {
  const args = readOnly
    ? ["-readonly", "-batch", "-json", databasePath, sql]
    : ["-batch", "-json", databasePath, sql];
  const output = execFileSync(binary, args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  return clean(output) ? JSON.parse(output) : [];
}

function suppressedPhones(rootDir) {
  const remote = readJson(path.join(rootDir, "campaign-data", "suppressed.json"), {});
  const local = readJson(path.join(rootDir, "campaign-data", "suppressed_local.json"), {});
  return new Set([
    ...(Array.isArray(remote?.phones) ? remote.phones : []),
    ...Object.keys(local?.entries || {}),
  ].map(clean).filter(Boolean));
}

function privatePhones(rootDir) {
  const payload = readJson(path.join(rootDir, "campaign-data", "work_inbox_ignore.json"), {});
  const entries = Array.isArray(payload?.entries)
    ? payload.entries
    : Object.values(payload?.entries || {});
  return new Set(entries.map((item) => clean(item?.phone || item)).filter(Boolean));
}

function candidateRows(binary, databasePath) {
  return sqliteJson(binary, databasePath, `
SELECT
  c.contact_key AS contactKey,
  c.phone,
  c.display_name AS displayName,
  c.updated_at AS updatedAt,
  (
    SELECT cv.connection_key
    FROM conversations cv
    WHERE cv.contact_key=c.contact_key AND cv.connection_key IS NOT NULL
    ORDER BY COALESCE(cv.last_message_at, cv.updated_at) DESC
    LIMIT 1
  ) AS connectionKey,
  (
    SELECT wc.device_key
    FROM conversations cv
    JOIN whatsapp_connections wc ON wc.connection_key=cv.connection_key
    WHERE cv.contact_key=c.contact_key
    ORDER BY COALESCE(cv.last_message_at, cv.updated_at) DESC
    LIMIT 1
  ) AS deviceKey
FROM contacts c
WHERE c.stop_flag=0
  AND EXISTS (SELECT 1 FROM conversations cv WHERE cv.contact_key=c.contact_key)
  AND NOT EXISTS (SELECT 1 FROM project_leads p WHERE p.contact_key=c.contact_key)
  AND NOT EXISTS (SELECT 1 FROM ads_leads a WHERE a.contact_key=c.contact_key)
  AND NOT EXISTS (SELECT 1 FROM recycle_leads r WHERE r.contact_key=c.contact_key)
  AND NOT EXISTS (SELECT 1 FROM own_leads o WHERE o.contact_key=c.contact_key)
  AND NOT EXISTS (SELECT 1 FROM lead_origins lo WHERE lo.contact_key=c.contact_key)
ORDER BY COALESCE(c.last_reply_at, c.updated_at) DESC;`);
}

function classifyCandidates(rows, { suppressed, personal, activePhones }) {
  const selected = [];
  const excluded = {
    invalidPhone: 0,
    suppressed: 0,
    privateContact: 0,
    activeCampaign: 0,
  };
  for (const row of rows) {
    const phone = clean(row.phone).replace(/\D/g, "");
    if (phone.length < 8 || phone.length > 15) {
      excluded.invalidPhone += 1;
      continue;
    }
    if (suppressed.has(phone)) {
      excluded.suppressed += 1;
      continue;
    }
    if (personal.has(phone)) {
      excluded.privateContact += 1;
      continue;
    }
    if (activePhones.has(phone)) {
      excluded.activeCampaign += 1;
      continue;
    }
    selected.push({ ...row, phone });
  }
  return { selected, excluded };
}

function applyCandidates(binary, databasePath, rows) {
  if (!rows.length) return 0;
  const now = new Date().toISOString();
  const statements = ["PRAGMA foreign_keys=ON;", "BEGIN IMMEDIATE;"];
  for (const row of rows) {
    const deviceKey = clean(row.deviceKey) || "local";
    const connectionKey = clean(row.connectionKey);
    statements.push(`
INSERT INTO own_leads(
  own_lead_key, contact_key, phone, name, assigned_sender_key, note, created_at, updated_at
) VALUES (
  ${sqlText(`own:${deviceKey}:${row.phone}`)}, ${sqlText(row.contactKey)}, ${sqlText(row.phone)},
  ${sqlText(clean(row.displayName) || row.phone)}, ${sqlNullable(connectionKey)},
  'Classified as Others from an unassigned ChatRoom conversation.',
  ${sqlText(now)}, ${sqlText(now)}
)
ON CONFLICT(own_lead_key) DO NOTHING;

INSERT INTO lead_origins(
  origin_key, contact_key, lead_type, project_code, assigned_sender_key,
  notion_page_id, notion_sync_status, notion_sync_error, note, created_at, updated_at
) VALUES (
  ${sqlText(`own:general:${row.phone}`)}, ${sqlText(row.contactKey)}, 'OWN', '',
  ${sqlNullable(connectionKey)}, NULL, 'LOCAL_ONLY', '',
  'Classified as Others from an unassigned ChatRoom conversation.',
  ${sqlText(now)}, ${sqlText(now)}
)
ON CONFLICT(origin_key) DO NOTHING;`);
  }
  statements.push("COMMIT;");
  sqliteJson(binary, databasePath, statements.join("\n"), { readOnly: false });
  return rows.length;
}

export function runClassification({
  rootDir,
  databasePath,
  apply = false,
  limit = 25,
  binary = "/usr/bin/sqlite3",
} = {}) {
  if (!fs.existsSync(binary)) throw new Error(`找不到 sqlite3：${binary}`);
  if (!fs.existsSync(databasePath)) throw new Error(`找不到数据库：${databasePath}`);
  const active = recentActiveRunState(rootDir);
  const raw = candidateRows(binary, databasePath);
  const classified = classifyCandidates(raw, {
    suppressed: suppressedPhones(rootDir),
    personal: privatePhones(rootDir),
    activePhones: active.phones,
  });
  const report = {
    mode: apply ? "apply" : "dry-run",
    databasePath,
    activeRuns: active.activeRuns,
    scanned: raw.length,
    eligible: classified.selected.length,
    excluded: classified.excluded,
    sample: classified.selected.slice(0, limit).map((row) => ({
      phone: `…${row.phone.slice(-4)}`,
      hasSender: Boolean(row.connectionKey),
      updatedAt: row.updatedAt,
    })),
  };
  if (!apply) return report;
  if (active.activeRuns.length) {
    const error = new Error(`仍有 ${active.activeRuns.length} 个近期活动 Campaign；拒绝写入 Others。`);
    error.code = "ACTIVE_CAMPAIGN_BLOCKS_OTHERS_APPLY";
    error.report = report;
    throw error;
  }
  const backupPath = backupSqliteDatabase({
    binary,
    rootDir,
    databasePath,
    prefix: "before-others-classification",
  });
  const applied = applyCandidates(binary, databasePath, classified.selected);
  return { ...report, backupPath, applied };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const rootDir = path.resolve(args.root || defaultRoot);
  const databasePath = path.resolve(args.db || path.join(rootDir, "campaign-data", "mamba.sqlite"));
  try {
    console.log(JSON.stringify(runClassification({
      rootDir,
      databasePath,
      apply: args.apply,
      limit: args.limit,
    }), null, 2));
  } catch (error) {
    if (error.report) console.error(JSON.stringify(error.report, null, 2));
    console.error(error.message);
    process.exitCode = 1;
  }
}
