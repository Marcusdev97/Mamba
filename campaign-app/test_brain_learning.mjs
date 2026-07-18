import assert from "node:assert/strict";
import { createRouter } from "./lib/http.mjs";
import {
  goldenProperties,
  learningCandidateFromPage,
  learningKeyFor,
  learningQueueSnapshot,
  learningTypeFor,
  objectionProperties,
  prepareGoldenImport,
  registerBrainLearningRoutes,
} from "./routes/brain-learning.routes.mjs";

const text = (value) => [{ plain_text: value }];
const page = {
  id: "4272e2ed-bf64-4f44-b670-c71ae4276051",
  created_time: "2026-07-12T03:00:00.000Z",
  properties: {
    "Reply Summary": { title: text("Price can lower?") },
    "AI Draft": { rich_text: text("Let me check.") },
    "Final Sent": { rich_text: text("I can check the latest package. Which layout do you prefer?") },
    Action: { select: { name: "Edited" } },
    Route: { select: { name: "Price" } },
    Project: { select: { name: "Gen Starz" } },
    Language: { select: { name: "EN" } },
    Timestamp: { date: { start: "2026-07-12T03:00:00.000Z" } },
  },
};

const candidate = learningCandidateFromPage(page);
assert.equal(candidate.learningStatus, "Pending");
assert.equal(candidate.learningType, "Golden");
assert.equal(candidate.action, "Edited");
assert.equal(candidate.customerText, "Price can lower?");

assert.equal(learningTypeFor("Complaint"), "Objection");
assert.equal(learningTypeFor("Not Interested"), "Objection");
assert.equal(learningTypeFor("Viewing"), "Golden");

const rejected = learningCandidateFromPage({
  ...page,
  properties: { ...page.properties, Action: { select: { name: "Takeover" } } },
});
assert.equal(rejected, null);

const keyInput = { ...candidate, learningType: "Golden" };
const key1 = learningKeyFor(keyInput);
const key2 = learningKeyFor({ ...keyInput, customerText: "  PRICE   can lower? " });
assert.equal(key1, key2);
assert.equal(key1.length, 20);

const golden = goldenProperties({ ...candidate, note: "Good question back to qualify intent." }, key1);
assert.equal(golden["Golden Key"].rich_text[0].text.content, key1);
assert.match(golden["Conversation Text"].rich_text[0].text.content, /Customer: Price can lower\?/);
assert.equal(golden["Customer Type"].select.name, "Unknown");
assert.equal(golden.Outcome.select.name, "Warm");

const fullContext = [
  "[2026-07-12T02:00:00.000Z] SALES: Here are the project details.",
  "[2026-07-12T02:10:00.000Z] CUSTOMER: Price can lower?",
  "[2026-07-12T02:12:00.000Z] SALES: Which layout do you prefer?",
].join("\n");
const contextual = goldenProperties({ ...candidate, conversationText: fullContext }, learningKeyFor({ ...candidate, conversationText: fullContext }));
assert.equal(contextual["Conversation Text"].rich_text.map((part) => part.text.content).join(""), fullContext);

const objection = objectionProperties({ ...candidate, route: "Complaint", note: "Acknowledge first." }, key1);
assert.equal(objection["Objection Key"].rich_text[0].text.content, key1);
assert.equal(objection["Customer Says"].title[0].text.content, "Price can lower?");

const approvedPage = {
  ...page,
  id: "5272e2ed-bf64-4f44-b670-c71ae4276052",
  properties: {
    ...page.properties,
    "Learning Status": { select: { name: "Approved" } },
  },
};
const snapshot = await learningQueueSnapshot({
  notion: async (method, pathname) => {
    assert.equal(method, "POST");
    assert.equal(pathname, "/databases/reply-log/query");
    return { results: [page, approvedPage], has_more: false };
  },
  aiReplyLogDbId: "reply-log",
  goldenDbId: "golden",
  objectionDbId: "objection",
});
assert.equal(snapshot.summary.Pending, 1);
assert.equal(snapshot.summary.Approved, 1);
assert.equal(snapshot.summary.Rejected, 0);
assert.deepEqual(snapshot.projects, ["Gen Starz"]);

