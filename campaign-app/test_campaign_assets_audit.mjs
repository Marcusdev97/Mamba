import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { auditCampaignAssets } from "../scripts/maintenance/audit-campaign-assets.mjs";

const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-assets-audit-"));
const assetsDir = path.join(rootDir, "campaign-assets");
const imagesDir = path.join(assetsDir, "images");
await fs.mkdir(imagesDir, { recursive: true });
await fs.writeFile(path.join(assetsDir, "projects.json"), JSON.stringify({
  projects: [{ id: "alpha", name: "Alpha", config: "alpha.json" }],
}));
await fs.writeFile(path.join(assetsDir, "alpha.json"), JSON.stringify({
  campaignId: "alpha",
  part1: {
    variants: [
      { id: "alpha-one", media: "images/used.png" },
      { id: "alpha-two", media: "images/missing.png" },
    ],
  },
}));
await fs.writeFile(path.join(assetsDir, "alpha_legacy.json"), JSON.stringify({
  campaignId: "alpha_old",
  part1: { variants: [] },
}));
await fs.writeFile(path.join(assetsDir, "image_aliases.json"), JSON.stringify({
  "Used alias": "used.png",
}));
await fs.writeFile(path.join(imagesDir, "used.png"), "same-image");
await fs.writeFile(path.join(imagesDir, "duplicate.png"), "same-image");
await fs.writeFile(path.join(imagesDir, "orphan.png"), "orphan");

const report = auditCampaignAssets({ rootDir });
assert.equal(report.mode, "audit-only");
assert.equal(report.summary.registeredProjects, 1);
assert.equal(report.summary.missingMedia, 1);
assert.equal(report.summary.duplicateContentGroups, 1);
assert.deepEqual(report.unregisteredCampaignConfigs, ["alpha_legacy.json"]);
assert.ok(report.unreferencedMedia.includes("images/duplicate.png"));
assert.ok(report.unreferencedMedia.includes("images/orphan.png"));
assert.ok(report.problems.some((item) => item.code === "REFERENCED_MEDIA_MISSING"));

await fs.rm(rootDir, { recursive: true, force: true });
console.log("✅ Campaign assets audit tests passed");
