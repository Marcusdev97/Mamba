import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildSenderKey, loadDeviceIdentity } from "./lib/device-identity.mjs";
import { filterInstancesForDevice, loadDeviceSenderPolicy, nextDeviceInstanceName, saveDeviceSenderPolicy } from "./lib/device-sender-policy.mjs";

import {
  analyzeDeviceOwnership,
  analyzeTrustedConnectionClaim,
  collectChatOwnershipEvidence,
  collectRunOwnershipEvidence,
  collectTrustedConnectionEvidence,
  collectTrustedLegacyRunEvidence,
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

test("a generated local Device ID persists across restarts", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-device-id-"));
  const first = await loadDeviceIdentity({}, { dataDir, hostname: "Marcus-MacBook.local" });
  const second = await loadDeviceIdentity({}, { dataDir, hostname: "Renamed-Mac.local" });
  assert.match(first.id, /^mamba-[0-9a-f-]{36}$/);
  assert.equal(second.id, first.id);
  assert.equal(second.configured, true);
});

test("a device sender policy persists and blocks every other phone", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-sender-policy-"));
  await saveDeviceSenderPolicy({ dataDir, deviceId: "marcus-device", expectedSenderPhone: "+60 16-856 8756" });
  const policy = await loadDeviceSenderPolicy({ dataDir, env: {} });
  assert.equal(policy.expectedSenderPhone, "60168568756");
  const filtered = filterInstancesForDevice([
    { name: "wa_01", number: "+60173447825" },
    { name: "marcus_wa_01", number: "+60168568756" },
  ], policy);
  assert.deepEqual(filtered.map((item) => item.name), ["marcus_wa_01"]);
  assert.equal(nextDeviceInstanceName([], { name: "Marcus MacBook Local" }), "marcus-macbook-local_wa_01");
});

test("authorized current WhatsApp evidence can claim a unique legacy row", () => {
  const evidence = collectTrustedConnectionEvidence([{
    instanceName: "wa_01",
    senderPhone: "60168568756",
    messages: [{ key: { id: "out-1", fromMe: true }, phone: "60133333333", at: 2000 }],
  }], {
    deviceId: device.id,
    resolvePhone: (message) => message.phone,
    messageTime: (message) => message.at,
  });
  const report = analyzeTrustedConnectionClaim({
    device: { ...device, configured: true },
    records: [{ id: "page-1", phone: "60133333333", project: "Project A" }],
    chatEvidence: evidence,
  });
  assert.equal(report.summary.confirmedLocal, 1);
  assert.equal(report.confirmed[0].proposed.lastSenderPhone, "60168568756");
  assert.equal(report.confirmed[0].proposed.lastSenderKey, `${device.id.toLowerCase()}::60168568756`);
  assert.equal(report.safety.notionWrites, 0);
});

test("duplicate project rows require a unique Last Blast time match", () => {
  const chatEvidence = [
    { phone: "60133333333", senderPhone: "60168568756", connectionKey: `${device.id.toLowerCase()}::60168568756`, instanceName: "wa_01", at: "2026-07-01T01:00:30.000Z", source: "authorized_current_whatsapp_connection" },
    { phone: "60133333333", senderPhone: "60168568756", connectionKey: `${device.id.toLowerCase()}::60168568756`, instanceName: "wa_01", at: "2026-07-10T02:00:30.000Z", source: "authorized_current_whatsapp_connection" },
  ];
  const report = analyzeTrustedConnectionClaim({
    device: { ...device, configured: true },
    records: [
      { id: "page-a", phone: "60133333333", project: "Project A", lastBlastAt: "2026-07-01T01:00:00.000Z" },
      { id: "page-b", phone: "60133333333", project: "Project B", lastBlastAt: "2026-07-10T02:00:00.000Z" },
    ],
    chatEvidence,
  });
  assert.equal(report.summary.confirmedLocal, 2);
  assert.ok(report.confirmed.every((item) => item.evidence.source === "authorized_whatsapp_last_blast_time_match"));
});

test("duplicate project rows without unique times remain conflicts", () => {
  const evidence = [{
    phone: "60133333333",
    senderPhone: "60168568756",
    connectionKey: `${device.id.toLowerCase()}::60168568756`,
    instanceName: "wa_01",
    at: "2026-07-01T01:00:30.000Z",
    source: "authorized_current_whatsapp_connection",
  }];
  const report = analyzeTrustedConnectionClaim({
    device: { ...device, configured: true },
    records: [
      { id: "page-a", phone: "60133333333", project: "Project A" },
      { id: "page-b", phone: "60133333333", project: "Project B" },
    ],
    chatEvidence: evidence,
  });
  assert.equal(report.summary.confirmedLocal, 0);
  assert.equal(report.summary.conflicts, 2);
});

test("trusted legacy run evidence requires the run phone to match the current connection", () => {
  const baseRun = {
    runId: "legacy-run",
    project: "Project A",
    instances: [{ name: "wa_01", owner: "60168568756" }],
    assignments: [{ instanceName: "wa_01", lead: { phone: "60133333333" }, part1: { sentAt: "2026-07-01T01:00:00.000Z" } }],
  };
  assert.equal(collectTrustedLegacyRunEvidence([baseRun], {
    deviceId: device.id,
    currentConnections: [{ name: "wa_01", senderPhone: "60168568756" }],
  }).length, 1);
  assert.equal(collectTrustedLegacyRunEvidence([baseRun], {
    deviceId: device.id,
    currentConnections: [{ name: "wa_01", senderPhone: "60199999999" }],
  }).length, 0);
});
