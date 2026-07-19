import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

export const GC_OUTCOMES = ["Viewing Booked", "Active", "Dormant", "Dead"];
export const GC_FIRST_REPLY_TYPES = ["price", "timing", "specific_question", "perfunctory", "no_reply"];
export const GC_DEATH_MESSAGE_TYPES = [
  "ab_slot_template", "price_probe", "budget_probe", "bulk_info_dump",
  "reassurance_push", "festival_greeting", "open_question", "other",
];
export const GC_FOLLOWUP_TYPES = [
  "ab_slot_template", "festival_greeting", "new_info", "price_update", "personalized_question",
];

const LEDGER_SCHEMA_VERSION = 1;
const HEADER_RE = /^\[([MC])(\d+)\](?:\s+(?:blast:(\S+)|\+(\d+)([mhd])))?$/;
const END_RE = /^\[—\]\s+(无回复|明确拒绝|已约)$/;
const MEDIA_RE = /^\[(IMG|VOICE|VIDEO|DOC):\s*[^\]]+\]$/;
const LEAD_CODE_RE = /^L\d{3,}$/;

function clean(value) {
  return String(value ?? "").trim();
}

function sqlText(value) {
  return `'${String(value ?? "").replaceAll("'", "''")}'`;
}

function sqlNullable(value) {
  return value === null || value === undefined || value === "" ? "NULL" : sqlText(value);
}

function sqlInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? String(Math.trunc(number)) : String(fallback);
}

function iso(value) {
  const candidate = arguments.length ? value : new Date();
  if (candidate === null || candidate === undefined || candidate === "") return "";
  const date = candidate instanceof Date ? candidate : new Date(candidate);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString();
}

function hash(value) {
  return crypto.createHash("sha256").update(String(value ?? "")).digest("hex");
}

function jsonArray(value, field, { min = 0, max = Infinity } = {}) {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value || "[]");
    } catch {
      throw validationError(`${field} 必须是有效的 JSON array。`, field);
    }
  }
  if (parsed === undefined || parsed === null || parsed === "") parsed = [];
  if (!Array.isArray(parsed)) throw validationError(`${field} 必须是 array。`, field);
  if (parsed.length < min || parsed.length > max) {
    throw validationError(`${field} 必须包含 ${min}${max === Infinity ? "+" : `–${max}`} 项。`, field);
  }
  return parsed;
}

function validationError(message, field = "") {
  const error = new Error(message);
  error.code = "GC_VALIDATION_FAILED";
  error.statusCode = 422;
  error.details = field ? { field } : {};
  return error;
}

function conflictError(message, details = {}) {
  const error = new Error(message);
  error.code = "GC_DUPLICATE";
  error.statusCode = 409;
  error.details = details;
  return error;
}

function runSqlite(binary, databasePath, sql, { json = false, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const args = ["-batch", ...(json ? ["-json"] : []), databasePath];
    const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => {
        const error = new Error(`Golden Conversation SQLite timeout after ${timeoutMs}ms`);
        error.code = "GC_SQLITE_TIMEOUT";
        reject(error);
      });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => finish(() => {
      const output = Buffer.concat(stdout).toString("utf8").trim();
      const errorOutput = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        const error = new Error(errorOutput || `sqlite3 exited with code ${code}`);
        error.code = /UNIQUE constraint failed/.test(error.message) ? "GC_DUPLICATE" : "GC_SQLITE_ERROR";
        reject(error);
        return;
      }
      if (!json) {
        resolve(output);
        return;
      }
      try {
        resolve(output ? JSON.parse(output) : []);
      } catch (error) {
        reject(new Error(`Golden Conversation SQLite returned invalid JSON: ${error.message}`));
      }
    }));
    child.stdin.end(sql);
  });
}

function namePatterns(names = []) {
  return [...new Set(names.map(clean).filter((name) => name.length >= 2))]
    .sort((a, b) => b.length - a.length);
}

/**
 * Mandatory pre-write PII scrubber. It intentionally keeps property prices and
 * dimensions; only likely contact identifiers are removed.
 */
