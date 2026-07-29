import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createWorkInboxIgnoreService } from "./lib/work-inbox-ignore-service.mjs";

const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-work-inbox-ignore-"));
const service = createWorkInboxIgnoreService({ rootDir });

assert.equal((await service.snapshot()).count, 0);
const saved = await service.update({
  text: "朋友 A, 019 861 9311\n家人 B | +60 13-811 1923\n0198619311",
});
assert.equal(saved.count, 2, "duplicate phones are stored once");
assert.equal(saved.text, "朋友 A, 60198619311\n家人 B, 60138111923");
assert.deepEqual(await service.match("019-861 9311"), {
  ignored: true,
  phone: "60198619311",
  name: "朋友 A",
});
assert.equal((await service.match("0123456789")).ignored, false);

const reloaded = createWorkInboxIgnoreService({ rootDir });
assert.equal((await reloaded.snapshot()).count, 2, "the list persists across service instances");

const settingsHtml = await fs.readFile(new URL("./settings.html", import.meta.url), "utf8");
const settingsScript = settingsHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1] || "";
assert.doesNotThrow(() => new vm.Script(settingsScript), "Settings inline JavaScript must parse");
assert.match(settingsHtml, /私人联系人 \/ 不进入工作 Inbox/);
assert.match(settingsHtml, /\/api\/settings\/work-inbox-ignore/);

await fs.rm(rootDir, { recursive: true, force: true });
console.log("✅ all work-inbox-ignore tests passed");
