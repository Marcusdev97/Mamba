import fs from "node:fs/promises";
import path from "node:path";

const LEVELS = new Set(["info", "warn", "error"]);
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

function todayKey(date = new Date()) {
  return date.toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" });
}

function cleanText(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function safeJson(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/token|apikey|api_key|authorization|password|secret/i.test(key)) {
      out[key] = "[redacted]";
    } else {
      out[key] = redact(item);
    }
  }
  return out;
}

function parseLine(line) {
  try {
    const entry = JSON.parse(line);
    return entry && typeof entry === "object" ? entry : null;
  } catch {
    return null;
  }
}

export function createSystemLogService({ rootDir, clock = () => new Date() }) {
  const logDir = path.join(rootDir, "campaign-data", "system-logs");

  async function write({ level = "info", area = "system", event = "event", message = "", context = {} } = {}) {
    const at = clock();
    const cleanLevel = LEVELS.has(String(level).toLowerCase()) ? String(level).toLowerCase() : "info";
    const entry = {
      at: at.toISOString(),
      level: cleanLevel,
      area: cleanText(area, "system").slice(0, 80),
      event: cleanText(event, "event").slice(0, 120),
      message: cleanText(message, "").slice(0, 2000),
      context: redact(safeJson(context)),
    };

    await fs.mkdir(logDir, { recursive: true });
    await fs.appendFile(path.join(logDir, `${todayKey(at)}.jsonl`), `${JSON.stringify(entry)}\n`);
    return entry;
  }

  async function list({ limit = DEFAULT_LIMIT, level = "", area = "", q = "", date = "" } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const files = (await fs.readdir(logDir).catch(() => []))
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
      .filter((name) => !date || name === `${date}.jsonl`)
      .sort()
      .reverse();

    const entries = [];
    const levelFilter = String(level || "").toLowerCase();
    const areaFilter = String(area || "").toLowerCase();
    const query = String(q || "").toLowerCase();

    for (const file of files) {
      const text = await fs.readFile(path.join(logDir, file), "utf8").catch(() => "");
      const lines = text.split(/\r?\n/).filter(Boolean).reverse();
      for (const line of lines) {
        const entry = parseLine(line);
        if (!entry) continue;
        if (levelFilter && String(entry.level || "").toLowerCase() !== levelFilter) continue;
        if (areaFilter && String(entry.area || "").toLowerCase() !== areaFilter) continue;
        if (query) {
          const haystack = `${entry.area || ""} ${entry.event || ""} ${entry.message || ""} ${JSON.stringify(entry.context || {})}`.toLowerCase();
          if (!haystack.includes(query)) continue;
        }
        entries.push(entry);
        if (entries.length >= safeLimit) return entries;
      }
    }
    return entries;
  }

  return {
    logDir,
    write,
    list,
    info: (event, message, context) => write({ level: "info", event, message, context }),
    warn: (event, message, context) => write({ level: "warn", event, message, context }),
    error: (event, message, context) => write({ level: "error", event, message, context }),
  };
}
