import { ProviderConfigurationError } from "./provider-errors.mjs";

function assertSendRequest(request = {}) {
  if (!request.providerId) throw new ProviderConfigurationError("providerId is required.");
  if (!request.to) throw new ProviderConfigurationError("Recipient phone is required.");
  if (!request.text) throw new ProviderConfigurationError("Message text is required.");
  if (request.suppressed === true) {
    throw new ProviderConfigurationError("Recipient is on the suppression list.", {
      code: "BLOCKED_SUPPRESSED",
    });
  }
  if (request.consentStatus && request.consentStatus !== "VALID") {
    throw new ProviderConfigurationError("Valid channel consent is required.", {
      code: "BLOCKED_NO_CONSENT",
    });
  }
}

export class ChannelRouter {
  constructor({ registry }) {
    if (!registry) throw new ProviderConfigurationError("Provider registry is required.");
    this.registry = registry;
  }

  async healthCheck(providerId) {
    const provider = this.registry.get(providerId);
    if (typeof provider.healthCheck !== "function") {
      return { provider: provider.id, channel: provider.channel, ok: true, status: "UNKNOWN" };
    }
    return provider.healthCheck();
  }

  async sendText(request) {
    assertSendRequest(request);
    const provider = this.registry.get(request.providerId);
    if (request.channel && provider.channel !== request.channel) {
      throw new ProviderConfigurationError(
        `Provider ${provider.id} is for ${provider.channel}, not ${request.channel}.`,
      );
    }
    return provider.sendText({
      to: request.to,
      text: request.text,
      sender: request.sender ?? null,
      metadata: request.metadata ?? {},
    });
  }
}
