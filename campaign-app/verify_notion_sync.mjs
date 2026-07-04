import { loadEnv } from "./campaign_core.mjs";
import { createNotionSync } from "./notion_sync.mjs";

const env = await loadEnv();
const sync = await createNotionSync({ env });

console.log("MAMBA NOTION SYNC TEST");
console.log("======================");

if (!sync.enabled) {
  console.log("Notion sync: OFF");
  console.log("Run 'Set Notion Token.command' first.");
  process.exit(1);
}

try {
  await sync.queryDataSource(sync.config.databases?.blastLeads ?? sync.config.dataSources.blastLeads ?? sync.config.dataSources.leadCrm, undefined, 1);
  await sync.queryDataSource(sync.config.databases?.adsLeads ?? sync.config.dataSources.adsLeads, undefined, 1);
  await sync.queryDataSource(sync.config.databases?.templates ?? sync.config.dataSources.templates, undefined, 1);
  await sync.queryDataSource(sync.config.databases?.images ?? sync.config.dataSources.images, undefined, 1);
  await sync.queryDataSource(sync.config.databases?.recycleLeads ?? sync.config.dataSources.recycleLeads, undefined, 1);
  console.log("Notion sync: ON");
  console.log("Blast Leads: OK");
  console.log("Ads Leads: OK");
  console.log("Templates: OK");
  console.log("Images: OK");
  console.log("Recycle Leads: OK");
  console.log("Listener can now update Notion.");
} catch (error) {
  console.log("Notion sync: FAILED");
  console.log(error.message);
  console.log("");
  console.log("Most common fix: open each Mamba Notion database, click ... / Add connections, and add your Notion integration.");
  process.exit(1);
}
