import assert from "node:assert/strict";
import { actionPatch, appointmentStageFor, buildFollowUpDesk } from "./routes/follow-up.routes.mjs";

const schema = {
  Status: { type: "select" },
  "Sequence Status": { type: "select" },
  "Next Action": { type: "select" },
  "AI Summary": { type: "rich_text" },
  "Reply Checked At": { type: "date" },
  "Follow Up At": { type: "date" },
  Priority: { type: "select" },
  "Appointment Date": { type: "date" },
  "Appointment Time": { type: "rich_text" },
  "Appointment Place": { type: "rich_text" },
  "Appointment Status": { type: "select" },
  "Assigned Sales": { type: "rich_text" },
  "Sales Notes": { type: "rich_text" },
};

assert.equal(appointmentStageFor({ status: "Appointment", nextAction: "Ask Viewing" }), "Viewing Interest");
assert.equal(appointmentStageFor({ appointmentStatus: "Confirmed" }), "Confirmed");

const confirmed = actionPatch(schema, "save_appointment", {
  appointmentStatus: "Confirmed",
  appointmentDate: "2026-07-18",
  appointmentTime: "2:00 PM",
  appointmentPlace: "Gen Starz Gallery",
  assignedSales: "Marcus",
  followUpAt: "2026-07-18T12:00",
  note: "Customer confirmed by WhatsApp",
});

assert.equal(confirmed["Appointment Status"].select.name, "Confirmed");
assert.equal(confirmed.Status.select.name, "Appointment");
assert.equal(confirmed["Next Action"].select.name, "Appointment Confirmed");
assert.equal(confirmed["Sequence Status"].select.name, "Human Takeover");
assert.equal(confirmed.Priority.select.name, "HIGH");
assert.equal(confirmed["Appointment Time"].rich_text[0].text.content, "2:00 PM");
assert.equal(confirmed["Assigned Sales"].rich_text[0].text.content, "Marcus");

assert.throws(
  () => actionPatch(schema, "save_appointment", { appointmentStatus: "Confirmed" }),
  /Appointment Date/,
);
const followed = actionPatch(schema, "follow_up", { followUpAt: "" }, "2026-07-13T02:00:00.000Z");
assert.equal(followed["Follow Up At"].date.start, "2026-07-14T02:00:00.000Z");

const called = actionPatch(schema, "call", {}, "2026-07-13T02:00:00.000Z");
assert.equal(called["Follow Up At"].date.start, "2026-07-14T02:00:00.000Z");

const customDate = actionPatch(schema, "send_price", { followUpAt: "2026-07-20T15:30:00+08:00" }, "2026-07-13T02:00:00.000Z");
assert.equal(customDate["Follow Up At"].date.start, "2026-07-20T07:30:00.000Z");

const done = actionPatch(schema, "done", {}, "2026-07-13T02:00:00.000Z");
assert.equal(done["Follow Up At"].date, null);

const desk = buildFollowUpDesk([
  { id: "unscheduled", status: "Warm", lastReplyText: "price?", aiCategory: "Price Inquiry", nextAction: "Send Price" },
  { id: "overdue", status: "Follow Up", lastReplyText: "later", followUpAt: "2026-07-12T02:00:00.000Z" },
  { id: "future", status: "Follow Up", lastReplyText: "next week", followUpAt: "2026-07-20T02:00:00.000Z" },
  { id: "stopped", status: "Stop", stopFlag: true, lastReplyText: "stop" },
  { id: "completed", status: "Warm", nextAction: "Done", lastReplyText: "thanks" },
], new Date("2026-07-13T04:00:00.000Z").getTime());

assert.equal(desk.summary.total, 3, "STOP and Done are not active follow-up work");
assert.equal(desk.summary.today, 2, "Today includes unscheduled and overdue work");
assert.equal(desk.summary.overdue, 1);
assert.equal(desk.summary.hot, 1);
assert.equal(desk.summary.stop, 1);
assert.equal(desk.records.find((record) => record.id === "unscheduled").bucket, "today");
assert.equal(desk.records.some((record) => record.id === "completed"), false);

console.log("✅ all follow-up pipeline tests passed");
