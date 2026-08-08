export class ProviderError extends Error {
  constructor(message, { code = "PROVIDER_ERROR", provider = null, cause = null, details = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "ProviderError";
    this.code = code;
    this.provider = provider;
    this.details = details;
  }
}

export class ProviderConfigurationError extends ProviderError {
  constructor(message, options = {}) {
    super(message, { ...options, code: "PROVIDER_CONFIGURATION_ERROR" });
    this.name = "ProviderConfigurationError";
  }
}

export class ProviderUnavailableError extends ProviderError {
  constructor(message, options = {}) {
    super(message, { ...options, code: "PROVIDER_UNAVAILABLE" });
    this.name = "ProviderUnavailableError";
  }
}

export class ProviderSendError extends ProviderError {
  constructor(message, options = {}) {
    super(message, { ...options, code: "PROVIDER_SEND_ERROR" });
    this.name = "ProviderSendError";
  }
}
