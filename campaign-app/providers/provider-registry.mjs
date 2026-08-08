import { ProviderConfigurationError } from "./provider-errors.mjs";

export class ProviderRegistry {
  constructor() {
    this.providers = new Map();
  }

  register(provider) {
    if (!provider?.id || typeof provider.sendText !== "function") {
      throw new ProviderConfigurationError("Provider must expose id and sendText().");
    }
    if (this.providers.has(provider.id)) {
      throw new ProviderConfigurationError(`Provider already registered: ${provider.id}`);
    }
    this.providers.set(provider.id, provider);
    return provider;
  }

  get(id) {
    const provider = this.providers.get(id);
    if (!provider) throw new ProviderConfigurationError(`Unknown provider: ${id}`);
    return provider;
  }

  list() {
    return [...this.providers.values()].map((provider) => ({
      id: provider.id,
      channel: provider.channel,
    }));
  }
}
