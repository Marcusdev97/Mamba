import assert from "node:assert/strict";
import fs from "node:fs/promises";

const payload = JSON.parse(await fs.readFile(new URL("./assets/ai-changes.json", import.meta.url), "utf8"));
const html = await fs.readFile(new URL("./ai-changes.html", import.meta.url), "utf8");
const staticRoutes = await fs.readFile(new URL("./routes/static.routes.mjs", import.meta.url), "utf8");
const shell = await fs.readFile(new URL("./assets/mamba-shell.js", import.meta.url), "utf8");

assert.equal(payload.version, 1);
assert.ok(Array.isArray(payload.changes) && payload.changes.length >= 3);
for (const item of payload.changes) {
  assert.ok(item.id);
  assert.ok(item.title);
  assert.ok(item.before?.text);
  assert.ok(item.after?.text);
  assert.ok(Array.isArray(item.types) && item.types.length);
}
assert.match(html, /data-testid="ai-change-list"/);
assert.match(html, /以前/);
assert.match(html, /现在/);
assert.match(staticRoutes, /"\/ai-changes": "ai-changes\.html"/);
assert.match(staticRoutes, /"application\/json; charset=utf-8"/);
assert.match(shell, /label: "AI Changes", href: "\/ai-changes"/);

console.log("✅ AI change log page tests passed");
