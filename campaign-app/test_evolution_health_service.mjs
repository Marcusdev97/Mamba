import assert from "node:assert/strict";
import { createEvolutionHealthService } from "./lib/evolution-health-service.mjs";

const healthy = createEvolutionHealthService({
  dockerInfo: async () => "29.1.3",
  listInstances: async () => [
    { name: "wa_01", status: "open", number: "60111111111", integration: "WHATSAPP-BAILEYS" },
    { name: "wa_03", status: "OPEN", number: "60133333333", integration: "WHATSAPP-BUSINESS" },
  ],
});
const open = await healthy.check({ requiredInstances: ["wa_01", "wa_03"] });
assert.equal(open.docker.ok, true);
assert.equal(open.evolution.ok, true);
assert.equal(open.whatsapp.ok, true);
assert.equal(open.healthy, true);
assert.equal(open.instances[0].provider.key, "BAILEYS");
assert.equal(open.instances[1].provider.key, "META_CLOUD_API");

const partial = createEvolutionHealthService({
  dockerInfo: async () => "29.1.3",
  listInstances: async () => [
    { name: "wa_01", status: "close" },
    { name: "wa_03", status: "open" },
  ],
});
const oneClosed = await partial.check({ requiredInstances: ["wa_01"] });
assert.equal(oneClosed.evolution.ok, true, "instance failure must not masquerade as API failure");
assert.equal(oneClosed.whatsapp.code, "WHATSAPP_INSTANCE_NOT_OPEN");
assert.match(oneClosed.whatsapp.detail, /wa_01 \(CLOSE\)/);

const inferredDocker = createEvolutionHealthService({
  dockerInfo: async () => { throw new Error("docker socket permission denied"); },
  listInstances: async () => [{ name: "wa_01", status: "open" }],
});
const inferred = await inferredDocker.check({ requiredInstances: ["wa_01"] });
assert.equal(inferred.docker.ok, true, "a live authenticated Evolution API proves its container host is running");
assert.equal(inferred.docker.code, "DOCKER_HOST_INFERRED_ONLINE");

const dockerDown = createEvolutionHealthService({
  dockerInfo: async () => { throw new Error("Cannot connect to the Docker daemon"); },
  listInstances: async () => { throw new Error("fetch failed"); },
});
const offline = await dockerDown.check();
assert.equal(offline.docker.code, "DOCKER_DAEMON_OFFLINE");
assert.equal(offline.evolution.code, "EVOLUTION_API_OFFLINE");
assert.match(offline.docker.detail, /不是 WhatsApp 号码 restriction/);

console.log("✅ evolution health service tests passed");
