import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  applyRuntimeHygiene,
  scanRuntimeHygiene,
} from "../scripts/maintenance/runtime-folder-hygiene.mjs";

const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-runtime-hygiene-"));
const dataDir = path.join(rootDir, "campaign-data");
const trackerDir = path.join(dataDir, "tracker");
const runsDir = path.join(dataDir, "runs");
await fs.mkdir(trackerDir, { recursive: true });
await fs.mkdir(runsDir, { recursive: true });
await fs.writeFile(path.join(dataDir, "active-runs.json"), JSON.stringify({ runs: [] }));
await fs.writeFile(path.join(dataDir, ".DS_Store"), "finder");
await fs.writeFile(path.join(dataDir, ".fuse_hidden01"), "open");
await fs.writeFile(path.join(dataDir, "valid.json"), "{}");
await fs.writeFile(path.join(trackerDir, "state.json.tmp.123"), "temp");
await fs.writeFile(path.join(trackerDir, "heartbeat.json"), "same");
await fs.writeFile(path.join(trackerDir, "heartbeat 2.json"), "same");
await fs.writeFile(path.join(trackerDir, "different.json"), "one");
await fs.writeFile(path.join(trackerDir, "different 2.json"), "two");
await fs.writeFile(path.join(dataDir, "settings.json.bak-2026-07-01"), "backup");
await fs.writeFile(path.join(dataDir, "active-run.stale-old.json"), "{}");
const old = new Date("2026-07-28T00:00:00.000Z");
for (const filename of [
  path.join(trackerDir, "state.json.tmp.123"),
  path.join(trackerDir, "heartbeat 2.json"),
  path.join(trackerDir, "different 2.json"),
  path.join(dataDir, "settings.json.bak-2026-07-01"),
  path.join(dataDir, "active-run.stale-old.json"),
]) await fs.utimes(filename, old, old);
const nowMs = new Date("2026-07-30T12:00:00.000Z").getTime();

const dryRun = scanRuntimeHygiene({ rootDir, nowMs });
assert.equal(dryRun.mode, "dry-run");
assert.equal(dryRun.summary.archiveable, 5);
assert.equal(dryRun.summary.manualReview, 2);
assert.ok(dryRun.archiveable.some((item) => item.reason === "exact-numbered-duplicate"));
assert.ok(dryRun.manualReview.some((item) => item.reason === "fuse-open-handle"));
assert.ok(dryRun.manualReview.some((item) => item.reason === "numbered-copy-differs"));

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
  () => applyRuntimeHygiene({ rootDir, nowMs }),
  (error) => error.code === "ACTIVE_CAMPAIGN_BLOCKS_RUNTIME_HYGIENE",
);
assert.equal((await fs.stat(path.join(trackerDir, "state.json.tmp.123"))).isFile(), true);

await fs.writeFile(path.join(dataDir, "active-runs.json"), JSON.stringify({ runs: [] }));
const applied = applyRuntimeHygiene({ rootDir, nowMs });
assert.equal(applied.archived, 5);
assert.ok(applied.archivePath);
assert.equal((await fs.stat(path.join(rootDir, applied.manifestPath))).isFile(), true);
await assert.rejects(fs.stat(path.join(dataDir, ".DS_Store")));
assert.equal((await fs.stat(path.join(dataDir, ".fuse_hidden01"))).isFile(), true);
assert.equal((await fs.stat(path.join(trackerDir, "different 2.json"))).isFile(), true);
assert.equal(scanRuntimeHygiene({ rootDir, nowMs }).summary.archiveable, 0);

await fs.rm(rootDir, { recursive: true, force: true });
console.log("✅ Runtime folder hygiene tests passed");