export function sanitizeGoldenPii(value, { names = [] } = {}) {
  let output = String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u200e\u200f\u202a-\u202e]/g, "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "{{EMAIL_REMOVED}}")
    .replace(/(?:\+?60|0)1\d(?:[\s().-]*\d){7,8}/g, "{{PHONE_REMOVED}}")
    .replace(/https?:\/\/\S+|www\.\S+/gi, "{{LINK_REMOVED}}")
    .replace(/\b(?:no\.?\s*)?\d{1,5}[A-Za-z]?\s*,?\s*(?:jalan|jln|lorong|persiaran|road|street)\s+[A-Za-z0-9 ./'-]{2,60}/gi, "{{ADDRESS_REMOVED}}")
    .replace(/\b(?:jalan|jln|lorong|persiaran)\s+[A-Za-z0-9 ./'-]{2,60}/gi, "{{ADDRESS_REMOVED}}")
    .replace(/\b[A-Z]{1,3}\s?\d{1,4}\s?[A-Z]?\b/gi, (match) => {
      const compact = match.replace(/\s/g, "");
      if (/^(?:RM|PSF|SF|SQFT|[MC])\d+$/i.test(compact)) return match;
      return "{{PLATE_REMOVED}}";
    });

  for (const name of namePatterns(names)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    output = output.replace(new RegExp(escaped, "gi"), "{{NAME}}");
  }
  return output.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function findResidualPii(value, { names = [] } = {}) {
  const text = String(value ?? "");
  const findings = [];
  if (/(?:\+?60|0)1\d(?:[\s().-]*\d){7,8}/.test(text)) findings.push("phone");
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text)) findings.push("email");
  const plateScanText = text
    .replace(/^\[[MC]\d+\].*$/gm, "")
    .replace(/\bRM\s?\d[\d,.]*/gi, "");
  const plateMatches = plateScanText.match(/\b[A-Z]{1,3}\s?\d{1,4}\s?[A-Z]?\b/gi) || [];
  if (plateMatches.some((match) => !/^(?:PSF|SF|SQFT|[MC])\d+$/i.test(match.replace(/\s/g, "")))) findings.push("plate");
  for (const name of namePatterns(names)) {
    if (text.toLowerCase().includes(name.toLowerCase())) findings.push(`name:${name}`);
  }
  return [...new Set(findings)];
}

export function parseConversationText(value) {
  const text = clean(value).replace(/\r\n?/g, "\n");
  if (!text) throw validationError("conversation_text 不能为空。", "conversation_text");
  const blocks = text.split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);
  const turns = [];
  let ending = "";
  const expected = { M: 1, C: 1 };

  for (const block of blocks) {
    const lines = block.split("\n");
    const header = lines.shift().trim();
    const endMatch = header.match(END_RE);
    if (endMatch) {
      if (lines.some((line) => clean(line))) throw validationError("结束标记后不能再有内容。", "conversation_text");
      ending = endMatch[1];
      if (block !== blocks.at(-1)) throw validationError("[—] 结束标记必须放在最后。", "conversation_text");
      continue;
    }

    const match = header.match(HEADER_RE);
    if (!match) throw validationError(`无法识别对话标头：${header}`, "conversation_text");
    if (ending) throw validationError("结束标记后不能再有对话。", "conversation_text");
    const [, party, rawNumber, blastVersion = "", gapValue = "", gapUnit = ""] = match;
    const number = Number(rawNumber);
    if (number !== expected[party]) {
      throw validationError(`${party} 编号必须从 ${party}${expected[party]} 连续递增，收到 ${party}${number}。`, "conversation_text");
    }
    expected[party] += 1;
    if (party === "M" && number === 1 && gapValue) {
      throw validationError("[M1] 不应填写时间间隔；可使用 blast:版本。", "conversation_text");
    }
    if (blastVersion && !(party === "M" && number === 1)) {
      throw validationError("blast:版本只允许写在 [M1]。", "conversation_text");
    }
    const content = lines.join("\n").trim();
    if (!content) throw validationError(`${party}${number} 没有讯息内容。`, "conversation_text");
    for (const line of lines.filter((line) => /^\[/.test(clean(line)))) {
      if (!MEDIA_RE.test(clean(line))) {
        throw validationError(`不支持的媒体标记：${clean(line)}`, "conversation_text");
      }
    }
    turns.push({
      id: `${party}${number}`,
      party,
      number,
      blastVersion,
      gap: gapValue ? { value: Number(gapValue), unit: gapUnit } : null,
      content,
    });
  }

  if (!ending) throw validationError("conversation_text 必须以 [—] 无回复 / 明确拒绝 / 已约 结束。", "conversation_text");
  if (!turns.some((turn) => turn.id === "C1")) {
    throw validationError("GC 只收至少有一次真实客户回复的对话（必须存在 [C1]）。", "conversation_text");
  }
  return {
    text,
    turns,
    ending,
    blastVersion: turns.find((turn) => turn.id === "M1")?.blastVersion || "",
    firstCustomerTurn: turns.find((turn) => turn.id === "C1") || null,
  };
}

export function calculateDeathTurn(parsed) {
  const lastCustomerIndex = parsed.turns.findLastIndex((turn) => turn.party === "C");
  const laterSales = parsed.turns.slice(lastCustomerIndex + 1).filter((turn) => turn.party === "M");
  return laterSales.length ? laterSales.at(-1) : null;
}

export function classifyDeathMessage(text) {
  const value = clean(text).toLowerCase();
  if (!value) return "other";
  if (/(sat|sun|星期|周[一二三四五六日天]|上午|下午|am|pm).{0,30}(还是|or)|\b(?:a|b)\s*(?:slot|时段)/i.test(value)) return "ab_slot_template";
  if (/(预算|budget|收入|income|负担|afford|dsr|薪水|salary)/i.test(value)) return "budget_probe";
  if (/(多少钱|价格|价钱|price|nett|net price|monthly|供期)/i.test(value)) return "price_probe";
  if (/(稳批|sure approve|confirm approve|一定批|guarantee.*loan)/i.test(value)) return "reassurance_push";
  if (/(新年|开斋|hari raya|christmas|圣诞|中秋|元宵|festival|节日快乐)/i.test(value)) return "festival_greeting";
  if ((value.match(/\n/g) || []).length >= 5 || value.length > 700) return "bulk_info_dump";
  if (/[?？]\s*$/.test(value)) return "open_question";
  return "other";
}

function validateTrace(value, parsed) {
  const trace = jsonArray(value, "decision_trace", { min: 1, max: 6 });
  const turnIds = new Set(parsed.turns.map((turn) => turn.id));
  return trace.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw validationError(`decision_trace 第 ${index + 1} 项必须是 object。`, "decision_trace");
    }
    const normalized = Object.fromEntries(["turn", "signal", "read", "move", "why", "effect"]
      .map((key) => [key, clean(item[key])]));
    for (const [key, value] of Object.entries(normalized)) {
      if (!value) throw validationError(`decision_trace 第 ${index + 1} 项缺少 ${key}。`, "decision_trace");
    }
    if (!/^C\d+$/.test(normalized.turn) || !turnIds.has(normalized.turn)) {
      throw validationError(`decision_trace 的 ${normalized.turn || "turn"} 必须指向真实客户回合 Cn。`, "decision_trace");
    }
    return normalized;
  });
}

