import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import {
  assessConsent,
  assessContactBudget,
  assessSenderHealth,
  normalizeCampaignSafetyPolicy,
} from "./domain/campaign-safety.mjs";
import { createCampaignSafetyService } from "./lib/campaign-safety-service.mjs";
import { createLocalDatabaseService } from "./lib/local-database-service.mjs";

const now = new Date("2026-08-01T08:00:00.000Z");
const policy = normalizeCampaignSafetyPolicy({
  consent: { mode: "enforce", validityDays: 365 },
  contactBudget: { mode: "enforce", windows: [{ days: 7, maxRuns: 2 }], maxUnansweredRuns: 3 },
  senderHealth: { mode: "enforce", minAttempts: 5, maxConsecutiveFailures: 3 },
});

assert.equal(assessConsent([], policy, now).code, "CONSENT_EVIDENCE_MISSING");
assert.equal(assessConsent([], policy, now).outcome, "BLOCK");
assert.equal(assessConsent([{
  category: "PROPERTY_MARKETING",
  action: "GRANTED",
  occurredAt: "2026-07-01T00:00:00.000Z",
}], policy, now).outcome, "ALLOW");
const revokedWhileOff = assessConsent([{
  category: "PROPERTY_MARKETING",
  action: "REVOKED",
  occurredAt: "2026-07-30T00:00:00.000Z",
}], { consent: { mode: "off" } }, now);
assert.equal(revokedWhileOff.outcome, "BLOCK", "revoked consent must never be bypassed by policy mode");

assert.equal(assessContactBudget({ runCounts: { 7: 1 }, unansweredRuns: 1 }, policy).outcome, "ALLOW");
assert.equal(assessContactBudget({ runCounts: { 7: 2 }, unansweredRuns: 1 }, policy).code, "CONTACT_BUDGET_EXCEEDED");
assert.equal(assessSenderHealth({ attempts: 0 }, {}, policy).code, "SENDER_HEALTH_WARMING_UP");
assert.equal(assessSenderHealth({ attempts: 3, failures: 3, consecutiveFailures: 3 }, {}, policy).outcome, "BLOCK");
assert.equal(assessSenderHealth({ attempts: 0 }, { state: "PAUSED", reasonCode: "MANUAL" }, policy).outcome, "BLOCK");

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-safety-test-"));
const permissionEvents = new Map([
  ["60120000001", [{
    category: "PROPERTY_MARKETING",
    action: "GRANTED",
    sourceType: "PHONE_CALL",
    occurredAt: "2026-07-20T00:00:00.000Z",
  }]],
  ["60120000002", [{
    category: "PROPERTY_MARKETING",
    action: "REVOKED",
    sourceType: "CUSTOMER_REQUEST",
    occurredAt: "2026-07-31T00:00:00.000Z",
  }]],
]);
const savedSenderStates = new Map();
const recordedChecks = [];
const localDatabase = {
  async permissionEventsForPhones(phones) {
    return new Map(phones.map((phone) => [phone, permissionEvents.get(phone) || []]));
  },
  async recordPermissionEvent(event) {
    return { eventId: "permission_test", phone: event.phone, ...event };
  },
  async recordCampaignSafetyChecks(checks) { recordedChecks.push(...checks); },
  async senderSafetyStates(names) {
    return new Map(names.map((name) => [name, savedSenderStates.get(name) || { instanceName: name, state: "HEALTHY" }]));
  },
  async setSenderSafetyState(state) {
    savedSenderStates.set(state.instanceName, state);
    return state;
  },
  async campaignSafetyCounts() {
    return { permissionEvents: 2, permissionContacts: 2, pausedSenders: 0, blockedChecks: 1 };
  },
};
const conversationLog = {
  async campaignTouchActivity(phones) {
    return new Map(phones.map((phone) => [phone, {
      runCounts: { 7: phone === "60120000003" ? 2 : 0, 30: 0 },
      unansweredRuns: 0,
    }]));
  },
  async senderDeliveryMetrics(names) {
    return new Map(names.map((name) => [name, name === "wa_bad"
      ? { instanceName: name, attempts: 3, failures: 3, unknown: 0, consecutiveFailures: 3 }
      : { instanceName: name, attempts: 0, failures: 0, unknown: 0, consecutiveFailures: 0 }]));
  },
};
const service = createCampaignSafetyService({
  dataDir: tempDir,
  localDatabase,
  conversationLog,
  listInstances: async () => [
    { name: "wa_good", status: "OPEN", provider: { key: "META_CLOUD_API", label: "Meta Cloud API", official: true } },
    { name: "wa_bad", status: "OPEN", provider: { key: "BAILEYS", label: "Evolution Baileys", official: false } },
  ],
  clock: () => now,
});
await service.savePolicy(policy);
const analyzed = await service.analyzeRecipients({
  scopeId: "run_p0",
  recipients: [
    { id: "allowed", phone: "60120000001", name: "Allowed" },
    { id: "revoked", phone: "60120000002", name: "Revoked" },
    { id: "budget", phone: "60120000003", name: "Budget" },
  ],
});
assert.deepEqual(analyzed.revokedConsent.map((item) => item.id), ["revoked"]);
assert.deepEqual(analyzed.contactBudget.map((item) => item.id), ["budget"]);
assert.deepEqual(analyzed.blockedRecipients.map((item) => item.id).sort(), ["budget", "revoked"]);
assert.equal(recordedChecks.length, 6);

