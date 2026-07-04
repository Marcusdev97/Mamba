import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(appDir, "..");
const envText = await fs.readFile(path.join(rootDir, "evolution-pilot", ".env"), "utf8");
const apiKey = envText.split(/\r?\n/).find((line) => line.startsWith("AUTHENTICATION_API_KEY="))?.split("=").slice(1).join("=");
const headers = { "Content-Type": "application/json", apikey: apiKey };
const apiBase = "http://127.0.0.1:8080";
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function api(pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, {
    ...options,
    headers,
    signal: AbortSignal.timeout(15000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${pathname}: HTTP ${response.status} ${JSON.stringify(body)}`);
  return body;
}

function nextInstanceName(instances) {
  const names = new Set(instances.map((item) => item.name ?? item?.instance?.instanceName));
  for (let number = 1; number <= 99; number += 1) {
    const candidate = `wa_${String(number).padStart(2, "0")}`;
    if (!names.has(candidate)) return candidate;
  }
  throw new Error("No available instance name was found.");
}

function maskedOwner(item) {
  const owner = String(item?.ownerJid ?? item?.instance?.owner ?? "").split("@")[0].split(":")[0];
  return owner ? `+${owner.slice(0, 2)}******${owner.slice(-4)}` : "Unknown";
}

console.log("ADD WHATSAPP NUMBER");
console.log("===================");
const existing = await api("/instance/fetchInstances");
if (existing.length) {
  console.log("Existing instances:");
  for (const item of existing) {
    const name = item.name ?? item?.instance?.instanceName;
    const status = item.connectionStatus ?? item?.instance?.state ?? item?.instance?.status ?? "unknown";
    console.log(`- ${name}: ${String(status).toUpperCase()} ${maskedOwner(item)}`);
  }
}

const suggestion = nextInstanceName(existing);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
console.log(`Press Enter to create ${suggestion}. A WhatsApp QR code will open next.`);
console.log("Do not enter a phone number here; the phone is identified automatically after scanning the QR.");
let instanceName;
while (!instanceName) {
  const answer = (await rl.question(`Instance label [${suggestion}, press Enter]: `)).trim();
  const candidate = answer || suggestion;
  if (!/^wa_\d{2}$/.test(candidate)) {
    console.log(`Please press Enter for ${suggestion}, or enter a label such as wa_03.`);
    continue;
  }
  if (existing.some((item) => (item.name ?? item?.instance?.instanceName) === candidate)) {
    console.log(`${candidate} already exists. Choose another label.`);
    continue;
  }
  instanceName = candidate;
}

const created = await api("/instance/create", {
  method: "POST",
  body: JSON.stringify({ instanceName, qrcode: true, integration: "WHATSAPP-BAILEYS" })
});
const base64 = created?.qrcode?.base64;
if (!base64) {
  await rl.close();
  throw new Error("Evolution did not return a QR code.");
}

const qrDir = path.join(rootDir, "campaign-data", "qr");
const qrPath = path.join(qrDir, `${instanceName}.png`);
await fs.mkdir(qrDir, { recursive: true });
await fs.writeFile(qrPath, Buffer.from(base64.replace(/^data:image\/png;base64,/, ""), "base64"));
console.log(`QR saved: ${qrPath}`);
console.log("Opening QR. On the target WhatsApp Business app, use Settings > Linked Devices > Link a Device.");
spawn("/usr/bin/open", [qrPath], { detached: true, stdio: "ignore" }).unref();

console.log("Waiting up to 3 minutes for the QR scan...");
let connected;
for (let attempt = 0; attempt < 60; attempt += 1) {
  await wait(3000);
  const instances = await api("/instance/fetchInstances");
  const item = instances.find((value) => (value.name ?? value?.instance?.instanceName) === instanceName);
  const status = item?.connectionStatus ?? item?.instance?.state ?? item?.instance?.status;
  if (status === "open") {
    connected = item;
    break;
  }
}

if (connected) {
  console.log(`CONNECTED: ${instanceName} -> ${maskedOwner(connected)}`);
  console.log(`Use ${instanceName} in Campaign Launcher, or press Enter there to use all OPEN instances.`);
} else {
  console.log("QR was not scanned within 3 minutes. Run this command again with a new instance name.");
}
await rl.close();
