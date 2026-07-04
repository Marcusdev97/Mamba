import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FileBlob, SpreadsheetFile } from "./xlsx_compat.mjs";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(appDir, "..");
const sourcePath = path.resolve(process.argv[2] || path.join(rootDir, "Untitled spreadsheet.xlsx"));
const outputPath = path.join(rootDir, "campaign-data", "leads.json");

function normalizePhone(value) {
  let digits = String(value ?? "").replace(/\D/g, "");
  if (digits.startsWith("0")) digits = `60${digits.slice(1)}`;
  return /^\d{8,15}$/.test(digits) ? digits : null;
}

const input = await FileBlob.load(sourcePath);
const workbook = await SpreadsheetFile.importXlsx(input);
const sheet = workbook.worksheets.getItemAt(0);
const values = sheet.getUsedRange(true)?.values ?? [];

if (values.length < 2) throw new Error("The workbook does not contain any lead rows.");

const headers = values[0].map((value) => String(value ?? "").trim().toLowerCase());
const nameIndex = headers.indexOf("name");
const phoneIndex = headers.indexOf("phone");
if (nameIndex < 0 || phoneIndex < 0) throw new Error("The workbook needs Name and Phone columns.");

const seen = new Set();
const leads = [];
const rejected = [];

for (let index = 1; index < values.length; index += 1) {
  const row = values[index];
  const name = String(row[nameIndex] ?? "").trim() || "there";
  const phone = normalizePhone(row[phoneIndex]);
  if (!phone || seen.has(phone)) {
    rejected.push({ row: index + 1, reason: phone ? "duplicate" : "invalid phone" });
    continue;
  }
  seen.add(phone);
  leads.push({ id: `lead_${String(index).padStart(5, "0")}`, name, phone, sourceRow: index + 1 });
}

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify({ sourcePath, importedAt: new Date().toISOString(), leads, rejected }, null, 2)}\n`);
console.log(JSON.stringify({ imported: leads.length, rejected: rejected.length, outputPath }));

