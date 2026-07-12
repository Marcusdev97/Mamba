import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(appDir, "..");
const paths = {
  dataDir: path.join(rootDir, "campaign-data"),
};

const NOTION_VERSION = "2022-06-28";
const configPath = path.join(paths.dataDir, "notion_config.json");
const statePath = path.join(paths.dataDir, "notion_state.json");

const defaultConfig = {
  project: "Gen Starz",
  databases: {
    blastLeads: "64b439a288c1415fa36ac890e17c88e6",
    adsLeads: "fcfe32f817244929b89085f4af59ade9",
    templates: "d8a1bf9c5fdd4c1198f50b91ee41079c",
    images: "b8978f28aa004e22a21ff4b95aa00790",
    recycleLeads: "fd7bba6715434c5f820a36ead4a582c8",
    campaignRuns: "38358de2161380e28f19f7587f3fa932",
  },
  dataSources: {
    blastLeads: "b7f288ef-c2dc-4dbd-8071-5e4914e7648c",
    adsLeads: "519ee6a3-06f8-43e1-a19d-ea61e0b53181",
    templates: "778879c7-fc76-4b0b-b27f-d3b20917dbf1",
    images: "90ab9ce5-70c9-4513-8e73-f0c0b1159e96",
    recycleLeads: "dd1d3c52-ed37-4fc6-a444-cb12506bd106",
    campaignRuns: "38358de2-1613-8045-b4d1-000b4e6a4a11",
  },
  templates: {
    en_part1_full: {
      pageId: "38858de21613819d9dedf6927b7d54ee",
      imagePageId: "38858de216138142881acf5ca5a41f62",
    },
    en_part1_still_looking: {
      pageId: "38858de2161381f79b71d7a0ce861f31",
      imagePageId: "38858de216138142881acf5ca5a41f62",
    },
    en_part1_quick_update: {
      pageId: "38858de2161381cdb81ad8a8b383ac14",
      imagePageId: "38858de216138142881acf5ca5a41f62",
    },
    zh_part1_full: {
      pageId: "38858de21613810cbb4fd81492ae5a7f",
      imagePageId: "38858de216138142881acf5ca5a41f62",
    },
    en_part2_floorplans: {
      pageId: "38858de21613816684a4ca03645894a5",
      imagePageId: "38858de21613812fba0fc5372fbe888b",
    },
    zh_part2_floorplans: {
      pageId: "38858de21613812da02ce610b5c4003b",
      imagePageId: "38858de21613812fba0fc5372fbe888b",
    },
  },
};

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function atomicWrite(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(tempPath, filePath);
}

function cleanId(value) {
  return String(value ?? "").replace(/[^a-fA-F0-9]/g, "");
}

function title(value) {
  return { title: [{ text: { content: String(value ?? "") } }] };
}

function richText(value) {
  return { rich_text: [{ text: { content: String(value ?? "").slice(0, 1900) } }] };
}

function richTextOrEmpty(value) {
  const text = String(value ?? "").slice(0, 1900);
  return text ? richText(text) : { rich_text: [] };
}

function select(name) {
  return name ? { select: { name } } : undefined;
}

function selectOrEmpty(name) {
  return name ? { select: { name } } : { select: null };
}

function status(name) {
  return name ? { status: { name } } : undefined;
}

function choice(schema, propertyName, optionName) {
  const type = schema?.[propertyName]?.type;
  if (!optionName) return type === "status" ? { status: null } : { select: null };
  return type === "status" ? { status: { name: optionName } } : { select: { name: optionName } };
}

function phoneNumber(value) {
  return { phone_number: String(value ?? "") };
}

function dateValue(iso) {
  return iso ? { date: { start: iso } } : undefined;
}

function dateValueOrEmpty(iso) {
  return iso ? { date: { start: iso } } : { date: null };
}

function checkbox(value) {
  return { checkbox: Boolean(value) };
}

function numberValue(value) {
  return { number: Number(value ?? 0) };
}

function relation(ids) {
  return { relation: [...new Set(ids.filter(Boolean).map((id) => ({ id: cleanId(id) })))] };
}

function pageRelationIds(page, propertyName) {
  return page?.properties?.[propertyName]?.relation?.map((item) => cleanId(item.id)) ?? [];
}

