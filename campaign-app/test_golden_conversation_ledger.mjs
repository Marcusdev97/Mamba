import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createLocalDatabaseService } from "./lib/local-database-service.mjs";
import {
  calculateDeathTurn,
  createGoldenConversationLedgerService,
  findResidualPii,
  normalizeGoldenConversation,
  parseConversationText,
  sanitizeGoldenPii,
} from "./lib/golden-conversation-ledger-service.mjs";

function sqlite(databasePath, sql, json = false) {
  const args = ["-batch", ...(json ? ["-json"] : []), databasePath];
  const output = execFileSync("/usr/bin/sqlite3", args, { input: sql, encoding: "utf8" }).trim();
  return json ? (output ? JSON.parse(output) : []) : output;
}

function activeFixture(overrides = {}) {
  return {
    projectCode: "BINASTRA",
    sourceChannel: "blast",
    blastVersion: "v3-safe",
    language: "mixed",
    customerRole: "self",
    primaryPurpose: "own_stay",
    firstReplyType: "price",
    outcome: "Active",
    lastCustomerReplyAt: "2026-05-01T00:00:00.000Z",
    conversationText: `[M1] blast:v3-safe
Hi Alicia, would you like the nett price or layout comparison first?

[C1] +3m
Price first. My number is +6012-345 6789 and email is alicia@example.com.

[M2] +5m
I will verify the current package. Is a lower cash out or a larger layout more important?

[—] 无回复`,
    leadName: "Alicia",
    decisionTrace: [{
      turn: "C1",
      signal: "Customer asks for price first.",
      read: "客户在建立比较基准，还没有进入单位选择。",
      move: "Ask one prioritization question before sending figures.",
      why: "没有先丢整张价单，避免客户在手机上结束判断。",
      effect: "No reply; this becomes a negative example for diagnosis.",
    }],
    doNotCopy: [{ quote: "bulk price sheet", reason: "May end the conversation before FactFind." }],
    pkConflicts: [],
    ...overrides,
  };
}

// Strict parser and death-turn semantics.
const parsed = parseConversationText(activeFixture().conversationText);
assert.equal(parsed.blastVersion, "v3-safe");
assert.equal(parsed.ending, "无回复");
assert.equal(calculateDeathTurn(parsed)?.id, "M2");
assert.throws(() => parseConversationText("[M1]\nhello\n\n[—] 无回复"), /必须存在 \[C1\]/);
assert.throws(() => parseConversationText("[M2]\nhello\n\n[C1] +2m\nhi\n\n[—] 无回复"), /M 编号必须/);

// PII is scrubbed before validation/database writes, while prices and turn IDs survive.
const scrubbed = sanitizeGoldenPii(
  "[M1]\nAlicia +6012 3456789 alicia@example.com plate VAB 1234, RM979,000, PSF 950",
  { names: ["Alicia"] },
);
assert.match(scrubbed, /\{\{NAME\}\}/);
assert.match(scrubbed, /\{\{PHONE_REMOVED\}\}/);
assert.match(scrubbed, /\{\{EMAIL_REMOVED\}\}/);
assert.match(scrubbed, /\{\{PLATE_REMOVED\}\}/);
assert.match(scrubbed, /^\[M1\]/);
assert.match(scrubbed, /RM979,000/);
assert.match(scrubbed, /PSF 950/);
assert.deepEqual(findResidualPii(scrubbed, { names: ["Alicia"] }), []);

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-gc-test-"));
const localDatabase = createLocalDatabaseService({
  dataDir: tempDir,
  device: { id: "gc_test", name: "GC Test", hostname: "gc-test" },
  senderPolicy: { configured: false },
});
const ledger = createGoldenConversationLedgerService({ localDatabase, dataDir: tempDir, dormantAfterDays: 30 });
const initialized = await ledger.initialize();
assert.equal(initialized.seed.inserted, true);
assert.equal(initialized.cache.count, 1);
assert.equal((await ledger.list({ outcome: "Viewing Booked" }))[0].lead_code, "L001");
assert.doesNotMatch((await ledger.list({ outcome: "Viewing Booked" }))[0].conversation_text, /ADDRESS_REMOVED/);

