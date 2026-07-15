import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createTelegramFilterService,
  formatTelegramFilterEntries,
  parseTelegramFilterEntries,
} from "./lib/telegram-filter-service.mjs";

const parsed = parseTelegramFilterEntries("Marcus, 011 3369 8121\nMark | +60 16-856 8756\n01133698121\ninvalid");
assert.deepEqual(parsed, [
  { name: "Marcus", phone: "601133698121" },
  { name: "Mark", phone: "60168568756" },
]);
assert.equal(formatTelegramFilterEntries(parsed), "Marcus, 601133698121\nMark, 60168568756");

const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-telegram-filter-"));
const service = createTelegramFilterService({
  rootDir,
  getConnectedPhones: async () => ["+60172064505"],
  connectedCacheMs: 0,
});

await service.update({ text: "Marcus, 01133698121", autoFilterConnectedSenders: true });
assert.equal((await service.match("+60 11-3369 8121")).reason, "filter-list");
assert.equal((await service.match("0172064505")).reason, "connected-sender");
assert.equal((await service.match("0168568756")).filtered, false);

await service.update({ text: "Marcus, 01133698121", autoFilterConnectedSenders: false });
assert.equal((await service.match("0172064505")).filtered, false);
const snapshot = await service.snapshot();
assert.equal(snapshot.count, 1);
assert.equal(snapshot.autoFilterConnectedSenders, false);
assert.deepEqual(snapshot.connectedPhones, []);

await fs.rm(rootDir, { recursive: true, force: true });
console.log("✅ all telegram-filter tests passed");
