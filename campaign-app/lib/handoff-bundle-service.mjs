import crypto from "node:crypto";
import fs from "node:fs/promises";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);
const FORMAT = "mamba-handoff-bundle-v1";
const KDF_PARAMS = Object.freeze({ name: "scrypt", N: 16384, r: 8, p: 1, keyLength: 32 });

function required(name, value) {
  const result = String(value ?? "").trim();
  if (!result) {
    const error = new Error(`${name} 不能为空。`);
    error.code = "HANDOFF_BUNDLE_INVALID_INPUT";
    throw error;
  }
  return result;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function deriveKey(passphrase, salt, params = KDF_PARAMS) {
  if (required("passphrase", passphrase).length < 12) {
    const error = new Error("交接密码至少需要 12 个字符，避免客户资料被轻易解密。");
    error.code = "HANDOFF_PASSPHRASE_TOO_SHORT";
    throw error;
  }
  if (params?.name !== "scrypt" || Number(params?.keyLength) !== 32) {
    const error = new Error("不支持的交接包密钥算法。");
    error.code = "HANDOFF_KDF_UNSUPPORTED";
    throw error;
  }
  return scrypt(passphrase, salt, 32, {
    N: Number(params.N),
    r: Number(params.r),
    p: Number(params.p),
    maxmem: 64 * 1024 * 1024,
  });
}

function validateSnapshot(snapshot) {
  if (!snapshot || snapshot.format !== "mamba-account-snapshot-v1" || Number(snapshot.schemaVersion) !== 4) {
    const error = new Error("交接快照格式错误或不是 SQLite v4 快照。");
    error.code = "HANDOFF_SNAPSHOT_INVALID";
    throw error;
  }
  if (!snapshot.transfer?.transfer_id || snapshot.transfer?.state !== "PREPARING") {
    const error = new Error("交接快照必须来自 PREPARING transfer。");
    error.code = "HANDOFF_SNAPSHOT_NOT_PREPARING";
    throw error;
  }
  const requiredSets = ["accounts", "bindings", "claims", "events", "projectLeads", "contacts", "campaignRuns"];
  for (const key of requiredSets) {
    if (!Array.isArray(snapshot.data?.[key])) {
      const error = new Error(`交接快照缺少 ${key}。`);
      error.code = "HANDOFF_SNAPSHOT_INCOMPLETE";
      throw error;
    }
  }
}

export async function createHandoffBundle({ snapshot, passphrase, expiresInMs = 30 * 60 * 1000, clock = () => new Date() } = {}) {
  validateSnapshot(snapshot);
  const createdAt = new Date(clock()).toISOString();
  const expiresAt = new Date(new Date(createdAt).getTime() + Math.max(60_000, Number(expiresInMs) || 0)).toISOString();
  const bundleId = `bundle_${createdAt.replace(/[:.]/g, "-")}_${crypto.randomUUID().slice(0, 8)}`;
  const plaintext = canonical(snapshot);
  const snapshotHash = sha256(plaintext);
  const salt = crypto.randomBytes(16);
  const nonce = crypto.randomBytes(12);
  const header = {
    format: FORMAT,
    bundleId,
    createdAt,
    expiresAt,
    schemaVersion: 4,
    snapshotHash,
    kdf: { ...KDF_PARAMS, salt: salt.toString("base64") },
    cipher: { name: "aes-256-gcm", nonce: nonce.toString("base64") },
  };
  const key = await deriveKey(passphrase, salt, header.kdf);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(canonical(header)));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ...header,
    authTag: authTag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export async function openHandoffBundle({ bundle, passphrase, clock = () => new Date() } = {}) {
  const value = typeof bundle === "string" ? JSON.parse(bundle) : bundle;
  if (!value || value.format !== FORMAT || Number(value.schemaVersion) !== 4) {
    const error = new Error("不是有效的 Mamba v4 交接包。");
    error.code = "HANDOFF_BUNDLE_INVALID";
    throw error;
  }
  if (new Date(value.expiresAt).getTime() <= new Date(clock()).getTime()) {
    const error = new Error("交接包已经过期。来源电脑仍应保持停止，请重新安全导出或人工处理。");
    error.code = "HANDOFF_BUNDLE_EXPIRED";
    throw error;
  }
  if (value.cipher?.name !== "aes-256-gcm") {
    const error = new Error("不支持的交接包加密算法。");
    error.code = "HANDOFF_CIPHER_UNSUPPORTED";
    throw error;
  }
  const header = {
    format: value.format,
    bundleId: value.bundleId,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    schemaVersion: value.schemaVersion,
    snapshotHash: value.snapshotHash,
    kdf: value.kdf,
    cipher: value.cipher,
  };
  try {
    const salt = Buffer.from(required("kdf.salt", value.kdf?.salt), "base64");
    const nonce = Buffer.from(required("cipher.nonce", value.cipher?.nonce), "base64");
    const key = await deriveKey(passphrase, salt, value.kdf);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(Buffer.from(canonical(header)));
    decipher.setAuthTag(Buffer.from(required("authTag", value.authTag), "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(required("ciphertext", value.ciphertext), "base64")),
      decipher.final(),
    ]).toString("utf8");
    if (sha256(plaintext) !== value.snapshotHash) {
      const error = new Error("交接包 snapshot hash 不一致。");
      error.code = "HANDOFF_BUNDLE_HASH_MISMATCH";
      throw error;
    }
    const snapshot = JSON.parse(plaintext);
    validateSnapshot(snapshot);
    return { bundleId: value.bundleId, createdAt: value.createdAt, expiresAt: value.expiresAt, snapshotHash: value.snapshotHash, snapshot };
  } catch (error) {
    if (error?.code?.startsWith?.("HANDOFF_")) throw error;
    const wrapped = new Error("交接包无法解密：密码错误、文件损坏，或内容被修改。来源电脑不会因此恢复发送权。");
    wrapped.code = "HANDOFF_BUNDLE_AUTH_FAILED";
    throw wrapped;
  }
}

export async function writeHandoffBundle(filePath, bundle) {
  const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tempPath, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tempPath, filePath);
  await fs.chmod(filePath, 0o600);
  return filePath;
}

export async function readHandoffBundle(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}
