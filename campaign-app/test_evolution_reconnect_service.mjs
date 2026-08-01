import assert from "node:assert/strict";
import { createEvolutionReconnectService } from "./lib/evolution-reconnect-service.mjs";

function service(overrides = {}) {
  return createEvolutionReconnectService({
    listInstances: async () => [{ name: "wa_03", status: "CLOSE", allowedOnThisDevice: true }],
    logoutInstanceSession: async () => ({ status: "SUCCESS" }),
    requestQr: async () => "data:image/png;base64,qr",
    ...overrides,
  });
}

const connected = await service().begin({ instanceName: "wa_03" });
assert.equal(connected.instancePreserved, true);
assert.equal(connected.sessionReset, true);
assert.equal(connected.pending, false);
assert.match(connected.qr, /^data:image\/png/);

const pending = await service({ requestQr: async () => null }).begin({ instanceName: "wa_03" });
assert.equal(pending.pending, true);
assert.equal(pending.qr, null);

const delayed = await service({
  requestQr: async () => { throw new Error("connect endpoint not ready"); },
}).begin({ instanceName: "wa_03" });
assert.equal(delayed.pending, true);
assert.match(delayed.qrError, /not ready/);

await assert.rejects(
  () => service().begin({ instanceName: "wa_03", isCampaignRunning: true }),
  (error) => error.statusCode === 409 && error.details.code === "CAMPAIGN_RUNNING",
);

await assert.rejects(
  () => service({
    listInstances: async () => [{ name: "wa_03", status: "OPEN", allowedOnThisDevice: true }],
  }).begin({ instanceName: "wa_03" }),
  (error) => error.statusCode === 409 && error.details.code === "EVOLUTION_INSTANCE_ALREADY_OPEN",
);

await assert.rejects(
  () => service({
    listInstances: async () => [{ name: "wa_03", status: "CLOSE", allowedOnThisDevice: false }],
  }).begin({ instanceName: "wa_03" }),
  (error) => error.statusCode === 403 && error.details.code === "EVOLUTION_INSTANCE_DEVICE_BLOCKED",
);

let statusReads = 0;
const recovered = await service({
  listInstances: async () => {
    statusReads += 1;
    return [{ name: "wa_03", status: "CLOSE", allowedOnThisDevice: true }];
  },
  logoutInstanceSession: async () => { throw new Error("HTTP 500 after logout"); },
}).begin({ instanceName: "wa_03" });
assert.equal(statusReads, 2);
assert.equal(recovered.logoutRecovered, true);

await assert.rejects(
  () => service({
    listInstances: async () => [{ name: "wa_03", status: "OPENING", allowedOnThisDevice: true }],
    logoutInstanceSession: async () => { throw new Error("logout failed"); },
  }).begin({ instanceName: "wa_03" }),
  (error) => error.statusCode === 503 && error.details.code === "EVOLUTION_LOGOUT_FAILED",
);

console.log("✅ Evolution reconnect service tests passed");
