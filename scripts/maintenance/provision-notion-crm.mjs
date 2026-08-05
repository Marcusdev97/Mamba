import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../../campaign-app/campaign_core.mjs";
import { createNotionCrmProvisioningService } from "../../campaign-app/lib/notion-crm-provisioning-service.mjs";
import { createNotionService } from "../../campaign-app/lib/notion-service.mjs";

function parseArgs(argv) {
  const result = { apply: false, parentPageId: "", confirmation: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") result.apply = false;
    else if (arg === "--apply") result.apply = true;
    else if (arg === "--parent-page-id") result.parentPageId = argv[index += 1] || "";
    else if (arg.startsWith("--parent-page-id=")) result.parentPageId = arg.slice("--parent-page-id=".length);
    else if (arg === "--confirm") result.confirmation = argv[index += 1] || "";
    else if (arg.startsWith("--confirm=")) result.confirmation = arg.slice("--confirm=".length);
    else throw new Error(`不支持的参数：${arg}`);
  }
  return result;
}

export async function runNotionCrmProvisioning({
  rootDir,
  apply = false,
  parentPageId = "",
  confirmation = "",
  notion,
} = {}) {
  const configPath = path.join(rootDir, "campaign-data", "notion_config.json");
  const adapter = notion || createNotionService({ env: await loadEnv(), logger: { log() {} } }).notion;
  const service = createNotionCrmProvisioningService({ notion: adapter, configPath });
  return apply
    ? service.apply({ parentPageId, confirmation })
    : service.dryRun();
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = await runNotionCrmProvisioning({ rootDir, ...args });
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    if (error.report) console.error(JSON.stringify(error.report, null, 2));
    console.error(`[${error.code || "NOTION_CRM_PROVISION_FAILED"}] ${error.message}`);
    process.exitCode = 1;
  }
}
