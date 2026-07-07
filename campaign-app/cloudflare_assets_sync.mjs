// Sync Mamba image assets to Cloudflare R2.
// Credentials are read from evolution-pilot/.env or process.env.

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assetsDir = path.join(rootDir, "assets");
const manifestPath = path.join(assetsDir, "manifest.json");

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const force = args.has("--force");

const IMAGE_EXTENSIONS = new Set([
  ".avif",
  ".gif",
  ".heic",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp",
]);

const MIME = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".json": "application/json",
};

function posixPath(value) {
  return value.split(path.sep).join("/");
}

function encodeKey(value) {
  return value
    .split("/")
    .map((part) => encodeURIComponent(part).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/");
}

function sha256(buffer, encoding = "hex") {
  return crypto.createHash("sha256").update(buffer).digest(encoding);
}

function hmac(key, value, encoding) {
  return crypto.createHmac("sha256", key).update(value).digest(encoding);
}

function signKey(secret, date, region, service) {
  const kDate = hmac(`AWS4${secret}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

async function readEnv() {
  const env = { ...process.env };
  const envPath = path.join(rootDir, "evolution-pilot", ".env");
  const text = await fs.readFile(envPath, "utf8").catch(() => "");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const idx = trimmed.indexOf("=");
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    if (!(key in env)) env[key] = value;
  }
  return env;
}

function sourceRoots(env) {
  const configured = String(env.CF_R2_SOURCE_DIRS ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const roots = configured.length ? configured : ["assets", "campaign-assets/images"];
  return roots.map((relativePath) => ({
    label: relativePath,
    absolutePath: path.join(rootDir, relativePath),
  }));
}

async function walk(dir) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name === ".DS_Store" || entry.name === "manifest.json") continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(fullPath)));
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext)) out.push(fullPath);
  }
  return out;
}

function keyForFile(source, filePath, prefix) {
  const relative = posixPath(path.relative(source.absolutePath, filePath));
  if (source.label === "campaign-assets/images") return `${prefix}/campaign-images/${relative}`;
  if (source.label === "assets") return `${prefix}/${relative}`;
  return `${prefix}/${source.label.replace(/[^a-zA-Z0-9/_-]+/g, "_")}/${relative}`;
}

async function collectFiles(env) {
  const prefix = String(env.CF_R2_PREFIX || "mamba-assets").replace(/^\/+|\/+$/g, "");
  const prior = await fs.readFile(manifestPath, "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => ({ items: [] }));
  const priorByLocalPath = new Map((prior.items ?? []).map((item) => [item.localPath, item]));
  const items = [];

  for (const source of sourceRoots(env)) {
    const files = await walk(source.absolutePath);
    for (const filePath of files) {
      const body = await fs.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const localPath = posixPath(path.relative(rootDir, filePath));
      const key = keyForFile(source, filePath, prefix);
      const hash = sha256(body);
      const previous = priorByLocalPath.get(localPath);
      items.push({
        localPath,
        source: source.label,
        key,
        size: body.length,
        sha256: hash,
        contentType: MIME[ext] ?? "application/octet-stream",
        unchanged: Boolean(prior.uploadedAt && previous && previous.key === key && previous.sha256 === hash),
        body,
      });
    }
  }

  return items.sort((a, b) => a.key.localeCompare(b.key));
}

function requiredConfig(env) {
  const config = {
    accountId: env.CF_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID,
    bucket: env.CF_R2_BUCKET,
    accessKeyId: env.CF_R2_ACCESS_KEY_ID,
    secretAccessKey: env.CF_R2_SECRET_ACCESS_KEY,
    publicBaseUrl: env.CF_R2_PUBLIC_URL || "",
  };
  const missing = [];
  if (!config.accountId) missing.push("CF_ACCOUNT_ID");
  if (!config.bucket) missing.push("CF_R2_BUCKET");
  if (!config.accessKeyId) missing.push("CF_R2_ACCESS_KEY_ID");
  if (!config.secretAccessKey) missing.push("CF_R2_SECRET_ACCESS_KEY");
  return { config, missing };
}

async function putObject(config, key, body, contentType) {
  const region = "auto";
  const service = "s3";
  const host = `${config.accountId}.r2.cloudflarestorage.com`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const shortDate = amzDate.slice(0, 8);
  const payloadHash = sha256(body);
  const canonicalUri = `/${encodeKey(config.bucket)}/${encodeKey(key)}`;
  const headers = {
    "content-type": contentType,
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((name) => `${name}:${headers[name]}\n`)
    .join("");
  const canonicalRequest = [
    "PUT",
    canonicalUri,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${shortDate}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256(Buffer.from(canonicalRequest)),
  ].join("\n");
  const signature = hmac(signKey(config.secretAccessKey, shortDate, region, service), stringToSign, "hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(`https://${host}${canonicalUri}`, {
    method: "PUT",
    headers: { ...headers, authorization },
    body,
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Upload failed ${res.status} for ${key}: ${text.slice(0, 500)}`);
  }
}

function publicUrl(base, key) {
  if (!base) return "";
  return `${base.replace(/\/+$/g, "")}/${encodeKey(key)}`;
}

function printSetupHelp(missing) {
  console.log("\n还不能上传，因为 Cloudflare R2 资料还没填完整。");
  console.log("把下面这些放进 evolution-pilot/.env：\n");
  console.log("CF_ACCOUNT_ID=你的 Cloudflare Account ID");
  console.log("CF_R2_BUCKET=你的 R2 bucket 名字，例如 mamba-assets");
  console.log("CF_R2_ACCESS_KEY_ID=你的 R2 access key");
  console.log("CF_R2_SECRET_ACCESS_KEY=你的 R2 secret key");
  console.log("CF_R2_PUBLIC_URL=https://assets.yourdomain.com");
  console.log("CF_R2_PREFIX=mamba-assets");
  console.log(`\n缺少: ${missing.join(", ")}`);
}

console.log("MAMBA CLOUDFLARE ASSETS SYNC");
console.log("============================\n");

await fs.mkdir(assetsDir, { recursive: true });
const env = await readEnv();
const { config, missing } = requiredConfig(env);
const files = await collectFiles(env);
const totalMb = files.reduce((sum, item) => sum + item.size, 0) / 1024 / 1024;

console.log(`Found ${files.length} image asset(s), ${totalMb.toFixed(2)} MB total.`);
console.log(`Mode: ${dryRun ? "dry run only" : "upload to Cloudflare R2"}`);
if (force) console.log("Force: upload everything even if local manifest says unchanged.");

if (!files.length) {
  console.log("\n没有找到图片。把图片放进 assets/ 或 campaign-assets/images/ 后再同步。");
  process.exit(0);
}

if (!dryRun && missing.length) {
  printSetupHelp(missing);
  process.exit(1);
}

let uploaded = 0;
let skipped = 0;
const manifestItems = [];

for (const item of files) {
  const url = publicUrl(config.publicBaseUrl, item.key);
  const shouldSkip = !force && item.unchanged;
  if (dryRun) {
    console.log(`DRY  ${item.key}`);
  } else if (shouldSkip) {
    skipped += 1;
    console.log(`SKIP ${item.key}`);
  } else {
    await putObject(config, item.key, item.body, item.contentType);
    uploaded += 1;
    console.log(`UP   ${item.key}`);
  }
  manifestItems.push({
    localPath: item.localPath,
    source: item.source,
    key: item.key,
    url,
    size: item.size,
    sha256: item.sha256,
    contentType: item.contentType,
  });
}

const manifest = {
  generatedAt: new Date().toISOString(),
  uploadedAt: dryRun ? "" : new Date().toISOString(),
  bucket: config.bucket || "",
  prefix: String(env.CF_R2_PREFIX || "mamba-assets").replace(/^\/+|\/+$/g, ""),
  publicBaseUrl: config.publicBaseUrl,
  totalFiles: manifestItems.length,
  totalBytes: manifestItems.reduce((sum, item) => sum + item.size, 0),
  items: manifestItems,
};

if (!dryRun) {
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const manifestKey = `${manifest.prefix}/manifest.json`;
  await putObject(config, manifestKey, Buffer.from(JSON.stringify(manifest, null, 2)), "application/json");
  console.log(`UP   ${manifestKey}`);
} else {
  console.log("\nDry run only. Manifest was not changed.");
}

console.log("\nDone.");
console.log(`Uploaded: ${uploaded}`);
console.log(`Skipped: ${skipped}`);
console.log(`Manifest: ${dryRun ? "not written in dry run" : path.relative(rootDir, manifestPath)}`);
if (config.publicBaseUrl) {
  console.log(`Cloud manifest: ${publicUrl(config.publicBaseUrl, `${manifest.prefix}/manifest.json`)}`);
}