function sanitizeJsonValue(value, scrub) {
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeJsonValue(item, scrub));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeJsonValue(item, scrub)]));
  }
  return value;
}

export function normalizeGoldenConversation(input = {}) {
  const privateNames = [...(Array.isArray(input.privateNames) ? input.privateNames : []), input.leadName].filter(Boolean);
  const scrub = (value) => sanitizeGoldenPii(value, { names: privateNames });
  const conversationText = scrub(input.conversationText);
  const parsed = parseConversationText(conversationText);
  const outcome = clean(input.outcome);
  const firstReplyType = clean(input.firstReplyType || input.first_reply_type);
  if (!GC_OUTCOMES.includes(outcome)) throw validationError(`outcome 必须是：${GC_OUTCOMES.join(" / ")}。`, "outcome");
  if (!GC_FIRST_REPLY_TYPES.includes(firstReplyType) || firstReplyType === "no_reply") {
    throw validationError("GC 已要求存在 C1，所以 first_reply_type 不能是 no_reply。", "firstReplyType");
  }
  const endingForOutcome = { "Viewing Booked": "已约", Dead: "明确拒绝" };
  if (endingForOutcome[outcome] && parsed.ending !== endingForOutcome[outcome]) {
    throw validationError(`${outcome} 对话必须以 [—] ${endingForOutcome[outcome]} 结束。`, "conversationText");
  }

  const triggerMessage = scrub(input.triggerMessage || input.trigger_message);
  const customerNextMove = scrub(input.customerNextMove || input.customer_next_move);
  if (outcome === "Viewing Booked" && (!triggerMessage || !customerNextMove)) {
    throw validationError("Viewing Booked 必须填写 trigger_message 和 customer_next_move。", "outcome");
  }
  if (outcome === "Viewing Booked" && !parsed.turns.some((turn) => turn.party === "M"
    && turn.content.split("\n").map(clean).includes(triggerMessage))) {
    throw validationError("trigger_message 必须逐字对应 conversation_text 里的一则 M 原句。", "triggerMessage");
  }
  if (outcome !== "Viewing Booked" && (triggerMessage || customerNextMove)) {
    throw validationError("trigger_message / customer_next_move 只允许用于 Viewing Booked。", "outcome");
  }

  const death = calculateDeathTurn(parsed);
  let deathTurn = input.deathTurn ?? input.death_turn ?? null;
  let deathMessageType = clean(input.deathMessageType || input.death_message_type);
  let deathNote = scrub(input.deathNote || input.death_note);
  if (["Dormant", "Dead"].includes(outcome)) {
    deathTurn = deathTurn === null || deathTurn === "" ? death?.number : Number(deathTurn);
    deathMessageType ||= classifyDeathMessage(death?.content);
    if (!deathTurn || !death || death.number !== deathTurn) {
      throw validationError("Dormant / Dead 必须能对应最后一则未获回复的 M 回合。", "deathTurn");
    }
    if (!GC_DEATH_MESSAGE_TYPES.includes(deathMessageType)) {
      throw validationError(`death_message_type 必须是：${GC_DEATH_MESSAGE_TYPES.join(" / ")}。`, "deathMessageType");
    }
    if (outcome === "Dead" && !deathNote) throw validationError("Dead 必须填写 death_note。", "deathNote");
  } else {
    deathTurn = null;
    deathMessageType = "";
    deathNote = "";
  }

  const frictionRemovers = jsonArray(input.frictionRemovers ?? input.friction_removers, "friction_removers");
  const decisionTrace = validateTrace(sanitizeJsonValue(input.decisionTrace ?? input.decision_trace, scrub), parsed);
  const doNotCopy = sanitizeJsonValue(jsonArray(input.doNotCopy ?? input.do_not_copy, "do_not_copy"), scrub);
  const pkConflicts = sanitizeJsonValue(jsonArray(input.pkConflicts ?? input.pk_conflicts, "pk_conflicts"), scrub);
  const allText = [conversationText, triggerMessage, customerNextMove, deathNote, JSON.stringify(decisionTrace), JSON.stringify(doNotCopy), JSON.stringify(pkConflicts)].join("\n");
  const residual = findResidualPii(allText, { names: privateNames });
  if (residual.length) {
    throw validationError(`PII 清洗后仍检测到：${residual.join(", ")}。请先移除再导入。`, "conversationText");
  }

  const createdAt = iso(input.createdAt || input.created_at || new Date());
  const outcomeUpdatedAt = iso(input.outcomeUpdatedAt || input.outcome_updated_at || createdAt);
  const lastCustomerReplyAt = iso(input.lastCustomerReplyAt || input.last_customer_reply_at) || null;
  return {
    leadCode: clean(input.leadCode || input.lead_code),
    projectCode: clean(input.projectCode || input.project_code).toUpperCase(),
    originProjectCode: clean(input.originProjectCode || input.origin_project_code).toUpperCase(),
    sourceChannel: clean(input.sourceChannel || input.source_channel),
    blastVersion: clean(input.blastVersion || input.blast_version || parsed.blastVersion),
    language: clean(input.language).toLowerCase(),
    customerRole: clean(input.customerRole || input.customer_role),
    primaryPurpose: clean(input.primaryPurpose || input.primary_purpose),
    firstReplyType,
    outcome,
    outcomeUpdatedAt,
    deathTurn,
    deathMessageType,
    deathNote,
    triggerMessage,
    customerNextMove,
    frictionRemovers,
    reconfirmed: input.reconfirmed === true || Number(input.reconfirmed) === 1 ? 1 : 0,
    decisionTrace,
    conversationText,
    doNotCopy,
    pkConflicts,
    createdAt,
    lastCustomerReplyAt,
    sourceHash: hash(conversationText),
    parsed,
  };
}

