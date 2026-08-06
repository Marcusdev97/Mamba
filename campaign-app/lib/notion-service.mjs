const NOTION_VERSION = "2022-06-28";

export class NotionIntegrationError extends Error {
  constructor(message, { code, category, retryable, status = 0, operation = "", target = "", cause } = {}) {
    super(message, { cause });
    this.name = "NotionIntegrationError";
    this.code = code || "NOTION_REQUEST_FAILED";
    this.category = category || "permanent";
    this.retryable = retryable === true;
    this.status = Number(status || 0);
    this.operation = operation;
    this.target = target;
  }
}

export function classifyNotionError({ status = 0, data = {}, error = null } = {}) {
  if (error) {
    const timeout = error?.name === "TimeoutError" || error?.name === "AbortError" || /timeout/i.test(error?.message || "");
    return {
      code: timeout ? "NOTION_TIMEOUT" : "NOTION_NETWORK_ERROR",
      category: "network",
      retryable: true,
    };
  }
  if (status === 401 || status === 403) return { code: "NOTION_AUTHENTICATION_FAILED", category: "authentication", retryable: false };
  if (status === 429) return { code: "NOTION_RATE_LIMITED", category: "rate_limit", retryable: true };
  if (status === 409) return { code: "NOTION_CONFLICT", category: "conflict", retryable: false };
  if (status >= 500) return { code: "NOTION_TEMPORARY_FAILURE", category: "network", retryable: true };
  if (status === 404) return { code: "NOTION_TARGET_NOT_FOUND", category: "permanent", retryable: false };
  if (status === 400 && /property|relation|validation/i.test(data?.message || "")) {
    return { code: "NOTION_SCHEMA_MISMATCH", category: "permanent", retryable: false };
  }
  return { code: `NOTION_HTTP_${status || "ERROR"}`, category: "permanent", retryable: false };
}

export function createNotionService({ env, logger = console, timeoutMs = 20000, maxRetries = 5, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  function notionTokenValue() {
    return env.NOTION_API_KEY || env.NOTION_TOKEN || process.env.NOTION_API_KEY || process.env.NOTION_TOKEN || "";
  }

  async function notion(method, pathname, body, attempt = 0) {
    const token = notionTokenValue();
    if (!token) {
      throw new NotionIntegrationError("没有 Notion token。请到 Settings 重新连接 Notion。", {
        code: "NOTION_AUTHENTICATION_REQUIRED", category: "authentication", retryable: false,
        operation: method, target: pathname,
      });
    }
    const started = Date.now();
    const retryTag = attempt ? ` retry=${attempt}` : "";
    logger?.log?.(`[notion] ${method} ${pathname}${retryTag}`);
    let response;
    try {
      response = await fetch(`https://api.notion.com/v1${pathname}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Notion-Version": NOTION_VERSION },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const classification = classifyNotionError({ error });
      throw new NotionIntegrationError(
        `${classification.code}：${method} ${pathname} 失败；本机资料已保留，稍后可重试。`,
        { ...classification, operation: method, target: pathname, cause: error },
      );
    }

    if ((response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504) && attempt < maxRetries) {
      const retryAfter = Number(response.headers.get("retry-after")) || (attempt + 1);
      await sleep(Math.min(retryAfter + 0.5, 10) * 1000);
      return notion(method, pathname, body, attempt + 1);
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      logger?.log?.(`[notion] FAIL ${method} ${pathname} HTTP ${response.status} ${Date.now() - started}ms`);
      const classification = classifyNotionError({ status: response.status, data });
      const detail = String(data?.message || data?.code || "request failed").slice(0, 300);
      throw new NotionIntegrationError(`Notion ${classification.category} HTTP ${response.status}: ${detail}`, {
        ...classification,
        status: response.status,
        operation: method,
        target: pathname,
      });
    }
    const summary = Array.isArray(data?.results) ? ` results=${data.results.length}` : data?.id ? ` id=${data.id}` : "";
    logger?.log?.(`[notion] OK ${method} ${pathname}${summary} ${Date.now() - started}ms`);
    return data;
  }

  const klTodayKL = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" });
  const nfTitle = (page, name) => (page?.properties?.[name]?.title ?? []).map((text) => text.plain_text).join("").trim();
  const nfText = (page, name) => (page?.properties?.[name]?.rich_text ?? []).map((text) => text.plain_text).join("").trim();
  const nfPhone = (page, name) => String(page?.properties?.[name]?.phone_number ?? "").trim();
  const nfSelect = (page, name) => page?.properties?.[name]?.select?.name ?? page?.properties?.[name]?.status?.name ?? "";

  function nfNormalizePhone(value) {
    let digits = String(value ?? "").replace(/\D/g, "");
    if (digits.startsWith("0")) digits = `60${digits.slice(1)}`;
    return /^\d{8,15}$/.test(digits) ? digits : null;
  }

  function nfAddDaysKL(days) {
    const date = new Date(`${klTodayKL()}T00:00:00+08:00`);
    date.setUTCDate(date.getUTCDate() + Number(days || 0));
    return date.toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" });
  }

  return {
    notionTokenValue,
    notion,
    klTodayKL,
    nfTitle,
    nfText,
    nfPhone,
    nfSelect,
    nfNormalizePhone,
    nfAddDaysKL,
  };
}
