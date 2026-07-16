import fs from "node:fs/promises";
import path from "node:path";

export function createBlastCacheService({
  rootDir,
  blastDatabaseId,
  notion,
  nfSelect,
  nfTitle,
  nfText,
  minFreshMs = 10 * 60 * 1000,
  clock = () => new Date(),
}) {
  const cachePath = () => path.join(rootDir, "campaign-data", "blast_leads_cache.json");
  let activeFullQuery = null;
  let activeSync = null;

  function rowToRecord(page) {
    const props = page.properties || {};
    return {
      id: page.id,
      project: nfSelect(page, "Project") || "",
      name: nfTitle(page, "Name") || "",
      phone: props["Phone"]?.phone_number || "",
      firstBlastAt: props["First Blast At"]?.date?.start || null,
      lastBlastAt: props["Last Blast At"]?.date?.start || null,
      lastFlowSent: nfSelect(page, "Last Flow Sent") || "",
      nextFlow: nfSelect(page, "Next Flow") || "",
      cohortDay: nfSelect(page, "Cohort Day") || "",
      sequenceStatus: nfSelect(page, "Sequence Status") || "",
      status: nfSelect(page, "Status") || "",
      nextAction: nfSelect(page, "Next Action") || "",
      stopFlag: props["Stop Flag"]?.checkbox === true,
      stopReason: nfText(page, "Stop Reason") || "",
      replyCount: props["Reply Count"]?.number ?? null,
      lastReplyAt: props["Last Reply At"]?.date?.start || null,
      replyCheckedAt: props["Reply Checked At"]?.date?.start || null,
      aiCategory: nfSelect(page, "AI Category") || "",
      aiSummary: nfText(page, "AI Summary") || "",
      lastReplyText: nfText(page, "Last Reply Text") || "",
      senderInstance: nfSelect(page, "Sender Instance") || "",
      assignedSenderKey: nfSelect(page, "Assigned Sender Key") || nfText(page, "Assigned Sender Key") || "",
      lastSenderKey: nfSelect(page, "Last Sender Key") || nfText(page, "Last Sender Key") || "",
      lastSenderPhone: props["Last Sender Phone"]?.phone_number || nfText(page, "Last Sender Phone") || "",
      lastSentByDevice: nfSelect(page, "Last Sent By Device") || nfText(page, "Last Sent By Device") || "",
      campaignRunId: nfText(page, "Campaign Run ID") || "",
      followUpAt: props["Follow Up At"]?.date?.start || null,
      priority: nfSelect(page, "Priority") || "",
      appointmentDate: props["Appointment Date"]?.date?.start || null,
      appointmentTime: nfText(page, "Appointment Time") || "",
      appointmentPlace: nfText(page, "Appointment Place") || "",
      appointmentStatus: nfSelect(page, "Appointment Status") || "",
      assignedSales: nfSelect(page, "Assigned Sales") || nfText(page, "Assigned Sales") || "",
      salesNotes: nfText(page, "Sales Notes") || "",
      url: `https://www.notion.so/${String(page.id).replace(/-/g, "")}`,
    };
  }

  async function retrieveRows(filter) {
    if (!blastDatabaseId) throw new Error("没有 Notion 配置。");
    console.log(`[blast-cache] retrieve Notion Blast Leads filter=${filter ? "yes" : "no"}`);
    const rows = [];
    let cursor;
    let pageNo = 0;
    do {
      pageNo += 1;
      let data;
      try {
        data = await notion("POST", `/databases/${blastDatabaseId}/query`, {
          filter,
          page_size: 100,
          ...(cursor ? { start_cursor: cursor } : {}),
        });
      } catch (error) {
        const message = `[BLAST_CACHE_PAGE_FAILED] 无法读取 Blast Leads 第 ${pageNo} 页；已读取 ${rows.length} 条但不会写入不完整缓存。请检查 Notion token、database sharing 和网络。原始错误：${error?.message || error}`;
        console.log(`[blast-cache:error] ${message}`);
        throw new Error(message);
      }
      console.log(`[blast-cache] retrieved page=${pageNo} rows=${data?.results?.length ?? 0}`);
      for (const page of data?.results ?? []) rows.push(rowToRecord(page));
      cursor = data?.has_more ? data?.next_cursor : null;
    } while (cursor);
    console.log(`[blast-cache] retrieve done total=${rows.length}`);
    return rows;
  }

  function queryRows(filter) {
    if (filter) return retrieveRows(filter);
    if (activeFullQuery) {
      console.log("[blast-cache] full retrieve joined existing request");
      return activeFullQuery;
    }
    activeFullQuery = retrieveRows(undefined).finally(() => { activeFullQuery = null; });
    return activeFullQuery;
  }

  async function sync({ force = false } = {}) {
    if (activeSync) {
      console.log("[blast-cache] sync joined existing request");
      return activeSync;
    }
    activeSync = (async () => {
      const cached = await read();
      const ageMs = cached.syncedAt ? clock().getTime() - new Date(cached.syncedAt).getTime() : Infinity;
      const reuseWindowMs = force ? Math.min(minFreshMs, 30_000) : minFreshMs;
      if (cached.records.length && Number.isFinite(ageMs) && ageMs >= 0 && ageMs < reuseWindowMs) {
        console.log(`[blast-cache] sync reused fresh cache count=${cached.records.length} age=${Math.round(ageMs / 1000)}s`);
        return { syncedAt: cached.syncedAt, count: cached.records.length, records: cached.records, reused: true };
      }
      console.log("[blast-cache] sync start");
      const records = await queryRows(undefined);
      return writeCache(records);
    })().finally(() => { activeSync = null; });
    return activeSync;
  }

  async function read() {
    try {
      const cache = JSON.parse(await fs.readFile(cachePath(), "utf8"));
      return { syncedAt: cache.syncedAt || null, records: Array.isArray(cache.records) ? cache.records : [] };
    } catch {
      return { syncedAt: null, records: [] };
    }
  }

  async function writeCache(records) {
    const safeRecords = Array.isArray(records) ? records : [];
    const payload = { syncedAt: clock().toISOString(), count: safeRecords.length, records: safeRecords };
    await fs.mkdir(path.dirname(cachePath()), { recursive: true });
    const tempPath = `${cachePath()}.tmp.${process.pid}.${Date.now()}`;
    await fs.writeFile(tempPath, JSON.stringify(payload));
    await fs.rename(tempPath, cachePath());
    console.log(`[blast-cache] cache written count=${payload.count} path=${cachePath()}`);
    return payload;
  }

  return {
    rowToRecord,
    queryRows,
    sync,
    read,
    writeCache,
  };
}
