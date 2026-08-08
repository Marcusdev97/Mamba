import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

export function createGitInspectorService({ rootDir } = {}) {
  async function run(args) { const result = await execFileAsync("git", args, { cwd: rootDir, timeout: 10000, maxBuffer: 1024 * 1024 }); return String(result.stdout).trim(); }
  return { async snapshot() {
    const [branch, head, status, numstat] = await Promise.all([run(["branch", "--show-current"]), run(["rev-parse", "HEAD"]), run(["status", "--short"]), run(["diff", "--numstat"])]);
    return { branch, head, dirty: Boolean(status), status: status.split("\n").filter(Boolean).slice(0,200), numstat: numstat.split("\n").filter(Boolean).slice(0,200) };
  } };
}