await assert.rejects(() => service.assertSendersAllowed(["wa_bad"]), (error) => error.code === "SENDER_SAFETY_PAUSED");
assert.equal(savedSenderStates.get("wa_bad").state, "PAUSED");
const snapshot = await service.snapshot();
assert.equal(snapshot.available, true);
assert.match(snapshot.transportRecommendation, /Meta Cloud API/);

const sqliteDir = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-safety-sqlite-"));
const sqliteDatabase = createLocalDatabaseService({
  dataDir: sqliteDir,
  device: { id: "safety_device", name: "Safety Test" },
  senderPolicy: { configured: false },
});
await sqliteDatabase.initialize();
await sqliteDatabase.recordPermissionEvent({
  phone: "0123456789",
  sourceType: "WEB_FORM",
  sourceReference: "form:test",
  occurredAt: now.toISOString(),
});
const sqlitePermission = await sqliteDatabase.permissionEventsForPhones(["60123456789"]);
assert.equal(sqlitePermission.get("60123456789")[0].action, "GRANTED");
await sqliteDatabase.setSenderSafetyState({ instanceName: "wa_test", state: "PAUSED", reasonCode: "TEST" });
assert.equal((await sqliteDatabase.senderSafetyStates(["wa_test"])).get("wa_test").state, "PAUSED");
await sqliteDatabase.recordCampaignSafetyChecks([{
  checkId: "check_test",
  scopeId: "run_test",
  phone: "60123456789",
  checkType: "CONSENT",
  outcome: "ALLOW",
  code: "CONSENT_ACTIVE",
  checkedAt: now.toISOString(),
}]);
assert.deepEqual(await sqliteDatabase.campaignSafetyCounts(), {
  permissionEvents: 1,
  permissionContacts: 1,
  pausedSenders: 1,
  blockedChecks: 0,
});

const conversationSource = await fs.readFile(new URL("./lib/conversation-log-service.mjs", import.meta.url), "utf8");
assert.match(conversationSource, /json_type\(m\.payload_json, '\$\.deliveryStatus'\) IS NOT NULL/,
  "legacy outbound rows without delivery evidence must not trip sender health");
const appSource = await fs.readFile(new URL("./app/createApp.mjs", import.meta.url), "utf8");
assert.match(appSource, /registerCampaignSafetyRoutes/);
const settingsHtml = await fs.readFile(new URL("./settings.html", import.meta.url), "utf8");
assert.match(settingsHtml, /WhatsApp Safety/);
for (const match of settingsHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
  assert.doesNotThrow(() => new vm.Script(match[1]), "Settings P0 inline JavaScript must parse");
}

console.log("✅ P0 campaign safety: consent, budget, sender circuit breaker, transport and UI passed");
