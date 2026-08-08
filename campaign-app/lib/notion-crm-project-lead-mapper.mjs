import { approvedHumanFields } from "../domain/notion-crm-sync.mjs";

function clean(value) {
  return String(value ?? "").trim();
}

const title = (value) => ({ title: clean(value) ? [{ type: "text", text: { content: clean(value) } }] : [] });
const text = (value) => ({ rich_text: clean(value) ? [{ type: "text", text: { content: clean(value).slice(0, 1900) } }] : [] });
const select = (value) => ({ select: clean(value) ? { name: clean(value).slice(0, 100) } : null });
const date = (value) => ({ date: value ? { start: value } : null });
const number = (value) => ({ number: value === null || value === undefined || value === "" ? null : Number(value) });
const multiSelect = (values) => ({ multi_select: (Array.isArray(values) ? values : []).map((value) => ({ name: clean(value).slice(0, 100) })).filter((item) => item.name) });
const relation = (pageId) => ({ relation: pageId ? [{ id: pageId }] : [] });

function pageText(page, name) {
  const property = page?.properties?.[name];
  return (property?.title || property?.rich_text || []).map((item) => item?.plain_text || item?.text?.content || "").join("").trim();
}

function pageSelect(page, name) {
  return page?.properties?.[name]?.select?.name || "";
}

export function projectLeadHumanValuesFromPage(page) {
  return approvedHumanFields("projectLeads", {
    Project: pageText(page, "Project"),
    "Lead Source": pageSelect(page, "Lead Source"),
    "Buying Purpose": pageSelect(page, "Buying Purpose"),
    "Budget Min": page?.properties?.["Budget Min"]?.number ?? null,
    "Budget Max": page?.properties?.["Budget Max"]?.number ?? null,
    "Preferred Area": (page?.properties?.["Preferred Area"]?.multi_select || []).map((item) => item.name).filter(Boolean),
    "Preferred Property Type": pageText(page, "Preferred Property Type"),
    "Unit Preference": pageText(page, "Unit Preference"),
    "Room Requirement": pageText(page, "Room Requirement"),
    "Tenure Preference": pageText(page, "Tenure Preference"),
    "Transport Requirement": pageText(page, "Transport Requirement"),
    "Buying Timeline": pageSelect(page, "Buying Timeline"),
    Temperature: pageSelect(page, "Temperature"),
    "Interest Level": pageSelect(page, "Interest Level"),
    "Project Stage": pageSelect(page, "Project Stage"),
    "Main Objection": pageText(page, "Main Objection"),
    "Decision Maker": pageText(page, "Decision Maker"),
    "Loan Readiness": pageText(page, "Loan Readiness"),
    "Current Property Ownership": pageText(page, "Current Property Ownership"),
    "Next Action": pageText(page, "Next Action"),
    "Next Follow-up At": page?.properties?.["Next Follow-up At"]?.date?.start || null,
    "Assigned Agent": pageText(page, "Assigned Agent"),
    "Lost Reason": pageText(page, "Lost Reason"),
    "Stage Change Reason": pageText(page, "Stage Change Reason"),
  });
}

export function projectLeadProperties(lead, projectLeadId, { customerPageId = "", syncStatus = "Synced" } = {}) {
  const human = approvedHumanFields("projectLeads", lead.humanValues || {});
  return {
    "Project Lead ID": title(projectLeadId),
    Customer: relation(customerPageId),
    Project: text(human.Project),
    "Lead Source": select(human["Lead Source"]),
    "Buying Purpose": select(human["Buying Purpose"]),
    "Budget Min": number(human["Budget Min"]),
    "Budget Max": number(human["Budget Max"]),
    "Preferred Area": multiSelect(human["Preferred Area"]),
    "Preferred Property Type": text(human["Preferred Property Type"]),
    "Unit Preference": text(human["Unit Preference"]),
    "Room Requirement": text(human["Room Requirement"]),
    "Tenure Preference": text(human["Tenure Preference"]),
    "Transport Requirement": text(human["Transport Requirement"]),
    "Buying Timeline": select(human["Buying Timeline"]),
    Temperature: select(human.Temperature),
    "Interest Level": select(human["Interest Level"]),
    "Project Stage": select(human["Project Stage"]),
    "Main Objection": text(human["Main Objection"]),
    "Decision Maker": text(human["Decision Maker"]),
    "Loan Readiness": text(human["Loan Readiness"]),
    "Current Property Ownership": text(human["Current Property Ownership"]),
    "Next Action": text(human["Next Action"]),
    "Last Flow Sent": text(lead.lastFlowSent),
    "Next Flow": text(lead.nextFlow),
    "Sequence Status": select(lead.sequenceStatus || "Active"),
    "Stop Flag": { checkbox: Boolean(lead.stopFlag) },
    "Last Contact At": date(lead.lastContactAt),
    "Next Follow-up At": date(human["Next Follow-up At"]),
    "Assigned Agent": text(human["Assigned Agent"]),
    "Lost Reason": text(human["Lost Reason"]),
    "Stage Change Reason": text(human["Stage Change Reason"]),
    "SQLite Updated At": date(lead.updatedAt),
    "Sync Status": select(syncStatus),
  };
}

export function stableIdFromPage(page, propertyName) {
  return pageText(page, propertyName);
}
