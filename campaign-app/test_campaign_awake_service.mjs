import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createCampaignAwakeService } from "./lib/campaign-awake-service.mjs";

const spawned = [];
function fakeSpawn(command, args) {
  const child = new EventEmitter();
  child.command = command;
  child.args = args;
  child.killedWith = null;
  child.unref = () => {};
  child.kill = (signal) => {
    child.killedWith = signal;
    return true;
  };
  spawned.push(child);
  return child;
}

const service = createCampaignAwakeService({ platform: "darwin", spawnImpl: fakeSpawn });
service.acquire("run_a");
service.acquire("run_b");
assert.equal(spawned.length, 1, "parallel Campaigns must share one caffeinate process");
assert.deepEqual(spawned[0].args, ["-i", "-s"]);
assert.equal(service.snapshot().active, true);
service.release("run_a");
assert.equal(spawned[0].killedWith, null, "guard stays active while another run owns a lease");
service.release("run_b");
assert.equal(spawned[0].killedWith, "SIGTERM");
assert.equal(service.snapshot().active, false);

const linux = createCampaignAwakeService({ platform: "linux", spawnImpl: fakeSpawn });
linux.acquire("run_linux");
assert.equal(linux.snapshot().supported, false);

console.log("✅ campaign awake service tests passed");