function pageNumber(page, propertyName) {
  return Number(page?.properties?.[propertyName]?.number ?? 0);
}

function pageSelectName(page, propertyName) {
  return page?.properties?.[propertyName]?.select?.name ?? page?.properties?.[propertyName]?.status?.name ?? "";
}

function languageLabel(language) {
  if (String(language).toLowerCase() === "zh") return "ZH";
  if (String(language).toLowerCase() === "bm") return "BM";
  return "EN";
}

function leadStatusFromReply(event) {
  return event?.status || "Warm";
}

function categoryFromReply(event) {
  return event?.aiCategory || event?.category || "Warm";
}

function nextActionFor(event) {
  return event?.nextAction || "Human Takeover";
}

function sequenceStatusFromReply(event) {
  return event?.sequenceStatus || "Human Takeover";
}

export function buildLeadReplyProperties(schema, event, replyCount = 1, checkedAt = new Date().toISOString()) {
  const properties = {
    Status: choice(schema, "Status", leadStatusFromReply(event)),
    "Sequence Status": choice(schema, "Sequence Status", sequenceStatusFromReply(event)),
    "Last Reply At": dateValue(event?.receivedAt),
    "Last Reply Text": richText(event?.text),
    "Reply Checked At": dateValue(checkedAt),
    "AI Category": choice(schema, "AI Category", categoryFromReply(event)),
    "Next Action": choice(schema, "Next Action", nextActionFor(event)),
    "Reply Count": numberValue(replyCount),
    "AI Summary": richText(event?.route
      ? `[${event.signal || "GREY"}] ${event.route} · 建议:${event.suggestedReply || "人工查看"}`
      : `Latest reply: ${event?.text || ""}`),
  };
  if (event?.stopFlag) {
    properties["Stop Flag"] = checkbox(true);
    properties["Stop Reason"] = richText(`Auto: ${event.route || "STOP"}`);
  }
  if (event?.route === "VIEWING_REQUEST") {
    if (schema?.["Appointment Status"]) properties["Appointment Status"] = choice(schema, "Appointment Status", "Viewing Interest");
    if (schema?.Priority) properties.Priority = choice(schema, "Priority", "HIGH");
  }
  return properties;
}

function blastLeadsDataSource(config) {
  return config.dataSources.blastLeads ?? config.dataSources.leadCrm;
}

function databaseId(config, key) {
  return config.databases?.[key] ?? config.dataSources?.[key] ?? "";
}

function blastLeadsDatabase(config) {
  return config.databases?.blastLeads ?? config.databases?.leadCrm ?? blastLeadsDataSource(config);
}

function recycleLeadsDatabase(config) {
  return config.databases?.recycleLeads ?? config.dataSources?.recycleLeads ?? "";
}

export async function ensureNotionConfig() {
  const current = await readJson(configPath, null);
  if (!current) await atomicWrite(configPath, defaultConfig);
  return current ?? defaultConfig;
}

export class NotionSync {
  constructor({ token, config, onLog } = {}) {
    this.token = token;
    this.config = config ?? defaultConfig;
    this.onLog = onLog;
    this.enabled = Boolean(token);
    this.state = null;
    this.blastSchema = null;
  }

  log(message) {
    if (this.onLog) this.onLog(message);
  }

  async init() {
    await ensureNotionConfig();
    this.state = await readJson(statePath, {
      leadPages: {},
      recycleLeadPages: {},
      creditedSends: {},
      creditedResponses: {},
      syncedReplyIds: {},
    });
    this.state.leadPages = this.state.leadPages ?? {};
    this.state.recycleLeadPages = this.state.recycleLeadPages ?? {};
    this.state.creditedSends = this.state.creditedSends ?? {};
    this.state.creditedResponses = this.state.creditedResponses ?? {};
    this.state.syncedReplyIds = this.state.syncedReplyIds ?? {};
    return this;
  }

  async saveState() {
    await atomicWrite(statePath, this.state);
  }

