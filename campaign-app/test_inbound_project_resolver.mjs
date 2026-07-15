import assert from "node:assert/strict";
import { resolveInboundProject } from "./lib/inbound-project-resolver.mjs";

const local = await resolveInboundProject({ phone: "60111111111", instanceName: "wa_01" }, {
  resolveLocal: () => "Binastra",
  notion: {
    enabled: true,
    findLeadProjectByPhone: async () => { throw new Error("Notion should not run"); },
  },
});
assert.deepEqual(local, { project: "Binastra", source: "local" });

let notionArgs;
const crossPc = await resolveInboundProject({ phone: "60122222222", instanceName: "wa_02" }, {
  resolveLocal: () => null,
  notion: {
    enabled: true,
    findLeadProjectByPhone: async (...args) => {
      notionArgs = args;
      return "Enlace";
    },
  },
});
assert.deepEqual(crossPc, { project: "Enlace", source: "notion" });
assert.deepEqual(notionArgs, ["60122222222", "wa_02"]);

const stranger = await resolveInboundProject({ phone: "60133333333", instanceName: "wa_01" }, {
  resolveLocal: () => null,
  notion: { enabled: true, findLeadProjectByPhone: async () => null },
});
assert.deepEqual(stranger, { project: null, source: "notion_not_found" });

const unavailable = await resolveInboundProject({ phone: "60144444444" }, {
  resolveLocal: () => null,
  notion: { enabled: false },
});
assert.deepEqual(unavailable, { project: null, source: "notion_unavailable" });

let logged = "";
const failed = await resolveInboundProject({ phone: "60155555555" }, {
  resolveLocal: () => null,
  notion: { enabled: true, findLeadProjectByPhone: async () => { throw new Error("timeout"); } },
  onLog: (message) => { logged = message; },
});
assert.deepEqual(failed, { project: null, source: "notion_error" });
assert.match(logged, /timeout/);

console.log("✅ all inbound project-resolver tests passed");
