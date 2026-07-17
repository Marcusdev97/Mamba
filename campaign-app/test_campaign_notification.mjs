import assert from "node:assert/strict";
import { campaignSenderSummary } from "./lib/campaign-notification.mjs";

assert.equal(campaignSenderSummary({
  instances: [{ name: "wa_01", owner: "60168568756" }],
  assignments: [{ instanceName: "wa_01" }, { instanceName: "wa_01" }],
}), "+60168568756 (wa_01)", "current runs should show the real sender phone once");

assert.equal(campaignSenderSummary({
  instances: [{ name: "wa_01", owner: "" }],
  assignments: [{ instanceName: "wa_01" }],
}), "wa_01", "missing phone evidence should fall back to the connection name");

assert.equal(campaignSenderSummary({
  instances: [{ name: "wa_02", number: "+60111111111" }],
  jobs: [{ instanceName: "wa_02" }],
}), "+60111111111 (wa_02)", "legacy jobs remain compatible");

assert.equal(campaignSenderSummary({
  instances: [{ name: "wa_03", phone: "0123456789" }],
  assignments: [],
}), "+60123456789 (wa_03)", "an empty prepared run can fall back to selected instances");

assert.equal(campaignSenderSummary({}), "-");

console.log("✅ all campaign-notification tests passed");
