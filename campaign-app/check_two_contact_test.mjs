import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(appDir, "..");
const resultName = process.argv[2] || "two-contact-test-result.json";
const test = JSON.parse(await fs.readFile(path.join(rootDir, "campaign-data", resultName), "utf8"));
const envText = await fs.readFile(path.join(rootDir, "evolution-pilot", ".env"), "utf8");
const apiKey = envText.split(/\r?\n/).find((line) => line.startsWith("AUTHENTICATION_API_KEY="))?.split("=").slice(1).join("=");

for (const item of test.results) {
  const response = await fetch("http://127.0.0.1:8080/chat/findStatusMessage/wa_01", {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: apiKey },
    body: JSON.stringify({ where: { id: item.messageId, fromMe: true }, limit: 5 }),
    signal: AbortSignal.timeout(15000)
  });
  const body = await response.json().catch(() => null);
  const records = Array.isArray(body) ? body : body?.messages?.records ?? body?.records ?? [];
  const record = records.find((value) => value?.id === item.messageId || value?.key?.id === item.messageId) ?? records[0];
  console.log(JSON.stringify({
    name: item.name,
    recipientLast4: item.recipientLast4,
    messageId: item.messageId,
    status: record?.status ?? record?.messageStatus ?? item.apiStatus,
    statusLookupHttp: response.status
  }));
}
