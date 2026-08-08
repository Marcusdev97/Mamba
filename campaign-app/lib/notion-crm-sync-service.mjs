import { approvedHumanFields, detectCrmConflict } from "../domain/notion-crm-sync.mjs";

function clean(value) {
  return String(value ?? "").trim();
}

function richText(value) {
  const content = clean(value).slice(0, 1900);
  return { rich_text: content ? [{ type: "text", text: { content } }] : [] };
}

function title(value) {
  return { title: [{ type: "text", text: { content: clean(value) } }] };
}

function date(value) {
  return { date: value ? { start: value } : null };
}

function select(value) {
  return { select: value ? { name: clean(value).slice(0, 100) } : null };
}

function pageText(page, name) {
  const property = page?.properties?.[name];
  return (property?.title || property?.rich_text || [])
    .map((item) => item?.plain_text || item?.text?.content || "").join("").trim();
}

function pageSelect(page, name) {
  return page?.properties?.[name]?.select?.name || "";
}

export function customerHumanValuesFromPage(page) {
  return approvedHumanFields("customers", {
    "Display Name": pageText(page, "Display Name"),
    Language: pageSelect(page, "Language"),
    Owner: pageText(page, "Owner"),
    "Global Status": pageSelect(page, "Global Status"),
    "Next Follow-up At": page?.properties?.["Next Follow-up At"]?.date?.start || null,
    "Current Sales Stage": pageSelect(page, "Current Sales Stage"),
    "Main Objection": pageText(page, "Main Objection"),
    Notes: pageText(page, "Notes"),
  });
}

export function customerHumanValues(customer) {
  return approvedHumanFields("customers", {
    "Display Name": clean(customer.displayName || customer.name),
    Language: clean(customer.language || "Other"),
    Owner: clean(customer.owner),
    "Global Status": clean(customer.globalStatus || "Active"),
    "Next Follow-up At": customer.nextFollowUpAt || null,
    "Current Sales Stage": clean(customer.currentSalesStage || "New"),
    "Main Objection": clean(customer.mainObjection),
    Notes: clean(customer.notes),
  });
}

export function customerProperties(customer, customerId, { includeHuman = true, syncStatus = "Synced" } = {}) {
  const properties = {
    "Customer ID": title(customerId),
    "Primary Phone": { phone_number: clean(customer.primaryPhone || customer.phone) || null },
    "Last Contact At": date(customer.lastContactAt),
    "Last Reply At": date(customer.lastReplyAt),
    "SQLite Updated At": date(customer.updatedAt),
    "Sync Status": select(syncStatus),
  };
  if (!includeHuman) return properties;
  const human = customerHumanValues(customer);
  return {
    ...properties,
    "Display Name": richText(human["Display Name"]),
    Language: select(human.Language),
    Owner: richText(human.Owner),
    "Global Status": select(human["Global Status"]),
    "Next Follow-up At": date(human["Next Follow-up At"]),
    "Current Sales Stage": select(human["Current Sales Stage"]),
    "Main Objection": richText(human["Main Objection"]),
    Notes: richText(human.Notes),
  };
}

export function createNotionCrmSyncService({ notion, databaseIds = {}, outbox = null } = {}) {
  if (typeof notion !== "function") throw new Error("Notion CRM sync 需要 notion adapter。");

  async function queueOffline(customer, customerId, error) {
    if (!outbox?.enqueue) throw error;
    await outbox.enqueue({
      entityType: "crm_customer",
      entityId: customerId,
      idempotencyKey: `LOCAL_TO_NOTION:crm_customer:${customerId}:${clean(customer.updatedAt) || "current"}`,
      payload: { customerId, operation: "UPSERT", errorCode: error.code || "NOTION_UNAVAILABLE" },
    });
    return { status: "QUEUED", customerId, errorCode: error.code || "NOTION_UNAVAILABLE" };
  }

  async function upsertCustomer({ customer, lastSyncedAt = null } = {}) {
    const databaseId = clean(databaseIds.customers);
    if (!databaseId) {
      const error = new Error("Notion CRM Customers database 尚未配置。");
      error.code = "NOTION_CRM_CUSTOMERS_NOT_CONFIGURED";
      throw error;
    }
    const customerId = clean(customer?.customerId);
    if (!customerId) {
      const error = new Error("Notion CRM sync 缺少稳定 customer_id；禁止从 phone/contact_key 临时生成。");
      error.code = "CUSTOMER_IDENTITY_REQUIRED_FOR_NOTION_SYNC";
      error.retryable = false;
      throw error;
    }
    try {
      const result = await notion("POST", `/databases/${databaseId}/query`, {
        filter: { property: "Customer ID", title: { equals: customerId } },
        page_size: 3,
      });
      const pages = result?.results || [];
      if (pages.length > 1) {
        const error = new Error(`Customers 中出现重复 stable ID ${customerId}；不会继续写入。`);
        error.code = "NOTION_CRM_DUPLICATE_CUSTOMER";
        throw error;
      }
      if (!pages.length) {
        const created = await notion("POST", "/pages", {
          parent: { database_id: databaseId },
          properties: customerProperties(customer, customerId),
        });
        return { status: "CREATED", customerId, pageId: created?.id || "" };
      }

      const page = pages[0];
      const sqliteValues = customerHumanValues(customer);
      const notionValues = customerHumanValuesFromPage(page);
      const conflict = detectCrmConflict({
        lastSyncedAt,
        sqliteUpdatedAt: customer.updatedAt,
        notionUpdatedAt: page.last_edited_time,
        sqliteValues,
        notionValues,
      });
      if (conflict.conflict) {
        await notion("PATCH", `/pages/${page.id}`, { properties: { "Sync Status": select("Conflict") } });
        return { status: "CONFLICT", customerId, pageId: page.id, conflict };
      }
      if (conflict.resolution === "IMPORT_NOTION") {
        return { status: "IMPORT_REQUIRED", customerId, pageId: page.id, changes: notionValues, conflict };
      }
      await notion("PATCH", `/pages/${page.id}`, {
        properties: customerProperties(customer, customerId, { includeHuman: true }),
      });
      return { status: "UPDATED", customerId, pageId: page.id };
    } catch (error) {
      if (error.code === "NOTION_CRM_DUPLICATE_CUSTOMER") throw error;
      return queueOffline(customer, customerId, error);
    }
  }

  return { upsertCustomer };
}
