import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { createCampaignRecipientRiskService } from "./lib/campaign-recipient-risk-service.mjs";

const assignments = [
  { id: "own", lead: { name: "My second phone", phone: "012-000 0001" } },
  { id: "private", lead: { name: "Friend", phone: "012-000 0002" } },
  { id: "history", lead: { name: "Old lead", phone: "012-000 0003" } },
  { id: "clean", lead: { name: "New lead", phone: "012-000 0004" } },
];

const service = createCampaignRecipientRiskService({
  conversationLog: {
    async sentBlastHistory() {
      return new Map([["60120000003", {
        lastSentAt: "2026-07-20T02:00:00.000Z",
        times: 2,
        flows: ["Flow 1 - Project Template", "Flow 2 - Layout"],
      }]]);
    },
  },
  workInboxIgnore: {
    async snapshot() {
      return { entries: [{ name: "Friend A", phone: "60120000002" }] };
    },
  },
  campaignSafety: {
    async analyzeRecipients({ recipients }) {
      const clean = recipients.find((item) => item.id === "clean");
      const history = recipients.find((item) => item.id === "history");
      return {
        missingConsent: clean ? [{ ...clean, reason: "Consent missing" }] : [],
        expiredConsent: [],
        revokedConsent: [],
        contactBudget: history ? [{ ...history, assessment: { code: "CONTACT_BUDGET_EXCEEDED", outcome: "WARN" } }] : [],
        blockedRecipients: [],
        unavailableChecks: [],
      };
    },
  },
  clock: () => new Date("2026-07-30T08:00:00.000Z"),
});

const risk = await service.analyze({
  scopeId: "run-risk-test",
  assignments,
  connectedInstances: [{ name: "wa_03", owner: "60120000001" }],
});
assert.equal(risk.total, 4);
assert.equal(risk.riskCount, 4);
assert.equal(risk.connectedSenders[0].id, "own");
assert.equal(risk.privateContacts[0].privateName, "Friend A");
assert.equal(risk.previousBlast[0].times, 2);
assert.deepEqual(risk.previousBlast[0].flows, ["Flow 1 - Project Template", "Flow 2 - Layout"]);
assert.equal(risk.missingConsent[0].id, "clean");
assert.equal(risk.contactBudget[0].id, "history");
assert.equal(service.matchesConfirmation(risk, risk.confirmationToken), true);
assert.equal(service.matchesConfirmation(risk, "bad-token"), false);

const skipped = await service.analyze({
  scopeId: "run-risk-test",
  assignments,
  connectedInstances: [{ name: "wa_03", owner: "60120000001" }],
  skipIds: ["own"],
});
assert.equal(skipped.total, 3);
assert.equal(skipped.connectedSenders.length, 0);
assert.notEqual(skipped.confirmationToken, risk.confirmationToken,
  "changing the selected recipients must invalidate the previous confirmation");

const unavailable = await createCampaignRecipientRiskService().analyze({
  scopeId: "run-unavailable",
  assignments: [assignments[3]],
});
assert.equal(unavailable.hasRisk, true);
assert.equal(unavailable.unavailableChecks.length, 2,
  "missing safety data must be visible and require explicit confirmation");
assert.equal(unavailable.safetyUnavailableChecks.length, 1,
  "missing P0 safety data must be separated so the backend can fail closed");

const routeSource = await fs.readFile(new URL("./routes/campaign.routes.mjs", import.meta.url), "utf8");
assert.match(routeSource, /\/api\/campaign\/recipient-risk/);
assert.match(routeSource, /RECIPIENT_RISK_CONFIRMATION_REQUIRED/);
assert.match(routeSource, /CAMPAIGN_SAFETY_BLOCKED/);
assert.match(routeSource, /assertSenderSafety/);
const modalSource = await fs.readFile(new URL("./assets/live-recipient-confirmation.js", import.meta.url), "utf8");
assert.match(modalSource, /确定要发给这群人/);
assert.match(modalSource, /自己的已连接号码/);
assert.match(modalSource, /本机有历史 Blast 记录/);
assert.match(modalSource, /缺少 Consent 证据/);
assert.match(modalSource, /强制阻止/);
assert.match(modalSource, /当前 Mamba Server 还是更新前的版本/);
assert.match(modalSource, /formatRequestError/);

for (const file of ["console.html", "next-flow.html", "lanes.html"]) {
  const html = await fs.readFile(new URL(`./${file}`, import.meta.url), "utf8");
  assert.match(html, /live-recipient-confirmation\.js/);
  assert.match(html, /recipientRiskToken/);
  const inlineScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  for (const source of inlineScripts) {
    assert.doesNotThrow(() => new vm.Script(source), `${file} inline JavaScript must parse`);
  }
}

console.log("✅ campaign recipient risk confirmation tests passed");
