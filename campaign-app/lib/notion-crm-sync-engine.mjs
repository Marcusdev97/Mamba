import { mergeNotionHumanFields } from "../domain/notion-crm-sync.mjs";
import { decideStageTransition, normalizeSalesStage } from "../domain/sales-pipeline.mjs";
import { customerHumanValuesFromPage, customerProperties } from "./notion-crm-sync-service.mjs";
import { projectLeadHumanValuesFromPage, projectLeadProperties, stableIdFromPage } from "./notion-crm-project-lead-mapper.mjs";

const ENTITY_DEFINITIONS = Object.freeze({
  crm_customer: { database: "customers", idProperty: "Customer ID" },
  crm_project_lead: { database: "projectLeads", idProperty: "Project Lead ID" },
});

function clean(value) {
  return String(value ?? "").trim();
}

function permanentError(code, message, category = "permanent") {
  const error = new Error(message);
  error.code = code;
  error.category = category;
  error.retryable = false;
  return error;
}

function syncStatusProperty(value) {
  return { "Sync Status": { select: { name: value } } };
}

export function createNotionCrmSyncEngine({ notion, repository, databaseIds = {}, clock = () => new Date() } = {}) {
  if (typeof notion !== "function") throw new Error("Notion CRM sync engine 需要 notion adapter。");
  if (!repository) throw new Error("Notion CRM sync engine 需要 repository。");

  function databaseId(entityType) {
    const definition = ENTITY_DEFINITIONS[entityType];
    const id = clean(databaseIds[definition?.database]);
    if (!definition || !id) throw permanentError("NOTION_CRM_DATABASE_NOT_CONFIGURED", `${definition?.database || entityType} database 尚未配置。`, "authentication");
    return id;
  }

  function pageHumanValues(entityType, page) {
    return entityType === "crm_customer" ? customerHumanValuesFromPage(page) : projectLeadHumanValuesFromPage(page);
  }

  function stableId(entityType, page) {
    return stableIdFromPage(page, ENTITY_DEFINITIONS[entityType].idProperty);
  }

  async function queryPage(entityType, stableNotionId) {
    const id = databaseId(entityType);
    const result = await notion("POST", `/databases/${id}/query`, {
      filter: { property: ENTITY_DEFINITIONS[entityType].idProperty, title: { equals: stableNotionId } },
      page_size: 3,
    });
    const pages = result?.results || [];
    if (pages.length > 1) throw permanentError("NOTION_CRM_DUPLICATE_STABLE_ID", `${stableNotionId} 在 Notion 出现重复页面。`, "conflict");
    return pages[0] || null;
  }

  async function receivePage(entityType, page) {
    const notionStableId = stableId(entityType, page);
    if (!notionStableId) throw permanentError("NOTION_CRM_STABLE_ID_MISSING", `${ENTITY_DEFINITIONS[entityType].idProperty} 为空，禁止导入。`);
    return repository.receiveInbox({
      notionPageId: page.id,
      notionDatabaseId: databaseId(entityType),
      entityType,
      stableId: notionStableId,
      notionEditedAt: page.last_edited_time || clock().toISOString(),
      payload: { humanValues: pageHumanValues(entityType, page) },
    });
  }

  async function processInboxItem(inbox) {
    if (!inbox.entityId) {
      await repository.markInbox(inbox.inboxId, "FAILED", { errorCode: "SYNC_LOCAL_ENTITY_NOT_FOUND", errorMessage: "Stable ID 在 SQLite 找不到对应实体。" });
      return { status: "FAILED", inboxId: inbox.inboxId };
    }
    const local = inbox.entityType === "crm_customer"
      ? await repository.loadCustomer(inbox.entityId)
      : await repository.loadProjectLead(inbox.entityId);
    if (!local) {
      await repository.markInbox(inbox.inboxId, "FAILED", { errorCode: "SYNC_LOCAL_ENTITY_NOT_FOUND", errorMessage: "SQLite 实体已不存在。" });
      return { status: "FAILED", inboxId: inbox.inboxId };
    }
    const mapping = await repository.mapping(inbox.entityType, inbox.entityId);
    const baseValues = mapping?.lastSqliteSnapshot || local.humanValues;
    const notionValues = inbox.payload.humanValues || {};
    const merge = mergeNotionHumanFields({
      database: ENTITY_DEFINITIONS[inbox.entityType].database,
      baseValues,
      sqliteValues: local.humanValues,
      notionValues,
    });
    if (inbox.entityType === "crm_project_lead" && merge.applyFromNotion["Project Stage"] !== undefined) {
      const stageReason = clean(notionValues["Stage Change Reason"]);
      const hasFreshStageReason = Boolean(stageReason) && stageReason !== clean(baseValues["Stage Change Reason"]);
      const stageDecision = decideStageTransition({
        from: local.salesStage || local.status,
        to: merge.applyFromNotion["Project Stage"],
        source: "notion",
        reason: hasFreshStageReason ? stageReason : "",
        lostReason: notionValues["Lost Reason"],
        allowBackward: hasFreshStageReason,
      });
      if (!stageDecision.allowed) {
        merge.conflicts.push({
          field: "Project Stage",
          baseValue: baseValues["Project Stage"] ?? null,
          sqliteValue: local.humanValues["Project Stage"] ?? normalizeSalesStage(local.salesStage || local.status),
          notionValue: notionValues["Project Stage"],
          reasonCode: stageDecision.code,
        });
        delete merge.applyFromNotion["Project Stage"];
      }
    }
    if (inbox.entityType === "crm_project_lead" && clean(merge.applyFromNotion.Temperature).toUpperCase() === "STOP" && !Number(local.stopFlag)) {
      merge.conflicts.push({
        field: "Temperature",
        baseValue: baseValues.Temperature ?? null,
        sqliteValue: local.humanValues.Temperature ?? null,
        notionValue: notionValues.Temperature,
        reasonCode: "USE_GLOBAL_STOP_WORKFLOW",
      });
      delete merge.applyFromNotion.Temperature;
    }
    const snapshot = { ...baseValues, ...merge.applyFromNotion };
    let conflictIds = [];
    if (merge.conflicts.length) {
      conflictIds = await repository.createConflicts({ inbox, entityId: inbox.entityId, conflicts: merge.conflicts });
    }
    if (Object.keys(merge.applyFromNotion).length) {
      const apply = inbox.entityType === "crm_customer" ? repository.applyCustomerHumanFields : repository.applyProjectLeadHumanFields;
      await apply({ inbox, entityId: inbox.entityId, values: merge.applyFromNotion, snapshot, syncStatus: conflictIds.length ? "CONFLICT" : "SYNCED" });
    } else {
      await repository.upsertMapping({
        entityType: inbox.entityType,
        sqliteEntityId: inbox.entityId,
        stableNotionId: inbox.payload.stableId,
        notionPageId: inbox.notionPageId,
        notionDatabaseId: inbox.notionDatabaseId,
        sqliteVersion: local.rowVersion,
        sqliteSnapshot: conflictIds.length ? baseValues : local.humanValues,
        notionEditedAt: inbox.notionEditedAt,
        syncStatus: conflictIds.length ? "CONFLICT" : "SYNCED",
      });
    }
    const status = conflictIds.length ? "CONFLICT" : "APPLIED";
    await repository.markInbox(inbox.inboxId, status, { conflictId: conflictIds[0] || null });
    if (conflictIds.length) await notion("PATCH", `/pages/${inbox.notionPageId}`, { properties: syncStatusProperty("Conflict") });
    return { status, inboxId: inbox.inboxId, appliedFields: Object.keys(merge.applyFromNotion), conflictIds };
  }

  async function processInbox({ limit = 50 } = {}) {
    const items = await repository.dueInbox({ limit });
    const report = { processed: 0, applied: 0, conflicts: 0, failed: 0 };
    for (const inbox of items) {
      report.processed += 1;
      try {
        const result = await processInboxItem(inbox);
        if (result.status === "CONFLICT") report.conflicts += 1;
        else if (result.status === "FAILED") report.failed += 1;
        else report.applied += 1;
      } catch (error) {
        await repository.markInbox(inbox.inboxId, "FAILED", { errorCode: error.code || "NOTION_PULL_APPLY_FAILED", errorMessage: error.message });
        report.failed += 1;
      }
    }
    return report;
  }

  async function pullDatabase(entityType, { editedAfter = null, pageLimit = 20 } = {}) {
    const id = databaseId(entityType);
    let cursor;
    let pages = 0;
    let received = 0;
    do {
      const body = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      if (editedAfter) body.filter = { timestamp: "last_edited_time", last_edited_time: { after: editedAfter } };
      const result = await notion("POST", `/databases/${id}/query`, body);
      for (const page of result?.results || []) {
        if (page.archived || page.in_trash) continue;
        const inbox = await receivePage(entityType, page);
        if (!inbox.duplicate) received += 1;
      }
      cursor = result?.has_more ? result.next_cursor : null;
      pages += 1;
    } while (cursor && pages < pageLimit);
    if (cursor) throw permanentError("NOTION_CRM_PULL_PAGE_LIMIT", `Notion pull 超过 ${pageLimit * 100} 页，已停止避免无限扫描。`);
    return { received, pages };
  }

  async function pullOnce() {
    const health = await repository.workerHealth();
    if (!Number(health.enabled)) return { paused: true, received: 0, processed: 0 };
    const editedAfter = health.lastPullAt || null;
    const customers = await pullDatabase("crm_customer", { editedAfter });
    const projectLeads = await pullDatabase("crm_project_lead", { editedAfter });
    const applied = await processInbox();
    await repository.markPullCompleted();
    return { received: customers.received + projectLeads.received, customers, projectLeads, ...applied };
  }

  async function pushEntity(job) {
    const definition = ENTITY_DEFINITIONS[job.entityType];
    if (!definition) return { handled: false };
    const health = await repository.workerHealth();
    if (!Number(health.enabled)) return { handled: true, defer: true, delayMs: 15 * 60_000, reason: "crm_sync_paused" };
    let entityId = job.entityId;
    let local = job.entityType === "crm_customer" ? await repository.loadCustomer(entityId) : await repository.loadProjectLead(entityId);
    if (!local && /^CUS-|^PLEAD-/.test(entityId)) {
      entityId = await repository.findEntityByStableId(job.entityType, entityId);
      local = job.entityType === "crm_customer" ? await repository.loadCustomer(entityId) : await repository.loadProjectLead(entityId);
    }
    if (!local) throw permanentError("SYNC_LOCAL_ENTITY_NOT_FOUND", `${job.entityType} 在 SQLite 找不到。`);
    const stableNotionId = job.entityType === "crm_customer" ? local.customerId : local.projectLeadId;
    let mapping = await repository.mapping(job.entityType, entityId);
    let page = mapping?.notionPageId ? await notion("GET", `/pages/${mapping.notionPageId}`) : await queryPage(job.entityType, stableNotionId);
    if (page && (!mapping || page.last_edited_time !== mapping.lastNotionEditedAt)) {
      const inbox = await receivePage(job.entityType, page);
      if (!inbox.duplicate || inbox.status === "PENDING") await processInbox();
      mapping = await repository.mapping(job.entityType, entityId);
      if (mapping?.syncStatus === "CONFLICT") throw permanentError("NOTION_CRM_FIELD_CONFLICT", `${stableNotionId} 有字段冲突，需要人工处理。`, "conflict");
      local = job.entityType === "crm_customer" ? await repository.loadCustomer(entityId) : await repository.loadProjectLead(entityId);
    }
    let properties;
    if (job.entityType === "crm_customer") {
      properties = customerProperties(local, stableNotionId);
    } else {
      const customerMap = await repository.mapping("crm_customer", local.customerId);
      properties = projectLeadProperties(local, stableNotionId, { customerPageId: customerMap?.notionPageId || "" });
    }
    page = page
      ? await notion("PATCH", `/pages/${page.id}`, { properties })
      : await notion("POST", "/pages", { parent: { database_id: databaseId(job.entityType) }, properties });
    await repository.upsertMapping({
      entityType: job.entityType,
      sqliteEntityId: entityId,
      stableNotionId,
      notionPageId: page.id,
      notionDatabaseId: databaseId(job.entityType),
      sqliteVersion: local.rowVersion,
      sqliteSnapshot: local.humanValues,
      notionEditedAt: page.last_edited_time || clock().toISOString(),
      syncStatus: "SYNCED",
    });
    await repository.recordPush({ entityType: job.entityType, entityId, changedFields: Object.keys(properties), idempotencyKey: job.idempotencyKey });
    return { handled: true, status: mapping ? "UPDATED" : "CREATED", pageId: page.id };
  }

  async function resolveConflict(conflictId, { resolution, value = null, resolvedBy = "operator" } = {}) {
    const detail = await repository.conflictDetail(conflictId);
    if (!detail) throw permanentError("SYNC_CONFLICT_NOT_FOUND", "找不到冲突记录。");
    if (detail.resolution !== "PENDING") return { conflict: detail, alreadyResolved: true };
    if (!["USE_SQLITE", "USE_NOTION", "CUSTOM", "CANCELLED"].includes(resolution)) {
      throw permanentError("SYNC_CONFLICT_RESOLUTION_INVALID", "不支持的冲突处理方式。");
    }
    const resolvedValue = resolution === "USE_SQLITE" ? detail.sqliteValue
      : resolution === "USE_NOTION" ? detail.notionValue
        : resolution === "CUSTOM" ? value : null;
    if (["USE_NOTION", "CUSTOM"].includes(resolution)) {
      const mapping = await repository.mapping(detail.entityType, detail.entityId);
      const inbox = {
        inboxId: detail.inboxId,
        notionPageId: detail.notionPageId,
        notionDatabaseId: detail.notionDatabaseId,
        notionEditedAt: detail.notionEditedAt,
        entityType: detail.entityType,
        entityId: detail.entityId,
        payload: detail.payload,
      };
      const apply = detail.entityType === "crm_customer" ? repository.applyCustomerHumanFields : repository.applyProjectLeadHumanFields;
      await apply({
        inbox,
        entityId: detail.entityId,
        values: { [detail.fieldName]: resolvedValue },
        snapshot: { ...(mapping?.lastSqliteSnapshot || {}), [detail.fieldName]: resolvedValue },
        syncStatus: "PENDING",
      });
    }
    const conflict = await repository.resolveConflict(conflictId, { resolution, value: resolvedValue, resolvedBy });
    const state = await repository.finalizeConflictState(detail);
    return { conflict, state };
  }

  return { pushEntity, pullOnce, pullDatabase, processInbox, processInboxItem, receivePage, resolveConflict };
}
