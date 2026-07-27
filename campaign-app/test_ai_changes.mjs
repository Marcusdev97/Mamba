import assert from "node:assert/strict";
import fs from "node:fs/promises";

const payload = JSON.parse(await fs.readFile(new URL("./assets/ai-changes.json", import.meta.url), "utf8"));
const html = await fs.readFile(new URL("./ai-changes.html", import.meta.url), "utf8");
const staticRoutes = await fs.readFile(new URL("./routes/static.routes.mjs", import.meta.url), "utf8");
const shell = await fs.readFile(new URL("./assets/mamba-shell.js", import.meta.url), "utf8");

assert.equal(payload.version, 2);
assert.ok(Array.isArray(payload.recordingStandard));
assert.deepEqual(payload.recordingStandard, [
  "为什么要改",
  "改了什么",
  "影响哪里",
  "现在怎么用",
  "怎么验证",
  "对应 Git commit",
]);
assert.ok(Array.isArray(payload.changes) && payload.changes.length >= 3);
for (const item of payload.changes) {
  assert.ok(item.id);
  assert.ok(item.title);
  assert.ok(item.before?.text);
  assert.ok(item.after?.text);
  assert.ok(Array.isArray(item.types) && item.types.length);
}
const currentFormatChanges = payload.changes.filter((item) => item.date >= "2026-07-27");
assert.ok(currentFormatChanges.length >= 4);
for (const item of currentFormatChanges) {
  assert.equal(item.status, "verified");
  assert.ok(item.area);
  assert.ok(item.reason);
  assert.ok(item.impact);
  assert.ok(item.usage);
  assert.ok(item.commit);
  assert.ok(Array.isArray(item.verification) && item.verification.length);
}
assert.match(html, /data-testid="ai-change-list"/);
assert.match(html, /以前/);
assert.match(html, /现在/);
assert.match(html, /为什么要改/);
assert.match(html, /验证结果/);
assert.match(html, /searchInput/);
assert.match(staticRoutes, /"\/ai-changes": "ai-changes\.html"/);
assert.match(staticRoutes, /"application\/json; charset=utf-8"/);
assert.match(shell, /label: "AI Changes", href: "\/ai-changes"/);

console.log("✅ AI change log page tests passed");
