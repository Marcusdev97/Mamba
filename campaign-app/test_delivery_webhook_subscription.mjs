import assert from "node:assert/strict";
import fs from "node:fs";

for (const file of ["blaster_tracker.mjs", "brain_service.mjs"]) {
  const source = fs.readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
  assert.match(
    source,
    /const events = \["MESSAGES_UPSERT", "MESSAGES_UPDATE"\];/,
    `${file} must subscribe to message upserts and delivery updates`,
  );
}

console.log("✅ Evolution delivery webhook subscription tests passed");
