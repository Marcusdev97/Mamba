import fs from "node:fs/promises";
import { spawn } from "node:child_process";

const DEFAULT_SQLITE_CANDIDATES = [
  "/usr/bin/sqlite3",
  "/opt/homebrew/bin/sqlite3",
  "/usr/local/bin/sqlite3",
  "/opt/anaconda3/bin/sqlite3",
];

export function sqlValue(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replaceAll("'", "''")}'`;
}

export async function findSqliteCli(preferred = "") {
  const candidates = [preferred, process.env.MAMBA_SQLITE3_PATH, ...DEFAULT_SQLITE_CANDIDATES].filter(Boolean);
  for (const candidate of [...new Set(candidates)]) {
    try {
      await fs.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return "";
}

export function runSqliteProcess(binary, args, input = "", timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      const error = new Error(`SQLite command timeout after ${timeoutMs}ms`);
      error.code = "SQLITE_COMMAND_TIMEOUT";
      reject(error);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString("utf8").trim();
      const errorOutput = Buffer.concat(stderr).toString("utf8").trim();
      if (code === 0) resolve(output);
      else {
        const error = new Error(errorOutput || `sqlite3 exited with code ${code}`);
        error.code = /locked|busy/i.test(error.message) ? "SQLITE_BUSY" : "SQLITE_COMMAND_FAILED";
        reject(error);
      }
    });
    child.stdin.end(input);
  });
}

export async function createSqliteCli({ databasePath, sqliteBinary = "", busyTimeoutMs = 5000 } = {}) {
  const binary = await findSqliteCli(sqliteBinary);
  if (!binary) {
    const error = new Error("找不到 sqlite3，无法使用 Mamba 本机数据库。");
    error.code = "SQLITE_DRIVER_NOT_FOUND";
    throw error;
  }

  const timeout = String(Math.max(0, Number(busyTimeoutMs) || 0));
  const prefix = "PRAGMA foreign_keys=ON;\n";
  return {
    binary,
    databasePath,
    async query(sql, timeoutMs = 120000) {
      const output = await runSqliteProcess(binary, ["-batch", "-json", "-cmd", `.timeout ${timeout}`, databasePath], `${prefix}${sql}`, timeoutMs);
      if (!output) return [];
      try {
        return JSON.parse(output);
      } catch (error) {
        const wrapped = new Error(`SQLite JSON output 无法解析：${error.message}`);
        wrapped.code = "SQLITE_JSON_PARSE_FAILED";
        wrapped.output = output.slice(0, 1000);
        throw wrapped;
      }
    },
    async exec(sql, timeoutMs = 120000) {
      await runSqliteProcess(binary, ["-batch", "-cmd", `.timeout ${timeout}`, databasePath], `${prefix}${sql}`, timeoutMs);
    },
  };
}
