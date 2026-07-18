import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createReplyServiceManager } from "./lib/reply-service-manager.mjs";

function harness({ brainEnabled }) {
  const online = { 8798: false, 8799: false };
  const started = [];
  const probe = async (url) => online[url.includes("8798") ? 8798 : 8799];
  const spawnProcess = (_node, args) => {
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
    probe,
    spawnProcess,
    onLog: () => {},
    downConfirmDelayMs: 0,
    brainEnabled,
  });
  return { manager, online, started, probe, spawnProcess };
}

const safe = harness({ brainEnabled: false });
const safeStatus = await safe.manager.ensureStarted();
assert.deepEqual(
  { tracker: safeStatus.tracker, brain: safeStatus.brain, mode: safeStatus.mode },
  { tracker: true, brain: false, mode: "tracker-only" },
);
assert.equal(safe.started.length, 1, "tracker-only mode must not start Sales Brain");
assert.ok(!safe.started[0].includes("--no-webhook"), "tracker must own the webhook when Brain is disabled");
safe.manager.stopManaged();

const live = harness({ brainEnabled: true });
const liveStatus = await live.manager.ensureStarted();
assert.deepEqual({ tracker: liveStatus.tracker, brain: liveStatus.brain }, { tracker: true, brain: true });
assert.equal(live.started.length, 2);
assert.ok(live.started[0].includes("--no-webhook"), "tracker must not own the webhook when Brain is enabled");

await live.manager.ensureStarted();
assert.equal(live.started.length, 2, "online services must not be started twice");

let trackerProbeCount = 0;
const transientManager = createReplyServiceManager({
  rootDir: "/tmp/mamba-test",
  probe: async (url) => {
    if (url.includes("8798")) {
      trackerProbeCount += 1;
      return trackerProbeCount > 1;
    }
    return true;
  },
  spawnProcess: live.spawnProcess,
  onLog: () => {},
  downConfirmDelayMs: 0,
  brainEnabled: true,
});
await transientManager.ensureStarted();
assert.equal(live.started.length, 2, "one transient health timeout must not start a duplicate reply service");
transientManager.stopManaged();

const persistedIssues = [];
let issueChild;
const issueManager = createReplyServiceManager({
  rootDir: "/tmp/mamba-test",
  probe: async (url) => url.includes("8798") && Boolean(issueChild),
  spawnProcess: () => {
    issueChild = new EventEmitter();
    issueChild.stdout = new EventEmitter();
    issueChild.stderr = new EventEmitter();
    issueChild.killed = false;
    issueChild.kill = () => { issueChild.killed = true; };
    return issueChild;
  },
  onLog: () => {},
  systemLogs: { write: async (entry) => { persistedIssues.push(entry); } },
  downConfirmDelayMs: 0,
  brainEnabled: false,
});
await issueManager.ensureStarted();
issueChild.stdout.emit("data", `[reply-tracker:issue] ${JSON.stringify({
  level: "error",
  code: "NOTION_AUTH_FAILED",
  message: "Notion 身份验证失败。",
  impact: "客户回复保存在本机。",
  action: "重新保存 token。",
})}\n`);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(persistedIssues.length, 1, "structured tracker issues must be copied into System Logs");
assert.equal(persistedIssues[0].event, "NOTION_AUTH_FAILED");
assert.match(persistedIssues[0].message, /影响.*处理/);
issueManager.stopManaged();

// A healthy-looking but wrong HTTP service on the preferred port must not be
// accepted as Reply Tracker. The manager should move to the next free dynamic
// port and report the conflict to the Dashboard.
const dynamicStarted = [];
const dynamicTracker = new Map([[8798, false], [8800, false], [8801, false]]);
const dynamicOccupied = new Map([[8798, true], [8800, false], [8801, false]]);
const portFromUrl = (url) => Number(new URL(url).port);
const dynamicManager = createReplyServiceManager({
  rootDir: "/tmp/mamba-test",
  trackerPorts: [8798, 8800, 8801],
  probe: async (url) => dynamicTracker.get(portFromUrl(url)) === true,
  portProbe: async (url) => dynamicOccupied.get(portFromUrl(url)) === true,
  spawnProcess: (_node, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; };
    const port = Number(options.env.TRACKER_PORT);
    dynamicTracker.set(port, true);
    dynamicOccupied.set(port, true);
    dynamicStarted.push({ args, port, webhook: options.env.TRACKER_WEBHOOK_URL });
    return child;
  },
  onLog: () => {},
  downConfirmDelayMs: 0,
  brainEnabled: false,
});
const dynamicStatus = await dynamicManager.ensureStarted();
assert.equal(dynamicStatus.tracker, true);
assert.equal(dynamicStatus.trackerPort, 8800, "tracker must skip a wrong service on preferred port 8798");
assert.deepEqual(dynamicStatus.portConflicts, [8798]);
assert.equal(dynamicStarted.length, 1);
assert.equal(dynamicStarted[0].port, 8800);
assert.match(dynamicStarted[0].webhook, /:8800\/webhook\/evolution$/);
dynamicManager.stopManaged();

live.manager.stopManaged();
console.log("✅ all reply-service manager tests passed");
