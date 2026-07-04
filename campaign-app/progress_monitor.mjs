import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const statePath = path.resolve(appDir, "..", "campaign-data", "active-run.json");
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const runOnce = process.argv.includes("--once");

function maskPhone(phone) {
  return `${phone.slice(0, 2)}******${phone.slice(-4)}`;
}

while (true) {
  process.stdout.write("\x1Bc");
  try {
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    const counts = {};
    for (const job of state.assignments) counts[job.status] = (counts[job.status] ?? 0) + 1;
    const current = state.assignments.find((job) => ["SENDING_PART1", "WAITING_PART2", "SENDING_PART2"].includes(job.status));
    const next = state.assignments.find((job) => job.status === "QUEUED");

    console.log("CAMPAIGN PROGRESS");
    console.log("=================");
    console.log(`Run: ${state.runId}`);
    console.log(`Mode: ${state.mode}`);
    console.log(`Status: ${state.status}`);
    console.log(`Progress: ${JSON.stringify(counts)}`);
    if (current) console.log(`Current: ${current.lead.name} (${maskPhone(current.lead.phone)}) - ${current.status} via ${current.instanceName}`);
    if (next) console.log(`Next: ${next.lead.name} at ${new Date(next.scheduledAt).toLocaleTimeString("en-MY")}`);
    console.log(`Updated: ${new Date(state.updatedAt).toLocaleString("en-MY")}`);
  } catch (error) {
    console.log("No campaign run is available yet.");
    console.log(error.message);
  }
  console.log("\nRefreshing every 5 seconds. Press Control+C to stop.");
  if (runOnce) break;
  await wait(5000);
}
