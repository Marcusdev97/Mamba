// Create a consistent, additive backup of Mamba's local SQLite source of truth.
// The runtime database is never overwritten or modified by this tool.
//
//   node tools/backup-local-database.mjs
//   node tools/backup-local-database.mjs --db campaign-data/backups/example.sqlite
//   node tools/backup-local-database.mjs --out-dir /safe/local/path
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};
const resolveFromRoot = (value) => path.isAbsolute(value) ? value : path.resolve(ROOT, value);
const sqlText = (value) => `'${String(value).replaceAll("'", "''")}'`;

const databasePath = resolveFromRoot(flag('--db', 'campaign-data/mamba.sqlite'));
const outputDirectory = resolveFromRoot(flag('--out-dir', 'campaign-data/backups'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join(outputDirectory, `mamba-manual-${stamp}.sqlite`);
const sqliteBinary = '/usr/bin/sqlite3';

if (!fs.existsSync(sqliteBinary)) {
  console.error(`找不到 sqlite3:${sqliteBinary}`);
  process.exit(1);
}
if (!fs.existsSync(databasePath)) {
  console.error(`找不到 SQLite:${databasePath}`);
  process.exit(1);
}
fs.mkdirSync(outputDirectory, { recursive: true });
if (fs.existsSync(backupPath)) {
  console.error(`备份目标已存在:${backupPath}`);
  process.exit(1);
}

try {
  execFileSync(sqliteBinary, ['-batch', databasePath, `.backup ${sqlText(backupPath)}`], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
} catch (error) {
  console.error(`建立备份失败:${String(error?.stderr || error?.message || error).trim()}`);
  process.exit(1);
}

try {
  // WAL-mode headers may require a writable -shm file unless SQLite is told the
  // completed backup is immutable. Validation must not mutate the backup folder.
  const immutableBackup = `file:${backupPath}?immutable=1`;
  const quickCheck = execFileSync(sqliteBinary, ['-batch', immutableBackup, 'PRAGMA quick_check;'], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  }).trim();
  if (quickCheck !== 'ok') throw new Error(quickCheck || '没有结果');
} catch (error) {
  console.error(`备份验证失败:${String(error?.stderr || error?.message || error).trim()}`);
  process.exit(1);
}

console.log(`✓ 本机 SQLite 已备份:${path.relative(ROOT, backupPath)}`);
console.log('  quick_check: ok');
