// Shared core for the Gen Starz WhatsApp campaign.
// Used by both the web console (server.mjs) and the terminal launcher (campaign_runner.mjs).

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(appDir, "..");

export const paths = {
  appDir,
  rootDir,
  campaignDir: path.join(rootDir, "campaign-assets"),
  dataDir: path.join(rootDir, "campaign-data"),
  runsDir: path.join(rootDir, "campaign-data", "runs"),
};

export const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
export const pick = (items) => items[Math.floor(Math.random() * items.length)];
const DEFAULT_API_TIMEOUT_MS = 15000;
const SEND_API_TIMEOUT_MS = 45000;

export function maskPhone(phone) {
  return `${phone.slice(0, 2)}******${phone.slice(-4)}`;
}

export function personalize(text, name) {
  return text.replaceAll("[Name]", name).replaceAll("[名字]", name);
}

export function isTimeoutError(error) {
  const name = String(error?.name ?? "");
  const message = String(error?.message ?? "");
  return name === "TimeoutError" || name === "AbortError" || /timeout|timed out|ETIMEDOUT|aborted/i.test(message);
}

export class UnconfirmedSendError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnconfirmedSendError";
    this.code = "SEND_TIMEOUT_UNCONFIRMED";
  }
}

// A template becomes a WhatsApp POLL (tappable options) when its Message Text
// contains a [[POLL]] marker on its own line. Everything ABOVE the marker is the
// poll question; each non-empty line BELOW is one option. This lives entirely in
// the Notion "Message Text" field — no schema change — so polls are authored and
// edited in Notion exactly like normal templates. Any leading "1/1️⃣/-/•" bullet
// on an option line is stripped so "1️⃣ Layout" becomes the option "Layout".
// If there is no marker (or fewer than 2 options) it is a normal text message.
export function parsePoll(text) {
  const raw = String(text ?? "");
  const marker = /^\s*\[\[?\s*poll\s*\]?\]\s*$/im;
  const m = raw.match(marker);
  if (!m) return { isPoll: false, question: raw, body: "", options: [] };
  const idx = raw.search(marker);
  const before = raw.slice(0, idx).replace(/\s+$/, "");
  const options = raw.slice(idx + m[0].length)
    .split(/\r?\n/)
    // Strip a leading bullet: keycap emoji (1️⃣ = digit+VS16+U+20E3), "1." / "2)" /
    // "3、", a circled number, or -/*/• — but NOT a bare "3 Bedroom" (no separator).
    .map((line) => line.replace(/^\s*(?:[0-9]️?⃣|\d+[.)、]|[①-⓿]|[-*•])\s*/u, "").trim())
    .filter(Boolean)
    .slice(0, 12); // WhatsApp allows up to 12 poll options
  if (options.length < 2) return { isPoll: false, question: raw, body: "", options: [] };
  // A WhatsApp poll can't carry text or media, so split what's before [[POLL]]
  // into a BODY (the narrative — sent first as its own message / image caption)
  // and the QUESTION (the poll title = the last non-empty line before the marker).
  const lines = before.split(/\r?\n/);
  let qi = lines.length - 1;
  while (qi >= 0 && !lines[qi].trim()) qi -= 1;
  const question = (qi >= 0 ? lines[qi].trim() : "") || "?";
  const body = lines.slice(0, qi).join("\n").trim();
  return { isPoll: true, question, body, options };
}

export function formatTime(date) {
  return date.toLocaleTimeString("en-MY", { hour: "2-digit", minute: "2-digit", hour12: false });
}

// "YYYY-MM-DD HH:MM:SS" in Kuala Lumpur time (sv-SE gives ISO-like output). Excel-friendly.
export function klDateTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("sv-SE", { timeZone: "Asia/Kuala_Lumpur" });
}

// Accepts "" / "now" / "HH:MM" (24h) / "1pm" / "1:30pm". Empty falls back to the
// provided default Date. AM/PM is supported so "1pm" is never misread as 01:00.
export function resolveTime(value, fallback) {
  const cleaned = String(value ?? "").trim().toLowerCase().replace(/\s+/g, "");
  if (!cleaned) return new Date(fallback);
  if (cleaned === "now") return new Date();
  const match = cleaned.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)?$/);
  if (!match || (match[2] === undefined && !match[3])) {
    throw new Error("时间格式：24小时制 HH:MM（如 13:00、21:00），或带 am/pm（如 1pm、1:30pm）。");
  }
  let hour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  const ampm = match[3];
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) throw new Error("时间超出范围，请检查（如 13:00 或 1pm）。");
  const date = new Date();
  date.setHours(hour, minute, 0, 0);
  return date;
}

export async function loadConfig() {
  return JSON.parse(await fs.readFile(path.join(paths.campaignDir, "gen_starz_campaign.json"), "utf8"));
}

// Multi-project registry: campaign-assets/projects.json lists each project with
// its own config file, fixed sender instances, and default Excel.
export async function loadProjects() {
  const data = JSON.parse(await fs.readFile(path.join(paths.campaignDir, "projects.json"), "utf8"));
  return data.projects ?? [];
}

export async function loadProjectConfig(project) {
  return JSON.parse(await fs.readFile(path.join(paths.campaignDir, project.config), "utf8"));
}

