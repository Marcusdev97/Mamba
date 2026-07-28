import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { createRouter } from "./lib/http.mjs";
import { registerCampaignRoutes } from "./routes/campaign.routes.mjs";

const html = await fs.readFile(new URL("./next-flow.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, "next-flow page must contain its client script");
new vm.Script(script);
assert.match(html, /▶ 继续发送 \(\$\{pendingNow\}\)/, "paused Flow 2-10 work must expose a Continue button");
assert.match(html, /async function resumeNextFlow/, "Continue button must call a dedicated resume action");
assert.match(html, /await api\("\/api\/resume"/, "Continue action must use the resume-safe backend endpoint");

const failedJob = { id: "failed-1", status: "FAILED", error: "timeout", instanceName: "wa_01" };
const sentJob = { id: "sent-1", status: "SENT", instanceName: "wa_01" };
const runner = {
  running: false,
  state: {
    runId: "run_retry_progress",
    project: "Binastra",
    mode: "LIVE",
    flowLabel: "Flow 2 - Layout",
    status: "COMPLETED",
    instances: [{ name: "wa_01" }],
    assignments: [failedJob, sentJob],
    notionSync: {},
  },
  retryFailedOnly() {
    failedJob.status = "QUEUED";
    failedJob.error = null;
    return 1;
  },
  pushLog(message) {
    this.logs = [...(this.logs || []), message];
  },
  async saveState() {},
  snapshot() {
    return { running: this.running, state: this.state };
  },
  async run() {
    await new Promise(() => {});
  },
};

const campaign = {
  getRunner: (runId) => runId === runner.state.runId ? runner : null,
  listRunners: () => [runner],
  setRunner: () => {},
  persistRunners: async () => {},
};
const runtime = {
  campaign,
  systemLogs: { write: async () => {} },
};
const router = createRouter(runtime);
registerCampaignRoutes(router);

let responseStatus = 0;
let responseBody = "";
const req = {
  method: "POST",
  url: "/api/retry-failed",
  async *[Symbol.asyncIterator]() {
    yield Buffer.from(JSON.stringify({ runId: runner.state.runId }));
  },
};
const res = {
  writeHead(status) {
    responseStatus = status;
  },
  end(value) {
    responseBody = String(value ?? "");
  },
};
await router.dispatch(req, res);

assert.equal(responseStatus, 200, responseBody);
assert.deepEqual(runner.state.resumeSession?.jobIds, ["failed-1"]);
assert.equal(runner.state.resumeSession?.total, 1);
assert.equal(failedJob.status, "QUEUED");
assert.equal(sentJob.status, "SENT", "successful customers must stay completed during retry");
assert.match(runner.logs?.join("\n") || "", /本次进度从 0\/1 开始/);

console.log("✅ Flow 2-10 continue/resume UI tests passed");
