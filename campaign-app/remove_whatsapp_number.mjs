import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(appDir, "..");
const envText = await fs.readFile(path.join(rootDir, "evolution-pilot", ".env"), "utf8");
const apiKey = envText.split(/\r?\n/).find((line) => line.startsWith("AUTHENTICATION_API_KEY="))?.split("=").slice(1).join("=");
const headers = { "Content-Type": "application/json", apikey: apiKey };
const apiBase = "http://127.0.0.1:8080";

async function request(pathname, options = {}, allowFailure = false) {
  const response = await fetch(`${apiBase}${pathname}`, {
    ...options,
    headers,
    signal: AbortSignal.timeout(15000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok && !allowFailure) throw new Error(`${pathname}: HTTP ${response.status} ${JSON.stringify(body)}`);
  return { ok: response.ok, status: response.status, body };
}

function details(item) {
  const name = item.name ?? item?.instance?.instanceName;
  const status = item.connectionStatus ?? item?.instance?.state ?? item?.instance?.status ?? "unknown";
  const owner = String(item.ownerJid ?? item?.instance?.owner ?? "").split("@")[0].split(":")[0];
  const masked = owner ? `+${owner.slice(0, 2)}******${owner.slice(-4)}` : "Not connected";
  return { name, status, masked };
}

console.log("REMOVE WHATSAPP NUMBER");
console.log("======================");

try {
  const active = JSON.parse(await fs.readFile(path.join(rootDir, "campaign-data", "active-run.json"), "utf8"));
  if (active.status === "RUNNING") throw new Error("A campaign is RUNNING. Stop it before removing an instance.");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const fetched = await request("/instance/fetchInstances");
const instances = fetched.body.map(details).filter((item) => item.name);
if (instances.length === 0) throw new Error("No instances exist.");

for (const item of instances) console.log(`- ${item.name}: ${String(item.status).toUpperCase()} ${item.masked}`);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let instanceName;
let selected;
while (!selected) {
  const answer = (await rl.question("Instance to remove (enter wa_01): ")).trim();
  instanceName = answer.replace(/^DELETE\s+/i, "").trim();
  selected = instances.find((item) => item.name === instanceName);
  if (!selected) {
    console.log(`Not found: ${instanceName || "(blank)"}. Choose one from the list above.`);
  }
}

console.log(`Selected: ${selected.name} ${selected.masked}`);
console.log("This logs out the linked WhatsApp device and permanently deletes its Evolution session.");
const confirmation = (await rl.question(`Type DELETE ${instanceName}: `)).trim();
if (confirmation !== `DELETE ${instanceName}`) {
  console.log("Cancelled. Nothing was deleted.");
  await rl.close();
  process.exit(0);
}

const logout = await request(`/instance/logout/${encodeURIComponent(instanceName)}`, { method: "DELETE" }, true);
if (!logout.ok) console.log(`Logout returned HTTP ${logout.status}; continuing with local instance deletion.`);
await request(`/instance/delete/${encodeURIComponent(instanceName)}`, { method: "DELETE" });
await fs.rm(path.join(rootDir, "campaign-data", "qr", `${instanceName}.png`), { force: true });

console.log(`REMOVED: ${instanceName} ${selected.masked}`);
console.log("Historical campaign results were kept.");
await rl.close();
