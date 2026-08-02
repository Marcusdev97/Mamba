import assert from "node:assert/strict";
import test from "node:test";
import { ChannelRouter } from "../providers/channel-router.mjs";
import { ProviderRegistry } from "../providers/provider-registry.mjs";

function testProvider() {
  return {
    id: "fake-sms",
    channel: "sms",
    async sendText({ to, text, sender, metadata }) {
      return {
        provider: "fake-sms",
        channel: "sms",
        senderId: sender?.id ?? null,
        messageId: "test-1",
        status: "accepted",
        sentAt: "2026-08-02T00:00:00.000Z",
        to,
        text,
        metadata,
      };
    },
  };
}

test("routes a permitted SMS send", async () => {
  const registry = new ProviderRegistry();
  registry.register(testProvider());
  const router = new ChannelRouter({ registry });

  const result = await router.sendText({
    providerId: "fake-sms",
    channel: "sms",
    to: "+60123456789",
    text: "Test",
    sender: { id: "sender-1" },
    consentStatus: "VALID",
    suppressed: false,
  });

  assert.equal(result.status, "accepted");
  assert.equal(result.senderId, "sender-1");
});

test("blocks a suppressed recipient", async () => {
  const registry = new ProviderRegistry();
  registry.register(testProvider());
  const router = new ChannelRouter({ registry });

  await assert.rejects(
    router.sendText({
      providerId: "fake-sms",
      channel: "sms",
      to: "+60123456789",
      text: "Test",
      consentStatus: "VALID",
      suppressed: true,
    }),
    /suppression list/i,
  );
});

test("blocks invalid channel consent", async () => {
  const registry = new ProviderRegistry();
  registry.register(testProvider());
  const router = new ChannelRouter({ registry });

  await assert.rejects(
    router.sendText({
      providerId: "fake-sms",
      channel: "sms",
      to: "+60123456789",
      text: "Test",
      consentStatus: "UNKNOWN",
    }),
    /consent/i,
  );
});
