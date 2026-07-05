// test_telegram_buttons.mjs — offline tests for the inline-button upgrade in telegram.mjs.
// Run: node test_telegram_buttons.mjs
// No network: only the pure helpers (keyboard building + update parsing).

import { buildInlineKeyboard, parseUpdate, escapeHtml } from "./telegram.mjs";

let fail = 0;
function check(label, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) { console.log(`❌ ${label}:\n   got      ${JSON.stringify(got)}\n   expected ${JSON.stringify(expected)}`); fail += 1; }
}

// --- buildInlineKeyboard ---

// Flat array -> one row (the brain service's 3-button layout).
check("flat array = one row", buildInlineKeyboard([
  { text: "✅ 照发", data: "ok:abc" },
  { text: "✏️ 改后发", data: "edit:abc" },
  { text: "🙋 接管", data: "take:abc" },
]), {
  inline_keyboard: [[
    { text: "✅ 照发", callback_data: "ok:abc" },
    { text: "✏️ 改后发", callback_data: "edit:abc" },
    { text: "🙋 接管", callback_data: "take:abc" },
  ]],
});

// Array of rows preserved as-is.
check("rows preserved", buildInlineKeyboard([[{ text: "A", data: "a" }], [{ text: "B", data: "b" }]]), {
  inline_keyboard: [[{ text: "A", callback_data: "a" }], [{ text: "B", callback_data: "b" }]],
});

// data defaults to text; empty/invalid buttons dropped; empty rows dropped.
check("defaults and drops", buildInlineKeyboard([{ text: "OK" }, null, { text: "" }]), {
  inline_keyboard: [[{ text: "OK", callback_data: "OK" }]],
});
check("empty input is safe", buildInlineKeyboard([]), { inline_keyboard: [] });

// Telegram caps callback_data at 64 bytes — must throw early.
let threw = false;
try { buildInlineKeyboard([{ text: "X", data: "x".repeat(65) }]); } catch { threw = true; }
check("callback_data > 64 bytes throws", threw, true);

// --- parseUpdate ---

check("callback update", parseUpdate({
  update_id: 101,
  callback_query: {
    id: "cbq1",
    data: "ok:abc",
    message: { message_id: 55, chat: { id: 777 } },
  },
}), { type: "callback", updateId: 101, chatId: 777, messageId: 55, data: "ok:abc", callbackQueryId: "cbq1" });

check("text message update", parseUpdate({
  update_id: 102,
  message: {
    message_id: 56,
    chat: { id: 777 },
    text: "改好的回复文本",
    reply_to_message: { message_id: 55 },
  },
}), { type: "message", updateId: 102, chatId: 777, messageId: 56, text: "改好的回复文本", replyToMessageId: 55 });

check("plain message without reply", parseUpdate({
  update_id: 103,
  message: { message_id: 57, chat: { id: 777 }, text: "hi" },
}), { type: "message", updateId: 103, chatId: 777, messageId: 57, text: "hi", replyToMessageId: null });

// Non-text / unknown updates -> null, never crash.
check("photo message -> null", parseUpdate({ update_id: 104, message: { message_id: 58, chat: { id: 777 }, photo: [] } }), null);
check("edited message -> null", parseUpdate({ update_id: 105, edited_message: { text: "x" } }), null);
check("garbage -> null", parseUpdate(null), null);

// --- escapeHtml regression (used in draft rendering) ---
check("escapeHtml", escapeHtml("<b>&"), "&lt;b&gt;&amp;");

console.log(fail ? `${fail} test(s) failed` : "✅ all telegram-button tests passed");
process.exitCode = fail ? 1 : 0;