function ledgerSchemaSql() {
  return `
CREATE TABLE IF NOT EXISTS golden_conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_code TEXT NOT NULL UNIQUE,
  project_code TEXT NOT NULL,
  origin_project_code TEXT,
  source_channel TEXT,
  blast_version TEXT,
  language TEXT,
  customer_role TEXT,
  primary_purpose TEXT,
  first_reply_type TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('Viewing Booked','Active','Dormant','Dead')),
  outcome_updated_at TEXT NOT NULL,
  death_turn INTEGER,
  death_message_type TEXT,
  death_note TEXT,
  trigger_message TEXT,
  customer_next_move TEXT,
  friction_removers TEXT NOT NULL DEFAULT '[]',
  reconfirmed INTEGER NOT NULL DEFAULT 0 CHECK (reconfirmed IN (0,1)),
  decision_trace TEXT NOT NULL DEFAULT '[]',
  conversation_text TEXT NOT NULL,
  do_not_copy TEXT NOT NULL DEFAULT '[]',
  pk_conflicts TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  source_hash TEXT NOT NULL UNIQUE,
  last_customer_reply_at TEXT
);
CREATE TABLE IF NOT EXISTS followup_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_code TEXT NOT NULL REFERENCES golden_conversations(lead_code) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  sent_at TEXT NOT NULL,
  silence_gap_days INTEGER NOT NULL,
  followup_type TEXT NOT NULL CHECK (followup_type IN ('ab_slot_template','festival_greeting','new_info','price_update','personalized_question')),
  content_summary TEXT,
  revival INTEGER NOT NULL CHECK (revival IN (0,1)),
  revival_gap_hours INTEGER,
  UNIQUE(lead_code, seq)
);
CREATE INDEX IF NOT EXISTS idx_gc_outcome ON golden_conversations(outcome);
CREATE INDEX IF NOT EXISTS idx_gc_project ON golden_conversations(project_code);
CREATE INDEX IF NOT EXISTS idx_fl_type ON followup_log(followup_type, revival);
`;
}

