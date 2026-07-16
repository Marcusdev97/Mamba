import fs from "node:fs/promises";
import path from "node:path";
import { httpError, json, readJson } from "../lib/http.mjs";

function requireLookup(runtime) {
  if (!runtime.lookup) {
    throw httpError(500, "Lookup service 没有载入。请重启 Mamba server。");
  }
  return runtime.lookup;
}

function isPhoneQuery(q) {
  const digits = q.replace(/[^0-9]/g, "");
  return digits.length >= 5 && /^[0-9+\s()-]+$/.test(q);
}

function sortLookupRows(rows) {
  return rows.slice().sort((a, b) =>
    String(b.lastBlastAt || b.firstBlastAt || "").localeCompare(String(a.lastBlastAt || a.firstBlastAt || "")));
}

function readableLookupError(error, action) {
  const message = String(error?.message || "");
  if (message.includes("Notion") || message.includes("token")) {
    return `${action}失败: Notion 连接有问题。请先到 Settings 确认 Notion token 和 database sharing。${message}`;
  }
  if (message.includes("Name and Phone columns")) {
    return `${action}失败: Excel 第一行必须有 Name 和 Phone 两个 column。`;
  }
  if (message.includes("lead rows")) {
    return `${action}失败: Excel 里面没有客户行。请确认第一张 sheet 有资料。`;
  }
  return `${action}失败: ${message || "没有明确原因。"}`;
}

export function registerLookupRoutes(router) {
  router.get("/api/lookup", async (req, res, runtime) => {
    const lookup = requireLookup(runtime);
    const url = new URL(req.url, `http://${runtime.host}:${runtime.port}`);
    const q = String(url.searchParams.get("q") ?? "").trim();
    if (!q) {
      json(res, 200, { ok: true, q: "", results: [] });
      return;
    }

    const digits = q.replace(/[^0-9]/g, "");
    const phoneQuery = isPhoneQuery(q);
    const cache = await lookup.readCache();
    let rows;

    if (cache.records.length) {
      if (phoneQuery) {
        const sig = digits.replace(/^0+/, "");
        rows = cache.records.filter((record) => (record.phone || "").replace(/[^0-9]/g, "").includes(sig));
      } else {
        const ql = q.toLowerCase();
        rows = cache.records.filter((record) => (record.name || "").toLowerCase().includes(ql));
      }
    } else {
      if (!lookup.hasBlastDatabase) {
        throw httpError(500, "没有 Notion Blast Leads 配置。请检查 campaign-data/notion_config.json。");
      }
      try {
        rows = await lookup.queryNotionRows(phoneQuery
          ? { property: "Phone", phone_number: { contains: digits.replace(/^0+/, "") } }
          : { property: "Name", title: { contains: q } });
      } catch (error) {
        throw httpError(500, readableLookupError(error, "查找客户"));
      }
    }

    rows = sortLookupRows(rows);
    json(res, 200, {
      ok: true,
      q,
      isPhone: phoneQuery,
      count: rows.length,
      results: rows,
      cached: cache.records.length > 0,
      syncedAt: cache.syncedAt || null,
    });
  });

  router.get("/api/lookup/cache-info", async (_req, res, runtime) => {
    const lookup = requireLookup(runtime);
    const cache = await lookup.readCache();
    json(res, 200, { ok: true, syncedAt: cache.syncedAt, count: cache.records.length });
  });

  router.post("/api/lookup/sync", async (_req, res, runtime) => {
    const lookup = requireLookup(runtime);
    try {
      // A user-clicked sync may bypass the normal 10-minute cache window, while
      // the cache service still collapses accidental duplicate clicks for 30s.
      const payload = await lookup.syncCache({ force: true });
      json(res, 200, { ok: true, syncedAt: payload.syncedAt, count: payload.count });
    } catch (error) {
      throw httpError(500, readableLookupError(error, "同步 Blast Leads cache"));
    }
  });

  router.post("/api/lookup/match", async (req, res, runtime) => {
    const lookup = requireLookup(runtime);
    const body = await readJson(req);
    const base64 = String(body.base64 ?? "");
    if (!base64) throw httpError(400, "缺少 Excel 文件。请拖入 Excel 后再匹配。");
    const comma = base64.indexOf(",");
    const b64 = base64.startsWith("data:") && comma >= 0 ? base64.slice(comma + 1) : base64;
    const tmp = path.join(lookup.rootDir, "campaign-data", `._match_${Date.now()}.xlsx`);
    await fs.mkdir(path.dirname(tmp), { recursive: true });
    await fs.writeFile(tmp, Buffer.from(b64, "base64"));

    let parsed;
    try {
      parsed = await lookup.importLeads(tmp);
    } catch (error) {
      throw httpError(400, readableLookupError(error, "匹配 Excel"));
    } finally {
      fs.unlink(tmp).catch(() => {});
    }

    const cache = await lookup.readCache();
    const byPhone = new Map();
    for (const record of cache.records) {
      const phone = lookup.normalizePhone(record.phone);
      if (!phone) continue;
      if (!byPhone.has(phone)) byPhone.set(phone, []);
      byPhone.get(phone).push(record);
    }

    const rows = parsed.leads.map((lead) => {
      const phone = lookup.normalizePhone(lead.phone);
      const matches = (byPhone.get(phone) || []).slice().sort((a, b) =>
        String(b.lastBlastAt || "").localeCompare(String(a.lastBlastAt || "")));
      return { name: lead.name, phone: lead.phone, matched: matches.length > 0, records: matches };
    });
    const matched = rows.filter((row) => row.matched).length;
    json(res, 200, {
      ok: true,
      syncedAt: cache.syncedAt,
      cacheCount: cache.records.length,
      total: rows.length,
      matched,
      fresh: rows.length - matched,
      rejected: parsed.rejected.length,
      rows,
    });
  });
}
