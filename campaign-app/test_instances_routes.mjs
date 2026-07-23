import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createRouter } from "./lib/http.mjs";
import {
  isEvolutionInstanceNameConflict,
  readableEvolutionError,
  registerInstancesRoutes,
  suggestedInstanceName,
} from "./routes/instances.routes.mjs";

const duplicate = new Error('/instance/create: HTTP 403 {"message":["This name \\"wa_02\\" is already in use."]}');

assert.equal(isEvolutionInstanceNameConflict(duplicate), true);
assert.equal(isEvolutionInstanceNameConflict(new Error("HTTP 403 Forbidden")), false);
assert.equal(suggestedInstanceName("wa_02", [{ name: "wa_01" }, { name: "wa_03" }]), "wa_04");
assert.equal(
  suggestedInstanceName("marcus-macbook_wa_01", [{ name: "marcus-macbook_wa_02" }]),
  "marcus-macbook_wa_03",
);
assert.match(readableEvolutionError(duplicate, "创建 wa_02"), /Evolution 使用/);
assert.doesNotMatch(readableEvolutionError(duplicate, "创建 wa_02"), /Notion/);

// 完整走一次 route：fetchInstances 没列出 wa_02，但 Evolution 建立时才回同名。
// 这种真实事故必须回 409（可处理的名称冲突），不能再变 503 + Notion 故障。
const writtenLogs = [];
const runtime = {
  host: "127.0.0.1",
  port: 8787,
  whatsapp: {
    listInstances: async () => [{ name: "wa_01" }],
    nextInstanceName: () => "wa_02",
    createInstance: async () => { throw duplicate; },
  },
  systemLogs: {
    write: async (entry) => { writtenLogs.push(entry); },
  },
};
const router = createRouter(runtime);
registerInstancesRoutes(router);

const request = Readable.from([Buffer.from(JSON.stringify({ name: "wa_02" }))]);
request.method = "POST";
request.url = "/api/instance/create";
let status = 0;
let responseText = "";
const response = {
  writeHead(value) { status = value; },
  end(value = "") { responseText += value; },
};
await router.handler(request, response);

const body = JSON.parse(responseText);
assert.equal(status, 409);
assert.equal(body.ok, false);
assert.match(body.error, /wa_02 已经被 Evolution 使用/);
assert.equal(body.details.code, "WHATSAPP_INSTANCE_NAME_CONFLICT");
assert.equal(body.details.suggestedName, "wa_03");
assert.equal(writtenLogs[0].event, "POST /api/instance/create");
assert.doesNotMatch(writtenLogs[0].message, /Notion/);

console.log("✅ all instance route helper tests passed");
