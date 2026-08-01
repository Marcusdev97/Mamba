import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

const sendHtml = await fs.readFile(new URL("./send.html", import.meta.url), "utf8");
const inlineScripts = (html) => [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
  .map((match) => match[1])
  .join("\n");
const sendScript = inlineScripts(sendHtml);
assert.doesNotThrow(() => new vm.Script(sendScript), "Send workspace inline JavaScript must parse");
assert.match(sendHtml, /class="campaign-page-head"/);
assert.match(sendHtml, /id="workspaceTitle">📣 Campaign Center/);
assert.match(sendHtml, /id="tab-campaign"[^>]*>[^<]*<span class="dot"><\/span>Campaign 安排/);
assert.match(sendHtml, /id="planner-flow1"/);
assert.match(sendHtml, /id="planner-next"/);
assert.match(sendHtml, /src="\/flow-1\?embedded=1&amp;view=setup"/);
assert.match(sendHtml, /data-src="\/next-flow\?embedded=1&amp;view=setup"/);
assert.match(sendHtml, /id="tab-monitor"/);
assert.doesNotMatch(sendHtml, /id="tab-refresh"|id="frame-refresh"/, "Customer Refresh belongs to the Customers sidebar, not Campaign Center");
assert.match(sendHtml, /id="monitorPage"/);
assert.match(sendHtml, /class="campaign-monitors"[^>]+hidden/);
assert.match(sendHtml, /class="tab-count hidden" id="monitorTabCount"/);
assert.match(sendHtml, /id="frame-campaign-monitor"[^>]+view=monitor/);
assert.match(sendHtml, /id="campaignRunDetailTitle">Campaign 发送详情/);
assert.match(sendHtml, /发送模式 · 每个号码各自设/);
assert.doesNotMatch(sendHtml, /id="campaign-flow1"|id="campaign-next"|id="campaignWorkspace"/, "Flow types belong inside the single Campaign planning workspace");
assert.doesNotMatch(sendHtml, /href="\/knowledge">🧠 脑编辑器/, "Sidebar already owns global navigation links");
assert.match(sendScript, /function showCampaign\(which\)/);
assert.match(sendScript, /monitorPage\.classList\.toggle\("hidden", which !== "monitor"\)/);
assert.match(sendScript, /mamba-campaign-monitor-height/);
assert.match(sendScript, /function syncCampaignRunDetail\(runs\)/);
assert.match(sendScript, /campaignRunFlowLabel\(tracked\.state\)/);
assert.match(sendScript, /function monitorRunNeedsAttention\(run\)/);
assert.match(sendScript, /detail\.classList\.toggle\("hidden", !tracked\)/);
assert.doesNotMatch(sendHtml, /没有正在运行的 Batch/);
assert.match(sendScript, /document\.getElementById\("workspaceTitle"\)\.textContent/);

const nextFlowHtml = await fs.readFile(new URL("./next-flow.html", import.meta.url), "utf8");
const nextFlowScript = inlineScripts(nextFlowHtml);
assert.doesNotThrow(() => new vm.Script(nextFlowScript), "Next Flow inline JavaScript must parse");
assert.match(nextFlowHtml, /mamba-embedded/);
assert.match(nextFlowHtml, /mamba-setup-view #statusPanel \{ display:none !important; \}/);
assert.match(nextFlowHtml, /window\.parent\?\.show\?\.\("monitor"\)/);
assert.match(nextFlowHtml, /class="page-intro"/);
assert.match(nextFlowScript, /function replacementRunningRun\(status\)/);
assert.match(nextFlowScript, /s = await api\(`\/api\/status\?runId=/);

const flowOneHtml = await fs.readFile(new URL("./console.html", import.meta.url), "utf8");
const flowOneScript = inlineScripts(flowOneHtml);
assert.doesNotThrow(() => new vm.Script(flowOneScript), "Flow 1 inline JavaScript must parse");
assert.match(flowOneHtml, /html\.mamba-embedded \.top \{ display:none; \}/);
assert.match(flowOneHtml, /mamba-setup-view #progressCard \{ display:none !important; \}/);
assert.match(flowOneHtml, /mamba-monitor-view \.setup-only/);
assert.match(flowOneHtml, /window\.parent\?\.show\?\.\("monitor"\)/);
assert.doesNotMatch(flowOneHtml, /<span class="step-no">4<\/span>/);

const refreshHtml = await fs.readFile(new URL("./refresh.html", import.meta.url), "utf8");
assert.match(refreshHtml, /html\.mamba-embedded \.top\{display:none\}/);
assert.match(refreshHtml, /<script src="\/assets\/mamba-shell\.js" defer><\/script>/, "Standalone Refresh page must load the shared sidebar shell");
assert.doesNotMatch(refreshHtml, /<nav class="nav">/, "Global navigation comes from the sidebar");

const shellScript = await fs.readFile(new URL("./assets/mamba-shell.js", import.meta.url), "utf8");
assert.doesNotThrow(() => new vm.Script(shellScript), "Sidebar JavaScript must parse");
assert.match(shellScript, /title: "Customers"[\s\S]+label: "Refresh Customers", href: "\/refresh"/);
assert.doesNotMatch(shellScript, /label: "Campaign Center"[^\n]+"\/refresh"/);

console.log("✅ Send workspace and monitor UI tests passed");
