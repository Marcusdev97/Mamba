import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { assertReducedSyncPayload, mergeNotionHumanFields } from "./domain/notion-crm-sync.mjs";
import { createLocalDatabaseService } from "./lib/local-database-service.mjs";
import { createNotionCrmSyncEngine } from "./lib/notion-crm-sync-engine.mjs";
import { createNotionCrmSyncRepository } from "./lib/notion-crm-sync-repository.mjs";
import { createSqliteCli, findSqliteCli } from "./lib/sqlite-cli.mjs";
import { migrateSqliteNotionSync, sqliteNotionSyncMigrationPlan } from "../scripts/maintenance/migrate-sqlite-notion-sync.mjs";
import { migrateCustomerIdentity } from "../scripts/maintenance/migrate-customer-identity.mjs";
import { migrateSendEligibility } from "../scripts/maintenance/migrate-send-eligibility.mjs";
import { migrateSalesPipeline } from "../scripts/maintenance/migrate-sales-stage-followup.mjs";

const binary = await findSqliteCli();
if (!binary) {
  console.log("⚠️ 这台机器没有 sqlite3，跳过 SQLite ↔ Notion sync 测试。");
  process.exit(0);
}

assert.deepEqual(mergeNotionHumanFields({
  database: "customers",
  baseValues: { Notes: "old", Owner: "A" },
  sqliteValues: { Notes: "local", Owner: "A" },
  notionValues: { Notes: "remote", Owner: "B", "Primary Phone": "forbidden" },
}), {
  applyFromNotion: { Owner: "B" },
  conflicts: [{ field: "Notes", baseValue: "old", sqliteValue: "local", notionValue: "remote" }],
  unchanged: [],
});
assert.throws(() => assertReducedSyncPayload({ raw_message_payload: { body: "secret" } }), (error) => error.code === "NOTION_SYNC_PAYLOAD_NOT_REDUCED");
const dashboardHtml = await fs.readFile(new URL("./notion-sync.html", import.meta.url), "utf8");
const dashboardScript = dashboardHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1] || "";
assert.doesNotThrow(() => new vm.Script(dashboardScript), "Notion Sync dashboard JavaScript must parse");

const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-notion-sync-"));
const dataDir = path.join(rootDir, "campaign-data");
const local = createLocalDatabaseService({ dataDir });
await local.initialize();

const dryRun = migrateSqliteNotionSync({ rootDir, databasePath: local.databasePath, binary });
assert.equal(dryRun.mode, "dry-run");
assert.equal(dryRun.plan.applied, false);
assert.deepEqual(dryRun.plan.blockers, []);
const applied = migrateSqliteNotionSync({
  rootDir,
  databasePath: local.databasePath,
  binary,
  apply: true,
  confirmation: "APPLY_SQLITE_NOTION_SYNC_V1",
});
assert.equal(applied.verification.quickCheck, "ok");
assert.equal(sqliteNotionSyncMigrationPlan({ rootDir, databasePath: local.databasePath, binary }).applied, true);

const db = await createSqliteCli({ databasePath: local.databasePath, sqliteBinary: binary });
const at = "2026-08-06T00:00:00.000Z";
await db.exec(`INSERT INTO contacts(contact_key,phone,display_name,created_at,updated_at)
VALUES ('contact-1','60120000001','Alice','${at}','${at}');`);
const identityApplied = migrateCustomerIdentity({
  rootDir,
  databasePath: local.databasePath,
  binary,
  apply: true,
  confirmation: "APPLY_CUSTOMER_IDENTITY_V1",
});
assert.equal(identityApplied.verification.quickCheck, "ok");
const eligibilityApplied = migrateSendEligibility({
  rootDir,
  databasePath: local.databasePath,
  binary,
  apply: true,
  confirmation: "APPLY_SEND_ELIGIBILITY_V1",
});
assert.equal(eligibilityApplied.verification.quickCheck, "ok");
const salesPipelineApplied = migrateSalesPipeline({
  rootDir,
  databasePath: local.databasePath,
  binary,
  apply: true,
  confirmation: "APPLY_SALES_PIPELINE_V1",
});
assert.equal(salesPipelineApplied.verification.quickCheck, "ok");

