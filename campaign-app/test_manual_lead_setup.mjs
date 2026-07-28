import assert from "node:assert/strict";
import { createManualLeadSetupService, listManualLeadTypes } from "./lib/manual-lead-setup-service.mjs";

assert.deepEqual(
  listManualLeadTypes().map((item) => item.key),
  ["BLAST", "RECYCLE", "ADS", "OWN"],
);

function fixture({ notionEnabled = true, notionError = null } = {}) {
  const calls = [];
  const localDatabase = {
    async setupManualLead(input) {
      calls.push(["local", input]);
      return {
        originKey: `${input.leadType.toLowerCase()}:general:60123456789`,
        phone: "60123456789",
        name: input.name || "Customer",
        leadType: input.leadType,
        projectCode: input.projectCode,
        projectName: input.projectName,
        instanceName: input.instanceName,
        assignedSenderKey: `device::${input.instanceName}`,
        notionSyncStatus: input.leadType === "OWN" ? "LOCAL_ONLY" : "PENDING",
        createdAt: "2026-07-28T07:00:00.000Z",
      };
    },
    async markManualLeadNotionSync(input) {
      calls.push(["sync", input]);
      return input;
    },
  };
  const conversationLog = {
    async prepareManualContact(input) {
      calls.push(["conversation", input]);
      return input;
    },
  };
  const notionSync = {
    enabled: notionEnabled,
    async upsertManualBlastLead(input) {
      calls.push(["notion-blast", input]);
      if (notionError) throw notionError;
      return { action: "created", pageId: "blast-page" };
    },
    async upsertAdLead(input) {
      calls.push(["notion-ads", input]);
      if (notionError) throw notionError;
      return { action: "created", pageId: "ads-page" };
    },
    async upsertRecycleLead(input) {
      calls.push(["notion-recycle", input]);
      if (notionError) throw notionError;
      return { action: "created", pageId: "recycle-page" };
    },
  };
  const service = createManualLeadSetupService({
    localDatabase,
    conversationLog,
    notionSync,
    loadProjects: async () => [{ id: "binastra", name: "Binastra" }],
  });
  return { service, calls };
}

{
  const { service, calls } = fixture();
  const result = await service.setup({
    phone: "0123456789",
    name: "Own Customer",
    leadType: "OWN",
    instanceName: "wa_01",
  });
  assert.equal(result.notionSyncStatus, "LOCAL_ONLY");
  assert.deepEqual(calls.map(([name]) => name), ["local", "conversation"]);
}

{
  const { service, calls } = fixture();
  const result = await service.setup({
    phone: "0123456789",
    name: "Blast Customer",
    leadType: "BLAST",
    projectId: "binastra",
    instanceName: "wa_03",
  });
  assert.equal(result.notionSyncStatus, "SYNCED");
  assert.equal(calls[0][1].projectCode, "binastra");
  assert.equal(calls.find(([name]) => name === "notion-blast")[1].projectName, "Binastra");
  assert.equal(calls.at(-1)[1].status, "SYNCED");
}

{
  const { service } = fixture();
  await assert.rejects(
    service.setup({ phone: "0123456789", leadType: "BLAST", instanceName: "wa_01" }),
    /必须选择有效的 Project/,
  );
}

{
  const { service, calls } = fixture({ notionError: new Error("offline") });
  const result = await service.setup({
    phone: "0123456789",
    leadType: "ADS",
    instanceName: "wa_01",
  });
  assert.equal(result.notionSyncStatus, "FAILED");
  assert.match(result.warning, /安全保存到本机/);
  assert.equal(calls.at(-1)[1].status, "FAILED");
}

console.log("manual lead setup tests passed");
