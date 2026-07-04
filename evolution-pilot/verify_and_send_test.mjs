import fs from "node:fs/promises";

const envText = await fs.readFile(new URL("./.env", import.meta.url), "utf8");
const env = Object.fromEntries(
  envText
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
);

const headers = {
  "Content-Type": "application/json",
  apikey: env.AUTHENTICATION_API_KEY,
};

const instancesResponse = await fetch("http://127.0.0.1:8080/instance/fetchInstances", {
  headers,
});
const instances = await instancesResponse.json();
if (!instancesResponse.ok) {
  console.error(JSON.stringify(instances));
  process.exit(1);
}

const instance = instances.find((item) => item?.name === "wa_01" || item?.instance?.instanceName === "wa_01");
const state = instance?.connectionStatus ?? instance?.instance?.state ?? instance?.instance?.status;
const owner = instance?.ownerJid ?? instance?.instance?.owner;
console.log(JSON.stringify({
  instanceName: "wa_01",
  connectionStatus: state ?? "unknown",
  senderLast4: owner ? String(owner).replace(/\D/g, "").slice(-4) : null,
}));

if (state !== "open") {
  console.error("wa_01 is not open; test message was not sent.");
  process.exit(2);
}

const recipient = process.env.TEST_RECIPIENT;
if (!recipient) {
  console.error("TEST_RECIPIENT is required.");
  process.exit(3);
}

const sendResponse = await fetch("http://127.0.0.1:8080/message/sendText/wa_01", {
  method: "POST",
  headers,
  body: JSON.stringify({
    number: recipient,
    text: "Evolution API test successful. This is a one-time setup test.",
  }),
});
const sendResult = await sendResponse.json();
if (!sendResponse.ok) {
  console.error(JSON.stringify(sendResult));
  process.exit(4);
}

console.log(JSON.stringify({
  sent: true,
  recipientLast4: recipient.slice(-4),
  messageId: sendResult?.key?.id ?? sendResult?.messageId ?? null,
  status: sendResult?.status ?? sendResult?.message?.status ?? null,
}));
