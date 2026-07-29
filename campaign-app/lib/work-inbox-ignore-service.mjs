import fs from "node:fs/promises";
import path from "node:path";
import { normalizePhone } from "../suppression.mjs";
import { formatNamedPhoneEntries, parseNamedPhoneEntries } from "./named-phone-list.mjs";

const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  entries: [],
  updatedAt: null,
});

export function createWorkInboxIgnoreService({ rootDir } = {}) {
  if (!rootDir) throw new Error("Work Inbox Ignore service 缺少 rootDir。");
  const filePath = path.join(rootDir, "campaign-data", "work_inbox_ignore.json");

  async function load() {
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
      return {
        ...DEFAULT_CONFIG,
        ...parsed,
        entries: parseNamedPhoneEntries(parsed.entries),
      };
    } catch (error) {
      if (error.code !== "ENOENT") console.log(`[work-inbox-ignore] read failed: ${error.message}`);
      return { ...DEFAULT_CONFIG, entries: [] };
    }
  }

  async function snapshot() {
    const config = await load();
    return {
      ...config,
      text: formatNamedPhoneEntries(config.entries),
      count: config.entries.length,
    };
  }

  async function update({ text, entries } = {}) {
    const next = {
      version: 1,
      entries: parseNamedPhoneEntries(entries ?? text),
      updatedAt: new Date().toISOString(),
    };
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await fs.rename(tempPath, filePath);
    return snapshot();
  }

  async function match(value) {
    const phone = normalizePhone(value);
    if (!phone) return { ignored: false, phone: null, name: null };
    const config = await load();
    const entry = config.entries.find((item) => item.phone === phone);
    return {
      ignored: Boolean(entry),
      phone,
      name: entry?.name || null,
    };
  }

  return { filePath, load, snapshot, update, match };
}
