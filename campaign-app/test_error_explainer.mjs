// 错误说明的测试。
//
// 这个功能的价值在于「看得懂」，所以测试也要守住这件事：每一条规则都必须回答
// 四个问题 —— 发生什么事、为什么、影响谁、我现在做什么。少一段就等于回到
// "The operation was aborted due to timeout" 那种看了也没用的状态。

import assert from "node:assert/strict";
import { explainError, formatExplanation, logExplainedError } from "./lib/error-explainer.mjs";

// --- 每一条说明都要四段俱全，而且不能是空话 ---
const samples = [
  Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }),
  Object.assign(new Error("找不到 sqlite3，无法使用 Mamba 本机数据库。"), { code: "SQLITE_DRIVER_NOT_FOUND" }),
  new Error("HTTP 401 unauthorized"),
  new Error("object_not_found: could not find database"),
  new Error("HTTP 429 rate limited"),
  new Error("The operation was aborted due to timeout"),
  new Error("connect ECONNREFUSED 127.0.0.1:8080"),
  new Error('{"exists":false}'),
  new Error("发送 timeout：Evolution 45 秒内没有确认。"),
  Object.assign(new Error("ENOENT: no such file or directory, open 'x.json'"), { code: "ENOENT" }),
  Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }),
  Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }),
  new Error("Unexpected token } in JSON at position 42"),
  new Error("某个从来没看过的鬼东西"),
];

for (const sample of samples) {
  const explanation = explainError(sample, { area: "test", event: "unit" });
  for (const field of ["code", "message", "why", "impact", "action"]) {
    assert.ok(explanation[field], `${sample.message} 缺 ${field}`);
    assert.ok(String(explanation[field]).length > 6, `${sample.message} 的 ${field} 太短，等于没讲`);
  }
  assert.ok(explanation.details, "原始讯息一定要留着，不可以吞掉");
  // 「请检查设定」这种废话不算 action —— 使用者照着做不了任何事。
  assert.ok(!/^请检查$|^检查一下$/.test(explanation.action), `${explanation.code} 的处理建议太空泛`);
}

// --- 认得出具体错误，不要全部掉进通用那条 ---
assert.equal(explainError(new Error("HTTP 401 unauthorized")).code, "NOTION_AUTH_FAILED");
assert.equal(explainError(new Error("HTTP 429 slow down")).code, "NOTION_RATE_LIMITED");
assert.equal(explainError(Object.assign(new Error("x"), { code: "ENOSPC" })).code, "DISK_FULL");
assert.equal(explainError(new Error("connect ECONNREFUSED 127.0.0.1:8080")).code, "WHATSAPP_NOT_CONNECTED");
assert.equal(explainError(Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" })).code, "SQLITE_BUSY");

// --- 判断顺序：具体的要赢过笼统的 ---
// 401 里也有 "fetch failed" 之类的字眼时，仍然要判成 auth 而不是网路问题。
assert.equal(
  explainError(new Error("fetch failed: HTTP 401 unauthorized")).code,
  "NOTION_AUTH_FAILED",
  "认证失败要赢过网路错误 —— 处理方式完全不同",
);

// --- 认不出来的也要有用：不能吞掉原文 ---
const unknown = explainError(new Error("weird internal thing #4213"));
assert.equal(unknown.code, "UNEXPECTED_ERROR");
assert.equal(unknown.matched, false);
assert.match(unknown.details, /weird internal thing #4213/, "认不出来的更要把原文留着");

// --- 会重复发送的错误必须讲出这个后果 ---
// 这是这次事故的核心：写不回 Notion = 下次重发。使用者看到讯息就要知道这件事，
// 不能只讲「同步失败」。
for (const code of ["NOTION_AUTH_FAILED", "NOTION_DATABASE_ACCESS_FAILED"]) {
  const sample = code === "NOTION_AUTH_FAILED" ? new Error("HTTP 401") : new Error("object_not_found");
  const explanation = explainError(sample);
  assert.equal(explanation.code, code);
  assert.match(explanation.impact, /重复发送|重发/, `${code} 必须讲明会导致重复发送`);
}

// timeout 不代表没送出去 —— 这句一定要在，不然使用者会盲目补发。
assert.match(explainError(new Error("发送 timeout")).why, /不代表没送出去/);

// --- 格式化成 log 那一行 ---
const formatted = formatExplanation(explainError(new Error("HTTP 401 unauthorized")));
assert.match(formatted, /为什么：/);
assert.match(formatted, /影响：/);
assert.match(formatted, /处理：/);
assert.match(formatted, /原始讯息：/);

// --- 一步写进 system log ---
const written = [];
const explanation = await logExplainedError(
  { write: async (entry) => { written.push(entry); } },
  Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }),
  { area: "campaign", event: "send_failed", context: { phone: "60123456789" } },
);
assert.equal(written.length, 1);
assert.equal(written[0].level, "error");
assert.equal(written[0].area, "campaign");
assert.equal(written[0].event, "SQLITE_BUSY", "event 用错误码，之后才 grep 得到同一类");
assert.equal(written[0].context.sourceEvent, "send_failed", "原本的 event 要留着，不然查不到是哪个功能");
assert.equal(written[0].context.phone, "60123456789");
assert.match(written[0].message, /影响：/);
assert.equal(explanation.code, "SQLITE_BUSY");

// systemLogs 挂掉也不能让呼叫端跟着炸 —— 记录失败不该盖过原本的错误。
await logExplainedError(null, new Error("x"), { area: "a", event: "b" });
await logExplainedError({ write: async () => { throw new Error("log 也坏了"); } }, new Error("x"), {});

console.log("✅ all error explainer tests passed");