const preview = ledger.preview(activeFixture());
assert.equal(preview.summary.piiSafe, true);
assert.match(preview.normalized.conversationText, /\{\{NAME\}\}/);
assert.doesNotMatch(preview.normalized.conversationText, /6012|alicia@example/);

const inserted = await ledger.importConversation(activeFixture());
assert.equal(inserted.inserted, true);
assert.equal(inserted.leadCode, "L002");
await assert.rejects(() => ledger.importConversation(activeFixture()), (error) => error.code === "GC_DUPLICATE");

// Only Active can become Dormant; automation never marks anything Dead.
const dormant = await ledger.markDormant({ now: "2026-07-18T00:00:00.000Z" });
assert.deepEqual(dormant.transitioned, ["L002"]);
assert.equal(dormant.deadTransitions, 0);
const [dormantRow] = await ledger.list({ outcome: "Dormant" });
assert.equal(dormantRow.death_turn, 2);
assert.equal(dormantRow.death_message_type, "open_question");

await ledger.addFollowup({
  leadCode: "L002", sentAt: "2026-06-10T00:00:00Z", silenceGapDays: 10,
  followupType: "personalized_question", contentSummary: "Asked about the customer's stated timing.",
  revival: true, revivalGapHours: 6,
});
await ledger.addFollowup({
  leadCode: "L002", sentAt: "2026-06-20T00:00:00Z", silenceGapDays: 20,
  followupType: "ab_slot_template", contentSummary: "Offered two appointment slots.", revival: false,
});
const report = await ledger.reports();
assert.equal(report.deathPoints[0].n, 1);
assert.equal(report.followupEffectiveness.length, 2);
assert.equal(report.silenceGap.length, 1);
assert.equal(report.silenceGap[0].gap_bucket, "8-30d");
assert.equal(report.blastQuality.some((row) => row.blast_version === "v3-safe"), true);

const rawRows = sqlite(localDatabase.databasePath, "SELECT conversation_text FROM golden_conversations WHERE lead_code='L002';", true);
assert.doesNotMatch(rawRows[0].conversation_text, /Alicia|6012|alicia@example/);
const cache = JSON.parse(await fs.readFile(ledger.runtimeCachePath, "utf8"));
assert.deepEqual(cache.records.map((row) => row.outcome), ["Viewing Booked"]);
assert.equal(cache.records[0].decision_trace.length, 6);

// Legacy v3 migration: retain every old row and keep an untouched backup table.
const legacyDir = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-gc-legacy-"));
const legacyPath = path.join(legacyDir, "mamba.sqlite");
sqlite(legacyPath, `
PRAGMA user_version=3;
CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL);
CREATE TABLE golden_conversations(
  golden_key TEXT PRIMARY KEY, notion_page_id TEXT UNIQUE, project_code TEXT NOT NULL,
  scenario TEXT NOT NULL DEFAULT '', conversation_text TEXT NOT NULL DEFAULT '',
  conversation_hash TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
INSERT INTO golden_conversations VALUES('old:1',NULL,'BINASTRA','Viewing Push','legacy text','abc123','2026-01-01','2026-01-02');
`);
const legacyLocal = createLocalDatabaseService({ dataDir: legacyDir, device: {}, senderPolicy: { configured: false } });
const legacyLedger = createGoldenConversationLedgerService({ localDatabase: legacyLocal, dataDir: legacyDir });
const legacyStatus = await legacyLedger.initialize();
assert.equal(legacyStatus.migration.migrated, true);
assert.equal(legacyStatus.migration.legacyRows, 1);
assert.equal(sqlite(legacyPath, "SELECT COUNT(*) FROM golden_conversations_legacy_v3;"), "1");
assert.equal(sqlite(legacyPath, "SELECT COUNT(*) FROM golden_conversations WHERE lead_code LIKE 'LEGACY%';"), "1");
assert.equal(sqlite(legacyPath, "PRAGMA user_version;"), "3");

// Viewing Booked fields and manual-read decision trace are mandatory.
assert.throws(() => normalizeGoldenConversation({
  ...activeFixture(), outcome: "Viewing Booked", conversationText: activeFixture().conversationText.replace("无回复", "已约"),
}), /trigger_message/);

console.log("✓ Golden Conversation Ledger: schema, migration, PII, parser, seed, reports and Dormant automation passed");
