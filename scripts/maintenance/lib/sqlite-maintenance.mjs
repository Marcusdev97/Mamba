import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { recentActiveRunState } from "../../../campaign-app/lib/active-campaign-state.mjs";

export function clean(value) {
  return String(value ?? "").trim();
}

export function sqlText(value) {
  return `'${String(value ?? "").replaceAll("'", "''")}'`;
}

export function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

export { recentActiveRunState };

export function backupSqliteDatabase({
  binary,
  rootDir,
  databasePath,
  prefix,
} = {}) {
  const backupDir = path.join(rootDir, "campaign-data", "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `${prefix}-${stamp}.sqlite`);
  execFileSync(binary, ["-batch", databasePath, `.backup ${sqlText(backupPath)}`], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  return backupPath;
}
