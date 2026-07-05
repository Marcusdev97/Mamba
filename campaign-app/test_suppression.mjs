// test_suppression.mjs — offline tests for the global STOP suppression module.
// Run: node test_suppression.mjs
// No network needed: tests phone normalization, snapshot round-trip, and the
// isSuppressed gate — the parts every send/import decision depends on.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePhone, loadSuppressionSync, isSuppressed } from "./suppression.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const snapshotPath = path.join(__dirname, "..", "campaign-data", "suppressed.json");

let fail = 0;
function check(label, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) { console.log(`❌ ${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`); fail += 1; }
}

// --- normalizePhone: must match the rest of the codebase exactly ---
check("MY leading 0", normalizePhone("0168568756"), "60168568756");
check("already 60", normalizePhone("60168568756"), "60168568756");
check("spaces and dashes", normalizePhone("+60 16-856 8756"), "60168568756");
check("wa suffix junk stripped", normalizePhone("60168568756@s.whatsapp.net".replace(/@.*/, "")), "60168568756");
check("too short -> null", normalizePhone("12345"), null);
check("empty -> null", normalizePhone(""), null);
check("null -> null", normalizePhone(null), null);

// --- snapshot round-trip + gate ---
const backup = fs.existsSync(snapshotPath) ? fs.readFileSync(snapshotPath, "utf8") : null;
try {
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  fs.writeFileSync(snapshotPath, JSON.stringify({
    updatedAt: "2026-07-04T00:00:00.000Z",
    count: 2,
    phones: ["60123456789", "60198765432"],
  }));

  const { set, updatedAt } = loadSuppressionSync();
  check("snapshot loads count", set.size, 2);
  check("snapshot loads updatedAt", updatedAt, "2026-07-04T00:00:00.000Z");

  // The gate must catch every FORMAT of the same phone, not just the exact string.
  check("gate: exact match", isSuppressed("60123456789", set), true);
  check("gate: leading-0 format", isSuppressed("0123456789", set), true);
  check("gate: +60 spaced format", isSuppressed("+60 12-345 6789", set), true);
  check("gate: clean phone passes", isSuppressed("60111111111", set), false);
  check("gate: invalid phone passes (not blocked, just invalid)", isSuppressed("abc", set), false);
  check("gate: null set is safe", isSuppressed("60123456789", null), false);

  // Missing snapshot must fail-open with an EMPTY set, never crash.
  fs.rmSync(snapshotPath);
  const empty = loadSuppressionSync();
  check("missing snapshot -> empty set", empty.set.size, 0);
  check("missing snapshot -> null updatedAt", empty.updatedAt, null);
} finally {
  if (backup !== null) fs.writeFileSync(snapshotPath, backup);
  else if (fs.existsSync(snapshotPath)) fs.rmSync(snapshotPath);
}

console.log(fail ? `${fail} test(s) failed` : "✅ all suppression tests passed");
process.exitCode = fail ? 1 : 0;
