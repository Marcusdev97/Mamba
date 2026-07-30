import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { resolveSupersededFlowSync } from "../scripts/maintenance/resolve-superseded-flow-sync.mjs";

const binary = "/usr/bin/sqlite3";
if (!fs.existsSync(binary)) {
  console.log("⚠️ 这台机器没有 sqlite3，跳过 superseded flow maintenance 测试。");
  process.exit(0);
}

const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "mamba-superseded-flow-"));
const dataDir = path.join(rootDir, "campaign-data");
const runsDir = path.join(dataDir, "runs");
const databasePath = path.join(dataDir, "mamba.sqlite");
fs.mkdirSync(runsDir, { recursive: true });
execFileSync(binary, [databasePath, `
CREATE TABLE sync_jobs (
  id INTEGER PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE,
  direction TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
  status TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL, last_error_code TEXT NOT NULL DEFAULT '',
  last_error_message TEXT NOT NULL DEFAULT '', payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE project_leads (
  project_code TEXT NOT NULL, phone TEXT NOT NULL, last_flow_sent TEXT NOT NULL,
  next_flow TEXT NOT NULL, sequence_status TEXT NOT NULL, notion_page_id TEXT);
INSERT INTO sync_jobs VALUES
  (338,'job-338','LOCAL_TO_NOTION','campaign_run','run-old','FAILED',6,'2026-07-30T00:00:00Z',
   'SYNC_FAILED','0 missing, 2 mismatch','{"flowLabel":"Flow 2 - Layout","projectId":"binastra"}',
   '2026-07-30T00:00:00Z','2026-07-30T00:00:00Z');
INSERT INTO project_leads VALUES
  ('binastra','60111111111','Flow 3 - Location','Flow 4 - Package','Running','page-1'),
  ('binastra','60122222222','Flow 4 - Package','Flow 6 - Price','Running','page-2');
`]);
fs.writeFileSync(path.join(runsDir, "run-old.json"), JSON.stringify({
  runId: "run-old",
  status: "COMPLETED",
  projectId: "binastra",
  flowLabel: "Flow 2 - Layout",
  assignments: [
    { status: "SENT", lead: { phone: "60111111111" }, part1: { sentAt: "2026-07-28T00:00:00Z" } },
    { status: "SENT", lead: { phone: "60122222222" }, part1: { sentAt: "2026-07-28T00:01:00Z" } },
  ],
  advanceSummary: { notFound: 0, flowMismatch: 2 },
}));

const dryRun = resolveSupersededFlowSync({ rootDir, databasePath, jobIds: [338] });
assert.equal(dryRun.mode, "dry-run");
assert.equal(dryRun.jobs[0].eligible, true);
assert.equal(dryRun.jobs[0].stateCounts.SUPERSEDED, 2);

const applied = resolveSupersededFlowSync({ rootDir, databasePath, jobIds: [338], apply: true });
assert.equal(applied.applied, 1);
assert.equal(applied.verification[0].status, "COMPLETED");
assert.equal(applied.verification[0].errorCode, "SUPERSEDED_FLOW_STATE");
assert.equal(applied.quickCheck, "ok");
assert.ok(fs.existsSync(applied.backupPath));

fs.rmSync(rootDir, { recursive: true, force: true });
console.log("✅ superseded Flow sync maintenance is dry-run-first and auditable");
