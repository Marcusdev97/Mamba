import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const result = { skipLocalServer: false, failFast: false, match: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--skip-local-server") result.skipLocalServer = true;
    else if (arg === "--fail-fast") result.failFast = true;
    else if (arg === "--match") result.match = argv[index += 1] || "";
    else if (arg.startsWith("--match=")) result.match = arg.slice("--match=".length);
    else throw new Error(`Unsupported argument: ${arg}`);
  }
  return result;
}

const options = parseArgs(process.argv.slice(2));
const appDir = path.dirname(fileURLToPath(import.meta.url));
const skipped = new Set(options.skipLocalServer ? ["test_team_view.mjs"] : []);
const tests = fs.readdirSync(appDir)
  .filter((name) => /^test_.*\.mjs$/.test(name))
  .filter((name) => !skipped.has(name))
  .filter((name) => !options.match || name.includes(options.match))
  .sort();

if (!tests.length) {
  console.error("No test files matched.");
  process.exit(1);
}

const failures = [];
const startedAt = Date.now();
for (const [index, test] of tests.entries()) {
  console.log(`\n[${index + 1}/${tests.length}] ${test}`);
  const result = spawnSync(process.execPath, [path.join(appDir, test)], {
    cwd: appDir,
    env: { ...process.env, MAMBA_TEST_MODE: "1" },
    stdio: "inherit",
  });
  if (result.status !== 0) {
    failures.push({ test, status: result.status, signal: result.signal });
    if (options.failFast) break;
  }
}

const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
if (skipped.size) console.log(`\nSkipped: ${[...skipped].join(", ")}`);
if (failures.length) {
  console.error(`\n❌ ${failures.length}/${tests.length} test files failed in ${seconds}s`);
  for (const failure of failures) console.error(`- ${failure.test}`);
  process.exit(1);
}
console.log(`\n✅ ${tests.length} test files passed in ${seconds}s`);