const imported = prepareGoldenImport({
  project: "Binastra",
  outcome: "Viewing Booked",
  salesName: "Marcus",
  privateNames: "Chloe",
  rawConversation: [
    "18/07/2026, 10:20 - Marcus: Hi Chloe, are you buying for own stay?",
    "18/07/2026, 10:21 - Chloe: Yes, can view this Saturday? My number is +6012 345 6789.",
    "18/07/2026, 10:22 - Marcus: Sure, I will arrange the viewing for Saturday.",
  ].join("\n"),
});
assert.equal(imported.item.project, "Binastra");
assert.equal(imported.item.scenario, "Viewing Push");
assert.equal(imported.item.customerType, "Own Stay");
assert.equal(imported.item.outcome, "Viewing Booked");
assert.match(imported.item.conversationText, /^SALES:/m);
assert.match(imported.item.conversationText, /^CUSTOMER:/m);
assert.doesNotMatch(imported.item.conversationText, /Chloe|6012 345 6789/);
assert.match(imported.item.conversationText, /\[NAME\]|\[PHONE\]/);
assert.equal(imported.stats.customerTurns, 1);
assert.equal(imported.stats.salesTurns, 2);
assert.equal(imported.key.length, 20);

const unresolvedImport = prepareGoldenImport({
  project: "Binastra",
  rawConversation: "Marcus: Hello\nClient A: Interested",
});
assert.equal(unresolvedImport.stats.customerTurns, 0);
assert.match(unresolvedImport.warnings.join(" "), /无法自动分辨/);

const goldenPages = [];
let createdGoldenProps = null;
const routeRuntime = {
  host: "127.0.0.1",
  port: 8787,
  systemLogs: { async write() {} },
  brainLearning: {
    aiReplyLogDbId: "reply-log",
    goldenDbId: "golden",
    objectionDbId: "objection",
    systemLogs: { async write() {} },
    async syncBrainCache() { return { golden: goldenPages.length, usable: 25, objections: 20 }; },
    async notion(method, pathname, body) {
      if (method === "GET" && pathname === "/databases/golden") {
        return { properties: { "Golden Key": {}, "Customer Type": {}, Outcome: {} } };
      }
      if (method === "POST" && pathname === "/databases/golden/query") {
        return { results: goldenPages, has_more: false };
      }
      if (method === "POST" && pathname === "/pages") {
        createdGoldenProps = body.properties;
        const key = body.properties["Golden Key"].rich_text[0].text.content;
        goldenPages.push({ id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", properties: { "Golden Key": { rich_text: [{ plain_text: key }] } } });
        return { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", url: "https://notion.example/golden" };
      }
      throw new Error(`Unexpected Notion call: ${method} ${pathname}`);
    },
  },
};
const routeRouter = createRouter(routeRuntime);
registerBrainLearningRoutes(routeRouter);
async function routeRequest(method, url, requestBody) {
  let status = 0;
  let responseBody = "";
  const res = {
    writeHead(value) { status = value; },
    end(value) { responseBody = String(value ?? ""); },
  };
  const req = {
    method,
    url,
    async *[Symbol.asyncIterator]() { if (requestBody !== undefined) yield Buffer.from(JSON.stringify(requestBody)); },
  };
  await routeRouter.dispatch(req, res);
  return { status, body: JSON.parse(responseBody) };
}

const importPayload = {
  project: "Binastra",
  scenario: "Viewing Push",
  customerType: "Own Stay",
  language: "EN",
  outcome: "Viewing Booked",
  note: "Clear next step.",
  rawConversation: "CUSTOMER: Can I view Saturday?\nSALES: Yes, I can arrange 2pm.",
};
const routePreview = await routeRequest("POST", "/api/brain-learning/import/preview", importPayload);
assert.equal(routePreview.status, 200);
assert.equal(routePreview.body.duplicate, false);
assert.equal(routePreview.body.item.outcome, "Viewing Booked");

const routeImport = await routeRequest("POST", "/api/brain-learning/import", importPayload);
assert.equal(routeImport.status, 201);
assert.equal(routeImport.body.created, true);
assert.equal(routeImport.body.cache.golden, 1);
assert.equal(createdGoldenProps.Outcome.select.name, "Viewing Booked");
assert.equal(createdGoldenProps["Customer Type"].select.name, "Own Stay");

const duplicateImport = await routeRequest("POST", "/api/brain-learning/import", importPayload);
assert.equal(duplicateImport.status, 409);
assert.equal(duplicateImport.body.duplicate, true);
assert.equal(goldenPages.length, 1);

console.log("✅ all brain-learning tests passed");
