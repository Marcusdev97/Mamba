import { loadEnv } from "./campaign_core.mjs";
import { createNotionSync } from "./notion_sync.mjs";

const env = await loadEnv();
const sync = await createNotionSync({ env });

console.log("MAMBA NOTION SYNC TEST");
console.log("======================");

if (!sync.enabled) {
  console.log("Notion sync: OFF");
  console.log("Open Mamba Settings and add the Notion token first.");
  process.exit(1);
}

const targets = [
  ["Blast Leads", sync.config.databases?.blastLeads ?? sync.config.dataSources.blastLeads ?? sync.config.dataSources.leadCrm],
  ["Ads Leads", sync.config.databases?.adsLeads ?? sync.config.dataSources.adsLeads],
  ["Templates", sync.config.databases?.templates ?? sync.config.dataSources.templates],
  ["Images", sync.config.databases?.images ?? sync.config.dataSources.images],
  ["Recycle Leads", sync.config.databases?.recycleLeads ?? sync.config.dataSources.recycleLeads],
  ["Campaign Runs", sync.config.databases?.campaignRuns ?? sync.config.dataSources.campaignRuns],
];

let failed = 0;
for (const [label, id] of targets) {
  try {
    await sync.queryDataSource(id, undefined, 1);
    console.log(`${label}: OK`);
  } catch (error) {
    failed += 1;
    console.log(`${label}: FAILED`);
    console.log(`  ${error.message}`);
  }
}

if (failed) {
  console.log("");
  console.log("Notion sync: PARTIAL / FAILED");
  console.log("Fix: open each failed Notion database, click ... / Add connections, and add your Notion integration.");
  process.exit(1);
}

console.log("");
console.log("Notion sync: ON");
console.log("Listener can now update Notion.");
