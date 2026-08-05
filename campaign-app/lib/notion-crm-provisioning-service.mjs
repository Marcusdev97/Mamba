import fs from "node:fs/promises";
import path from "node:path";
import {
  NOTION_CRM_DATABASES,
  NOTION_CRM_SCHEMA_VERSION,
  NOTION_CRM_VIEWS,
  crmFieldOwnership,
} from "../domain/notion-crm-schema.mjs";

function cleanId(value) {
  return String(value ?? "").replace(/[^a-fA-F0-9]/g, "");
}

function databaseTitle(database) {
  return (database?.title || []).map((item) => item?.plain_text || item?.text?.content || "").join("").trim();
}

function propertyPayload(config, databaseIds = {}) {
  switch (config.type) {
    case "title": return { title: {} };
    case "rich_text": return { rich_text: {} };
    case "phone_number": return { phone_number: {} };
    case "date": return { date: {} };
    case "number": return { number: { format: "number" } };
    case "checkbox": return { checkbox: {} };
    case "last_edited_time": return { last_edited_time: {} };
    case "select": return { select: { options: (config.options || []).map((name) => ({ name })) } };
    case "multi_select": return { multi_select: { options: (config.options || []).map((name) => ({ name })) } };
    case "relation": {
      const targetId = cleanId(databaseIds[config.database]);
      return targetId ? { relation: { database_id: targetId, single_property: {} } } : null;
    }
    default: throw new Error(`不支持的 Notion CRM property type: ${config.type}`);
  }
}

function createProperties(definition, databaseIds = {}, { includeRelations = true } = {}) {
  return Object.fromEntries(Object.entries(definition.properties).flatMap(([name, config]) => {
    if (!includeRelations && config.type === "relation") return [];
    const payload = propertyPayload(config, databaseIds);
    return payload ? [[name, payload]] : [];
  }));
}

function relationTarget(property) {
  return cleanId(property?.relation?.database_id);
}

function compareDatabase(logicalKey, definition, database, databaseIds = {}) {
  if (!database) {
    return {
      logicalKey,
      title: definition.title,
      action: "CREATE",
      missingProperties: Object.keys(definition.properties),
      conflicts: [],
      relationWaits: Object.values(definition.properties).filter((item) => item.type === "relation").length,
    };
  }
  const schema = database.properties || {};
  const missingProperties = [];
  const conflicts = [];
  let relationWaits = 0;
  for (const [name, expected] of Object.entries(definition.properties)) {
    const actual = schema[name];
    if (!actual) {
      if (expected.type === "relation" && !cleanId(databaseIds[expected.database])) relationWaits += 1;
      else missingProperties.push(name);
      continue;
    }
    if (actual.type !== expected.type) {
      conflicts.push({ property: name, expectedType: expected.type, actualType: actual.type });
      continue;
    }
    if (expected.type === "relation") {
      const targetId = cleanId(databaseIds[expected.database]);
      if (!targetId) relationWaits += 1;
      else if (relationTarget(actual) !== targetId) {
        conflicts.push({ property: name, expectedRelation: expected.database, actualType: "relation_to_other_database" });
      }
    }
  }
  return {
    logicalKey,
    title: definition.title,
    action: conflicts.length ? "CONFLICT" : missingProperties.length || relationWaits ? "UPDATE" : "READY",
    missingProperties,
    conflicts,
    relationWaits,
  };
}

async function atomicWriteJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

