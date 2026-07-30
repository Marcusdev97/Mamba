import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const result = { root: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") result.root = argv[index += 1] || "";
    else if (arg.startsWith("--root=")) result.root = arg.slice("--root=".length);
    else throw new Error(`不支持的参数：${arg}`);
  }
  return result;
}

function readJson(filePath) {
  try {
    return { value: JSON.parse(fs.readFileSync(filePath, "utf8")), error: null };
  } catch (error) {
    return { value: null, error: error.message };
  }
}

function walkFiles(directory, relativeBase = "") {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relativePath = path.join(relativeBase, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path.join(directory, entry.name), relativePath));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files;
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function collectNamedValues(value, keyName, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectNamedValues(item, keyName, output);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === keyName && typeof child === "string" && child.trim()) output.push(child.trim());
      collectNamedValues(child, keyName, output);
    }
  }
  return output;
}

function duplicateValues(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([value, count]) => ({ value, count }));
}

export function auditCampaignAssets({ rootDir } = {}) {
  const assetsDir = path.join(rootDir, "campaign-assets");
  const manifest = readJson(path.join(assetsDir, "projects.json"));
  const problems = [];
  if (manifest.error) {
    problems.push({ code: "PROJECTS_MANIFEST_INVALID", path: "projects.json", detail: manifest.error });
  }
  const projects = Array.isArray(manifest.value?.projects) ? manifest.value.projects : [];
  for (const duplicate of duplicateValues(projects.map((item) => String(item?.id || "").trim()).filter(Boolean))) {
    problems.push({ code: "DUPLICATE_PROJECT_ID", value: duplicate.value, count: duplicate.count });
  }
  for (const duplicate of duplicateValues(projects.map((item) => String(item?.config || "").trim()).filter(Boolean))) {
    problems.push({ code: "DUPLICATE_PROJECT_CONFIG", value: duplicate.value, count: duplicate.count });
  }

  const registeredConfigs = new Set();
  const registeredMedia = new Set();
  const duplicateVariantIds = [];
  const missingMediaReferences = new Map();
  for (const project of projects) {
    const projectId = String(project?.id || "").trim();
    const configName = String(project?.config || "").trim();
    if (!projectId || !configName) {
      problems.push({ code: "PROJECT_ENTRY_INCOMPLETE", projectId, config: configName });
      continue;
    }
    registeredConfigs.add(configName);
    const configPath = path.join(assetsDir, configName);
    if (!fs.existsSync(configPath)) {
      problems.push({ code: "PROJECT_CONFIG_MISSING", projectId, path: configName });
      continue;
    }
    const config = readJson(configPath);
    if (config.error) {
      problems.push({ code: "PROJECT_CONFIG_INVALID", projectId, path: configName, detail: config.error });
      continue;
    }
    const campaignId = String(config.value?.campaignId || "").trim();
    if (campaignId && campaignId !== projectId) {
      problems.push({ code: "CAMPAIGN_ID_MISMATCH", projectId, campaignId, path: configName });
    }
    for (const duplicate of duplicateValues(collectNamedValues(config.value, "id"))) {
      duplicateVariantIds.push({ projectId, id: duplicate.value, count: duplicate.count });
    }
    for (const media of collectNamedValues(config.value, "media")) {
      if (/^https?:\/\//i.test(media)) continue;
      const normalized = media.replaceAll("\\", "/").replace(/^\/+/, "");
      registeredMedia.add(normalized);
      if (!fs.existsSync(path.join(assetsDir, normalized))) {
        const key = `${projectId}\u0000${configName}\u0000${normalized}`;
        const existing = missingMediaReferences.get(key);
        missingMediaReferences.set(key, {
          code: "REFERENCED_MEDIA_MISSING",
          projectId,
          config: configName,
          path: normalized,
          references: (existing?.references || 0) + 1,
        });
      }
    }
  }
  problems.push(...missingMediaReferences.values());

  const aliasesPath = path.join(assetsDir, "image_aliases.json");
  const aliases = readJson(aliasesPath);
  if (!aliases.error && aliases.value && typeof aliases.value === "object") {
    for (const filename of Object.values(aliases.value)) {
      if (typeof filename === "string" && filename.trim()) {
        registeredMedia.add(`images/${filename.trim()}`.replaceAll("\\", "/"));
      }
    }
  } else if (fs.existsSync(aliasesPath)) {
    problems.push({ code: "IMAGE_ALIASES_INVALID", path: "image_aliases.json", detail: aliases.error });
  }

  const topLevelJson = fs.existsSync(assetsDir)
    ? fs.readdirSync(assetsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
    : [];
  const unregisteredCampaignConfigs = [];
  for (const filename of topLevelJson) {
    if (registeredConfigs.has(filename) || filename === "projects.json") continue;
    const parsed = readJson(path.join(assetsDir, filename));
    if (parsed.value?.part1 || parsed.value?.part2) unregisteredCampaignConfigs.push(filename);
  }

  const imageFiles = walkFiles(path.join(assetsDir, "images"))
    .map((relativePath) => `images/${relativePath.replaceAll("\\", "/")}`);
  const hashes = new Map();
  for (const relativePath of imageFiles) {
    const digest = sha256(path.join(assetsDir, relativePath));
    if (!hashes.has(digest)) hashes.set(digest, []);
    hashes.get(digest).push(relativePath);
  }
  const duplicateContentGroups = [...hashes.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([hash, files]) => ({ hash, files: files.sort() }))
    .sort((left, right) => right.files.length - left.files.length);
  const unreferencedMedia = imageFiles
    .filter((relativePath) => !registeredMedia.has(relativePath))
    .sort();

  return {
    mode: "audit-only",
    assetsDir,
    summary: {
      registeredProjects: projects.length,
      registeredConfigs: registeredConfigs.size,
      problems: problems.length,
      missingMedia: missingMediaReferences.size,
      duplicateContentGroups: duplicateContentGroups.length,
      unregisteredCampaignConfigs: unregisteredCampaignConfigs.length,
      unreferencedMedia: unreferencedMedia.length,
    },
    problems,
    duplicateVariantIds,
    duplicateContentGroups,
    unregisteredCampaignConfigs: unregisteredCampaignConfigs.sort(),
    unreferencedMedia,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  console.log(JSON.stringify(auditCampaignAssets({
    rootDir: path.resolve(args.root || defaultRoot),
  }), null, 2));
}
