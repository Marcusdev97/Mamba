import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import vm from "node:vm";
import { decideTemplateRetirement, findUnfinishedTemplateUsage } from "./domain/template-retirement.mjs";
import { createRouter } from "./lib/http.mjs";
import { registerTemplatesRoutes } from "./routes/templates.routes.mjs";

const PAGE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DATABASE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const activeRunner = {
  running: false,
  state: {
    runId: "run-template-active",
    status: "READY",
    mode: "LIVE",
    assignments: [{ part1Variant: PAGE_ID, extraParts: [] }],
  },
};
assert.deepEqual(findUnfinishedTemplateUsage({ pageId: PAGE_ID, runners: [activeRunner] }), {
  runId: "run-template-active", status: "READY", mode: "LIVE",
});
assert.equal(decideTemplateRetirement({ pageId: PAGE_ID, runners: [activeRunner] }).allowed, false);
assert.equal(decideTemplateRetirement({ pageId: PAGE_ID, runners: [{ ...activeRunner, state: { ...activeRunner.state, status: "COMPLETED" } }] }).allowed, true);
assert.equal(decideTemplateRetirement({ pageId: PAGE_ID, runners: [{ ...activeRunner, state: { ...activeRunner.state, status: "STOPPED" } }] }).allowed, true);
assert.equal(decideTemplateRetirement({ pageId: PAGE_ID, runners: [{ ...activeRunner, state: { ...activeRunner.state, status: "FAILED" } }] }).allowed, true);

function notionPage(status = "Active") {
  return {
    id: PAGE_ID,
    parent: { database_id: DATABASE_ID },
    properties: {
      "Template Name": { title: [{ plain_text: "[Old Project][F01][EN][P1][v1]" }] },
      Project: { select: { name: "Old Project" } },
      "Flow Topic": { select: { name: "Project Template" } },
      Language: { select: { name: "EN" } },
      Part: { select: { name: "Part 1" } },
      Status: { select: { name: status } },
    },
  };
}

function nfSelect(page, name) { return page.properties?.[name]?.select?.name || ""; }
function nfTitle(page, name) { return page.properties?.[name]?.title?.map((item) => item.plain_text || "").join("") || ""; }

async function postDelete({ runners = [], body = {}, status = "Active" } = {}) {
  const calls = [];
  const logs = [];
  const runtime = {
    host: "127.0.0.1",
    port: 8787,
    templates: {
      notionConfig: { databases: { templates: DATABASE_ID } },
      nfSelect,
      nfTitle,
      async notion(method, endpoint, payload) {
        calls.push({ method, endpoint, payload });
        if (method === "GET") return notionPage(status);
        return { id: PAGE_ID };
      },
    },
    campaign: { listRunners: () => runners },
    systemLogs: { async write(entry) { logs.push(entry); } },
  };
  const router = createRouter(runtime);
  registerTemplatesRoutes(router);
  const request = new EventEmitter();
  request.method = "POST";
  request.url = "/api/templates/delete";
  request[Symbol.asyncIterator] = async function* iterator() { yield Buffer.from(JSON.stringify(body)); };
  let statusCode = 0;
  let responseBody = "";
  const response = { writeHead(value) { statusCode = value; }, end(value) { responseBody = String(value || ""); } };
  await router.dispatch(request, response);
  return { calls, logs, statusCode, response: JSON.parse(responseBody) };
}

const missingConfirmation = await postDelete({ body: { pageId: PAGE_ID } });
assert.equal(missingConfirmation.statusCode, 400);
assert.equal(missingConfirmation.calls.length, 0);

const blocked = await postDelete({
  runners: [activeRunner],
  body: { pageId: PAGE_ID, project: "Old Project", templateName: "[Old Project][F01][EN][P1][v1]", confirmation: "RETIRE_TEMPLATE" },
});
assert.equal(blocked.statusCode, 409);
assert.equal(blocked.response.details.code, "TEMPLATE_USED_BY_UNFINISHED_CAMPAIGN");
assert.equal(blocked.calls.some((call) => call.method === "PATCH"), false);

const retired = await postDelete({
  body: { pageId: PAGE_ID, project: "Old Project", templateName: "[Old Project][F01][EN][P1][v1]", confirmation: "RETIRE_TEMPLATE" },
});
assert.equal(retired.statusCode, 200);
assert.deepEqual(retired.calls.at(-1), {
  method: "PATCH",
  endpoint: "/pages/aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa",
  payload: { properties: { Status: { select: { name: "Retired" } } } },
});
assert.equal(retired.response.retired, true);
assert.equal(retired.response.recoverable, true);
assert.equal(retired.logs[0].event, "template_retired");

const html = await fs.readFile(new URL("./templates.html", import.meta.url), "utf8");
assert.match(html, /delete-template-btn/, "Template cards must expose the Delete action");
assert.match(html, /confirmation:\s*"RETIRE_TEMPLATE"/, "Delete UI must send explicit retirement confirmation");
assert.doesNotThrow(() => new vm.Script(html.match(/<script>\s*([\s\S]*?)\s*<\/script>\s*<\/body>/)?.[1] || ""));

console.log("✅ Template Delete safely retires Notion templates and blocks unfinished Campaign usage");