export function createNotionCrmProvisioningService({
  notion,
  configPath,
  readConfig = async () => JSON.parse(await fs.readFile(configPath, "utf8")),
  writeConfig = atomicWriteJson,
} = {}) {
  if (typeof notion !== "function") throw new Error("Notion CRM provisioner 需要 notion adapter。");

  async function searchAccessibleDatabases() {
    const response = await notion("POST", "/search", {
      query: "Mamba CRM |",
      filter: { property: "object", value: "database" },
      page_size: 100,
    });
    return response?.results || [];
  }

  async function inspect() {
    const config = await readConfig().catch(() => ({}));
    const configuredIds = config?.crm?.databases || {};
    const searchResults = await searchAccessibleDatabases();
    const byTitle = new Map(searchResults.map((database) => [databaseTitle(database), database]));
    const databaseIds = {};
    const databases = {};
    for (const [logicalKey, definition] of Object.entries(NOTION_CRM_DATABASES)) {
      const configuredId = cleanId(configuredIds[logicalKey]);
      let database = null;
      if (configuredId) {
        try { database = await notion("GET", `/databases/${configuredId}`); } catch { /* exact-title discovery below is idempotent */ }
      }
      database ||= byTitle.get(definition.title) || null;
      if (database?.id) databaseIds[logicalKey] = cleanId(database.id);
      databases[logicalKey] = database;
    }
    const plan = Object.entries(NOTION_CRM_DATABASES).map(([logicalKey, definition]) =>
      compareDatabase(logicalKey, definition, databases[logicalKey], databaseIds));
    return {
      schemaVersion: NOTION_CRM_SCHEMA_VERSION,
      parentConfigured: Boolean(cleanId(config?.crm?.parentPageId)),
      plan,
      summary: {
        ready: plan.filter((item) => item.action === "READY").length,
        create: plan.filter((item) => item.action === "CREATE").length,
        update: plan.filter((item) => item.action === "UPDATE").length,
        conflict: plan.filter((item) => item.action === "CONFLICT").length,
      },
      manualViews: NOTION_CRM_VIEWS,
      fieldOwnership: crmFieldOwnership(),
      _internal: { config, databaseIds, databases },
    };
  }

  function publicReport(report, mode = "dry-run") {
    const { _internal, ...safe } = report;
    return { mode, ...safe };
  }

  async function dryRun() {
    return publicReport(await inspect());
  }

  async function apply({ parentPageId = "", confirmation = "" } = {}) {
    if (confirmation !== "CREATE_NOTION_CRM_V1") {
      const error = new Error("Apply 需要明确 confirmation=CREATE_NOTION_CRM_V1。");
      error.code = "NOTION_CRM_APPLY_CONFIRMATION_REQUIRED";
      throw error;
    }
    const before = await inspect();
    if (before.summary.conflict) {
      const error = new Error("现有 Notion CRM schema 有 property type/relation 冲突；不会静默覆盖。");
      error.code = "NOTION_CRM_SCHEMA_CONFLICT";
      error.report = publicReport(before);
      throw error;
    }
    const config = before._internal.config;
    const parent = cleanId(parentPageId || config?.crm?.parentPageId);
    if (!parent) {
      const error = new Error("缺少已分享给 Mamba integration 的 CRM Hub parent page ID。");
      error.code = "NOTION_CRM_PARENT_PAGE_REQUIRED";
      throw error;
    }
    const databaseIds = { ...before._internal.databaseIds };
    for (const [logicalKey, definition] of Object.entries(NOTION_CRM_DATABASES)) {
      if (databaseIds[logicalKey]) continue;
      const created = await notion("POST", "/databases", {
        parent: { type: "page_id", page_id: parent },
        title: [{ type: "text", text: { content: definition.title } }],
        properties: createProperties(definition, databaseIds, { includeRelations: false }),
      });
      databaseIds[logicalKey] = cleanId(created?.id);
      if (!databaseIds[logicalKey]) throw new Error(`Notion 没有返回 ${definition.title} database id。`);
    }

    for (const [logicalKey, definition] of Object.entries(NOTION_CRM_DATABASES)) {
      const database = await notion("GET", `/databases/${databaseIds[logicalKey]}`);
      const comparison = compareDatabase(logicalKey, definition, database, databaseIds);
      if (comparison.conflicts.length) {
        const error = new Error(`${definition.title} 有 schema 冲突；停止 apply。`);
        error.code = "NOTION_CRM_SCHEMA_CONFLICT";
        error.conflicts = comparison.conflicts;
        throw error;
      }
      const missing = Object.fromEntries(comparison.missingProperties.map((name) => [
        name,
        propertyPayload(definition.properties[name], databaseIds),
      ]).filter(([, value]) => value));
      if (Object.keys(missing).length) {
        await notion("PATCH", `/databases/${databaseIds[logicalKey]}`, { properties: missing });
      }
    }

    const nextConfig = {
      ...config,
      crm: {
        ...(config.crm || {}),
        schemaVersion: NOTION_CRM_SCHEMA_VERSION,
        parentPageId: parent,
        databases: databaseIds,
        viewsRequireManualSetup: config?.crm?.viewsRequireManualSetup !== false,
      },
    };
    await writeConfig(configPath, nextConfig);
    const after = await inspect();
    if (after.summary.create || after.summary.update || after.summary.conflict) {
      const error = new Error("Notion CRM apply 后 verification 未通过；配置已保留供诊断，不会重复建立同名 database。");
      error.code = "NOTION_CRM_VERIFICATION_FAILED";
      error.report = publicReport(after, "apply");
      throw error;
    }
    return publicReport(after, "apply");
  }

  return { dryRun, apply };
}
