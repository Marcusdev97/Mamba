import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(appDir, "..");

async function walkMjs(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walkMjs(absolutePath));
    else if (entry.isFile() && entry.name.endsWith(".mjs")) files.push(absolutePath);
  }
  return files;
}

function relative(filePath) {
  return path.relative(rootDir, filePath).replaceAll("\\", "/");
}

const allMjs = await walkMjs(appDir);
const productionMjs = allMjs.filter((filePath) => !path.basename(filePath).startsWith("test_"));
const ddlPattern = /\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX)\b|\bRENAME\s+TO\b|PRAGMA\s+user_version/i;
const ddlFiles = [];
for (const filePath of productionMjs) {
  if (ddlPattern.test(await fs.readFile(filePath, "utf8"))) ddlFiles.push(relative(filePath));
}
const allowedDdlFiles = new Set([
  "campaign-app/lib/local-database-service.mjs",
  "campaign-app/lib/v3-runtime-schema.mjs",
  "campaign-app/migrate_v2_to_v3.mjs",
  "campaign-app/migrate_v3_to_v4.mjs",
]);
assert.deepEqual(
  ddlFiles.filter((filePath) => !allowedDdlFiles.has(filePath)),
  [],
  "Runtime DDL must stay in the schema owner or explicit migration tools",
);

const routeFiles = await walkMjs(path.join(appDir, "routes"));
const directFetchFiles = [];
const directEnvFiles = [];
let settingsFetchCount = 0;
let settingsEnvCount = 0;
for (const filePath of routeFiles) {
  const source = await fs.readFile(filePath, "utf8");
  const fetchCount = (source.match(/\bfetch\s*\(/g) || []).length;
  const envCount = (source.match(/process\.env/g) || []).length;
  if (fetchCount) directFetchFiles.push(relative(filePath));
  if (envCount) directEnvFiles.push(relative(filePath));
  if (path.basename(filePath) === "settings.routes.mjs") {
    settingsFetchCount = fetchCount;
    settingsEnvCount = envCount;
  }
}
assert.deepEqual(
  directFetchFiles,
  ["campaign-app/routes/settings.routes.mjs"],
  "Do not add new direct external fetch calls to routes",
);
assert.ok(settingsFetchCount <= 3, "Do not increase the legacy direct fetch baseline");
assert.deepEqual(
  directEnvFiles,
  ["campaign-app/routes/settings.routes.mjs"],
  "Do not add new direct process.env reads to routes",
);
assert.ok(settingsEnvCount <= 7, "Do not increase the legacy process.env baseline");

const serverSource = await fs.readFile(path.join(appDir, "server.mjs"), "utf8");
assert.doesNotMatch(serverSource, ddlPattern, "server.mjs must not own schema changes");
assert.doesNotMatch(
  serverSource,
  /campaign_restart_auto_resumed|restart-auto-resume|autoResumed:\s*true/,
  "A restarted LIVE campaign must wait for explicit operator Continue",
);
assert.match(
  serverSource,
  /MANUAL_RESUME_REQUIRED_AFTER_RESTART/,
  "Restart recovery must expose an auditable manual-resume state",
);
await fs.access(path.join(rootDir, "docs", "DATA_OWNERSHIP.md"));
await fs.access(path.join(rootDir, "docs", "RUNTIME_DATA_RETENTION.md"));
console.log("✅ Architecture boundary regression tests passed");