let editSequence = 0;
const pages = [];
function touch(page) {
  editSequence += 1;
  page.last_edited_time = `2026-08-06T00:${String(editSequence).padStart(2, "0")}:00.000Z`;
  return page;
}
const notion = async (method, pathname, body) => {
  if (method === "POST" && pathname.endsWith("/query")) {
    const property = body?.filter?.property;
    const expected = body?.filter?.title?.equals;
    const results = property
      ? pages.filter((page) => page.properties[property]?.title?.[0]?.text?.content === expected)
      : pages;
    return { results, has_more: false, next_cursor: null };
  }
  if (method === "POST" && pathname === "/pages") {
    const page = touch({ id: `page-${pages.length + 1}`, archived: false, properties: structuredClone(body.properties) });
    pages.push(page);
    return structuredClone(page);
  }
  if (method === "GET" && pathname.startsWith("/pages/")) {
    const page = pages.find((item) => item.id === pathname.split("/").at(-1));
    if (!page) throw Object.assign(new Error("missing"), { status: 404, code: "object_not_found", retryable: false });
    return structuredClone(page);
  }
  if (method === "PATCH" && pathname.startsWith("/pages/")) {
    const page = pages.find((item) => item.id === pathname.split("/").at(-1));
    Object.assign(page.properties, structuredClone(body.properties || {}));
    return structuredClone(touch(page));
  }
  throw new Error(`Unexpected Notion call ${method} ${pathname}`);
};

const repository = createNotionCrmSyncRepository({ dataDir, sqliteBinary: binary });
assert.equal((await repository.schemaStatus()).ready, true);
assert.equal((await repository.workerHealth()).enabled, 0, "migration must fail closed with sync paused");
await repository.setWorkerPaused(false);
assert.equal((await repository.enqueueDirtyEntities()).pending, 1);

const engine = createNotionCrmSyncEngine({ notion, repository, databaseIds: { customers: "customers-db", projectLeads: "project-leads-db" } });
const [job] = await db.query("SELECT id,idempotency_key AS idempotencyKey,entity_type AS entityType,entity_id AS entityId FROM sync_jobs WHERE entity_type='crm_customer';");
const pushed = await engine.pushEntity(job);
assert.equal(pushed.status, "CREATED");
assert.equal(pages.length, 1);
await engine.pushEntity(job);
assert.equal(pages.length, 1, "outbox replay must update the mapped page, never create a duplicate");

pages[0].properties.Notes = { rich_text: [{ plain_text: "Human note", text: { content: "Human note" } }] };
touch(pages[0]);
await engine.pullDatabase("crm_customer");
let pull = await engine.processInbox();
assert.equal(pull.applied, 1);
let [profile] = await db.query("SELECT notes FROM crm_customer_profiles WHERE contact_key='contact-1';");
assert.equal(profile.notes, "Human note");

const duplicate = await engine.receivePage("crm_customer", structuredClone(pages[0]));
assert.equal(duplicate.duplicate, true, "same page edit must be idempotent in the inbox");

await db.exec("UPDATE crm_customer_profiles SET notes='SQLite note',updated_at='2026-08-06T01:00:00.000Z' WHERE contact_key='contact-1';");
pages[0].properties.Notes = { rich_text: [{ plain_text: "Different Notion note", text: { content: "Different Notion note" } }] };
touch(pages[0]);
await engine.pullDatabase("crm_customer");
pull = await engine.processInbox();
assert.equal(pull.conflicts, 1);
const [conflict] = await db.query("SELECT field_name AS fieldName,resolution FROM sync_conflicts WHERE resolution='PENDING';");
assert.deepEqual(conflict, { fieldName: "Notes", resolution: "PENDING" });
profile = (await db.query("SELECT notes FROM crm_customer_profiles WHERE contact_key='contact-1';"))[0];
assert.equal(profile.notes, "SQLite note", "conflict must never silently overwrite SQLite");
const resolved = await engine.resolveConflict((await db.query("SELECT conflict_id AS conflictId FROM sync_conflicts WHERE resolution='PENDING';"))[0].conflictId, {
  resolution: "USE_NOTION",
  resolvedBy: "test-operator",
});
assert.equal(resolved.conflict.resolution, "USE_NOTION");
profile = (await db.query("SELECT notes FROM crm_customer_profiles WHERE contact_key='contact-1';"))[0];
assert.equal(profile.notes, "Different Notion note", "explicit USE_NOTION resolution must apply the selected value");

const activeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-notion-sync-active-"));
const activeData = path.join(activeRoot, "campaign-data");
const activeLocal = createLocalDatabaseService({ dataDir: activeData });
await activeLocal.initialize();
const activeDb = await createSqliteCli({ databasePath: activeLocal.databasePath, sqliteBinary: binary });
await activeDb.exec(`INSERT INTO projects(project_code,project_name,active,created_at,updated_at) VALUES ('p','P',1,'${at}','${at}');
INSERT INTO campaign_runs(run_id,project_code,mode,status,started_at) VALUES ('live-run','p','LIVE','RUNNING','${at}');`);
const blocked = sqliteNotionSyncMigrationPlan({ rootDir: activeRoot, databasePath: activeLocal.databasePath, binary });
assert.ok(blocked.blockers.includes("active_campaigns"), "SQLite RUNNING ledger must block migration even without an active-run JSON file");

await fs.rm(rootDir, { recursive: true, force: true });
await fs.rm(activeRoot, { recursive: true, force: true });
console.log("✅ SQLite ↔ Notion migration, push, pull, replay, privacy and conflict tests passed");
