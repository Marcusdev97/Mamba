// test_reply_intake.mjs — offline tests for reply_intake.mjs (shared webhook parsing).
// Run: node test_reply_intake.mjs

import {
  normalizePhone, extractText, describeMessage, jidPhone, resolvePhone,
  collectMessages, senderFromPayload, inboundEvent,
} from "./reply_intake.mjs";

let fail = 0;
function check(label, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) { console.log(`❌ ${label}:\n   got      ${JSON.stringify(got)}\n   expected ${JSON.stringify(expected)}`); fail += 1; }
}

// --- normalizePhone (MY convention: leading 0 -> 60) ---
check("normalize 0123456789", normalizePhone("0123456789"), "60123456789");
check("normalize +60 12-345 6789", normalizePhone("+60 12-345 6789"), "60123456789");
check("normalize empty", normalizePhone(""), null);

// --- extractText / describeMessage ---
check("plain conversation", extractText({ message: { conversation: "多少钱?" } }), "多少钱?");
check("extended text", extractText({ message: { extendedTextMessage: { text: "price?" } } }), "price?");
check("image caption", extractText({ message: { imageMessage: { caption: "这个户型" } } }), "这个户型");
check("voice note label", describeMessage({ message: { audioMessage: { ptt: true } } }), "[voice note]");
check("sticker label", describeMessage({ message: { stickerMessage: {} } }), "[sticker]");
check("unknown body label", describeMessage({ message: {} }), "[reply]");

// --- jidPhone / resolvePhone ---
check("jid with device suffix", jidPhone("60123456789:12@s.whatsapp.net"), "60123456789");
check("group jid rejected", jidPhone("12345@g.us"), null);
check("lid jid rejected", jidPhone("98765@lid"), null);
check("resolve falls back to senderPn", resolvePhone({
  key: { remoteJid: "98765@lid" },
  senderPn: "60123456789@s.whatsapp.net",
}), "60123456789");

// --- collectMessages (nested Evolution payload) ---
const payload = {
  instance: "mamba01",
  data: {
    messages: [
      { key: { id: "M1", remoteJid: "60123456789@s.whatsapp.net" }, message: { conversation: "hi" }, messageTimestamp: 1751700000 },
    ],
  },
};
check("collectMessages finds nested", collectMessages(payload).length, 1);
check("senderFromPayload", senderFromPayload(payload), "mamba01");

// --- inboundEvent: the normalized shape both services consume ---
const event = inboundEvent(payload, collectMessages(payload)[0]);
check("inboundEvent shape", { id: event.id, instanceName: event.instanceName, phone: event.phone, text: event.text }, {
  id: "M1", instanceName: "mamba01", phone: "60123456789", text: "hi",
});
check("inboundEvent seconds->ISO", event.receivedAt, new Date(1751700000 * 1000).toISOString());

// Own messages and groups are dropped.
check("fromMe dropped", inboundEvent(payload, { key: { id: "M2", fromMe: true, remoteJid: "601@s.whatsapp.net" }, message: { conversation: "x" } }), null);
check("group dropped", inboundEvent(payload, { key: { id: "M3", remoteJid: "1@g.us" }, message: { conversation: "x" } }), null);
check("no phone dropped", inboundEvent(payload, { key: { id: "M4", remoteJid: "9@lid" }, message: { conversation: "x" } }), null);

console.log(fail ? `${fail} test(s) failed` : "✅ all reply-intake tests passed");
process.exitCode = fail ? 1 : 0;
