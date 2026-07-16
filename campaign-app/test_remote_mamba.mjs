import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRemoteMambaService, validateRemoteMambaConfig } from "./lib/remote-mamba-service.mjs";

assert.deepEqual(validateRemoteMambaConfig({
  host: "home-mac.tailnet.ts.net",
  username: "marcus",
  localPort: 18787,
  remotePort: 8787,
}), {
  host: "home-mac.tailnet.ts.net",
  username: "marcus",
  localPort: 18787,
  remotePort: 8787,
  restartWatchdog: true,
});
assert.throws(() => validateRemoteMambaConfig({ host: "home;open", username: "marcus" }), /名称格式不对/);
assert.throws(() => validateRemoteMambaConfig({ host: "home-mac", username: "bad user" }), /用户名格式不对/);
assert.throws(() => validateRemoteMambaConfig({ host: "home-mac", username: "marcus", localPort: 8787 }), /正在给本机 Mamba 使用/);

const spawned = [];
const fakeSpawn = (_file, args) => {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  spawned.push({ args, child });
  return child;
};
const service = createRemoteMambaService({
  rootDir: "/tmp/mamba-remote-test",
  spawnProcess: fakeSpawn,
  execFileAsync: async () => ({ stdout: "", stderr: "" }),
  probe: async () => true,
  delay: async () => {},
});
const connected = await service.connect({
  host: "home-mac",
  username: "marcus",
  localPort: 18787,
  remotePort: 8787,
});
assert.equal(connected.status, "connected");
assert.equal(connected.openUrl, "http://127.0.0.1:18787/control-center");
assert.ok(spawned[0].args.includes("127.0.0.1:18787:127.0.0.1:8787"));
assert.ok(spawned[0].args.includes("marcus@home-mac"));

const stopped = service.stop();
assert.equal(stopped.status, "disconnected");
assert.equal(spawned[0].child.killed, true);
console.log("✅ all remote-mamba tests passed");

