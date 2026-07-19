import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const html = await fs.readFile(path.join(appDir, "campaign-todo.html"), "utf8");

for (const text of [
  "今天这一班",
  "排班预览",
  "Lifecycle Board",
  "提前放工",
  "开新一批",
  "开工",
  "预计发完",
]) {
  assert.ok(html.includes(text), `Campaign Automations must show ${text}`);
}

for (const forbidden of ["TEST 模式名单", "<h2>Progress</h2>", "<h2>Links</h2>", "立即 TEST", ">Inbox<", "Needs You", "Today Flow"]) {
  assert.ok(!html.includes(forbidden), `Campaign Automations must not show ${forbidden}`);
}

for (const href of ["/send"]) {
  assert.ok(html.includes(`href="${href}"`), `Campaign Automations must link to ${href}`);
}
for (const href of ["/templates", "/logs", "/settings", "/conversations", "/flow-map"]) {
  assert.ok(!html.includes(`href="${href}"`), `Campaign Automations should not duplicate link ${href}`);
}

assert.match(html, /renderProgress\(data\.progress \|\| \{\}\)/);
assert.match(html, /data\.workPreview \|\| \{\}/);
assert.ok(!html.includes("renderReplies"), "Campaign Automations should not render a Needs You card");

console.log("✅ Campaign Automations control tower checks passed");