  async request(method, pathname, body, attempt = 0) {
    if (!this.enabled) return null;
    const started = Date.now();
    const retryTag = attempt ? ` retry=${attempt}` : "";
    console.log(`[notion-sync] ${method} ${pathname}${retryTag}`);
    const response = await fetch(`https://api.notion.com/v1${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "Notion-Version": NOTION_VERSION,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    // Auto-retry on rate limit / transient errors.
    if ((response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504) && attempt < 5) {
      const retryAfter = Number(response.headers.get("retry-after")) || (attempt + 1);
      await new Promise((res) => setTimeout(res, Math.min(retryAfter + 0.5, 10) * 1000));
      return this.request(method, pathname, body, attempt + 1);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.log(`[notion-sync] FAIL ${method} ${pathname} HTTP ${response.status} ${Date.now() - started}ms`);
      throw new Error(`Notion ${method} ${pathname}: HTTP ${response.status} ${JSON.stringify(data)}`);
    }
    const summary = Array.isArray(data?.results) ? ` results=${data.results.length}` : data?.id ? ` id=${data.id}` : "";
    console.log(`[notion-sync] OK ${method} ${pathname}${summary} ${Date.now() - started}ms`);
    return data;
  }

  async queryDataSource(dataSourceId, filter, pageSize = 10) {
    return this.request("POST", `/databases/${cleanId(dataSourceId)}/query`, { filter, page_size: pageSize });
  }

  async retrievePage(pageId) {
    console.log(`[notion-sync] retrieve page=${cleanId(pageId)}`);
    return this.request("GET", `/pages/${cleanId(pageId)}`);
  }

  async getBlastSchema() {
    if (this.blastSchema) return this.blastSchema;
    const data = await this.request("GET", `/databases/${cleanId(blastLeadsDatabase(this.config))}`);
    this.blastSchema = data?.properties || {};
    return this.blastSchema;
  }

  async updatePage(pageId, properties) {
    return this.request("PATCH", `/pages/${cleanId(pageId)}`, { properties });
  }

  async createLeadPage({ lead, job, sentAt, templateIds = [] }) {
    const schema = await this.getBlastSchema();
    const properties = {
      Name: title(lead.name || lead.phone),
      Phone: phoneNumber(lead.phone),
      Status: choice(schema, "Status", "Blasted"),
      Project: choice(schema, "Project", this.config.project),
      Language: choice(schema, "Language", languageLabel(job.language)),
      "Sender Instance": choice(schema, "Sender Instance", job.instanceName || "Unknown"),
      "Last Blast At": dateValue(sentAt),
      "Template Sent": relation(templateIds),
      "Reply Count": numberValue(0),
      "Stop Flag": checkbox(false),
    };
    const body = {
      parent: { type: "database_id", database_id: cleanId(blastLeadsDatabase(this.config)) },
      properties,
    };
    return this.request("POST", "/pages", body);
  }

  async findLeadByPhone(phone) {
    if (this.state.leadPages[phone]) {
      try {
        return await this.retrievePage(this.state.leadPages[phone]);
      } catch {
        delete this.state.leadPages[phone];
      }
    }

    const result = await this.queryDataSource(blastLeadsDatabase(this.config), {
      property: "Phone",
      phone_number: { equals: phone },
    }, 1);
    return result?.results?.[0] ?? null;
  }

  // STOP stops the PERSON, not the project: the same phone can have one Blast
  // Leads row per 楼盘 it was blasted under. Tick Stop Flag on EVERY row that
  // shares this phone so no other project's sequence keeps messaging them.
  // Best-effort — a failure here never blocks the main reply upsert.
  async stopAllRowsForPhone(phone, reason = "STOP") {
    if (!this.enabled || !phone) return 0;
    let flagged = 0;
    try {
      const result = await this.queryDataSource(blastLeadsDatabase(this.config), {
        property: "Phone",
        phone_number: { equals: phone },
      }, 20);
      for (const page of result?.results ?? []) {
        if (page?.properties?.["Stop Flag"]?.checkbox === true) continue;
        await this.updatePage(page.id, {
          "Stop Flag": checkbox(true),
          "Stop Reason": richText(`Auto (all projects): ${reason}`),
        });
        flagged += 1;
      }
      if (flagged > 1) console.log(`[notion-sync] STOP propagated to ${flagged} project row(s) for phone=${phone}`);
    } catch (error) {
      console.log(`[notion-sync] stopAllRowsForPhone failed phone=${phone}: ${error.message}`);
    }
    return flagged;
  }

  async findRecycleLeadByPhone(phone) {
    if (this.state.recycleLeadPages[phone]) {
      try {
        return await this.retrievePage(this.state.recycleLeadPages[phone]);
      } catch {
        delete this.state.recycleLeadPages[phone];
      }
    }

    const database = recycleLeadsDatabase(this.config);
    if (!database) throw new Error("Notion config is missing recycleLeads database.");
    const result = await this.queryDataSource(database, {
      property: "Phone",
      phone_number: { equals: phone },
    }, 1);
    return result?.results?.[0] ?? null;
  }

  async findAdLeadByPhone(phone) {
    const database = databaseId(this.config, "adsLeads");
    if (!database) return null;
    const result = await this.queryDataSource(database, { property: "Phone", phone_number: { equals: phone } }, 1);
    return result?.results?.[0] ?? null;
  }

  // Create (or update) a lead in the Ads Leads database. Used when a customer
  // messages in from a click-to-WhatsApp ad (detected by the opening phrase).
  // Property names/types mirror what morning_followup already writes to Ads.
  async upsertAdLead(event) {
    if (!this.enabled || !event?.phone) return { action: "skipped" };
    console.log(`[notion-sync] upload ads lead phone=${event.phone}`);
    const database = databaseId(this.config, "adsLeads");
    if (!database) throw new Error("Notion config is missing adsLeads database.");

    const existing = await this.findAdLeadByPhone(event.phone);
    const now = event.receivedAt || new Date().toISOString();
    const properties = {
      Name: title(event.name || event.phone),
      Phone: phoneNumber(event.phone),
      "Lead Status": select("Warm"),
      "Last Touch Type": select("Customer Replied"),
      "Last Message Text": richTextOrEmpty(event.text || ""),
      "Last Touch At": dateValue(now),
      "Next Action": select("Send Details"),
    };
    // Only stamp "received" the first time we see them, so it stays the ad date.
    if (!existing) properties["Lead Received At"] = dateValue(now);

    if (existing) {
      await this.updatePage(existing.id, properties);
    } else {
      await this.request("POST", "/pages", {
        parent: { type: "database_id", database_id: cleanId(database) },
        properties,
      });
    }
    console.log(`[notion-sync] ads lead ${existing ? "updated" : "created"} phone=${event.phone}`);
    return { action: existing ? "updated" : "created" };
  }

  async upsertRecycleLead(record) {
    if (!this.enabled || !record?.phone) return { action: "skipped" };
    console.log(`[notion-sync] upload recycle lead phone=${record.phone}`);
    const database = recycleLeadsDatabase(this.config);
    if (!database) throw new Error("Notion config is missing recycleLeads database.");

    const existing = await this.findRecycleLeadByPhone(record.phone);
    const protectedDoNotCall = pageSelectName(existing, "Lead Status") === "Do Not Call";
    const leadStatus = protectedDoNotCall ? "Do Not Call" : record.leadStatus;
    const recycleCategory = protectedDoNotCall ? "Do Not Call" : record.recycleCategory;
    const nextAction = protectedDoNotCall ? "Do Not Call" : record.nextAction;
    const blastEligible = protectedDoNotCall ? false : record.blastEligible;
    const callIncrement = record.hasCallActivity ? 1 : 0;
    const callCount = existing ? pageNumber(existing, "Call Count") + callIncrement : callIncrement;

    const properties = {
      Name: title(record.name || record.phone),
      Phone: phoneNumber(record.phone),
      "Lead Status": select(leadStatus),
      "Recycle Category": select(recycleCategory),
      "Blast Eligible": checkbox(blastEligible),
      "Call Count": numberValue(callCount),
      "Call Date": dateValueOrEmpty(record.callDate),
      "Call Time": richTextOrEmpty(record.callTime || ""),
      "Last Call Outcome": selectOrEmpty(record.lastCallOutcome),
      "Follow Up Due": dateValueOrEmpty(record.followUpDue),
      "Next Action": select(nextAction),
      Remark: richTextOrEmpty(record.remark || ""),
      "AI Summary": richTextOrEmpty(record.aiSummary || ""),
      "Source Batch": richTextOrEmpty(record.sourceBatch || ""),
      "Imported At": dateValue(record.importedAt),
      "Import File": richTextOrEmpty(record.importFile || ""),
    };

    let page;
    if (existing) {
      page = await this.updatePage(existing.id, properties);
    } else {
      page = await this.request("POST", "/pages", {
        parent: { type: "database_id", database_id: cleanId(database) },
        properties,
      });
    }

    this.state.recycleLeadPages[record.phone] = cleanId(page.id);
    await this.saveState();
    console.log(`[notion-sync] recycle lead ${existing ? "updated" : "created"} phone=${record.phone}`);
    return { action: existing ? "updated" : "created", protectedDoNotCall };
  }

  async upsertLeadBlast({ job, part, sentAt }) {
    if (!this.enabled || !job?.lead?.phone) return;
    console.log(`[notion-sync] upload blast lead phone=${job.lead.phone} part=${part} sender=${job.instanceName || "Unknown"}`);
    const schema = await this.getBlastSchema();
    const variantId = part === 2 ? job.part2Variant : job.part1Variant;
    const template = this.config.templates[variantId];
    if (!template?.pageId) return;

    const phone = job.lead.phone;
    const existing = await this.findLeadByPhone(phone);
    const existingTemplates = existing ? pageRelationIds(existing, "Template Sent") : [];
    const templateIds = [...existingTemplates, template.pageId];

    let page;
    if (existing) {
      page = await this.updatePage(existing.id, {
        Status: choice(schema, "Status", "Blasted"),
        Project: choice(schema, "Project", this.config.project),
        Language: choice(schema, "Language", languageLabel(job.language)),
        "Sender Instance": choice(schema, "Sender Instance", job.instanceName || "Unknown"),
        "Last Blast At": dateValue(sentAt),
        "Template Sent": relation(templateIds),
      });
    } else {
      page = await this.createLeadPage({ lead: job.lead, job, sentAt, templateIds });
    }

    this.state.leadPages[phone] = cleanId(page.id);
    await this.creditSend({ phone, template });
    await this.saveState();
    console.log(`[notion-sync] blast lead ${existing ? "updated" : "created"} phone=${phone}`);
  }

  async creditSend({ phone, template }) {
    const key = `${phone}:${cleanId(template.pageId)}:sent`;
    if (this.state.creditedSends[key]) return;
    this.state.creditedSends[key] = true;
    await this.incrementPageNumber(template.pageId, "Sent Count", 1);
    if (template.imagePageId) await this.incrementPageNumber(template.imagePageId, "Sent Count", 1);
  }

  async incrementPageNumber(pageId, propertyName, amount = 1) {
    const page = await this.retrievePage(pageId);
    const next = pageNumber(page, propertyName) + amount;
    await this.updatePage(pageId, { [propertyName]: numberValue(next) });
  }

  async upsertLeadReply(event, { createIfMissing = true } = {}) {
    if (!this.enabled || !event?.phone || !event?.id) return { action: "skipped", matched: false };
    if (!event.force && this.state.syncedReplyIds[event.id]) return { action: "deduped", matched: true };
    console.log(`[notion-sync] upload reply phone=${event.phone} route=${event.route || "-"} force=${event.force === true}`);

    const schema = await this.getBlastSchema();
    const existing = await this.findLeadByPhone(event.phone);
    // RED / STOP verdict -> flag every project row for this phone first, so a
    // multi-盘 customer is stopped everywhere, not just the row found below.
    if (event.stopFlag) await this.stopAllRowsForPhone(event.phone, event.route || "STOP");
    if (!existing && !createIfMissing) {
      console.log(`[notion-sync] reply skipped phone=${event.phone} reason=not_in_blast_leads`);
      return { action: "not_found", matched: false };
    }
    // Stop Flag ticked -> customer asked to stop. Leave their Notion row alone
    // (don't reset status / re-engage); just remember we've seen this reply.
    if (existing?.properties?.["Stop Flag"]?.checkbox === true) {
      this.state.syncedReplyIds[event.id] = true;
      await this.saveState();
      return { action: "already_stopped", matched: true };
    }
    const replyCount = existing ? pageNumber(existing, "Reply Count") + 1 : 1;
    const existingTemplates = existing ? pageRelationIds(existing, "Template Sent") : [];
    // Fields a REPLY is allowed to touch. Identity fields (Name / Phone / Project)
    // are deliberately excluded: an existing lead was blasted under a specific
    // 楼盘, so a reply must never re-stamp their Project — that was flipping e.g.
    // Gen Starz customers to whichever project happened to be configured when they
    // replied. Multi-project safe: a customer's 楼盘 is fixed at blast time.
    const replyProps = buildLeadReplyProperties(schema, event, replyCount);

    let page;
    if (existing) {
      // Update only reply fields. Name/Phone/Project preserved; Stop Flag also
      // untouched so an update never un-ticks a customer you've stopped.
      page = await this.updatePage(existing.id, replyProps);
    } else {
      // Brand-new inbound (never blasted). Project is left BLANK unless the event
      // already carries one — you run multiple 楼盘 at once, so a global default
      // would mis-tag a stranger ~half the time. You assign the 楼盘 on review.
      page = await this.request("POST", "/pages", {
        parent: { type: "database_id", database_id: cleanId(blastLeadsDatabase(this.config)) },
        properties: {
          Name: title(event.name || event.phone),
          Phone: phoneNumber(event.phone),
          ...(event.project ? { Project: choice(schema, "Project", event.project) } : {}),
          "Stop Flag": checkbox(false),
          ...replyProps,
        },
      });
    }

    this.state.leadPages[event.phone] = cleanId(page.id);
    await this.creditResponse({ event, templatePageIds: existingTemplates });
    this.state.syncedReplyIds[event.id] = true;
    await this.saveState();
    console.log(`[notion-sync] reply ${existing ? "updated" : "created"} phone=${event.phone} status=${leadStatusFromReply(event)}`);
    return { action: existing ? "updated" : "created", matched: true, pageId: cleanId(page.id) };
  }

  templateByPageId(pageId) {
    const cleaned = cleanId(pageId);
    return Object.values(this.config.templates).find((template) => cleanId(template.pageId) === cleaned);
  }

  async creditResponse({ event, templatePageIds }) {
    for (const templatePageId of templatePageIds) {
      const template = this.templateByPageId(templatePageId);
      const responseKey = `${event.phone}:${cleanId(templatePageId)}:response`;
      if (!this.state.creditedResponses[responseKey]) {
        this.state.creditedResponses[responseKey] = true;
        await this.incrementPageNumber(templatePageId, "Response Count", 1);
        if (template?.imagePageId) await this.incrementPageNumber(template.imagePageId, "Response Count", 1);
      }

      if (event.signal === "GREEN" || event.status === "Warm" || event.status === "Appointment" || event.status === "Follow Up") {
        const warmKey = `${event.phone}:${cleanId(templatePageId)}:warm`;
        if (!this.state.creditedResponses[warmKey]) {
          this.state.creditedResponses[warmKey] = true;
          await this.incrementPageNumber(templatePageId, "Warm Count", 1);
          if (template?.imagePageId) await this.incrementPageNumber(template.imagePageId, "Warm Count", 1);
        }
      }

      if (event.signal === "RED" || event.stopFlag || event.status === "Stop") {
        const stopKey = `${event.phone}:${cleanId(templatePageId)}:stop`;
        if (!this.state.creditedResponses[stopKey]) {
          this.state.creditedResponses[stopKey] = true;
          await this.incrementPageNumber(templatePageId, "Stop Count", 1);
          if (template?.imagePageId) await this.incrementPageNumber(template.imagePageId, "Stop Count", 1);
        }
      }
    }
  }
}

export async function createNotionSync({ env = {}, onLog } = {}) {
  const config = await ensureNotionConfig();
  // Prefer the token saved in evolution-pilot/.env (managed by "Set Notion Token")
  // over any stale NOTION_API_KEY exported in the shell — otherwise a leftover
  // shell export can shadow the good token and cause 401 "API token is invalid".
  const token = env.NOTION_API_KEY || env.NOTION_TOKEN || process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;
  const sync = new NotionSync({ token, config, onLog });
  await sync.init();
  return sync;
}
