import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mamba-local-db-tools-'));
const sourcePath = path.join(tempDirectory, 'source.sqlite');
const backupDirectory = path.join(tempDirectory, 'backups');
const panelPath = path.join(tempDirectory, 'panel.html');
const sqliteBinary = '/usr/bin/sqlite3';

const run = (script, args = []) => spawnSync(process.execPath, [script, ...args], {
  cwd: ROOT,
  encoding: 'utf8',
});

try {
  execFileSync(sqliteBinary, ['-batch', sourcePath, `
    CREATE TABLE contacts (
      contact_key TEXT PRIMARY KEY,
      display_name TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO contacts VALUES (
      'test-contact',
      'Local Tool Test',
      '2026-08-05T00:00:00.000Z',
      '2026-08-05T00:00:00.000Z'
    );
  `]);

  const backupResult = run('tools/backup-local-database.mjs', [
    '--db', sourcePath,
    '--out-dir', backupDirectory,
  ]);
  assert.equal(backupResult.status, 0, backupResult.stderr || backupResult.stdout);
  assert.match(backupResult.stdout, /quick_check: ok/);

  const backups = fs.readdirSync(backupDirectory).filter((name) => name.endsWith('.sqlite'));
  assert.equal(backups.length, 1);
  const backupPath = path.join(backupDirectory, backups[0]);
  const immutableBackup = `file:${backupPath}?immutable=1`;
  assert.equal(execFileSync(sqliteBinary, ['-batch', immutableBackup, 'PRAGMA quick_check;'], { encoding: 'utf8' }).trim(), 'ok');
  assert.equal(execFileSync(sqliteBinary, ['-batch', immutableBackup, 'SELECT display_name FROM contacts;'], { encoding: 'utf8' }).trim(), 'Local Tool Test');

  const panelResult = run('tools/sql-html/build.mjs', [
    '--db', sourcePath,
    '--out', panelPath,
  ]);
  assert.equal(panelResult.status, 0, panelResult.stderr || panelResult.stdout);
  const panel = fs.readFileSync(panelPath, 'utf8');
  assert.match(panel, /Local Tool Test/);
  assert.doesNotMatch(panel, /btn-pg|PostgreSQL|Postgres/);

  const retiredResult = run('tools/sql-html/build.mjs', ['--global', '--out', panelPath]);
  assert.equal(retiredResult.status, 2);
  assert.match(retiredResult.stderr, /已退役/);

  console.log('✓ local database tools tests passed');
} finally {
  fs.rmSync(tempDirectory, { recursive: true, force: true });
}
