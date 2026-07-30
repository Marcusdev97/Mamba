import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { reconcileCampaignTerminalState } from "../scripts/maintenance/reconcile-campaign-terminal-state.mjs";

const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-reconcile-terminal-"));
const dataDir = path.join(rootDir, "campaign-data");
const runsDir = path.join(dataDir, "runs");
const databasePath = path.join(dataDir, "mamba.sqlite");
await fs.mkdir(runsDir, { recursive: true });
await fs.writeFile(path.join(dataDir, "active-runs.json"), JSON.stringify({ runs: [] }));
execFileSync("/usr/bin/sqlite3", ["-batch", databasePath, `
CREATE TABLE campaign_runs(
  run_id TEXT PRIMARY KEY,
  status TEXT,
  requested_count INTEGER,
  sent_count INTEGER,
  failed_count INTEGER,
  finished_at TEXT
);
INSERT INTO campaign_runs VALUES ('run_done','RUNNING',1,1,0,NULL);
`]);
await fs.writeFile(path.join(runsDir, "run_done.json"), JSON.stringify({
  runId: "run_done",
  status: "COMPLETED",
  updatedAt: "2026-07-30T02:00:00.000Z",
  assignments: [
    { status: "SENT" },
    { status: "SENT" },
    { status: "FAILED" },
  ],
}));

const dryRun = reconcileCampaignTerminalState({ rootDir, databasePath });
assert.equal(dryRun.repairable.length, 1);
assert.equal(dryRun.repairable[0].databaseStatus, "RUNNING");
assert.equal(dryRun.repairable[0].status, "COMPLETED");

const applied = reconcileCampaignTerminalState({ rootDir, databasePath, apply: true });
assert.equal(applied.applied, 1);
assert.equal(applied.verification.quickCheck, "ok");
assert.equal(applied.verification.remainingRepairable, 0);
const rows = JSON.parse(execFileSync("/usr/bin/sqlite3", [
  "-batch", "-json", databasePath,
  "SELECT status, requested_count AS requested, sent_count AS sent, failed_count AS failed FROM campaign_runs WHERE run_id='run_done';",
], { encoding: "utf8" }));
assert.deepEqual(rows, [{ status: "COMPLETED", requested: 3, sent: 2, failed: 1 }]);
assert.equal(reconcileCampaignTerminalState({ rootDir, databasePath }).repairable.length, 0, "repair is idempotent");

const activeRunId = "run_active";
await fs.writeFile(path.join(runsDir, `${activeRunId}.json`), JSON.stringify({
  runId: activeRunId,
  status: "RUNNING",
  assignments: [],
}));
await fs.writeFile(path.join(dataDir, "active-runs.json"), JSON.stringify({
  runs: [{ runId: activeRunId, status: "RUNNING" }],
}));
assert.throws(
  () => reconcileCampaignTerminalState({ rootDir, databasePath, apply: true }),
  (error) => error.code === "ACTIVE_CAMPAIGN_BLOCKS_TERMINAL_RECONCILIATION",
);

await fs.rm(rootDir, { recursive: true, force: true });
console.log("✅ Campaign terminal reconciliation tests passed");
