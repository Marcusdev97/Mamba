import fs from "node:fs/promises";
import path from "node:path";

export function createBlastCacheService({ rootDir, blastDatabaseId, notion, nfSelect, nfTitle, nfText }) {
  const cachePath = () => path.join(rootDir, "campaign-data", "blast_leads_cache.json");

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

  async function queryRows(filter) {
    if (!blastDatabaseId) throw new Error("没有 Notion 配置。");
    console.log(`[blast-cache] retrieve Notion Blast Leads filter=${filter ? "yes" : "no"}`);
    const rows = [];
    let cursor;
    let pageNo = 0;
    do {
      pageNo += 1;
      const data = await notion("POST", `/databases/${blastDatabaseId}/query`, {
        filter,
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      });
      console.log(`[blast-cache] retrieved page=${pageNo} rows=${data?.results?.length ?? 0}`);
      for (const page of data?.results ?? []) rows.push(rowToRecord(page));
      cursor = data?.has_more ? data?.next_cursor : null;
    } while (cursor);
    console.log(`[blast-cache] retrieve done total=${rows.length}`);
    return rows;
  }

  async function sync() {
    console.log("[blast-cache] sync start");
    const records = await queryRows(undefined);
    return writeCache(records);
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
    const payload = { syncedAt: new Date().toISOString(), count: safeRecords.length, records: safeRecords };
    await fs.mkdir(path.dirname(cachePath()), { recursive: true });
    await fs.writeFile(cachePath(), JSON.stringify(payload));
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
