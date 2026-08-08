import assert from "node:assert/strict";
import crypto from "node:crypto";
import { NOTION_CRM_DATABASES, crmSchemaManifest } from "./domain/notion-crm-schema.mjs";
import { approvedHumanFields, stableCrmId } from "./domain/notion-crm-sync.mjs";
import { createNotionCrmProvisioningService } from "./lib/notion-crm-provisioning-service.mjs";

const manifest = crmSchemaManifest();
assert.equal(manifest.version, 2);
assert.equal(
  crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
  "b6885e0fd699524644ce4f992c3a96448b9b352551f4054b859f40e0bc71da35",
  "Notion CRM v2 property names/types/ownership are frozen; bump schema version for intentional changes",
);
assert.equal(Object.keys(manifest.databases).length, 8);
assert.equal(new Set(Object.values(manifest.databases).map((item) => item.title)).size, 8);
for (const [key, database] of Object.entries(manifest.databases)) {
  assert.equal(database.properties[database.idProperty]?.type, "title", `${key} must use its stable ID as title`);
  for (const property of Object.values(database.properties)) {
    if (property.type === "relation") assert.ok(manifest.databases[property.database], `${key} has an unknown relation target`);
  }
}
for (const denied of manifest.privacyDenylist) {
  const normalizedNames = Object.values(manifest.databases).flatMap((database) => Object.keys(database.properties))
    .map((name) => name.toLowerCase().replaceAll(" ", "_"));
  assert.equal(normalizedNames.includes(denied), false, `${denied} must not be copied to Notion CRM`);
}
assert.equal(stableCrmId("PLEAD", "project:contact-key"), stableCrmId("PLEAD", "project:contact-key"));
assert.notEqual(stableCrmId("PLEAD", "project:contact-key"), stableCrmId("PLEAD", "project:other-contact"));
assert.deepEqual(approvedHumanFields("customers", {
  "Display Name": "Approved",
  "Primary Phone": "not-human-owned",
  raw_message_payload: "private",
}), { "Display Name": "Approved" });

function responseProperty(payload) {
  const type = Object.keys(payload || {})[0];
  return { id: `prop_${type}`, type, ...(payload || {}) };
}

function fakeNotion() {
  const databases = new Map();
  const calls = [];
  let sequence = 1;
  const adapter = async (method, pathname, body) => {
    calls.push({ method, pathname, body });
    if (method === "POST" && pathname === "/search") {
      return { results: [...databases.values()] };
    }
    if (method === "POST" && pathname === "/databases") {
      const id = sequence.toString(16).padStart(32, "0");
      sequence += 1;
      const database = {
        id,
        title: body.title.map((item) => ({ plain_text: item.text.content })),
        properties: Object.fromEntries(Object.entries(body.properties).map(([name, value]) => [name, responseProperty(value)])),
      };
      databases.set(id, database);
      return database;
    }
    const databaseMatch = pathname.match(/^\/databases\/([a-f0-9]+)$/);
    if (method === "GET" && databaseMatch) {
      const database = databases.get(databaseMatch[1]);
      if (!database) throw new Error("Notion 404");
      return database;
    }
    if (method === "PATCH" && databaseMatch) {
      const database = databases.get(databaseMatch[1]);
      for (const [name, value] of Object.entries(body.properties || {})) {
        database.properties[name] = responseProperty(value);
      }
      return database;
    }
    throw new Error(`Unexpected Notion call ${method} ${pathname}`);
  };
  return { adapter, databases, calls };
}

const fake = fakeNotion();
let savedConfig = { project: "Test", databases: { blastLeads: "legacy-stays-untouched" } };
const provisioner = createNotionCrmProvisioningService({
  notion: fake.adapter,
  configPath: "/not-used/notion_config.json",
  readConfig: async () => savedConfig,
  writeConfig: async (_path, value) => { savedConfig = value; },
});
const dryRun = await provisioner.dryRun();
assert.deepEqual(dryRun.summary, { ready: 0, create: 8, update: 0, conflict: 0 });
assert.equal(fake.calls.some((call) => call.method !== "POST" || call.pathname !== "/search"), false, "Dry-run must not write");
await assert.rejects(
  provisioner.apply({ parentPageId: "a".repeat(32), confirmation: "wrong" }),
  (error) => error.code === "NOTION_CRM_APPLY_CONFIRMATION_REQUIRED",
);

const applied = await provisioner.apply({
  parentPageId: "a".repeat(32),
  confirmation: "CREATE_NOTION_CRM_V2",
});
assert.deepEqual(applied.summary, { ready: 8, create: 0, update: 0, conflict: 0 });
assert.equal(fake.calls.filter((call) => call.method === "POST" && call.pathname === "/databases").length, 8);
assert.equal(savedConfig.databases.blastLeads, "legacy-stays-untouched", "CRM provisioning must not replace legacy integrations");
assert.equal(Object.keys(savedConfig.crm.databases).length, 8);
assert.equal(savedConfig.crm.viewsRequireManualSetup, true, "Provisioning should report that views still need a separate setup step");

for (const [logicalKey, definition] of Object.entries(NOTION_CRM_DATABASES)) {
  const database = fake.databases.get(savedConfig.crm.databases[logicalKey]);
  for (const [propertyName, property] of Object.entries(definition.properties)) {
    assert.equal(database.properties[propertyName]?.type, property.type, `${logicalKey}.${propertyName} type mismatch`);
    if (property.type === "relation") {
      assert.equal(
        database.properties[propertyName].relation.database_id,
        savedConfig.crm.databases[property.database],
        `${logicalKey}.${propertyName} relation mismatch`,
      );
    }
  }
}

savedConfig.crm.viewsRequireManualSetup = false;
await provisioner.apply({ parentPageId: "a".repeat(32), confirmation: "CREATE_NOTION_CRM_V2" });
assert.equal(fake.calls.filter((call) => call.method === "POST" && call.pathname === "/databases").length, 8, "Second apply must not duplicate databases");
assert.equal(savedConfig.crm.viewsRequireManualSetup, false, "Verified views must remain complete on a repeated apply");

const conflictFake = fakeNotion();
conflictFake.databases.set("f".repeat(32), {
  id: "f".repeat(32),
  title: [{ plain_text: NOTION_CRM_DATABASES.customers.title }],
  properties: { "Customer ID": { type: "rich_text", rich_text: {} } },
});
const conflictProvisioner = createNotionCrmProvisioningService({
  notion: conflictFake.adapter,
  configPath: "/not-used/notion_config.json",
  readConfig: async () => ({}),
  writeConfig: async () => {},
});
const conflictPlan = await conflictProvisioner.dryRun();
assert.equal(conflictPlan.summary.conflict, 1);
await assert.rejects(
  conflictProvisioner.apply({ parentPageId: "a".repeat(32), confirmation: "CREATE_NOTION_CRM_V2" }),
  (error) => error.code === "NOTION_CRM_SCHEMA_CONFLICT",
);

console.log("✅ Notion CRM v2 schema, relations, privacy and provisioning tests passed");
