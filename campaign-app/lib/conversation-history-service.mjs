import fs from "node:fs/promises";
import path from "node:path";

function normalizePhone(value) {
  return String(value ?? "").replace(/\D/g, "");
}

function stableKey(entry) {
  return String(entry.messageId || `${entry.at || ""}:${entry.instanceName || ""}:${entry.text || ""}`).slice(0, 500);
}

export function createConversationHistoryService({ rootDir }) {
  const historyDir = path.join(rootDir, "campaign-data", "conversations");

  function filePath(phone) {
    const clean = normalizePhone(phone);
    if (!clean) throw new Error("Invalid phone for conversation history.");
    return path.join(historyDir, `${clean}.jsonl`);
  }

  async function read(phone, { limit = 100 } = {}) {
    const clean = normalizePhone(phone);
    if (!clean) return [];
    try {
      const raw = await fs.readFile(filePath(clean), "utf8");
      const entries = raw.split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          try { return JSON.parse(line); } catch { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
      return entries.slice(0, Math.max(1, Math.min(Number(limit) || 100, 500)));
    } catch {
      return [];
    }
  }

  async function append(phone, entry) {
    const clean = normalizePhone(phone);
    if (!clean) return { added: false, reason: "invalid_phone" };
    const eventKey = stableKey(entry);
    const existing = await read(clean, { limit: 500 });
    if (existing.some((item) => item.eventKey === eventKey)) {
      return { added: false, reason: "duplicate" };
    }

    const payload = {
      eventKey,
      savedAt: new Date().toISOString(),
      phone: clean,
      direction: "inbound",
      ...entry,
    };
    await fs.mkdir(historyDir, { recursive: true });
    await fs.appendFile(filePath(clean), `${JSON.stringify(payload)}\n`);
    return { added: true, entry: payload };
  }

  async function appendMany(events) {
    let added = 0;
    let skipped = 0;
    for (const event of Array.isArray(events) ? events : []) {
      const result = await append(event.phone, event);
      if (result.added) added += 1;
      else skipped += 1;
    }
    return { added, skipped };
  }

  return {
    read,
    append,
    appendMany,
  };
}
