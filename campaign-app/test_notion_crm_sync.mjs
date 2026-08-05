import assert from "node:assert/strict";
import { createNotionCrmSyncService } from "./lib/notion-crm-sync-service.mjs";

function textProperty(value, type = "rich_text") {
  return { [type]: value ? [{ plain_text: value, text: { content: value } }] : [] };
}

function pageFromCustomer({ id = "page-1", customerId, notes = "", displayName = "Alice", editedAt = "2026-08-05T01:00:00.000Z" }) {
  return {
    id,
    last_edited_time: editedAt,
    properties: {
      "Customer ID": textProperty(customerId, "title"),
      "Display Name": textProperty(displayName),
      Language: { select: { name: "EN" } },
      Owner: textProperty("Agent A"),
      "Global Status": { select: { name: "Active" } },
      "Next Follow-up At": { date: null },
      "Current Sales Stage": { select: { name: "New" } },
      "Main Objection": textProperty(""),
      Notes: textProperty(notes),
    },
  };
}

const pages = [];
const calls = [];
let customerId = "";
const notion = async (method, pathname, body) => {
  calls.push({ method, pathname, body });
  if (method === "POST" && pathname.endsWith("/query")) {
    customerId = body.filter.title.equals;
    return { results: pages.filter((page) => page.properties["Customer ID"].title[0]?.plain_text === customerId) };
  }
  if (method === "POST" && pathname === "/pages") {
    const page = pageFromCustomer({ customerId, editedAt: "2026-08-05T01:00:00.000Z" });
    pages.push(page);
    return page;
  }
  if (method === "PATCH" && pathname.startsWith("/pages/")) return { id: pathname.split("/").at(-1) };
  throw new Error(`Unexpected ${method} ${pathname}`);
};

const service = createNotionCrmSyncService({ notion, databaseIds: { customers: "customers-db" } });
const customer = {
  contactKey: "contact-1",
  phone: "60120000001",
  displayName: "Alice",
  language: "EN",
  owner: "Agent A",
  globalStatus: "Active",
  currentSalesStage: "New",
  notes: "Initial",
  updatedAt: "2026-08-05T01:00:00.000Z",
};
const created = await service.upsertCustomer({ customer });
assert.equal(created.status, "CREATED");
assert.equal(calls.find((call) => call.method === "POST" && call.pathname === "/pages")
  .body.properties["Primary Phone"].phone_number, customer.phone);
const replay = await service.upsertCustomer({ customer, lastSyncedAt: "2026-08-05T01:00:00.000Z" });
assert.equal(replay.status, "UPDATED");
assert.equal(calls.filter((call) => call.method === "POST" && call.pathname === "/pages").length, 1, "Replay must not create a duplicate customer");

pages[0] = pageFromCustomer({
  customerId: created.customerId,
  notes: "Human changed this",
  editedAt: "2026-08-05T02:00:00.000Z",
});
const manualEdit = await service.upsertCustomer({
  customer: { ...customer, updatedAt: "2026-08-05T01:00:00.000Z" },
  lastSyncedAt: "2026-08-05T01:00:00.000Z",
});
assert.equal(manualEdit.status, "IMPORT_REQUIRED");
assert.equal(manualEdit.changes.Notes, "Human changed this");
assert.equal(Object.hasOwn(manualEdit.changes, "Primary Phone"), false, "System fields must never enter the human-edit import patch");

const conflict = await service.upsertCustomer({
  customer: { ...customer, notes: "SQLite changed this", updatedAt: "2026-08-05T03:00:00.000Z" },
  lastSyncedAt: "2026-08-05T01:00:00.000Z",
});
assert.equal(conflict.status, "CONFLICT");
assert.ok(conflict.conflict.differentFields.includes("Notes"));
const conflictPatch = calls.filter((call) => call.method === "PATCH").at(-1);
assert.deepEqual(conflictPatch.body.properties["Sync Status"], { select: { name: "Conflict" } });

pages.push(pageFromCustomer({ id: "page-duplicate", customerId: created.customerId }));
await assert.rejects(
  service.upsertCustomer({ customer }),
  (error) => error.code === "NOTION_CRM_DUPLICATE_CUSTOMER",
  "Duplicate stable IDs must stop sync instead of creating or overwriting",
);

const queued = [];
const offlineService = createNotionCrmSyncService({
  notion: async () => { const error = new Error("Notion offline"); error.code = "NOTION_TIMEOUT"; throw error; },
  databaseIds: { customers: "customers-db" },
  outbox: { async enqueue(job) { queued.push(job); } },
});
const offline = await offlineService.upsertCustomer({ customer });
assert.equal(offline.status, "QUEUED");
assert.equal(queued.length, 1);
assert.match(queued[0].idempotencyKey, /^LOCAL_TO_NOTION:crm_customer:/);
assert.equal(Object.hasOwn(queued[0].payload, "phone"), false, "Outbox diagnostics must not copy customer phone unnecessarily");

const noPhoneCalls = [];
const noPhoneService = createNotionCrmSyncService({
  notion: async (method, pathname, body) => {
    noPhoneCalls.push({ method, pathname, body });
    if (method === "POST" && pathname.endsWith("/query")) return { results: [] };
    if (method === "POST" && pathname === "/pages") return { id: "no-phone-page" };
    throw new Error(`Unexpected ${method} ${pathname}`);
  },
  databaseIds: { customers: "customers-db" },
});
await noPhoneService.upsertCustomer({
  customer: { contactKey: "no-phone", displayName: "No Phone", updatedAt: "2026-08-05T04:00:00.000Z" },
});
assert.equal(noPhoneCalls.find((call) => call.pathname === "/pages")
  .body.properties["Primary Phone"].phone_number, null, "Notion rejects an empty-string phone number");

console.log("✅ Notion CRM customer duplicate, manual edit, conflict and offline tests passed");