export async function loadEnv() {
  const envText = await fs.readFile(path.join(paths.rootDir, "evolution-pilot", ".env"), "utf8");
  return Object.fromEntries(
    envText
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

export function makeApi(env) {
  const apiBase = "http://127.0.0.1:8080";
  const apiHeaders = { "Content-Type": "application/json", apikey: env.AUTHENTICATION_API_KEY };
  return async function api(pathname, options = {}) {
    const { timeoutMs = DEFAULT_API_TIMEOUT_MS, ...fetchOptions } = options;
    const response = await fetch(`${apiBase}${pathname}`, {
      ...fetchOptions,
      headers: { ...apiHeaders, ...(fetchOptions.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${pathname}: HTTP ${response.status} ${JSON.stringify(body)}`);
    return body;
  };
}

export function normalizePhone(value) {
  let digits = String(value ?? "").replace(/\D/g, "");
  if (digits.startsWith("0")) digits = `60${digits.slice(1)}`;
  return /^\d{8,15}$/.test(digits) ? digits : null;
}

export async function importLeads(sourcePath) {
  const { FileBlob, SpreadsheetFile } = await import("./xlsx_compat.mjs");
  const resolved = path.resolve(sourcePath || path.join(paths.rootDir, "Untitled spreadsheet.xlsx"));
  const input = await FileBlob.load(resolved);
  const workbook = await SpreadsheetFile.importXlsx(input);
  const sheet = workbook.worksheets.getItemAt(0);
  const values = sheet.getUsedRange(true)?.values ?? [];
  if (values.length < 2) throw new Error("The workbook does not contain any lead rows.");

  const headers = values[0].map((value) => String(value ?? "").trim().toLowerCase());
  const nameIndex = headers.indexOf("name");
  const phoneIndex = headers.indexOf("phone");
  if (nameIndex < 0 || phoneIndex < 0) throw new Error("The workbook needs Name and Phone columns.");

  const seen = new Set();
  const leads = [];
  const rejected = [];
  for (let index = 1; index < values.length; index += 1) {
    const row = values[index];
    const name = String(row[nameIndex] ?? "").trim() || "there";
    const phone = normalizePhone(row[phoneIndex]);
    if (!phone || seen.has(phone)) {
      rejected.push({ row: index + 1, reason: phone ? "duplicate" : "invalid phone" });
      continue;
    }
    seen.add(phone);
    leads.push({ id: `lead_${String(index).padStart(5, "0")}`, name, phone, sourceRow: index + 1 });
  }

  const result = { sourcePath: resolved, importedAt: new Date().toISOString(), leads, rejected };
  await fs.mkdir(paths.dataDir, { recursive: true });
  await fs.writeFile(path.join(paths.dataDir, "leads.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

export async function loadSavedLeads() {
  try {
    return JSON.parse(await fs.readFile(path.join(paths.dataDir, "leads.json"), "utf8"));
  } catch {
    return null;
  }
}

// Only OPEN instances, normalized for sending.
export async function openInstances(api) {
  const items = await api("/instance/fetchInstances");
  return items
    .filter((item) => (item.connectionStatus ?? item?.instance?.state ?? item?.instance?.status) === "open")
    .map((item) => ({
      name: item.name ?? item?.instance?.instanceName,
      owner: String(item.ownerJid ?? item?.instance?.owner ?? "").split("@")[0].split(":")[0],
    }))
    .filter((item) => item.name);
}

// All instances with display status, for the monitor panel.
export async function listInstances(api) {
  const items = await api("/instance/fetchInstances");
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    const name = item?.name ?? item?.instance?.instanceName ?? "unknown";
    const status = item?.connectionStatus ?? item?.instance?.state ?? item?.instance?.status ?? "unknown";
    const owner = item?.ownerJid ?? item?.instance?.owner;
    const digits = String(owner ?? "").split("@")[0].split(":")[0].replace(/\D/g, "");
    const number = digits ? `+${digits}` : "Not connected";
    return { name, status: String(status).toUpperCase(), number };
  });
}

export function nextInstanceName(items) {
  const names = new Set(items.map((item) => item.name ?? item?.instance?.instanceName));
  for (let number = 1; number <= 99; number += 1) {
    const candidate = `wa_${String(number).padStart(2, "0")}`;
    if (!names.has(candidate)) return candidate;
  }
  throw new Error("没有可用的号码标签了（wa_01 ~ wa_99 都被占用）。");
}

export async function createInstance(api, instanceName) {
  const created = await api("/instance/create", {
    method: "POST",
    body: JSON.stringify({ instanceName, qrcode: true, integration: "WHATSAPP-BAILEYS" }),
  });
  return { instanceName, qr: created?.qrcode?.base64 ?? null };
}

export async function instanceQr(api, instanceName) {
  const body = await api(`/instance/connect/${encodeURIComponent(instanceName)}`);
  return body?.base64 ?? body?.qrcode?.base64 ?? null;
}

export async function deleteInstance(api, instanceName) {
  try {
    await api(`/instance/logout/${encodeURIComponent(instanceName)}`, { method: "DELETE" });
  } catch {
    // already logged out / not connected — continue to delete
  }
  await api(`/instance/delete/${encodeURIComponent(instanceName)}`, { method: "DELETE" });
}

export function chooseLanguage(config) {
  const threshold = config.languageSelection.weights.en;
  return Math.random() * 100 < threshold ? "en" : "zh";
}

export function firstFlowVariants(config) {
  const variants = config?.part1?.variants || [];
  const flow1 = variants.filter((variant) => /(^|_)flow0?1(_|$)/i.test(String(variant.id || "")));
  return flow1.length ? flow1 : variants;
}

function hasExplicitFirstFlow(config) {
  return (config?.part1?.variants || []).some((variant) => /(^|_)flow0?1(_|$)/i.test(String(variant.id || "")));
}

export function firstFlowPart2Variants(config, part1Variant) {
  const variants = config?.part2?.variants || [];
  if (!variants.length) return [];
  const sameLanguage = variants.filter((variant) => variant.language === part1Variant?.language);
  const candidates = sameLanguage.length ? sameLanguage : variants;

  // New flow-based configs keep follow-up flow messages inside part1/part2 arrays.
  // For the first-blast console, do not let Flow 2/6/8/9 Part 2 messages sneak
  // into Flow 1. Legacy configs without flow IDs keep their old pairing behavior.
  if (!hasExplicitFirstFlow(config)) return candidates;

  return candidates.filter((variant) => {
    const id = String(variant.id || "");
    return /(^|_)flow0?1(_|$)/i.test(id) || /project[_-]?template/i.test(id);
  });
}

// TEST recipients can come from the web UI (one per line: Name, Phone, Lang) or
// from TEST_LEADS in .env (legacy: Name:phone:lang:templateId).
export function getTestLeads(raw = process.env.TEST_LEADS || "") {
  const text = String(raw || "").trim();
  const entries = (text.includes("\n")
    ? text.split(/\r?\n/)
    : (text.includes(":") && text.includes(",") ? text.split(",") : [text]))
    .map((s) => s.trim())
    .filter(Boolean);
  const leads = entries.map((entry, i) => {
    const pieces = entry.includes(":") ? entry.split(":") : entry.split(/[,\t|]/);
    const [nameRaw, phoneRaw, languageRaw, templateIdRaw] = pieces.map((s) => (s || "").trim());
    const phone = normalizePhone(phoneRaw);
    if (!nameRaw || !phone) return null;
    const language = String(languageRaw || "en").trim().toLowerCase();
    const slug = nameRaw.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || `recipient_${i + 1}`;
    return {
      id: `test_${i}_${slug}`,
      name: nameRaw,
      phone,
      language: language === "zh" ? "zh" : "en",
      templateId: templateIdRaw || "",
    };
  }).filter(Boolean);
  if (!leads.length) {
    console.warn("[TEST MODE] 没有测试收件人。请在页面填写，或在 .env 设置 TEST_LEADS。");
  }
  return leads;
}

// Per-lead manual template override. overrides: [{ id, part1Variant }].
// Switching a lead's Part 1 also switches its language and re-matches Part 2.
export function applyTemplateOverrides(state, overrides, config) {
  if (!Array.isArray(overrides) || !overrides.length) return;
  const byId = new Map(overrides.map((item) => [item.id, item]));
  const allowedPart1 = firstFlowVariants(config);
  for (const job of state.assignments) {
    const override = byId.get(job.id);
    if (!override || !override.part1Variant) continue;
    const variant1 = allowedPart1.find((variant) => variant.id === override.part1Variant);
    if (!variant1) continue;
    job.part1Variant = variant1.id;
    job.language = variant1.language;
    job.part1Text = personalize(variant1.text, job.lead.name);
    const allowedPart2 = firstFlowPart2Variants(config, variant1);
    const variant2 = allowedPart2.find((variant) => variant.id === job.part2Variant) || allowedPart2[0] || null;
    if (variant2) {
      job.part2Variant = variant2.id;
      job.part2Text = personalize(variant2.text, job.lead.name);
      job.part2Media = variant2.media ?? config.part2?.media ?? "";
    } else {
      job.part2Variant = null;
      job.part2Text = "";
      job.part2Media = "";
    }
  }
}

export function buildAssignments(leads, instances, startAt, endAt, config) {
  const part1Variants = firstFlowVariants(config);
  const assignments = leads.map((lead, index) => {
    const preferredSender = String(lead.senderInstance || "").trim();
    const instance = preferredSender
      ? instances.find((item) => item.name === preferredSender)
      : instances[index % instances.length];
    if (!instance) {
      throw new Error(`Sender Instance ${preferredSender} 不在线或没有被勾选。请到 Settings reconnect，或不要勾选这个客户。`);
    }
    let language = lead.language ?? chooseLanguage(config);

    // Fall back to a language that actually has templates (projects may be EN-only, etc.).
    let eligiblePart1 = part1Variants.filter((variant) => variant.language === language);
    if (!eligiblePart1.length) {
      language = part1Variants[0]?.language ?? language;
      eligiblePart1 = part1Variants.filter((variant) => variant.language === language);
    }
    const part1 = (lead.templateId && eligiblePart1.find((variant) => variant.id === lead.templateId)) || pick(eligiblePart1);
    if (!part1) throw new Error(`No active Flow 1 template for ${lead.name} (${language}).`);
    const part2 = pick(firstFlowPart2Variants(config, part1));

    // Dynamic extra parts (Part 3, 4, ...) — optional. config.extraParts is an
    // ordered array; each element is { variants: [{language, text, media}] }.
    const extraParts = (config.extraParts || []).map((ep) => {
      let elig = (ep.variants || []).filter((v) => v.language === language);
      if (!elig.length) elig = ep.variants || [];
      const v = elig.length ? pick(elig) : null;
      return v ? { variant: v.id ?? null, text: personalize(v.text, lead.name), media: v.media || "", sentInfo: null } : null;
    }).filter(Boolean);

    return {
      id: `job_${String(index + 1).padStart(5, "0")}`,
      lead,
      instanceName: instance.name,
      instanceKey: instance.name,
      senderLast4: instance.owner.slice(-4),
      language,
      part1Variant: part1.id,
      part2Variant: part2?.id ?? null,
      part1Text: personalize(part1.text, lead.name),
      part2Text: part2 ? personalize(part2.text, lead.name) : "",
      part1Media: part1.media ?? config.part1?.media,
      part2Media: part2?.media ?? "",
      extraParts,
      status: "QUEUED",
      scheduledAt: null,
      part1: null,
      part2: null,
      error: null,
    };
  });

  const latestPart1 = endAt.getTime() - config.delivery.partGapSeconds * 1000;
  const interval = assignments.length > 1 ? (latestPart1 - startAt.getTime()) / (assignments.length - 1) : 0;
  assignments.forEach((job, index) => {
    job.scheduledAt = new Date(startAt.getTime() + interval * index).toISOString();
  });
  return assignments;
}

// Drives one campaign run. Holds state in memory and mirrors it to disk so the
// web console can poll progress and other tools can read active-run.json.
export class CampaignRunner {
  constructor({ config, env, onLog, systemLogs } = {}) {
    this.config = config;
    this.env = env;
    this.api = makeApi(env);
    this.onLog = onLog;
    this.systemLogs = systemLogs;
    this.state = null;
    this.runPath = null;
    this.stopped = false;
    this.running = false;
    this.log = [];
    this.mediaCache = new Map();
    this.consecutiveFailures = 0;
  }

  pushLog(message) {
    const entry = { time: new Date().toISOString(), message };
    this.log.push(entry);
    if (this.log.length > 500) this.log.shift();
    if (this.onLog) this.onLog(entry);
    return entry;
  }

  async systemLog(level, event, message, context = {}) {
    if (!this.systemLogs) return;
    try {
      await this.systemLogs.write({
        level,
        area: "campaign",
        event,
        message,
        context: {
          runId: this.state?.runId ?? null,
          project: this.state?.project ?? this.config?.campaignName ?? null,
          mode: this.state?.mode ?? null,
          ...context,
        },
      });
    } catch {
      // System logs must never block or break a campaign send.
    }
  }

  async atomicWrite(filePath, value) {
    const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
    await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
    await fs.rename(tempPath, filePath);
  }

  async saveState() {
    this.state.updatedAt = new Date().toISOString();
    await this.atomicWrite(this.runPath, this.state);
    await this.atomicWrite(path.join(paths.dataDir, "active-run.json"), this.state);
  }

  summary() {
    const counts = {};
    if (this.state) for (const job of this.state.assignments) counts[job.status] = (counts[job.status] ?? 0) + 1;
    return counts;
  }

  showProgress(message) {
    this.pushLog(message);
  }

  async prepare({ mode, startAt, endAt, instances, leads, project }) {
    const runId = `run_${new Date().toISOString().replace(/[:.]/g, "-")}`;
    this.runPath = path.join(paths.runsDir, `${runId}.json`);
    await fs.mkdir(paths.runsDir, { recursive: true });
    this.state = {
      runId,
      project: project ?? null,
      campaignId: this.config.campaignId,
      mode,
      status: mode === "LIVE" ? "READY" : "READY_TEST",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startAt: startAt.toISOString(),
      endAt: endAt.toISOString(),
      instances,
      assignments: buildAssignments(leads, instances, startAt, endAt, this.config),
    };
    if (mode === "TEST") {
      for (const job of this.state.assignments) job.scheduledAt = startAt.toISOString();
    }
    await this.saveState();
    return this.state;
  }

  async loadMedia(relativeMediaPath) {
    let media = this.mediaCache.get(relativeMediaPath);
    if (media) return media;
    const buffer = await fs.readFile(path.join(paths.campaignDir, relativeMediaPath));
    if (!buffer.length) throw new Error(`媒体文件为空：${relativeMediaPath}`);
    media = buffer.toString("base64");
    this.mediaCache.set(relativeMediaPath, media);
    return media;
  }

  // Resolve an instance's OWN WhatsApp number (the connected sender), cached for
  // 60s so a blast doesn't hammer Evolution. Used to fill [Phone_Number] with the
  // number that is actually sending, so the customer sees/saves the right contact.
  async resolveSenderPhone(instanceName) {
    this._senderPhones ??= new Map();
    if (!this._senderPhones.has(instanceName) || Date.now() - (this._senderPhonesAt || 0) > 60000) {
      try {
        const items = await this.api("/instance/fetchInstances");
        for (const item of Array.isArray(items) ? items : []) {
          const name = item.name ?? item?.instance?.instanceName;
          const owner = String(item.ownerJid ?? item?.instance?.owner ?? "").split("@")[0].split(":")[0];
          if (name) this._senderPhones.set(name, owner);
        }
        this._senderPhonesAt = Date.now();
      } catch { /* keep whatever we had */ }
    }
    return this._senderPhones.get(instanceName) || "";
  }

  // Fill [Phone_Number] / [电话号码] with the sending instance's own number (+<intl>).
  // No-op (and no API call) when the placeholder isn't present.
  async applySenderPhone(text, instanceName) {
    const s = String(text ?? "");
    if (!/\[Phone_Number\]|\[电话号码\]/i.test(s)) return s;
    const phone = await this.resolveSenderPhone(instanceName);
    const formatted = phone ? `+${phone}` : "";
    return s.replace(/\[Phone_Number\]/gi, formatted).replaceAll("[电话号码]", formatted);
  }

  async sendMediaWithRetry(instanceName, number, text, relativeMediaPath, attempts = 3) {
    // Substitute the sender's own number first, so [Phone_Number] is filled whether
    // the message ends up going out as text, media, or a poll.
    text = await this.applySenderPhone(text, instanceName);
    // Poll templates ([[POLL]] marker in the text). A WhatsApp poll can't carry an
    // image or body text, so send the image (with the narrative as its caption)
    // FIRST as its own message, then the poll itself. Every send path (preview,
    // Flow-1 blast, per-flow follow-up) goes through this method, so polls work
    // everywhere. The nested send below carries no [[POLL]] marker, so it takes
    // the normal media/text path — no recursion loop.
    const poll = parsePoll(text);
    if (poll.isPoll) {
      const gap = (this.config?.delivery?.partGapSeconds ?? 1) * 1000;
      if (relativeMediaPath) {
        await this.sendMediaWithRetry(instanceName, number, poll.body, relativeMediaPath, attempts);
        await wait(gap);
      } else if (poll.body) {
        await this.sendText(instanceName, number, poll.body);
        await wait(gap);
      }
      return this.sendPoll(instanceName, number, poll.question, poll.options);
    }
    // If a media file is configured but not on disk, don't fail the whole
    // message — send text-only and warn. One missing image never blocks a blast.
    if (relativeMediaPath) {
      try {
        await fs.access(path.join(paths.campaignDir, relativeMediaPath));
      } catch {
        this.showProgress(`⚠️ 图片缺失,改为只发文字:${relativeMediaPath}`);
        await this.systemLog("warn", "missing_media", "Configured media missing; sending text only.", {
          instanceName,
          phone: number,
          media: relativeMediaPath,
        });
        relativeMediaPath = "";
      }
    }
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (this.stopped) throw lastError ?? new Error("stopped");
      try {
        // No media -> send as a plain text message (e.g. text-only Part 2).
        return relativeMediaPath
          ? await this.sendMedia(instanceName, number, text, relativeMediaPath)
          : await this.sendText(instanceName, number, text);
      } catch (error) {
        lastError = error;
        // "exists":false -> the number is not on WhatsApp. Permanent, so don't retry.
        if (/"exists"\s*:\s*false/.test(error.message) || /not.*whatsapp/i.test(error.message)) {
          throw new Error("不是 WhatsApp 号码 (not on WhatsApp)");
        }
        // Timeout is dangerous to retry: Evolution/WhatsApp may have received the
        // send request but failed to answer in time. Retrying can duplicate the
        // same customer message, so stop and let the user verify before resending.
        if (isTimeoutError(error)) {
          await this.systemLog("warn", "send_timeout_unconfirmed", "Send timeout without confirmation; automatic retry stopped to avoid duplicates.", {
            instanceName,
            phone: number,
            timeoutMs: SEND_API_TIMEOUT_MS,
            error: error.message,
          });
          throw new UnconfirmedSendError(
            `发送 timeout：Evolution/WhatsApp ${Math.round(SEND_API_TIMEOUT_MS / 1000)} 秒内没有确认。为避免重复发送，系统已停止自动重试；请先检查客户 WhatsApp 是否已收到，再决定是否补发。`,
          );
        }
        if (attempt < attempts) {
          this.showProgress(`Send failed (try ${attempt}/${attempts}): ${error.message} — retrying in 4s`);
          await this.systemLog("warn", "send_retry", "Send failed; retrying.", {
            instanceName,
            phone: number,
            attempt,
            attempts,
            error: error.message,
          });
          await wait(4000);
        }
      }
    }
    throw lastError;
  }

  async sendMedia(instanceName, number, text, relativeMediaPath) {
    const mediaPath = path.join(paths.campaignDir, relativeMediaPath);
    const media = await this.loadMedia(relativeMediaPath);
    // Pick mediatype/mimetype from the file extension so videos (e.g. Flow 8 mp4)
    // send as video, not image.
    const ext = (relativeMediaPath.split(".").pop() || "").toLowerCase();
    const isVideo = ["mp4", "mov", "3gp", "m4v"].includes(ext);
    const mediatype = isVideo ? "video" : "image";
    const mimetype = isVideo
      ? (ext === "mov" ? "video/quicktime" : "video/mp4")
      : ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/jpeg";
    const result = await this.api(`/message/sendMedia/${encodeURIComponent(instanceName)}`, {
      method: "POST",
      timeoutMs: SEND_API_TIMEOUT_MS,
      body: JSON.stringify({
        number,
        mediatype,
        mimetype,
        caption: text,
        media,
        fileName: path.basename(mediaPath),
        delay: 1000,
      }),
    });
    return { messageId: result?.key?.id ?? null, apiStatus: result?.status ?? null, sentAt: new Date().toISOString() };
  }

  async sendText(instanceName, number, text) {
    // Direct callers (e.g. a template sent straight as text) also get [Phone_Number]
    // substitution + poll routing. Any narrative before [[POLL]] goes out as its
    // own text message first (a poll can't carry body text), then the poll.
    text = await this.applySenderPhone(text, instanceName);
    const poll = parsePoll(text);
    if (poll.isPoll) {
      if (poll.body) {
        const gap = (this.config?.delivery?.partGapSeconds ?? 1) * 1000;
        await this.sendText(instanceName, number, poll.body);
        await wait(gap);
      }
      return this.sendPoll(instanceName, number, poll.question, poll.options);
    }
    const result = await this.api(`/message/sendText/${encodeURIComponent(instanceName)}`, {
      method: "POST",
      timeoutMs: SEND_API_TIMEOUT_MS,
      body: JSON.stringify({ number, text, delay: 1000 }),
    });
    return { messageId: result?.key?.id ?? null, apiStatus: result?.status ?? null, sentAt: new Date().toISOString() };
  }

  // Native WhatsApp poll — the customer taps an option instead of typing. Works on
  // regular WhatsApp (unlike tap-buttons, which don't render on personal numbers).
  // selectableCount 1 = single choice. The vote comes back as a pollUpdate webhook,
  // which reply_intake decodes into the chosen option text so it flows through the
  // same reply classifier as a typed answer.
  async sendPoll(instanceName, number, question, options) {
    const values = (options || []).map((o) => String(o).slice(0, 100)).filter(Boolean).slice(0, 12);
    if (values.length < 2) {
      // Not enough options to be a real poll — fall back to plain text so nothing is lost.
      return this.sendText(instanceName, number, [question, ...values].filter(Boolean).join("\n"));
    }
    const result = await this.api(`/message/sendPoll/${encodeURIComponent(instanceName)}`, {
      method: "POST",
      timeoutMs: SEND_API_TIMEOUT_MS,
      body: JSON.stringify({ number, name: String(question || "?").slice(0, 255), selectableCount: 1, values, delay: 1000 }),
    });
    return { messageId: result?.key?.id ?? null, apiStatus: result?.status ?? null, sentAt: new Date().toISOString() };
  }

  async repliedSince(instanceName, phone, sinceIso) {
    try {
      const response = await this.api(`/chat/findMessages/${encodeURIComponent(instanceName)}`, {
        method: "POST",
        body: JSON.stringify({ where: { key: { remoteJid: `${phone}@s.whatsapp.net` } } }),
      });
      const since = new Date(sinceIso).getTime();
      return collectMessageObjects(response).some((message) => {
        const timestamp = Number(message.messageTimestamp ?? 0);
        const milliseconds = timestamp < 100000000000 ? timestamp * 1000 : timestamp;
        return message?.key?.fromMe === false && milliseconds >= since;
      });
    } catch {
      return false;
    }
  }

  async waitUntil(isoTime) {
    while (!this.stopped) {
      const remaining = new Date(isoTime).getTime() - Date.now();
      if (remaining <= 0) return;
      await wait(Math.min(remaining, 1000));
    }
  }

  async processJob(job) {
    if (this.stopped) return;
    await this.waitUntil(job.scheduledAt);
    if (this.stopped) return;
    if (Date.now() > new Date(this.state.endAt).getTime()) {
      job.status = "SKIPPED_END_TIME";
      await this.saveState();
      return;
    }
    // GLOBAL suppression gate (A1), send-time check: even if a lead slipped
    // into the cohort (imported before the STOP, or an old cohort file),
    // nothing goes out to a phone on the global STOP list.
    const supPhone = normalizePhone(job.lead?.phone);
    if (supPhone && this.suppression?.has(supPhone)) {
      job.status = "SKIPPED_SUPPRESSED";
      job.error = "Global STOP list (opted out — possibly in another project).";
      await this.saveState();
      this.showProgress(`⛔ ${job.lead.name} skipped — global STOP list.`);
      await this.systemLog("info", "suppression_skip", "Lead skipped by global STOP list.", {
        jobId: job.id,
        name: job.lead.name,
        phone: job.lead.phone,
        instanceName: job.instanceName,
      });
      return;
    }

    // P2 (2026-07-11): 未结算回复防线。客户之前回复过但没人结算 (tracker 没开 /
    // 早间没跑) 的话, Notion 状态还是 Running, cohort 挡不住 — 这里发 Part 1 前
    // 直接问 Evolution: 这个号最近 N 天有没有 inbound? 有 -> 跳过, 等结算处理。
    // repliedSince 查询失败时 fail-open (返回 false), 所以这是安全网不是唯一闸门。
    if (!job.part1?.sentAt) {
      const lookbackDays = Number(this.config?.delivery?.replyLookbackDays ?? 7);
      if (lookbackDays > 0) {
        const sinceIso = new Date(Date.now() - lookbackDays * 86400000).toISOString();
        if (await this.repliedSince(job.instanceName, supPhone ?? job.lead.phone, sinceIso)) {
          job.status = "SKIPPED_REPLIED";
          job.error = `Inbound reply within last ${lookbackDays}d — settle it (早间跟进/tracker) before re-sending.`;
          await this.saveState();
          this.showProgress(`✋ ${job.lead.name} skipped — 有未结算的回复,先跑早间跟进。`);
          await this.systemLog("info", "unsettled_reply_skip", "Lead skipped: recent inbound reply not yet settled.", {
            jobId: job.id,
            name: job.lead.name,
            phone: job.lead.phone,
            instanceName: job.instanceName,
            lookbackDays,
          });
          return;
        }
      }
    }

    try {
      if (!job.part1?.sentAt) {
        job.status = "SENDING_PART1";
        await this.saveState();
        this.showProgress(`Part 1 → ${job.lead.name} (${job.lead.phone}) via ${job.instanceName}`);
        job.part1 = await this.sendMediaWithRetry(job.instanceName, job.lead.phone, job.part1Text, job.part1Media);
      } else {
        this.showProgress(`Part 1 already sent → ${job.lead.name}; resume from next unfinished part.`);
      }
      job.status = "WAITING_PART2";
      await this.saveState();

      await wait(this.config.delivery.partGapSeconds * 1000);
      if (this.stopped) return;

      if (this.config.delivery.cancelPart2WhenCustomerReplies && await this.repliedSince(job.instanceName, job.lead.phone, job.part1.sentAt)) {
        job.status = "REPLIED_WARM";
        await this.saveState();
        this.showProgress(`Reply detected → ${job.lead.name}; Part 2 cancelled`);
        return;
      }

      if (Date.now() > new Date(this.state.endAt).getTime()) {
        job.status = "PART1_ONLY_END_TIME";
        await this.saveState();
        return;
      }

      // Single-message flow (no Part 2 template): finish after Part 1 instead of
      // sending an empty message.
      if (!job.part2Text && !job.part2Media) {
        job.status = "SENT";
        this.consecutiveFailures = 0;
        await this.saveState();
        return;
      }

      if (!job.part2?.sentAt) {
        job.status = "SENDING_PART2";
        await this.saveState();
        this.showProgress(`Part 2 → ${job.lead.name} (${job.lead.phone}) via ${job.instanceName}`);
        job.part2 = await this.sendMediaWithRetry(job.instanceName, job.lead.phone, job.part2Text, job.part2Media);
        await this.saveState();
      } else {
        this.showProgress(`Part 2 already sent → ${job.lead.name}; resume from next unfinished part.`);
      }

      // Dynamic extra parts (Part 3, 4, ...): same pacing + reply-cancel as Part 2.
      const extras = Array.isArray(job.extraParts) ? job.extraParts : [];
      for (let k = 0; k < extras.length; k++) {
        const ep = extras[k];
        if (!ep || (!ep.text && !ep.media)) continue;
        if (ep.sentInfo?.sentAt) continue;
        await wait(this.config.delivery.partGapSeconds * 1000);
        if (this.stopped) { await this.saveState(); return; }
        if (this.config.delivery.cancelPart2WhenCustomerReplies && await this.repliedSince(job.instanceName, job.lead.phone, job.part1.sentAt)) {
          job.status = "REPLIED_WARM";
          await this.saveState();
          this.showProgress(`Reply detected → ${job.lead.name}; remaining parts cancelled`);
          return;
        }
        if (Date.now() > new Date(this.state.endAt).getTime()) { job.status = "SENT"; await this.saveState(); return; }
        job.status = `SENDING_PART${k + 3}`;
        this.showProgress(`Part ${k + 3} → ${job.lead.name} (${job.lead.phone}) via ${job.instanceName}`);
        ep.sentInfo = await this.sendMediaWithRetry(job.instanceName, job.lead.phone, ep.text, ep.media);
        await this.saveState();
      }

      job.status = "SENT";
      this.consecutiveFailures = 0;
      await this.saveState();
    } catch (error) {
      job.status = "FAILED";
      job.error = error.message;
      this.consecutiveFailures += 1;
      await this.saveState();
      this.showProgress(`FAILED → ${job.lead.name}: ${error.message}（已跳过，继续下一个）`);
      await this.systemLog("error", "campaign_job_failed", "Lead failed and was skipped.", {
        jobId: job.id,
        name: job.lead.name,
        phone: job.lead.phone,
        instanceName: job.instanceName,
        error: error.message,
        consecutiveFailures: this.consecutiveFailures,
      });
      if (this.consecutiveFailures >= 3) {
        this.showProgress("连续 3 个失败，已自动停止（可能号码被封或服务异常，请检查）。");
        await this.systemLog("error", "campaign_auto_stop", "Campaign stopped after 3 consecutive failures.", {
          consecutiveFailures: this.consecutiveFailures,
        });
        this.stopped = true;
      }
    }
  }

  retryFailedOnly() {
    if (!this.state?.assignments) throw new Error("没有可补发的 run。");
    let count = 0;
    for (const job of this.state.assignments) {
      if (job.status !== "FAILED") continue;
      job.status = "QUEUED";
      job.error = null;
      job.retryCount = (job.retryCount ?? 0) + 1;
      count += 1;
    }
    return count;
  }

  async runQueue() {
    for (let index = 0; index < this.state.assignments.length; index += 1) {
      if (this.stopped) return;
      // Resume-safe: only send leads still QUEUED; already SENT/FAILED/etc. are skipped.
      if (this.state.assignments[index].status !== "QUEUED") continue;
      await this.processJob(this.state.assignments[index]);
      if (this.stopped || index === this.state.assignments.length - 1) return;
      const next = this.state.assignments.slice(index + 1).find((job) => job.status === "QUEUED");
      if (!next) return;
      // Pacing is enforced by processJob -> waitUntil(next.scheduledAt). The
      // schedule is rebased to real wall-clock time in rebaseSchedule(), so we
      // must NOT add an extra fixed wait here (that was collapsing the spread
      // into a ~1/min burst whenever a slot was already in the past).
      const clock = new Date(next.scheduledAt).toLocaleTimeString("en-GB", { hour12: false });
      const mins = Math.max(0, Math.round((new Date(next.scheduledAt).getTime() - Date.now()) / 60000));
      this.showProgress(`Next → ${next.lead.name} at ~${clock} (in ~${mins} min)`);
    }
  }

  // Re-spread all still-QUEUED leads across the time remaining (now -> endAt),
  // never sending faster than a hard minimum gap. This is the core safety fix:
  // the old code paced by absolute scheduled timestamps, so if the run was
  // started AFTER the scheduled start (slots already in the past), waitUntil()
  // returned instantly and every lead fired back-to-back at the 45-75s contact
  // gap. Rebasing from the real clock guarantees the spread always holds.
  rebaseSchedule() {
    const queued = this.state.assignments.filter((job) => job.status === "QUEUED");
    const n = queued.length;
    if (n === 0) return;

    const partGapMs = (this.config.delivery.partGapSeconds || 0) * 1000;
    const minGapSec = this.config.delivery.contactGapSeconds?.min ?? 45;
    const maxGapSec = this.config.delivery.contactGapSeconds?.max ?? Math.max(minGapSec, 75);
    // Hard floor between the START of one lead's blast and the next. Defaults to
    // 2 minutes (configurable via delivery.minBlastGapSeconds) and is never
    // smaller than the two-part send needs. Sending can never be faster.
    const minBlastGapSec = this.config.delivery.minBlastGapSeconds ?? 120;
    const floorMs = Math.max(minBlastGapSec * 1000, partGapMs + minGapSec * 1000);

    // Honor the start time: if the run is launched before it, the first lead
    // waits until the start time; if launched after, we begin now. Either way
    // the spread runs from this anchor to endAt.
    const now = Date.now();
    const startMs = Math.max(now, new Date(this.state.startAt).getTime());
    const endMs = new Date(this.state.endAt).getTime();
    const windowMs = endMs - startMs;
    const evenInterval = n > 1 ? windowMs / (n - 1) : 0;
    // TEST runs shouldn't be stretched across the whole window — pace the few
    // test contacts by the floor gap so the test completes promptly.
    const baseInterval = this.state.mode === "TEST" ? floorMs : Math.max(evenInterval, floorMs);
    // Human-like jitter, capped by the contact-gap range and never below floor.
    const jitterMs = Math.max(0, Math.min((maxGapSec - minGapSec) * 1000, baseInterval * 0.3));

    let t = startMs;
    for (let i = 0; i < n; i += 1) {
      queued[i].scheduledAt = new Date(t).toISOString();
      const jitter = (Math.random() * 2 - 1) * (jitterMs / 2);
      t += Math.max(floorMs, baseInterval + jitter);
    }

    // If the floor pushed the last send past the window, extend endAt so the
    // end-time cutoff doesn't skip those leads (safety beats the strict window).
    const lastScheduled = new Date(queued[n - 1].scheduledAt).getTime();
    if (lastScheduled + floorMs > endMs) {
      this.state.endAt = new Date(lastScheduled + floorMs).toISOString();
    }

    const perMin = Math.round(baseInterval / 6000) / 10; // minutes, 1 decimal
    const hhmm = (ms) => new Date(ms).toLocaleTimeString("en-GB", { hour12: false });
    const waitMin = Math.max(0, Math.round((startMs - now) / 60000));
    this.showProgress(
      `Pacing ${n} leads ~${perMin} min apart (floor ${Math.round(floorMs / 1000)}s), ` +
      `first at ${hhmm(startMs)}${waitMin > 0 ? ` (waiting ~${waitMin} min)` : ""}, ` +
      `last around ${hhmm(new Date(this.state.endAt).getTime())}.`
    );
  }

  async run() {
    if (!this.state) throw new Error("Call prepare() before run().");
    // GLOBAL suppression gate (A1): refresh the STOP snapshot from Notion at
    // campaign start; if Notion is unreachable, fall back to the last local
    // snapshot so an outage never turns the gate off entirely.
    try {
      const { syncSuppressionList } = await import("./suppression.mjs");
      const { set, updatedAt } = await syncSuppressionList();
      this.suppression = set;
      this.pushLog(`Suppression list refreshed: ${set.size} phone(s) blocked (as of ${updatedAt}).`);
    } catch (err) {
      const { loadSuppressionSync } = await import("./suppression.mjs");
      const { set, updatedAt } = loadSuppressionSync();
      this.suppression = set;
      this.pushLog(`Suppression refresh failed (${err?.message}) — using local snapshot: ${set.size} phone(s)${updatedAt ? ` from ${updatedAt}` : ""}.`);
    }
    this.running = true;
    this.stopped = false;
    this.consecutiveFailures = 0;
    this.state.status = "RUNNING";
    this.rebaseSchedule();
    await this.saveState();
    try {
      await this.runQueue();
      this.state.status = this.stopped ? "STOPPED" : "COMPLETED";
    } finally {
      await this.saveState();
      this.running = false;
    }
    this.pushLog(`Campaign ${this.state.status}. Final: ${JSON.stringify(this.summary())}`);
    // 跑完自动发 Telegram 通知(COMPLETED / STOPPED 都发,注明状态与统计)。
    // 优先发去 Mamba 系统台 (Hub ops 群); 没配 ops 才退回旧的私聊通知。
    try {
      const s = this.summary();
      const proj = this.state.project?.name || this.state.project || this.config?.campaignName || "";
      const parts = Object.entries(s).map(([k, v]) => `${k}: ${v}`).join(" · ") || "(无)";
      const icon = this.state.status === "COMPLETED" ? "✅" : "⏹";
      const text = `${icon} Mamba ${this.state.status}\n项目: ${proj}\n模式: ${this.state.mode}\n${parts}`;
      const { makeHub } = await import("./telegram_hub.mjs");
      const hub = makeHub();
      if (hub.hasOps) {
        await hub.postOps(text);
      } else {
        const { makeTelegram } = await import("./telegram.mjs");
        const tg = makeTelegram();
        if (tg.enabled && tg.hasChatId) await tg.send(text);
      }
    } catch (err) {
      this.pushLog(`Telegram 完成通知发送失败: ${err?.message || err}`);
    }
    return this.state.status;
  }

  stop() {
    this.stopped = true;
    if (this.state) {
      this.state.status = "STOPPED";
      this.saveState().catch(() => {});
    }
  }

  snapshot() {
    return {
      running: this.running,
      stopped: this.stopped,
      state: this.state
        ? {
            runId: this.state.runId,
            mode: this.state.mode,
            status: this.state.status,
            startAt: this.state.startAt,
            endAt: this.state.endAt,
            total: this.state.assignments.length,
            summary: this.summary(),
            flowLabel: this.state.flowLabel ?? null,
            templateSource: this.state.templateSource ?? null,
            templateFlow: this.state.templateFlow ?? null,
            templateProject: this.state.templateProject ?? null,
            advanceDone: this.state.advanceDone ?? false,
            assignments: this.state.assignments.map((job) => ({
              id: job.id,
              name: job.lead.name,
              phone: job.lead.phone,
              instanceName: job.instanceName,
              instanceKey: job.instanceKey ?? job.instanceName,
              language: job.language,
              part1Variant: job.part1Variant,
              part2Variant: job.part2Variant,
              scheduledAt: job.scheduledAt,
              part1At: job.part1?.sentAt ?? null,
              part2At: job.part2?.sentAt ?? null,
              extraPartsAt: Array.isArray(job.extraParts) ? job.extraParts.map((ep) => ep?.sentInfo?.sentAt ?? null) : [],
              status: job.status,
              error: job.error,
            })),
          }
        : null,
      log: this.log.slice(-120),
    };
  }
}

function collectMessageObjects(value, found = []) {
  if (!value || typeof value !== "object") return found;
  if (value.key && (value.messageTimestamp || value.createdAt)) found.push(value);
  for (const child of Object.values(value)) collectMessageObjects(child, found);
  return found;
}
