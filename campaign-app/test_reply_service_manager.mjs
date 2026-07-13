import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createReplyServiceManager } from "./lib/reply-service-manager.mjs";

const online = { 8798: false, 8799: false };
const started = [];
const fakeProbe = async (url) => online[url.includes("8798") ? 8798 : 8799];
const fakeSpawn = (_node, args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  const script = args[0];
  if (script.endsWith("blaster_tracker.mjs")) online[8798] = true;
  if (script.endsWith("brain_service.mjs")) online[8799] = true;
  started.push(args);
  return child;
};

const manager = createReplyServiceManager({
  rootDir: "/tmp/mamba-test",
  probe: fakeProbe,
  spawnProcess: fakeSpawn,
  onLog: () => {},
});

const status = await manager.ensureStarted();
assert.deepEqual({ tracker: status.tracker, brain: status.brain }, { tracker: true, brain: true });
assert.equal(started.length, 2);
assert.ok(started[0].includes("--no-webhook"), "tracker must never own the webhook when Brain is managed");

await manager.ensureStarted();
assert.equal(started.length, 2, "online services must not be started twice");

manager.stopManaged();
console.log("✅ all reply-service manager tests passed");
