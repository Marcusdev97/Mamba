import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBlastCacheService } from "./lib/blast-cache-service.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-blast-cache-"));
let current = new Date("2026-07-16T10:00:00.000Z");
let releaseQuery;
const queryGate = new Promise((resolve) => { releaseQuery = resolve; });
let notionCalls = 0;
const notion = async () => {
  notionCalls += 1;
  await queryGate;
  return {
    results: [{
      id: "page-1",
      properties: {
        Name: { title: [{ plain_text: "Alice" }] },
        Phone: { phone_number: "60111111111" },
      },
    }],
    has_more: false,
  };
};
const service = createBlastCacheService({
  rootDir: root,
  blastDatabaseId: "database-1",
  notion,
  nfSelect: () => "",
  nfTitle: (page, name) => page.properties?.[name]?.title?.[0]?.plain_text || "",
  nfText: () => "",
  clock: () => current,
});

const first = service.sync();
await new Promise((resolve) => setImmediate(resolve));
const second = service.sync();
releaseQuery();
const [firstResult, secondResult] = await Promise.all([first, second]);
assert.equal(notionCalls, 1, "concurrent full cache syncs must share one Notion request");
assert.equal(firstResult.count, 1);
assert.equal(secondResult.count, 1);

const reused = await service.sync();
assert.equal(reused.reused, true, "fresh cache must be reused instead of downloaded again");
assert.equal(notionCalls, 1);

const duplicateManual = await service.sync({ force: true });
assert.equal(duplicateManual.reused, true, "duplicate manual clicks inside 30 seconds must be collapsed");
assert.equal(notionCalls, 1);

current = new Date(current.getTime() + 31_000);
await service.sync({ force: true });
assert.equal(notionCalls, 2, "a manual refresh should bypass the normal 10-minute window after duplicate protection expires");

current = new Date(current.getTime() + 11 * 60 * 1000);
await service.sync();
assert.equal(notionCalls, 3, "stale cache should be refreshed");

const failing = createBlastCacheService({
  rootDir: root,
  blastDatabaseId: "database-1",
  notion: async () => { throw new Error("HTTP 401 token invalid"); },
  nfSelect: () => "",
  nfTitle: () => "",
  nfText: () => "",
  minFreshMs: 0,
});
await assert.rejects(
  () => failing.sync({ force: true }),
  (error) => /BLAST_CACHE_PAGE_FAILED/.test(error.message)
    && /第 1 页/.test(error.message)
    && /token.*database sharing.*网络/i.test(error.message),
);

await fs.rm(root, { recursive: true, force: true });
console.log("✅ all blast-cache service tests passed");
