const NOTION_VERSION = "2022-06-28";

export function createNotionService({ env }) {
  function notionTokenValue() {
    return env.NOTION_API_KEY || env.NOTION_TOKEN || process.env.NOTION_API_KEY || process.env.NOTION_TOKEN || "";
  }

  async function notion(method, pathname, body, attempt = 0) {
    const token = notionTokenValue();
    if (!token) throw new Error("没有 Notion token。先运行 Set Notion Token。");
    const response = await fetch(`https://api.notion.com/v1${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Notion-Version": NOTION_VERSION },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });

    if ((response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504) && attempt < 5) {
      const retryAfter = Number(response.headers.get("retry-after")) || (attempt + 1);
      await new Promise((resolve) => setTimeout(resolve, Math.min(retryAfter + 0.5, 10) * 1000));
      return notion(method, pathname, body, attempt + 1);
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`Notion HTTP ${response.status} ${JSON.stringify(data)}`);
    }
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
