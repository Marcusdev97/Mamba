import assert from "node:assert/strict";
import {
  goldenProperties,
  learningCandidateFromPage,
  learningKeyFor,
  learningTypeFor,
  objectionProperties,
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

console.log("✅ all brain-learning tests passed");
