function clean(value) { return String(value ?? "").trim(); }

function providerError(provider, response, data) {
  const status = Number(response?.status) || 0;
  const error = new Error(`${provider} ${status || "request"}: ${data?.error?.message || data?.message || "request failed"}`);
  error.code = status === 401 || status === 403 ? "AI_AUTHENTICATION" : status === 429 ? "AI_RATE_LIMIT" : status >= 500 || status === 0 ? "AI_RETRYABLE" : "AI_PERMANENT";
  error.retryable = [0, 408, 429].includes(status) || status >= 500;
  return error;
}

function extractJson(text) {
  const cleaned = clean(text).replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(cleaned); } catch {
    const start = cleaned.indexOf("{"); const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw Object.assign(new Error("AI returned invalid JSON."), { code: "AI_AUDIT_OUTPUT_INVALID", retryable: false });
  }
}

export function createStructuredJsonClient({ env = {}, fetchFn = fetch, timeoutMs = 45000 } = {}) {
  const mode = clean(env.LEAD_AUDITOR_PROVIDER || env.BRAIN_AI_PROVIDER || "rules").toLowerCase();
  const configured = () => {
    if (["rules", "rule", "off", "none"].includes(mode)) return null;
    if (["openai", "auto"].includes(mode) && env.OPENAI_API_KEY) return { provider: "openai", key: env.OPENAI_API_KEY, model: env.LEAD_AUDITOR_OPENAI_MODEL || env.BRAIN_OPENAI_SIMPLE_MODEL || "gpt-5-mini" };
    if (["gemini", "google", "auto"].includes(mode) && env.GEMINI_API_KEY) return { provider: "gemini", key: env.GEMINI_API_KEY, model: env.LEAD_AUDITOR_GEMINI_MODEL || env.BRAIN_GEMINI_SIMPLE_MODEL || "gemini-2.5-flash" };
    if (["anthropic", "claude", "auto"].includes(mode) && env.ANTHROPIC_API_KEY) return { provider: "anthropic", key: env.ANTHROPIC_API_KEY, model: env.LEAD_AUDITOR_ANTHROPIC_MODEL || env.BRAIN_ANTHROPIC_SIMPLE_MODEL || "claude-sonnet-4-5" };
    return null;
  };

  async function generateJson({ system, input }) {
    const config = configured();
    if (!config) throw Object.assign(new Error("Lead Auditor AI provider is not configured; rule candidate remains available."), { code: "AI_PROVIDER_UNAVAILABLE", retryable: false });
    const user = JSON.stringify(input);
    let url; let headers; let body;
    if (config.provider === "openai") {
      url = "https://api.openai.com/v1/responses";
      headers = { Authorization: `Bearer ${config.key}`, "Content-Type": "application/json" };
      body = { model: config.model, max_output_tokens: 1200, input: [{ role: "system", content: system }, { role: "user", content: user }] };
    } else if (config.provider === "gemini") {
      url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent`;
      headers = { "x-goog-api-key": config.key, "Content-Type": "application/json" };
      body = { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: user }] }], generationConfig: { responseMimeType: "application/json", maxOutputTokens: 1200 } };
    } else {
      url = "https://api.anthropic.com/v1/messages";
      headers = { "x-api-key": config.key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" };
      body = { model: config.model, max_tokens: 1200, system, messages: [{ role: "user", content: user }] };
    }
    let response;
    try { response = await fetchFn(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) }); }
    catch (cause) { throw Object.assign(new Error(`${config.provider} request failed: ${cause.message}`), { code: "AI_RETRYABLE", retryable: true, cause }); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw providerError(config.provider, response, data);
    const text = config.provider === "openai"
      ? clean(data.output_text) || (data.output || []).flatMap((item) => item.content || []).filter((item) => item.type === "output_text").map((item) => item.text).join("")
      : config.provider === "gemini"
        ? (data.candidates || []).flatMap((item) => item.content?.parts || []).map((item) => item.text || "").join("")
        : (data.content || []).filter((item) => item.type === "text").map((item) => item.text).join("");
    return { json: extractJson(text), provider: config.provider, model: config.model, usage: { inputTokens: Number(data.usage?.input_tokens || data.usageMetadata?.promptTokenCount) || 0, outputTokens: Number(data.usage?.output_tokens || data.usageMetadata?.candidatesTokenCount) || 0, estimatedCost: 0 } };
  }

  return { generateJson, status: () => ({ configured: Boolean(configured()), provider: configured()?.provider || "rules" }) };
}
