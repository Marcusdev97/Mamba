import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { createApp } from "./app/createApp.mjs";
import { controlCenterApiUrl, fetchControlCenter } from "./routes/team-view.routes.mjs";

assert.equal(
  controlCenterApiUrl("http://127.0.0.1:18787/control-center"),
  "http://127.0.0.1:18787/api/control-center",
);
assert.throws(
  () => controlCenterApiUrl("https://example.com/control-center"),
  /只允许读取本机安全映射/,
);

let requestedUrl = "";
const payload = await fetchControlCenter("http://127.0.0.1:8787/api/control-center", {
  fetchImpl: async (url) => {
    requestedUrl = url;
    return {
      ok: true,
      json: async () => ({ ok: true, scope: { device: { id: "test-mac" } } }),
    };
  },
});
assert.equal(requestedUrl, "http://127.0.0.1:8787/api/control-center");
assert.equal(payload.scope.device.id, "test-mac");

const html = await fs.readFile(new URL("./team-view.html", import.meta.url), "utf8");
const staticRoutes = await fs.readFile(new URL("./routes/static.routes.mjs", import.meta.url), "utf8");
const app = await fs.readFile(new URL("./app/createApp.mjs", import.meta.url), "utf8");
const shell = await fs.readFile(new URL("./assets/mamba-shell.js", import.meta.url), "utf8");

assert.match(html, /Mamba Team View/);
assert.match(html, /只读总览/);
assert.match(html, /setInterval\(loadTeamView, 15000\)/);
assert.match(staticRoutes, /"\/team-view": "team-view\.html"/);
assert.match(app, /registerTeamViewRoutes\(router\)/);
assert.match(shell, /label: "Team View", href: "\/team-view"/);

const runtime = {
  host: "127.0.0.1",
  port: 0,
  appDir: new URL(".", import.meta.url).pathname,
  paths: { rootDir: new URL("..", import.meta.url).pathname },
  handlers: {},
  device: { id: "test-mac", name: "Test Mac", hostname: "test.local" },
  settings: { snapshot: () => ({ brain: { enabled: false }, notion: {} }) },
  telegramHub: { enabled: false },
  remoteMamba: {
    snapshot: async () => ({
      status: "disconnected",
      error: "",
      openUrl: "",
      config: { host: "second-mac" },
    }),
  },
};
const server = http.createServer(createApp(runtime));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
runtime.port = server.address().port;
try {
  const response = await fetch(`http://127.0.0.1:${runtime.port}/api/team-view`);
  const team = await response.json();
  assert.equal(response.status, 200);
  assert.equal(team.ok, true);
  assert.equal(team.readOnly, true);
  assert.equal(team.devices.length, 2);
  assert.equal(team.devices[0].connected, true);
  assert.equal(team.devices[0].data.scope.device.id, "test-mac");
  assert.equal(team.devices[1].connected, false);
  assert.match(team.devices[1].error, /尚未连接/);
} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log("✅ Team View tests passed");
