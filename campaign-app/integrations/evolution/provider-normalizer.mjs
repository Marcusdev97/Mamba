function clean(value) {
  return String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export function normalizeEvolutionProvider(value) {
  const raw = clean(value);
  if (["WHATSAPP_BUSINESS", "WHATSAPP_CLOUD_API", "CLOUD_API", "META_CLOUD_API"].includes(raw)) {
    return {
      key: "META_CLOUD_API",
      label: "Meta Cloud API",
      official: true,
      raw: raw || "UNKNOWN",
    };
  }
  if (["WHATSAPP_BAILEYS", "BAILEYS"].includes(raw)) {
    return {
      key: "BAILEYS",
      label: "Evolution Baileys / WhatsApp Web",
      official: false,
      raw: raw || "UNKNOWN",
    };
  }
  return {
    key: "UNKNOWN",
    label: "Provider 未识别",
    official: false,
    raw: raw || "UNKNOWN",
  };
}

export function evolutionProviderFromInstance(item = {}) {
  return normalizeEvolutionProvider(
    item.integration
      || item.provider
      || item?.instance?.integration
      || item?.instance?.provider,
  );
}
