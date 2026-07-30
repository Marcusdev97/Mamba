import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recentActiveRunState } from "./lib/sqlite-maintenance.mjs";

const DEFAULT_MIN_AGE_HOURS = 24;
const EXCLUDED_DIRECTORIES = new Set(["backups", "maintenance-archive"]);

function parseArgs(argv) {
  const result = { apply: false, root: "", minAgeHours: DEFAULT_MIN_AGE_HOURS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") result.apply = true;
    else if (arg === "--dry-run") result.apply = false;
    else if (arg === "--root") result.root = argv[index += 1] || "";
    else if (arg.startsWith("--root=")) result.root = arg.slice("--root=".length);
    else if (arg === "--min-age-hours") result.minAgeHours = Number(argv[index += 1]);
    else if (arg.startsWith("--min-age-hours=")) {
      result.minAgeHours = Number(arg.slice("--min-age-hours=".length));
    } else throw new Error(`不支持的参数：${arg}`);
  }
  if (!Number.isFinite(result.minAgeHours) || result.minAgeHours < 0) {
    throw new Error("--min-age-hours 必须是 0 或正数。");
  }
  return result;
}

function walkFiles(directory, relativeBase = "") {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relativePath = path.join(relativeBase, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRECTORIES.has(entry.name)) {
        files.push(...walkFiles(path.join(directory, entry.name), relativePath));
      }
    } else if (entry.isFile()) files.push(relativePath);
  }
  return files;
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function candidateForFile({ dataDir, relativePath, minAgeMs, nowMs }) {
  const absolutePath = path.join(dataDir, relativePath);
  const basename = path.basename(relativePath);
  const stats = fs.statSync(absolutePath);
  const ageMs = Math.max(0, nowMs - stats.mtimeMs);
  const base = {
    path: relativePath,
    bytes: stats.size,
    modifiedAt: stats.mtime.toISOString(),
    ageHours: Math.floor(ageMs / 3_600_000),
  };

  // FUSE hidden files can still be open file handles. They are surfaced for
  // diagnosis but never moved automatically, even when no Campaign is active.
  if (basename.startsWith(".fuse_hidden")) {
    return { bucket: "manualReview", item: { ...base, reason: "fuse-open-handle" } };
  }
  if (basename === ".DS_Store") {
    return { bucket: "archiveable", item: { ...base, reason: "finder-metadata" } };
  }
  if (ageMs < minAgeMs) return null;
  if (/\.tmp(?:\.|$)/i.test(basename)) {
    return { bucket: "archiveable", item: { ...base, reason: "stale-atomic-temp" } };
  }
  if (/\.bak-/i.test(basename)) {
    return { bucket: "archiveable", item: { ...base, reason: "backup-outside-backups-folder" } };
  }
  if (/^active-run\.stale-.*\.json$/i.test(basename)) {
    return { bucket: "archiveable", item: { ...base, reason: "legacy-run-snapshot" } };
  }

  const numberedCopy = basename.match(/^(.*) (\d+)(\.[^.]+)$/);
  if (!numberedCopy) return null;
  const siblingName = `${numberedCopy[1]}${numberedCopy[3]}`;
  const siblingRelative = path.join(path.dirname(relativePath), siblingName);
  const siblingPath = path.join(dataDir, siblingRelative);
  if (!fs.existsSync(siblingPath) || !fs.statSync(siblingPath).isFile()) {
    return { bucket: "manualReview", item: { ...base, reason: "numbered-copy-without-original" } };
  }
  if (sha256(absolutePath) === sha256(siblingPath)) {
    return {
      bucket: "archiveable",
      item: { ...base, reason: "exact-numbered-duplicate", original: siblingRelative },
    };
  }
  return {
    bucket: "manualReview",
    item: { ...base, reason: "numbered-copy-differs", original: siblingRelative },
  };
}

export function scanRuntimeHygiene({
  rootDir,
  minAgeHours = DEFAULT_MIN_AGE_HOURS,
  nowMs = Date.now(),
} = {}) {
  const dataDir = path.join(rootDir, "campaign-data");
  const result = { archiveable: [], manualReview: [] };
  for (const relativePath of walkFiles(dataDir)) {
    const candidate = candidateForFile({
      dataDir,
      relativePath,
      minAgeMs: minAgeHours * 3_600_000,
      nowMs,
    });
    if (candidate) result[candidate.bucket].push(candidate.item);
  }
  result.archiveable.sort((left, right) => left.path.localeCompare(right.path));
  result.manualReview.sort((left, right) => left.path.localeCompare(right.path));
  return {
    mode: "dry-run",
    dataDir,
    minAgeHours,
    summary: {
      archiveable: result.archiveable.length,
      manualReview: result.manualReview.length,
      archiveableBytes: result.archiveable.reduce((sum, item) => sum + item.bytes, 0),
    },
    ...result,
  };
}

function writeManifest(manifestPath, manifest) {
  const temporaryPath = `${manifestPath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, manifestPath);
}

export function applyRuntimeHygiene({
  rootDir,
  minAgeHours = DEFAULT_MIN_AGE_HOURS,
  nowMs = Date.now(),
} = {}) {
  const report = scanRuntimeHygiene({ rootDir, minAgeHours, nowMs });
  const active = recentActiveRunState(rootDir);
  if (active.activeRuns.length) {
    const error = new Error(`仍有 ${active.activeRuns.length} 个活动 Campaign；拒绝整理 Runtime Folder。`);
    error.code = "ACTIVE_CAMPAIGN_BLOCKS_RUNTIME_HYGIENE";
    error.report = { ...report, activeRuns: active.activeRuns };
    throw error;
  }
  if (!report.archiveable.length) {
    return { ...report, mode: "apply", activeRuns: [], archived: 0, archivePath: null };
  }

  const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, "-");
  const archiveRoot = path.join(report.dataDir, "maintenance-archive", `runtime-hygiene-${stamp}`);
  const filesRoot = path.join(archiveRoot, "files");
  const manifestPath = path.join(archiveRoot, "manifest.json");
  fs.mkdirSync(filesRoot, { recursive: true });
  const manifest = {
    version: 1,
    createdAt: new Date(nowMs).toISOString(),
    policy: "archive-only",
    status: "MOVING",
    entries: report.archiveable.map((item) => ({ ...item, archived: false })),
  };
  writeManifest(manifestPath, manifest);
  for (const entry of manifest.entries) {
    const source = path.join(report.dataDir, entry.path);
    const destination = path.join(filesRoot, entry.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(source, destination);
    entry.archived = true;
    entry.archivePath = path.relative(report.dataDir, destination);
    writeManifest(manifestPath, manifest);
  }
  manifest.status = "COMPLETED";
  writeManifest(manifestPath, manifest);
  return {
    ...report,
    mode: "apply",
    activeRuns: [],
    archived: manifest.entries.length,
    archivePath: path.relative(rootDir, archiveRoot),
    manifestPath: path.relative(rootDir, manifestPath),
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const rootDir = path.resolve(args.root || defaultRoot);
  try {
    const result = args.apply
      ? applyRuntimeHygiene({ rootDir, minAgeHours: args.minAgeHours })
      : scanRuntimeHygiene({ rootDir, minAgeHours: args.minAgeHours });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    if (error.report) console.error(JSON.stringify(error.report, null, 2));
    console.error(error.message);
    process.exitCode = 1;
  }
}
