import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const html = await fs.readFile(path.join(appDir, "flow-map.html"), "utf8");

for (const requiredText of [
  "Mamba Project Design",
  "Outbound · 群发关键路径",
  "Inbound · 回复与人工接管",
  "Account &amp; Device · 号码身份与换电脑",
  "Cooperative handoff · v4 candidate / 尚未 Cutover",
  "Flow 1–10 · 自动跟进节奏",
  "Conditional Flow 5",
  "Conditional Flow 9",
  "Account = 真实号码；Binding = Device::号码",
  "Emergency Takeover 必须等 Phase 2 原子 Arbiter",
]) {
  assert.ok(html.includes(requiredText), `Flow Map must explain: ${requiredText}`);
}

const mainSequence = ["Flow 1", "Flow 2", "Flow 3", "Flow 4", "Flow 6", "Flow 7", "Flow 8", "Flow 10"];
let previousIndex = -1;
for (const flow of mainSequence) {
  const index = html.indexOf(`<b>${flow}</b>`, previousIndex + 1);
  assert.ok(index > previousIndex, `${flow} must appear in the correct automatic sequence`);
  previousIndex = index;
}

assert.match(html, /api\("\/api\/control-center"\)/);
assert.match(html, /api\("\/api\/settings\/local-database"\)/);
assert.ok(html.includes("db.health === \"ready\""), "Live SQLite status must distinguish healthy data from fallback defaults");
assert.ok(html.includes("Manual / Tracker only · OFF"), "The current AI auto-reply state must be explicit");

console.log("✅ Flow Map architecture checks passed");
