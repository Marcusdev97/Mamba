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

function sameValue(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

export function mergeNotionHumanFields({
  database,
  baseValues = {},
  sqliteValues = {},
  notionValues = {},
} = {}) {
  const approvedNotion = approvedHumanFields(database, notionValues);
  const approvedSqlite = approvedHumanFields(database, sqliteValues);
  const approvedBase = approvedHumanFields(database, baseValues);
  const applyFromNotion = {};
  const conflicts = [];
  const unchanged = [];

  for (const field of Object.keys(approvedNotion)) {
    const baseValue = approvedBase[field] ?? null;
    const sqliteValue = approvedSqlite[field] ?? null;
    const notionValue = approvedNotion[field] ?? null;
    const sqliteChanged = !sameValue(sqliteValue, baseValue);
    const notionChanged = !sameValue(notionValue, baseValue);
    if (sqliteChanged && notionChanged && !sameValue(sqliteValue, notionValue)) {
      conflicts.push({ field, baseValue, sqliteValue, notionValue });
    } else if (notionChanged && !sameValue(sqliteValue, notionValue)) {
      applyFromNotion[field] = notionValue;
    } else {
      unchanged.push(field);
    }
  }
  return { applyFromNotion, conflicts, unchanged };
}

export function assertReducedSyncPayload(payload = {}) {
  const denied = new Set(NOTION_CRM_PRIVACY_DENYLIST.map((item) => item.toLowerCase()));
  const forbidden = [];
  const visit = (value, path = []) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      const normalized = key.toLowerCase().replaceAll(" ", "_");
      if (denied.has(normalized) || /^(raw_message|raw_conversation|full_transcript|messages)$/i.test(normalized)) {
        forbidden.push([...path, key].join("."));
      } else {
        visit(child, [...path, key]);
      }
    }
  };
  visit(payload);
  if (forbidden.length) {
    const error = new Error(`Notion sync payload 包含只应保留在 SQLite 的字段：${forbidden.join(", ")}`);
    error.code = "NOTION_SYNC_PAYLOAD_NOT_REDUCED";
    error.retryable = false;
    throw error;
  }
  return payload;
}
