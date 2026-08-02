import {
  ProviderConfigurationError,
  ProviderSendError,
  ProviderUnavailableError,
} from "./provider-errors.mjs";

function basicAuth(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

export function createAndroidSmsGatewayProvider({
  id = "android-sms-gateway",
  baseUrl,
  username,
  password,
  timeoutMs = 30000,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!baseUrl || !username || !password) {
    throw new ProviderConfigurationError("Android SMS Gateway requires baseUrl, username, and password.", {
      provider: id,
    });
  }
  if (typeof fetchImpl !== "function") {
    throw new ProviderConfigurationError("A fetch implementation is required.", { provider: id });
  }

  const endpoint = `${String(baseUrl).replace(/\/$/, "")}/message`;

  async function request(body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          authorization: basicAuth(username, password),
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload = null;
      try { payload = text ? JSON.parse(text) : null; } catch { payload = { text }; }
      if (!response.ok) {
        throw new ProviderSendError(`Android SMS Gateway returned HTTP ${response.status}.`, {
          provider: id,
          details: payload,
        });
      }
      return payload;
    } catch (error) {
      if (error instanceof ProviderSendError) throw error;
      if (error?.name === "AbortError") {
        throw new ProviderUnavailableError("Android SMS Gateway timed out.", {
          provider: id,
          cause: error,
        });
      }
      throw new ProviderUnavailableError(`Android SMS Gateway unavailable: ${error.message}`, {
        provider: id,
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    id,
    channel: "sms",

    async healthCheck() {
      return {
        provider: id,
        channel: "sms",
        ok: true,
        status: "CONFIGURED",
        endpoint,
      };
    },

    async sendText({ to, text, sender = null, metadata = {} }) {
      const payload = {
        textMessage: { text: String(text) },
        phoneNumbers: [String(to)],
      };
      if (sender?.simNumber !== undefined && sender?.simNumber !== null) {
        payload.simNumber = Number(sender.simNumber);
      }
      const raw = await request(payload);
      return {
        provider: id,
        channel: "sms",
        senderId: sender?.id ?? null,
        messageId: raw?.id ?? raw?.messageId ?? null,
        status: "accepted",
        sentAt: new Date().toISOString(),
        metadata,
        raw,
      };
    },
  };
}
