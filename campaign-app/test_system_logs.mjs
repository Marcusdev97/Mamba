import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSystemLogService } from "./lib/system-log-service.mjs";

let fail = 0;
function check(label, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) {
    console.log(`❌ ${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
    fail += 1;
  }
}
function checkTrue(label, value) { check(label, Boolean(value), true); }

const root = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-system-log-test-"));
const clock = () => new Date("2026-07-09T06:30:00.000Z");
const logs = createSystemLogService({ rootDir: root, clock });

await logs.write({
  level: "error",
  area: "telegram",
  event: "send_failed",
  message: "chat not found",
  context: { telegramBotToken: "123456:SECRET", nested: { api_key: "abc" }, safe: "ok" },
});
await logs.warn("notion_sync", "template missing", { project: "Gen Starz" });

const all = await logs.list({ limit: 10 });
check("latest first", all.map((entry) => entry.event), ["notion_sync", "send_failed"]);
check("filter level", (await logs.list({ level: "error" })).map((entry) => entry.event), ["send_failed"]);
check("filter query", (await logs.list({ q: "Gen Starz" })).map((entry) => entry.event), ["notion_sync"]);
check("redact token", all[1].context.telegramBotToken, "[redacted]");
check("redact nested api key", all[1].context.nested.api_key, "[redacted]");
check("keep safe context", all[1].context.safe, "ok");
checkTrue("jsonl file exists", (await fs.readdir(path.join(root, "campaign-data", "system-logs"))).includes("2026-07-09.jsonl"));

await fs.rm(root, { recursive: true, force: true });
console.log(fail ? `${fail} test(s) failed` : "✅ all system-log tests passed");
process.exitCode = fail ? 1 : 0;
