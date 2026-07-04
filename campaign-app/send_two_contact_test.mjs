import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(appDir, "..");
const campaignDir = path.join(rootDir, "campaign-assets");
const resultPath = path.join(rootDir, "campaign-data", "two-contact-test-result.json");

try {
  await fs.access(resultPath);
  throw new Error("This two-contact test has already been sent. Result file exists.");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const config = JSON.parse(await fs.readFile(path.join(campaignDir, "mid_valley_campaign.json"), "utf8"));
const envText = await fs.readFile(path.join(rootDir, "evolution-pilot", ".env"), "utf8");
const env = Object.fromEntries(
  envText.split(/\r?\n/).filter((line) => line && !line.startsWith("#") && line.includes("=")).map((line) => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), line.slice(separator + 1)];
  }),
);

const apiBase = "http://127.0.0.1:8080";
const headers = { "Content-Type": "application/json", apikey: env.AUTHENTICATION_API_KEY };
const imagePath = path.join(campaignDir, config.part1.media);
const imageBase64 = (await fs.readFile(imagePath)).toString("base64");

const tests = [
  { name: "CCLIU", phone: "60179978682", templateId: "en_part1_still_looking" },
  { name: "Mark", phone: "60168568756", templateId: "en_part1_quick_update" }
];

async function api(pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, {
    ...options,
    headers,
    signal: AbortSignal.timeout(20000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

const instances = await api("/instance/fetchInstances");
const instance = instances.find((item) => item.name === "wa_01");
if (!instance || instance.connectionStatus !== "open") throw new Error("wa_01 is not OPEN.");

const results = [];
for (const test of tests) {
  const template = config.part1.variants.find((variant) => variant.id === test.templateId);
  if (!template) throw new Error(`Template not found: ${test.templateId}`);
  const caption = template.text.replaceAll("[Name]", test.name).replaceAll("[名字]", test.name);
  const response = await api("/message/sendMedia/wa_01", {
    method: "POST",
    body: JSON.stringify({
      number: test.phone,
      mediatype: "image",
      mimetype: "image/jpeg",
      caption,
      media: imageBase64,
      fileName: path.basename(imagePath),
      delay: 1000
    })
  });
  results.push({
    name: test.name,
    recipientLast4: test.phone.slice(-4),
    templateId: test.templateId,
    messageId: response?.key?.id ?? null,
    apiStatus: response?.status ?? null,
    sentAt: new Date().toISOString()
  });
  console.log(JSON.stringify(results.at(-1)));
  await new Promise((resolve) => setTimeout(resolve, 3000));
}

await fs.mkdir(path.dirname(resultPath), { recursive: true });
await fs.writeFile(resultPath, `${JSON.stringify({ instanceName: "wa_01", image: config.part1.media, results }, null, 2)}\n`);
