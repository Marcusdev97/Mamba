import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(appDir, "..");
const envPath = path.join(rootDir, "evolution-pilot", ".env");
const token = String(process.env.NOTION_TOKEN_INPUT ?? "").trim();

if (!token) {
  throw new Error("No token provided.");
}

let envText = await fs.readFile(envPath, "utf8");
const lines = envText.split(/\r?\n/);
let replaced = false;
for (let index = 0; index < lines.length; index += 1) {
  if (lines[index].startsWith("NOTION_API_KEY=") || lines[index].startsWith("NOTION_TOKEN=")) {
    lines[index] = `NOTION_API_KEY=${token}`;
    replaced = true;
  }
}
if (!replaced) {
  if (lines.at(-1) !== "") lines.push("");
  lines.push(`NOTION_API_KEY=${token}`);
}

envText = `${lines.join("\n").replace(/\n+$/, "")}\n`;
await fs.writeFile(envPath, envText);
console.log("Notion token saved. The token is hidden in this output.");
