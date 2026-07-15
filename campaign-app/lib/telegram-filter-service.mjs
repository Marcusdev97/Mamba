import fs from "node:fs/promises";
import path from "node:path";
import { normalizePhone } from "../suppression.mjs";

const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  autoFilterConnectedSenders: true,
  entries: [],
  updatedAt: null,
});

function cleanName(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
}

export function parseTelegramFilterEntries(value) {
  const lines = Array.isArray(value) ? value : String(value ?? "").split(/\r?\n/);
  const seen = new Set();
  const entries = [];

  for (const raw of lines) {
    if (raw && typeof raw === "object") {
      const phone = normalizePhone(raw.phone);
      if (!phone || seen.has(phone)) continue;
      seen.add(phone);
      entries.push({ name: cleanName(raw.name), phone });
      continue;
    }

    const line = String(raw ?? "").trim();
    if (!line || line.startsWith("#")) continue;
    const phoneMatch = line.match(/\+?\d[\d\s().-]{6,}\d/);
    const phone = normalizePhone(phoneMatch?.[0] ?? line);
    if (!phone || seen.has(phone)) continue;
    seen.add(phone);
    const name = cleanName(phoneMatch ? line.replace(phoneMatch[0], "").replace(/^[,;|\s-]+|[,;|\s-]+$/g, "") : "");
    entries.push({ name, phone });
  }

  return entries;
}

export function formatTelegramFilterEntries(entries) {
  return parseTelegramFilterEntries(entries)
    .map((entry) => entry.name ? `${entry.name}, ${entry.phone}` : entry.phone)
    .join("\n");
}

export function createTelegramFilterService({
  rootDir,
  getConnectedPhones = async () => [],
  connectedCacheMs = 30_000,
} = {}) {
  if (!rootDir) throw new Error("Telegram Filter service 缺少 rootDir。");
  const filePath = path.join(rootDir, "campaign-data", "telegram_filter_list.json");
  let connectedCache = { at: 0, phones: [] };

  async function load() {
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
      return {
        ...DEFAULT_CONFIG,
        ...parsed,
        autoFilterConnectedSenders: parsed.autoFilterConnectedSenders !== false,
        entries: parseTelegramFilterEntries(parsed.entries),
      };
    } catch (error) {
      if (error.code !== "ENOENT") console.log(`[telegram-filter] read failed: ${error.message}`);
      return { ...DEFAULT_CONFIG, entries: [] };
    }
  }

  async function connectedPhones({ force = false } = {}) {
    if (!force && Date.now() - connectedCache.at < connectedCacheMs) return connectedCache.phones;
    try {
      const values = await getConnectedPhones();
      connectedCache = {
        at: Date.now(),
        phones: [...new Set((values ?? []).map((item) => normalizePhone(item?.number ?? item)).filter(Boolean))],
      };
    } catch (error) {
      console.log(`[telegram-filter] connected phone check failed: ${error.message}`);
      connectedCache = { at: Date.now(), phones: [] };
    }
    return connectedCache.phones;
  }

  async function snapshot({ forceConnected = false } = {}) {
    const config = await load();
    const automaticPhones = config.autoFilterConnectedSenders
      ? await connectedPhones({ force: forceConnected })
      : [];
    return {
      ...config,
      text: formatTelegramFilterEntries(config.entries),
      count: config.entries.length,
      connectedPhones: automaticPhones,
    };
  }

  async function update({ text, entries, autoFilterConnectedSenders = true } = {}) {
    const next = {
      version: 1,
      autoFilterConnectedSenders: autoFilterConnectedSenders !== false,
      entries: parseTelegramFilterEntries(entries ?? text),
      updatedAt: new Date().toISOString(),
    };
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await fs.rename(tempPath, filePath);
    return snapshot({ forceConnected: true });
  }

  async function match(value) {
    const phone = normalizePhone(value);
    if (!phone) return { filtered: false, phone: null, reason: null };
    const config = await load();
    const explicit = config.entries.find((entry) => entry.phone === phone);
    if (explicit) {
      return { filtered: true, phone, reason: "filter-list", name: explicit.name || null };
    }
    if (config.autoFilterConnectedSenders) {
      const automaticPhones = await connectedPhones();
      if (automaticPhones.includes(phone)) {
        return { filtered: true, phone, reason: "connected-sender", name: null };
      }
    }
    return { filtered: false, phone, reason: null, name: null };
  }

  return { filePath, load, snapshot, update, match };
}
