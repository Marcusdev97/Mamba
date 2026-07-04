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

const headers = { apikey: env.AUTHENTICATION_API_KEY };
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const runOnce = process.argv.includes("--once");

function formatNumber(value) {
  if (!value) return "Not connected";
  const accountPart = String(value).split("@")[0].split(":")[0];
  const digits = accountPart.replace(/\D/g, "");
  if (!digits) return "Unknown";
  return `+${digits.slice(0, 2)}******${digits.slice(-4)}`;
}

async function getJson(url) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

while (true) {
  process.stdout.write("\x1Bc");
  console.log("EVOLUTION API - WHATSAPP NUMBER MONITOR");
  console.log("=======================================");
  console.log(`Updated: ${new Date().toLocaleString("en-MY", { timeZone: "Asia/Kuala_Lumpur" })}`);

  try {
    const health = await getJson("http://127.0.0.1:8080/");
    const instances = await getJson("http://127.0.0.1:8080/instance/fetchInstances");
    console.log(`API: ONLINE (v${health.version ?? "unknown"})`);
    console.log("");

    if (!Array.isArray(instances) || instances.length === 0) {
      console.log("No WhatsApp instances have been created.");
    } else {
      console.log("INSTANCE       STATUS         WHATSAPP NUMBER");
      console.log("---------------------------------------------");
      for (const item of instances) {
        const name = item?.name ?? item?.instance?.instanceName ?? "unknown";
        const status = item?.connectionStatus ?? item?.instance?.state ?? item?.instance?.status ?? "unknown";
        const owner = item?.ownerJid ?? item?.instance?.owner;
        console.log(`${name.padEnd(14)} ${String(status).toUpperCase().padEnd(14)} ${formatNumber(owner)}`);
      }
    }
  } catch (error) {
    console.log("API: OFFLINE");
    console.log(`Reason: ${error.message}`);
  }

  console.log("\nRefreshing every 5 seconds. Press Control+C to stop.");
  if (runOnce) break;
  await wait(5000);
}
