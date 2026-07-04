import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(appDir, "..");
const campaignDir = path.join(rootDir, "campaign-assets");
const resultPath = path.join(rootDir, "campaign-data", "two-contact-part2-result.json");

try {
  await fs.access(resultPath);
  throw new Error("Part 2 has already been sent for this test.");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const config = JSON.parse(await fs.readFile(path.join(campaignDir, "mid_valley_campaign.json"), "utf8"));
const envText = await fs.readFile(path.join(rootDir, "evolution-pilot", ".env"), "utf8");
const apiKey = envText.split(/\r?\n/).find((line) => line.startsWith("AUTHENTICATION_API_KEY="))?.split("=").slice(1).join("=");
const template = config.part2.variants.find((variant) => variant.id === "en_part2_floorplans");
const imagePath = path.join(campaignDir, config.part2.media);
const media = (await fs.readFile(imagePath)).toString("base64");
const recipients = [
  { name: "CCLIU", phone: "60179978682" },
  { name: "Mark", phone: "60168568756" }
];

const results = [];
for (const recipient of recipients) {
  const response = await fetch("http://127.0.0.1:8080/message/sendMedia/wa_01", {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: apiKey },
    body: JSON.stringify({
      number: recipient.phone,
      mediatype: "image",
      mimetype: "image/jpeg",
      caption: template.text,
      media,
      fileName: path.basename(imagePath),
      delay: 1000
    }),
    signal: AbortSignal.timeout(20000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Part 2 failed for ${recipient.name}: HTTP ${response.status}`);
  const result = {
    name: recipient.name,
    recipientLast4: recipient.phone.slice(-4),
    templateId: template.id,
    messageId: body?.key?.id ?? null,
    apiStatus: body?.status ?? null,
    sentAt: new Date().toISOString()
  };
  results.push(result);
  console.log(JSON.stringify(result));
  await new Promise((resolve) => setTimeout(resolve, 3000));
}

await fs.writeFile(resultPath, `${JSON.stringify({ instanceName: "wa_01", image: config.part2.media, results }, null, 2)}\n`);
