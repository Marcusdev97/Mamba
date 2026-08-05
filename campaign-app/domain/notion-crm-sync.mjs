import crypto from "node:crypto";
import { NOTION_CRM_DATABASES, NOTION_CRM_PRIVACY_DENYLIST } from "./notion-crm-schema.mjs";

function clean(value) {
  return String(value ?? "").trim();
}

function timestamp(value) {
  const result = new Date(value || 0).getTime();
  return Number.isFinite(result) ? result : 0;
}

export function stableCrmId(prefix, source, { length = 12 } = {}) {
  const value = clean(source);
  if (!value) throw new Error(`${prefix} stable ID 缺少 source key。`);
  const digest = crypto.createHash("sha256").update(value).digest("hex").slice(0, length).toUpperCase();
  return `${clean(prefix).toUpperCase()}-${digest}`;
}

export function approvedHumanFields(database, values = {}) {
  const definition = NOTION_CRM_DATABASES[database];
  if (!definition) throw new Error(`未知 Notion CRM database: ${database}`);
  const denied = new Set(NOTION_CRM_PRIVACY_DENYLIST.map((item) => item.toLowerCase()));
  return Object.fromEntries(Object.entries(values).filter(([name]) => {
    const normalized = name.toLowerCase().replaceAll(" ", "_");
    return definition.properties[name]?.ownership === "human" && !denied.has(normalized);
  }));
}

export function detectCrmConflict({
  lastSyncedAt,
  sqliteUpdatedAt,
  notionUpdatedAt,
  sqliteValues = {},
  notionValues = {},
} = {}) {
  const lastSync = timestamp(lastSyncedAt);
  const sqliteChanged = timestamp(sqliteUpdatedAt) > lastSync;
  const notionChanged = timestamp(notionUpdatedAt) > lastSync;
  const differentFields = Object.keys({ ...sqliteValues, ...notionValues })
    .filter((field) => JSON.stringify(sqliteValues[field] ?? null) !== JSON.stringify(notionValues[field] ?? null));
  return {
    sqliteChanged,
    notionChanged,
    differentFields,
    conflict: sqliteChanged && notionChanged && differentFields.length > 0,
    resolution: sqliteChanged && notionChanged && differentFields.length
      ? "MANUAL"
      : notionChanged && differentFields.length
        ? "IMPORT_NOTION"
        : sqliteChanged && differentFields.length
          ? "EXPORT_SQLITE"
          : "NO_CHANGE",
  };
}
