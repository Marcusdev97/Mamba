import assert from "node:assert/strict";
import { actionPatch, appointmentStageFor } from "./routes/follow-up.routes.mjs";

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
assert.throws(
  () => actionPatch(schema, "follow_up", { followUpAt: "" }),
  /下一次跟进日期与时间/,
);

console.log("✅ all follow-up pipeline tests passed");
