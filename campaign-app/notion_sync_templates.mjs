// Sync active templates from the Notion "Mamba | Templates" DB into local project
// configs. Only Status = Active templates are used. Projects + their templates are
// rebuilt from Notion; sender/excel mappings in projects.json are preserved.
// Image strategy A: each template's "Image Name" must match a file in campaign-assets/images/.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./campaign_core.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assetsDir = path.join(rootDir, "campaign-assets");
const imagesDir = path.join(assetsDir, "images");

const env = await loadEnv();
const token = env.NOTION_API_KEY || env.NOTION_TOKEN;
if (!token) { console.log("No NOTION_API_KEY in .env — open Mamba Settings and add the Notion token first."); process.exit(1); }

const config = JSON.parse(await fs.readFile(path.join(rootDir, "campaign-data", "notion_config.json"), "utf8"));
const dbId = String(config.databases.templates).replace(/[^a-fA-F0-9]/g, "");

const DELIVERY = {
  partGapSeconds: 45,
  contactGapSeconds: { min: 45, max: 75 },
  globalSerialSending: true,
  cancelPart2WhenCustomerReplies: true,
  preventDuplicateContact: true,
  requireOpenInstance: true,
};
const LANGUAGE_SELECTION = { mode: "random", weights: { en: 50, zh: 50 }, keepPartsInSameLanguage: true };
const PERSONALIZATION = { sourceColumn: "Name", placeholders: ["[Name]", "[名字]"] };
// All projects share one leads file; the user fills it and picks the project per blast.
const SHARED_EXCEL = "Untitled spreadsheet.xlsx";

const slug = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
const txt = (prop) => {
  if (!prop) return "";
  if (prop.type === "title") return prop.title.map((t) => t.plain_text).join("");
  if (prop.type === "rich_text") return prop.rich_text.map((t) => t.plain_text).join("");
  if (prop.type === "select") return prop.select?.name ?? "";
  return "";
};

async function notion(method, pathname, body) {
  const res = await fetch(`https://api.notion.com/v1${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Notion-Version": "2022-06-28" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Notion ${method} ${pathname}: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function queryActiveTemplates() {
  const rows = [];
  let cursor;
  do {
    const data = await notion("POST", `/databases/${dbId}/query`, {
      filter: { property: "Status", select: { equals: "Active" } },
      page_size: 100,
      start_cursor: cursor,
    });
    rows.push(...(data.results ?? []));
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return rows;
}

console.log("SYNC TEMPLATES FROM NOTION");
console.log("=========================\n");

const rows = await queryActiveTemplates();
console.log(`Active templates pulled: ${rows.length}\n`);

// Optional alias map: Notion "Image Name" -> local filename in campaign-assets/images/.
// Lets you keep descriptive names in Notion while pointing at real files locally.
let aliases = {};
try {
  aliases = JSON.parse(await fs.readFile(path.join(assetsDir, "image_aliases.json"), "utf8"));
} catch { /* no aliases */ }
const resolveMedia = (name) => aliases[name] ?? name;

// Group into projects.
const byProject = new Map();
for (const page of rows) {
  const p = page.properties;
  const projectName = txt(p.Project);
  const part = txt(p.Part);
  const language = txt(p.Language).toLowerCase();
  const text = txt(p["Message Text"]);
  const media = txt(p["Image Name"]).trim();
  const code = txt(p["Template Code"]).trim() || slug(txt(p["Template Name"]));
  if (!projectName || !text || (part !== "Part 1" && part !== "Part 2")) continue; // skip Follow Up / incomplete

  if (!byProject.has(projectName)) byProject.set(projectName, { part1: [], part2: [] });
  const variant = { id: code, language: language || "en", text, media: resolveMedia(media) };
  byProject.get(projectName)[part === "Part 1" ? "part1" : "part2"].push(variant);
}

// Preserve existing sender/excel mappings.
let existing = {};
try {
  const prev = JSON.parse(await fs.readFile(path.join(assetsDir, "projects.json"), "utf8"));
  for (const proj of prev.projects ?? []) existing[proj.id] = proj;
} catch { /* first run */ }

const allImages = new Set(await fs.readdir(imagesDir).catch(() => []));
const projects = [];
const warnings = [];

for (const [name, parts] of byProject) {
  const id = slug(name);
  // media is stored relative to campaign-assets/, i.e. with the images/ folder prefix.
  const withImagePath = (v) => ({ ...v, media: v.media ? `images/${v.media}` : "" });
  const cfg = {
    campaignId: id,
    campaignName: name,
    languageSelection: LANGUAGE_SELECTION,
    delivery: DELIVERY,
    personalization: PERSONALIZATION,
    part1: { variants: parts.part1.map(withImagePath) },
    part2: { variants: parts.part2.map(withImagePath) },
  };
  await fs.writeFile(path.join(assetsDir, `${id}.json`), `${JSON.stringify(cfg, null, 2)}\n`);

  // Carry over senders + excel; default for new projects.
  const prior = existing[id] ?? {};
  projects.push({
    id,
    name,
    config: `${id}.json`,
    senders: prior.senders ?? [],
    excel: SHARED_EXCEL,
  });

  // Report counts + missing images.
  const missing = [...new Set([...parts.part1, ...parts.part2].map((v) => v.media))]
    .filter((m) => m && !allImages.has(m));
  console.log(`${name}: Part1=${parts.part1.length}, Part2=${parts.part2.length}, senders=[${(prior.senders ?? []).join(",")}]`);
  if (!parts.part1.length || !parts.part2.length) warnings.push(`${name}: 缺少 Part 1 或 Part 2 的 Active 模板，无法发送。`);
  for (const m of missing) warnings.push(`${name}: 图片找不到 -> campaign-assets/images/${m}（请放入该文件，或改 Notion 的 Image Name 为本地文件名）。`);
}

await fs.writeFile(path.join(assetsDir, "projects.json"), `${JSON.stringify({ projects }, null, 2)}\n`);

console.log(`\nWrote ${projects.length} project config(s) + projects.json.`);
if (warnings.length) {
  console.log("\n⚠️  注意：");
  for (const w of warnings) console.log("  - " + w);
} else {
  console.log("All images found. Ready to blast.");
}
console.log("\n重启 Campaign Console 后，Project 下拉就会更新。");