export function createGoldenConversationLedgerService({
  localDatabase,
  dataDir,
  dormantAfterDays = 30,
  intervalMs = 6 * 60 * 60 * 1000,
} = {}) {
  if (!localDatabase?.databasePath || !localDatabase?.driver) {
    throw new Error("Golden Conversation Ledger requires localDatabase.");
  }
  const databasePath = localDatabase.databasePath;
  const runtimeCachePath = path.join(dataDir || path.dirname(databasePath), "brain", "golden-ledger.json");
  let timer = null;
  let sqliteBinary = "";

  async function ensureDriver() {
    if (sqliteBinary) return sqliteBinary;
    const detected = await localDatabase.driver();
    if (!detected.available) {
      const error = new Error("找不到 sqlite3，无法启动 Golden Conversation Ledger。");
      error.code = "GC_SQLITE_NOT_FOUND";
      throw error;
    }
    sqliteBinary = detected.binary;
    return sqliteBinary;
  }

  async function query(sql) {
    return runSqlite(await ensureDriver(), databasePath, `.timeout 5000\n${sql}`, { json: true });
  }

  async function execute(sql) {
    return runSqlite(await ensureDriver(), databasePath, `.timeout 5000\n${sql}`, { timeoutMs: 60000 });
  }

  async function migrateLegacyIfNeeded() {
    const columns = await query("PRAGMA table_info(golden_conversations);");
    if (!columns.length) {
      await execute(`PRAGMA foreign_keys=ON; BEGIN IMMEDIATE; ${ledgerSchemaSql()} COMMIT;`);
      return { migrated: false, legacyRows: 0 };
    }
    const names = new Set(columns.map((column) => column.name));
    if (names.has("lead_code") && names.has("source_hash")) {
      if (!names.has("last_customer_reply_at")) {
        await execute("ALTER TABLE golden_conversations ADD COLUMN last_customer_reply_at TEXT;");
      }
      await execute(ledgerSchemaSql());
      return { migrated: false, legacyRows: 0 };
    }
    if (!names.has("golden_key")) {
      const error = new Error("golden_conversations 结构未知，已停止升级以保护资料。");
      error.code = "GC_UNKNOWN_SCHEMA";
      throw error;
    }
    const [backup] = await query("SELECT name FROM sqlite_master WHERE type='table' AND name='golden_conversations_legacy_v3';");
    if (backup) {
      const error = new Error("发现 legacy 备份但目前仍是旧表，无法判断上次升级状态；请先人工检查。");
      error.code = "GC_PARTIAL_MIGRATION";
      throw error;
    }
    const [countRow] = await query("SELECT count(*) AS count FROM golden_conversations;");
    const legacyRows = Number(countRow?.count || 0);
    await execute(`
PRAGMA foreign_keys=OFF;
BEGIN IMMEDIATE;
DROP TABLE IF EXISTS followup_log;
ALTER TABLE golden_conversations RENAME TO golden_conversations_legacy_v3;
${ledgerSchemaSql()}
INSERT INTO golden_conversations(
  lead_code, project_code, source_channel, language, customer_role, primary_purpose,
  first_reply_type, outcome, outcome_updated_at, friction_removers, reconfirmed,
  decision_trace, conversation_text, do_not_copy, pk_conflicts, created_at, source_hash
)
SELECT
  printf('LEGACY%04d', rowid), project_code, 'legacy_notion', '', '', 'unknown',
  'perfunctory', 'Active', COALESCE(updated_at, created_at), '[]', 0,
  '[]', conversation_text, '[]', '[]', created_at,
  CASE WHEN trim(COALESCE(conversation_hash,'')) <> ''
    THEN 'legacy:' || conversation_hash
    ELSE 'legacy:' || lower(hex(randomblob(32))) END
FROM golden_conversations_legacy_v3;
INSERT INTO metadata(key, value, updated_at)
VALUES ('gc_legacy_backup_table', 'golden_conversations_legacy_v3', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at;
COMMIT;
PRAGMA foreign_keys=ON;
`);
    return { migrated: true, legacyRows };
  }

  async function nextLeadCode() {
    const [row] = await query(`
SELECT COALESCE(MAX(CAST(substr(lead_code, 2) AS INTEGER)), 0) AS max_code
FROM golden_conversations WHERE lead_code GLOB 'L[0-9]*';
`);
    return `L${String(Number(row?.max_code || 0) + 1).padStart(3, "0")}`;
  }

  async function insertNormalized(item, { allowDuplicate = false } = {}) {
    const leadCode = item.leadCode || await nextLeadCode();
    if (!LEAD_CODE_RE.test(leadCode)) throw validationError("lead_code 格式必须是 L001、L002…", "leadCode");
    if (!item.projectCode) throw validationError("project_code 不能为空。", "projectCode");
    const [existing] = await query(`
SELECT lead_code, source_hash FROM golden_conversations
WHERE lead_code=${sqlText(leadCode)} OR source_hash=${sqlText(item.sourceHash)} LIMIT 1;
`);
    if (existing && !allowDuplicate) {
      throw conflictError(`这段对话已经导入（${existing.lead_code}）。`, { leadCode: existing.lead_code });
    }
    if (existing) return { inserted: false, leadCode: existing.lead_code };
    await execute(`
PRAGMA foreign_keys=ON;
BEGIN IMMEDIATE;
INSERT INTO golden_conversations(
  lead_code, project_code, origin_project_code, source_channel, blast_version, language,
  customer_role, primary_purpose, first_reply_type, outcome, outcome_updated_at,
  death_turn, death_message_type, death_note, trigger_message, customer_next_move,
  friction_removers, reconfirmed, decision_trace, conversation_text, do_not_copy,
  pk_conflicts, created_at, source_hash, last_customer_reply_at
) VALUES (
  ${sqlText(leadCode)}, ${sqlText(item.projectCode)}, ${sqlNullable(item.originProjectCode)},
  ${sqlNullable(item.sourceChannel)}, ${sqlNullable(item.blastVersion)}, ${sqlNullable(item.language)},
  ${sqlNullable(item.customerRole)}, ${sqlNullable(item.primaryPurpose)}, ${sqlNullable(item.firstReplyType)},
  ${sqlText(item.outcome)}, ${sqlText(item.outcomeUpdatedAt)}, ${item.deathTurn ? sqlInteger(item.deathTurn) : "NULL"},
  ${sqlNullable(item.deathMessageType)}, ${sqlNullable(item.deathNote)}, ${sqlNullable(item.triggerMessage)},
  ${sqlNullable(item.customerNextMove)}, ${sqlText(JSON.stringify(item.frictionRemovers))},
  ${sqlInteger(item.reconfirmed)}, ${sqlText(JSON.stringify(item.decisionTrace))},
  ${sqlText(item.conversationText)}, ${sqlText(JSON.stringify(item.doNotCopy))},
  ${sqlText(JSON.stringify(item.pkConflicts))}, ${sqlText(item.createdAt)}, ${sqlText(item.sourceHash)},
  ${sqlNullable(item.lastCustomerReplyAt)}
);
COMMIT;
`);
    await exportRuntimeCache();
    return { inserted: true, leadCode, sourceHash: item.sourceHash };
  }

  async function importConversation(input, options = {}) {
    const normalized = normalizeGoldenConversation(input);
    const result = await insertNormalized(normalized, options);
    return { ...result, preview: summaryOf(normalized) };
  }

  function preview(input) {
    const normalized = normalizeGoldenConversation(input);
    return { normalized, summary: summaryOf(normalized) };
  }

  function summaryOf(item) {
    return {
      leadCode: item.leadCode || "自动分配",
      projectCode: item.projectCode,
      outcome: item.outcome,
      turns: item.parsed.turns.length,
      customerTurns: item.parsed.turns.filter((turn) => turn.party === "C").length,
      ending: item.parsed.ending,
      blastVersion: item.blastVersion,
      deathTurn: item.deathTurn,
      sourceHash: item.sourceHash,
      piiSafe: true,
    };
  }

  async function list({ outcome = "", projectCode = "", limit = 100 } = {}) {
    const filters = [];
    if (outcome) filters.push(`outcome=${sqlText(outcome)}`);
    if (projectCode) filters.push(`project_code=${sqlText(projectCode.toUpperCase())}`);
    const rows = await query(`
SELECT * FROM golden_conversations
${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
ORDER BY datetime(outcome_updated_at) DESC, id DESC LIMIT ${Math.min(Math.max(Number(limit) || 100, 1), 500)};
`);
    return rows.map(decodeRow);
  }

  function decodeRow(row) {
    const decoded = { ...row };
    for (const field of ["friction_removers", "decision_trace", "do_not_copy", "pk_conflicts"]) {
      try { decoded[field] = JSON.parse(decoded[field] || "[]"); } catch { decoded[field] = []; }
    }
    return decoded;
  }

  async function addFollowup(input = {}) {
    const leadCode = clean(input.leadCode || input.lead_code);
    const type = clean(input.followupType || input.followup_type);
    const sentAt = iso(input.sentAt || input.sent_at);
    const gapDays = Number(input.silenceGapDays ?? input.silence_gap_days);
    const revival = input.revival === true || Number(input.revival) === 1 ? 1 : 0;
    const revivalGap = input.revivalGapHours ?? input.revival_gap_hours;
    if (!LEAD_CODE_RE.test(leadCode)) throw validationError("follow-up 必须指定有效 lead_code。", "leadCode");
    if (!GC_FOLLOWUP_TYPES.includes(type)) throw validationError(`followup_type 必须是：${GC_FOLLOWUP_TYPES.join(" / ")}。`, "followupType");
    if (!sentAt || !Number.isInteger(gapDays) || gapDays < 0) throw validationError("sent_at 和非负整数 silence_gap_days 必填。", "sentAt");
    if (revival && (!Number.isFinite(Number(revivalGap)) || Number(revivalGap) < 0)) {
      throw validationError("revival=1 时必须填写 revival_gap_hours。", "revivalGapHours");
    }
    const [exists] = await query(`SELECT lead_code FROM golden_conversations WHERE lead_code=${sqlText(leadCode)};`);
    if (!exists) throw validationError(`找不到 ${leadCode}。`, "leadCode");
    const [seqRow] = await query(`SELECT COALESCE(MAX(seq),0)+1 AS seq FROM followup_log WHERE lead_code=${sqlText(leadCode)};`);
    const seq = Number(input.seq || seqRow?.seq || 1);
    const summary = sanitizeGoldenPii(input.contentSummary || input.content_summary, { names: input.privateNames || [] });
    await execute(`
INSERT INTO followup_log(lead_code, seq, sent_at, silence_gap_days, followup_type, content_summary, revival, revival_gap_hours)
VALUES (${sqlText(leadCode)}, ${sqlInteger(seq)}, ${sqlText(sentAt)}, ${sqlInteger(gapDays)}, ${sqlText(type)},
${sqlNullable(summary)}, ${sqlInteger(revival)}, ${revival ? sqlInteger(revivalGap) : "NULL"});
`);
    return { inserted: true, leadCode, seq };
  }

  async function reports() {
    const [deathPoints, blastQuality, followupEffectiveness, silenceGap] = await Promise.all([
      query(`SELECT death_message_type, COUNT(*) AS n FROM golden_conversations WHERE outcome IN ('Dormant','Dead') GROUP BY death_message_type ORDER BY n DESC;`),
      query(`SELECT blast_version, SUM(first_reply_type='specific_question') AS good, COUNT(*) AS total, ROUND(1.0*SUM(first_reply_type='specific_question')/NULLIF(COUNT(*),0),2) AS rate FROM golden_conversations GROUP BY blast_version ORDER BY rate DESC;`),
      query(`SELECT followup_type, COUNT(*) AS sent, SUM(revival) AS revived, ROUND(1.0*SUM(revival)/NULLIF(COUNT(*),0),2) AS revival_rate FROM followup_log GROUP BY followup_type ORDER BY revival_rate DESC;`),
      query(`SELECT CASE WHEN silence_gap_days<=3 THEN '0-3d' WHEN silence_gap_days<=7 THEN '4-7d' WHEN silence_gap_days<=30 THEN '8-30d' ELSE '30d+' END AS gap_bucket, ROUND(1.0*SUM(revival)/NULLIF(COUNT(*),0),2) AS revival_rate, COUNT(*) AS n FROM followup_log GROUP BY gap_bucket ORDER BY MIN(silence_gap_days);`),
    ]);
    return { deathPoints, blastQuality, followupEffectiveness, silenceGap };
  }

  async function markDormant({ now = new Date() } = {}) {
    const nowIso = iso(now);
    const candidates = await query(`
SELECT lead_code, conversation_text, last_customer_reply_at
FROM golden_conversations
WHERE outcome='Active'
  AND last_customer_reply_at IS NOT NULL
  AND datetime(last_customer_reply_at) <= datetime(${sqlText(nowIso)}, '-${sqlInteger(dormantAfterDays)} days');
`);
    const transitioned = [];
    const skipped = [];
    for (const row of candidates) {
      try {
        const parsed = parseConversationText(row.conversation_text);
        const death = calculateDeathTurn(parsed);
        if (!death) {
          skipped.push({ leadCode: row.lead_code, reason: "没有未获回复的最终 M 回合" });
          continue;
        }
        await execute(`
UPDATE golden_conversations SET
  outcome='Dormant', outcome_updated_at=${sqlText(nowIso)}, death_turn=${sqlInteger(death.number)},
  death_message_type=${sqlText(classifyDeathMessage(death.content))},
  death_note=${sqlText(`超过 ${dormantAfterDays} 天无客户回复；仍保留在跟进名单。`)}
WHERE lead_code=${sqlText(row.lead_code)} AND outcome='Active';
`);
        transitioned.push(row.lead_code);
      } catch (error) {
        skipped.push({ leadCode: row.lead_code, reason: error.message });
      }
    }
    if (transitioned.length) await exportRuntimeCache();
    return { checked: candidates.length, transitioned, skipped, deadTransitions: 0 };
  }

  async function exportRuntimeCache() {
    const rows = await query(`
SELECT lead_code, project_code, origin_project_code, source_channel, blast_version, language,
customer_role, primary_purpose, first_reply_type, outcome, trigger_message, customer_next_move,
friction_removers, reconfirmed, decision_trace, do_not_copy, pk_conflicts, outcome_updated_at
FROM golden_conversations WHERE outcome='Viewing Booked' ORDER BY datetime(outcome_updated_at) DESC;
`);
    const records = rows.map(decodeRow).map((row) => ({
      ...row,
      runtime_note: "只检索 signal/read/move；对话里的价格、库存、距离均为历史快照，不是 Project Knowledge。",
    }));
    await fs.mkdir(path.dirname(runtimeCachePath), { recursive: true });
    await fs.writeFile(runtimeCachePath, `${JSON.stringify({ generatedAt: iso(), records }, null, 2)}\n`, "utf8");
    return { path: runtimeCachePath, count: records.length };
  }

  async function seedL001() {
    const input = {
      leadCode: "L001",
      projectCode: "ENLACE",
      sourceChannel: "xhs",
      language: "en",
      customerRole: "self",
      primaryPurpose: "investment",
      firstReplyType: "specific_question",
      outcome: "Viewing Booked",
      triggerMessage: "Now studio still got 2 last forest view unit / maybe you can come see see first",
      customerNextMove: "主动问 which floor → 主动问 this sunday around 12/1pm",
      frictionRemovers: ["nett_price_calc", "monthly_diff_calc", "waze_link", "carpark_reserved", "virtual_tour"],
      reconfirmed: 1,
      conversationText: `[M1]
Hi {{NAME}}, thanks for asking about Enlace. Are you looking for own stay or investment?

[C1] +8m
Just started my market research, looking for investment purpose.

[M2] +5m
For investment I would compare the lower-entry Suite 1 options first, then verify rental evidence and holding cost on the same basis.

[C2] +4m
Can I reply in English?

[M3] +1m
Of course. English is easier and faster for me too, so please use whichever is comfortable.

[C3] +12m
What is the PSF and transacted rental? Is the public transport already operating now?

[M4] +10m
I will separate current official data, verified transactions, asking rent and future transport plans, so projections are not presented as facts.

[C4] +18m
I am comparing 474sf or 560sf.

[M5] +7m
I will compare both on latest nett price, layout, maintenance, vacancy assumption and verified or comparable rent. The 560sf historical unit status must be rechecked before quoting.

[C5] +9m
What is the price difference between Enlace 1 and 2?

[M6] +8m
Suite 1 historically had a lower entry direction, but I will use the latest official price list before giving you the difference.

[C6] +3m
Oh woah.

[M7] +2m
Now studio still got 2 last forest view unit / maybe you can come see see first

[C7] +5m
Which floor? This Sunday any availability around 12/1pm?

[M8] +4m
I will prepare the two nett-price and monthly-difference calculations, send Waze and reserve a carpark. The actual availability will be verified before the visit.

[C8] +3m
Okay, I will send the car details privately for this visit.

[M9] +15m
Thank you. The private car details are for parking only and will not be kept in the learning record.

[C9] +1d
Sorry ya I might have to reschedule.

[M10] +2m
No worries. Is next Wednesday 2pm comfortable instead?

[C10] +6m
Wednesday 2pm is okay.

[M11] +6d
Reconfirming our Wednesday 2pm viewing. I will resend the Waze and parking entrance before you come.

[C11] +9m
Confirmed.

[—] 已约`,
      decisionTrace: [
        { turn: "C1", signal: "「Just started my market research, looking for investment purpose」", read: "自报investment + 自报还在早期 = 不会马上买，但会认真比较。这种人给宣传没用，要给可比数据", move: "立刻转方向：推 Suite 1 而不是 Suite 2，理由是入场低", why: "投资客第一关卡在入场成本，不是 lifestyle。这时候讲森林讲生活会被判定为不专业", effect: "客户接着问 PSF 和 transacted rental —— 进入数据比较模式" },
        { turn: "C2", signal: "「我用英文回复可以吗」", read: "语言摩擦会降低她提问的意愿", move: "立刻切英文，并解释自己英文打字更快", why: "让她觉得换语言是帮我，不是她麻烦我", effect: "后续提问密度明显上升" },
        { turn: "C4", signal: "「474sf or 560sf」——自己缩小到两个户型", read: "从比较项目进到比较单位。这是可以推进约看的信号，不用再教育", move: "讲 560 只剩最后 1 间 pending loan + 一层只有 1 间", why: "她已经选定范围，这时候稀缺性才有杀伤力；太早讲会像话术", effect: "客户没有被吓跑，继续问 Enlace 1 vs 2 价差" },
        { turn: "C6", signal: "「Oh woah」（听到价差后）", read: "情绪出现 = 她开始把这件事当真，可以下邀请了", move: "补一句「studio 还有 2 间 last forest view」+「maybe you can come see see first」", why: "用 maybe / see see 降低承诺感。这时候用 A/B 硬时段会显得在推销", effect: "★ 客户自己开口：「This sunday any availability around 12/1pm?」" },
        { turn: "C7", signal: "客户自己提出时段，并问 which floor / nett price", read: "已经在心里安排行程了。现在要做的不是继续说服，是把障碍全部清掉", move: "算两个楼层的 nett 价差与月供差、发 Waze、主动要车牌代订车位", why: "她 11:30 在 Kepong 有另一个 appointment，路程和停车是真实阻力", effect: "客户给了车牌 —— 等于心理上已经确认要来" },
        { turn: "C9", signal: "「Sorry ya I might have to reschedule」", read: "改期不是拒绝。压时间会把已经建立的东西全毁掉", move: "「no worries」+ 立刻给新日期选项", why: "保住关系比保住那个时段重要", effect: "重新约成周三 2pm；前一晚再 reconfirm 时间与车牌" },
      ],
      doNotCopy: [
        { quote: "due to loan reject HAHA", reason: "拿其他买家的贷款结果开玩笑" },
      ],
      pkConflicts: [
        { claim: "psf RM950+ / 各户型预估租金", pk_status: "unverified", action: "以 PK 最新价单为准" },
      ],
      createdAt: "2026-07-18T00:00:00.000Z",
    };
    try {
      return await importConversation(input, { allowDuplicate: true });
    } catch (error) {
      if (error.code === "GC_DUPLICATE") return { inserted: false, leadCode: "L001" };
      throw error;
    }
  }

  async function status() {
    const [counts, meta] = await Promise.all([
      query(`SELECT outcome, COUNT(*) AS count FROM golden_conversations GROUP BY outcome ORDER BY outcome;`),
      query(`SELECT key, value, updated_at FROM metadata WHERE key IN ('gc_schema_version','gc_legacy_backup_table');`),
    ]);
    return { schemaVersion: LEDGER_SCHEMA_VERSION, databasePath, runtimeCachePath, counts, metadata: meta };
  }

  async function initialize() {
    await localDatabase.initialize();
    const migration = await migrateLegacyIfNeeded();
    const now = iso();
    await execute(`
INSERT INTO metadata(key, value, updated_at) VALUES ('gc_schema_version', '${LEDGER_SCHEMA_VERSION}', ${sqlText(now)})
ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at;
`);
    const seed = await seedL001();
    const dormant = await markDormant();
    const cache = await exportRuntimeCache();
    return { migration, seed, dormant, cache, ...(await status()) };
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => markDormant().catch((error) => console.error(`[golden-ledger] dormant check failed: ${error.message}`)), intervalMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    databasePath,
    runtimeCachePath,
    initialize,
    preview,
    importConversation,
    list,
    addFollowup,
    reports,
    markDormant,
    exportRuntimeCache,
    status,
    start,
    stop,
    seedL001,
  };
}
