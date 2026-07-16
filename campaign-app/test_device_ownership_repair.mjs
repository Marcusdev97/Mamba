import assert from "node:assert/strict";
import test from "node:test";
import { buildSenderKey } from "./lib/device-identity.mjs";

import {
  analyzeDeviceOwnership,
  collectChatOwnershipEvidence,
  collectRunOwnershipEvidence,
  normalizeOwnershipPhone,
  ownershipConnectionKey,
} from "./lib/device-ownership-repair-service.mjs";

const device = { id: "Cicis-MacBook-Pro", name: "Cici's MacBook Pro" };

function chatEvidence(messages, senderPhone = "60111111111") {
  return collectChatOwnershipEvidence([
    { instanceName: "wa_01", senderPhone, messages },
  ], {
    deviceId: device.id,
    resolvePhone: (message) => message.phone,
    messageTime: (message) => message.at,
  });
}

test("normalizes phone numbers and creates a device + sender connection key", () => {
  assert.equal(normalizeOwnershipPhone("017-344 7825"), "60173447825");
  assert.equal(
    ownershipConnectionKey("Cicis MacBook Pro", "+60 11-111 1111"),
    "cicis-macbook-pro::60111111111",
  );
  assert.equal(buildSenderKey("Cicis MacBook Pro", "+60 11-111 1111"), "cicis-macbook-pro::60111111111");
  assert.equal(buildSenderKey("Cicis MacBook Pro", "wa_01"), "");
});

test("chat evidence accepts outbound messages only", () => {
  const evidence = chatEvidence([
    { key: { fromMe: false }, phone: "60122222222", at: 1000 },
    { key: { fromMe: true }, phone: "60133333333", at: 2000 },
  ]);

  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].phone, "60133333333");
});

test("WhatsApp history alone cannot prove which computer sent a message", () => {
  const report = analyzeDeviceOwnership({
    device,
    records: [{ id: "page-1", phone: "60133333333", project: "Project A" }],
    chatEvidence: chatEvidence([
      { key: { fromMe: true }, phone: "60133333333", at: 2000 },
    ]),
  });

  assert.equal(report.summary.confirmedLocal, 0);
  assert.equal(report.summary.unresolved, 1);
  assert.equal(report.unresolved[0].reason, "whatsapp_history_cannot_prove_sending_device");
  assert.equal(report.safety.notionWrites, 0);
  assert.equal(report.safety.whatsappSends, 0);
});

test("chat-only evidence leaves duplicate phone project rows unresolved", () => {
  const report = analyzeDeviceOwnership({
    device,
    records: [
      { id: "page-a", phone: "60133333333", project: "Project A" },
      { id: "page-b", phone: "60133333333", project: "Project B" },
    ],
    chatEvidence: chatEvidence([
      { key: { fromMe: true }, phone: "60133333333", at: 2000 },
    ]),
  });

  assert.equal(report.summary.confirmedLocal, 0);
  assert.equal(report.summary.unresolved, 2);
  assert.ok(report.unresolved.every((item) => item.reason === "whatsapp_history_cannot_prove_sending_device"));
});

test("campaign run evidence disambiguates the matching project row", () => {
  const runEvidence = collectRunOwnershipEvidence([
    {
      runId: "run-1",
      deviceId: device.id,
      project: "Project B",
      instances: [{ name: "wa_02", owner: "60199999999" }],
      assignments: [{
        instanceName: "wa_02",
        lead: { phone: "60133333333" },
        part1: { sentAt: "2026-07-16T01:00:00.000Z" },
      }],
    },
  ], { deviceId: device.id });

  const report = analyzeDeviceOwnership({
    device,
    records: [
      { id: "page-a", phone: "60133333333", project: "Project A" },
      { id: "page-b", phone: "60133333333", project: "Project B" },
    ],
    runEvidence,
  });

  assert.equal(report.summary.confirmedLocal, 1);
  assert.equal(report.confirmed[0].pageId, "page-b");
  assert.equal(report.confirmed[0].proposed.lastSenderPhone, "60199999999");
  assert.equal(report.summary.unresolved, 1);
});

test("multiple outbound senders still cannot prove a device and are never auto-selected", () => {
  const messages = [{ key: { fromMe: true }, phone: "60133333333", at: 2000 }];
  const report = analyzeDeviceOwnership({
    device,
    records: [{ id: "page-1", phone: "60133333333", project: "Project A" }],
    chatEvidence: [
      ...chatEvidence(messages, "60111111111"),
      ...chatEvidence(messages, "60199999999"),
    ],
  });

  assert.equal(report.summary.confirmedLocal, 0);
  assert.equal(report.summary.unresolved, 1);
  assert.equal(report.unresolved[0].reason, "whatsapp_history_cannot_prove_sending_device");
  assert.deepEqual(report.unresolved[0].observedSenderPhones.sort(), ["60111111111", "60199999999"]);
});

test("existing ownership is preserved without proposing an overwrite", () => {
  const report = analyzeDeviceOwnership({
    device,
    records: [{
      id: "page-1",
      phone: "60133333333",
      project: "Project A",
      lastSentByDevice: "another-device",
      lastSenderPhone: "60155555555",
    }],
    chatEvidence: chatEvidence([
      { key: { fromMe: true }, phone: "60133333333", at: 2000 },
    ]),
  });

  assert.equal(report.summary.alreadyAssigned, 1);
  assert.equal(report.summary.confirmedLocal, 0);
  assert.equal(report.safety.overwritesExistingOwnership, 0);
});

test("rows without reliable outbound evidence stay unresolved", () => {
  const report = analyzeDeviceOwnership({
    device,
    records: [{ id: "page-1", phone: "60133333333", project: "Project A" }],
  });

  assert.equal(report.summary.unresolved, 1);
  assert.equal(report.unresolved[0].reason, "no_explicit_device_run_evidence");
});

test("legacy run files without an explicit Device ID are ignored", () => {
  const runEvidence = collectRunOwnershipEvidence([{
    runId: "legacy-run",
    project: "Project A",
    instances: [{ name: "wa_01", owner: "60111111111" }],
    assignments: [{
      instanceName: "wa_01",
      lead: { phone: "60133333333" },
      part1: { sentAt: "2026-07-16T01:00:00.000Z" },
    }],
  }], { deviceId: device.id });

  assert.deepEqual(runEvidence, []);
});
