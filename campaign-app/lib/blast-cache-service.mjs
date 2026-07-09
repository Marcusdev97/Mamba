import fs from "node:fs/promises";
import path from "node:path";

export function createBlastCacheService({ rootDir, blastDatabaseId, notion, nfSelect, nfTitle, nfText }) {
  const cachePath = () => path.join(rootDir, "campaign-data", "blast_leads_cache.json");

  function rowToRecord(page) {
    const props = page.properties || {};
    return {
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
      stopFlag: props["Stop Flag"]?.checkbox === true,
      stopReason: nfText(page, "Stop Reason") || "",
      replyCount: props["Reply Count"]?.number ?? null,
      lastReplyAt: props["Last Reply At"]?.date?.start || null,
      aiCategory: nfSelect(page, "AI Category") || "",
      lastReplyText: nfText(page, "Last Reply Text") || "",
      senderInstance: nfSelect(page, "Sender Instance") || "",
      url: `https://www.notion.so/${String(page.id).replace(/-/g, "")}`,
    };
  }

  async function queryRows(filter) {
    if (!blastDatabaseId) throw new Error("没有 Notion 配置。");
    const rows = [];
    let cursor;
    do {
      const data = await notion("POST", `/databases/${blastDatabaseId}/query`, {
        filter,
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      });
      for (const page of data?.results ?? []) rows.push(rowToRecord(page));
      cursor = data?.has_more ? data?.next_cursor : null;
    } while (cursor);
    return rows;
  }

  async function sync() {
    const records = await queryRows(undefined);
    const payload = { syncedAt: new Date().toISOString(), count: records.length, records };
    await fs.mkdir(path.dirname(cachePath()), { recursive: true });
    await fs.writeFile(cachePath(), JSON.stringify(payload));
    return payload;
  }

  async function read() {
    try {
      const cache = JSON.parse(await fs.readFile(cachePath(), "utf8"));
      return { syncedAt: cache.syncedAt || null, records: Array.isArray(cache.records) ? cache.records : [] };
    } catch {
      return { syncedAt: null, records: [] };
    }
  }

  return {
    rowToRecord,
    queryRows,
    sync,
    read,
  };
}
