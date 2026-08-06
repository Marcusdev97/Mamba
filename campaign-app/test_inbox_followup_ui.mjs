import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync(new URL("./inbox.html", import.meta.url), "utf8");
const inlineScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] || "";

assert.doesNotThrow(() => new vm.Script(inlineScript), "Chat Room inline JavaScript must parse");
assert.match(html, /Follow-up 工作台/);
assert.match(inlineScript, /\/api\/follow-up/);
assert.match(inlineScript, /\/api\/follow-up\/action/);
assert.match(inlineScript, /\["overdue", "已逾期"\]/);
assert.match(inlineScript, /\["today", "今天"\]/);
assert.match(inlineScript, /\["scheduled", "已安排"\]/);
assert.match(inlineScript, /\["unplanned", "未安排"\]/);
assert.match(inlineScript, /data-followup-preset="tomorrow"/);
assert.match(inlineScript, /saveChatFollowUp\("done"\)/);
assert.match(inlineScript, /建议不会自动发送/);
assert.match(inlineScript, /suggestedDisposition\(category\)/);
assert.match(inlineScript, /"NOT_INTERESTED"/);
assert.match(inlineScript, /\/api\/conversations\/disposition/);
assert.match(html, /列为 Not Interested/);
assert.match(html, /intent-not-interested/);
assert.match(html, /class="media-card"/);
assert.match(inlineScript, /IntersectionObserver/);
assert.match(inlineScript, /video\.preload = "metadata"/);
assert.match(inlineScript, /video\.playsInline = true/);
assert.doesNotMatch(inlineScript, /video\.autoplay\s*=\s*true/);
assert.match(inlineScript, /\/api\/inbox\/media\/file/);
assert.match(inlineScript, /function deliveryMark\(message\)/);
assert.match(inlineScript, /SERVER_ACK/);
assert.match(inlineScript, /DELIVERY_ACK/);
assert.match(inlineScript, /已送达客户装置（双勾）/);
assert.match(inlineScript, /不能据此直接判定被封锁/);
assert.match(html, /delivery-mark\.read/);

// 客户摘要（本机关键词整理，不呼叫任何模型）+ 顶栏客户资料。
assert.match(inlineScript, /function summarizeCustomer\(messages\)/);
assert.match(inlineScript, /客户说过什么/);
assert.match(inlineScript, /本机按关键词整理客户原话/);
assert.match(inlineScript, /data-jump=/);
assert.match(inlineScript, /function focusMessage\(id\)/);
assert.match(inlineScript, /function intentPayload\(messages\)/);
assert.match(inlineScript, /function applyTone\(text, tone\)/);
assert.match(inlineScript, /data-tone="warm"/);
assert.match(inlineScript, /contactCardToggle/);
assert.match(inlineScript, /function sourceTag\(message\)/);
assert.match(inlineScript, /自动发送/);
assert.match(html, /class="msg-row/);

// Tab 显示实际电话号码，Evolution 标签只留在 tooltip / fallback。
assert.match(inlineScript, /function prettyPhone\(value\)/);
assert.match(inlineScript, /function instanceLabel\(instance\)/);
assert.match(inlineScript, /\$\{esc\(phone \|\| number\.instance\)\}/);

console.log("✅ Chat Room follow-up UI tests passed");
