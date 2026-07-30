import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registerStaticRoutes } from "./routes/static.routes.mjs";

const appDir = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-static-snapshot-"));
await fs.mkdir(path.join(appDir, "assets"), { recursive: true });
await fs.writeFile(path.join(appDir, "console.html"), "boot html");
await fs.writeFile(path.join(appDir, "assets", "live-recipient-confirmation.js"), "boot js");

let middleware;
registerStaticRoutes({ use(handler) { middleware = handler; } }, { appDir });
await fs.writeFile(path.join(appDir, "console.html"), "new html");
await fs.writeFile(path.join(appDir, "assets", "live-recipient-confirmation.js"), "new js");

async function request(url) {
  let body;
  const response = {
    writeHead() {},
    end(value) { body = Buffer.isBuffer(value) ? value.toString("utf8") : value; },
  };
  const handled = await middleware(
    { method: "GET", url },
    response,
    { host: "127.0.0.1", port: 8787, appDir, paths: { rootDir: appDir } },
  );
  assert.equal(handled, true);
  return body;
}

assert.equal(await request("/flow-1"), "boot html");
assert.equal(await request("/assets/live-recipient-confirmation.js"), "boot js");

await fs.rm(appDir, { recursive: true, force: true });
console.log("✅ static HTML and JS stay on one server-boot version");
