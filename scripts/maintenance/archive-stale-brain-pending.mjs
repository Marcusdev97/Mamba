import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, "../..");
const brainDir = path.join(rootDir, "campaign-data", "brain");
const pendingPath = path.join(brainDir, "pending.json");
const archiveDir = path.join(brainDir, "archive");
const apply = process.argv.includes("--apply");
const ttlHoursArg = process.argv.find((arg) => arg.startsWith("--ttl-hours="));
const ttlHours = Number(ttlHoursArg?.split("=")[1] || process.env.BRAIN_PENDING_TTL_HOURS || 72);

if (!Number.isFinite(ttlHours) || ttlHours < 1) {
  throw new Error("--ttl-hours 必须是大于 0 的数字。");
}

const payload = JSON.parse(await fs.readFile(pendingPath, "utf8"));
const pending = payload.pending && typeof payload.pending === "object" ? payload.pending : {};
const awaitingEdit = payload.awaitingEdit && typeof payload.awaitingEdit === "object" ? payload.awaitingEdit : {};
const cutoff = Date.now() - ttlHours * 60 * 60 * 1000;
const stale = {};
const active = {};

for (const [id, item] of Object.entries(pending)) {
  const createdAt = new Date(item?.createdAt || 0).getTime();
  if (!Number.isFinite(createdAt) || createdAt < cutoff) stale[id] = item;
  else active[id] = item;
}

const staleIds = new Set(Object.keys(stale));
const activeAwaitingEdit = Object.fromEntries(
  Object.entries(awaitingEdit).filter(([, pendingId]) => !staleIds.has(String(pendingId))),
);
const staleAwaitingEdit = Object.fromEntries(
  Object.entries(awaitingEdit).filter(([, pendingId]) => staleIds.has(String(pendingId))),
);

console.log(JSON.stringify({
  mode: apply ? "apply" : "dry-run",
  ttlHours,
  total: Object.keys(pending).length,
  stale: Object.keys(stale).length,
  preserved: Object.keys(active).length,
  staleAwaitingEdit: Object.keys(staleAwaitingEdit).length,
}, null, 2));

if (!apply || !Object.keys(stale).length) process.exit(0);

await fs.mkdir(archiveDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const archivePath = path.join(archiveDir, `pending-expired-${stamp}.json`);
await fs.writeFile(archivePath, `${JSON.stringify({
  archivedAt: new Date().toISOString(),
  reason: `older_than_${ttlHours}_hours`,
  pending: stale,
  awaitingEdit: staleAwaitingEdit,
}, null, 2)}\n`, { mode: 0o600 });

const nextPath = `${pendingPath}.maintenance.tmp`;
await fs.writeFile(nextPath, `${JSON.stringify({
  pending: active,
  awaitingEdit: activeAwaitingEdit,
}, null, 2)}\n`, { mode: 0o600 });
await fs.rename(nextPath, pendingPath);

console.log(`Archived stale approvals to ${path.relative(rootDir, archivePath)}`);
