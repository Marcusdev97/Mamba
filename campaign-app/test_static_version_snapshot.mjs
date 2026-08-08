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
  let statusCode;
  let headers;
  const response = {
    writeHead(status, values) { statusCode = status; headers = values; },
    end(value) { body = Buffer.isBuffer(value) ? value.toString("utf8") : value; },
  };
  const handled = await middleware(
    { method: "GET", url },
    response,
    { host: "127.0.0.1", port: 8787, appDir, paths: { rootDir: appDir } },
  );
  assert.equal(handled, true);
  return { body, statusCode, headers };
}

assert.equal((await request("/flow-1")).body, "boot html");
assert.equal((await request("/assets/live-recipient-confirmation.js")).body, "boot js");
const identityRedirect = await request("/customer-identity");
assert.equal(identityRedirect.statusCode, 302);
assert.equal(identityRedirect.headers.Location, "/settings?section=data-maintenance");
const campaignsRedirect = await request("/campaigns");
assert.equal(campaignsRedirect.statusCode, 302);
assert.equal(campaignsRedirect.headers.Location, "/send");

await fs.rm(appDir, { recursive: true, force: true });
console.log("✅ static HTML and JS stay on one server-boot version");
