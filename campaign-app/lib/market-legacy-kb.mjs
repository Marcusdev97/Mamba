// 2026-06-02 旧知识库 (brain-vault-import/市场库) 的补空层。
//
// 公司 Property 213 的 API 只回一份很薄的清单：价钱、状态、面积。旧 KB 那 136 个 md
// 才有 completion / land size / maintenance / blocks 这些回客户时真正会被问到的东西。
// 两边用 uid 对得起来，所以这里做一件事而已 ——
//
//   公司资料是准的，旧 KB 只填空格，永远不覆盖公司已经有值的栏位。
//
// 两条硬规矩：
//   1. 只补 132 个公司现有的盘。旧 KB 里公司系统已经查无此盘的，不补进来 ——
//      那些多数是下架/卖完的，凭空长回资料库比缺资料更危险。
//   2. Penang / Johor 一律挡掉，跟公司刷新那道闸同一个规则。现在旧 KB 里一个都没有，
//      但换新 KB 的时候这道闸要还在。

import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { completenessOf, isExcludedMarketProject, priceBand } from "./market-dashboard-service.mjs";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");

// 结尾的 --- 必须自成一行。好几个项目描述里有长横线分隔，那是内容不是 frontmatter 结束。
export const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/;

export const LEGACY_KB_DIR = ["brain-vault-import", "市场库"];
export const LEGACY_KB_LABEL = "旧 KB 2026-06-02 (未核对)";

// Fable 的第一批导出里有些 quoted scalar 直接跨行，严格 YAML 会拒绝。
// 只读不写，所以这里做保守 fallback：按 top-level key 拆值，
// 不改原文件，也不让损坏的扩展字段进入 Active Brain。
export function parseLenientFrontmatter(source) {
  const fields = {};
  let currentKey = null;
  let chunks = [];
  const commit = () => {
    if (!currentKey) return;
    const raw = chunks.join("\n").trim();
    if (["price_range_rm", "bu_range_sf"].includes(currentKey)) {
      fields[currentKey] = (raw.match(/-?[\d.]+/g) ?? []).slice(0, 2).map(Number);
    } else if (currentKey === "tags") {
      fields[currentKey] = chunks.map((line) => line.match(/^\s*-\s*(.+)$/)?.[1]?.trim()).filter(Boolean);
    } else if (currentKey === "verified") {
      fields[currentKey] = /^true\b/i.test(raw);
    } else {
      fields[currentKey] = raw
        .replace(/\s+#.*$/, "")
        .replace(/^"/, "")
        .replace(/"$/, "")
        .replace(/\\"/g, '"')
        .trim();
    }
  };
  for (const line of source.split(/\r?\n/)) {
    const keyMatch = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (keyMatch) {
      commit();
      currentKey = keyMatch[1];
      chunks = [keyMatch[2]];
    } else if (currentKey) {
      chunks.push(line);
    }
  }
  commit();
  return fields;
}

export function parseFrontmatter(raw) {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) return null;
  // source = frontmatter 原文。qa_flag / verified 这类安全旗标要直接从原文再读一次，
  // 不能因为前面某个坏引号把整段吃掉就跟着丢。
  try {
    return { fields: yaml.load(match[1]) ?? {}, body: match[2], source: match[1], parseMode: "yaml" };
  } catch {
    return { fields: parseLenientFrontmatter(match[1]), body: match[2], source: match[1], parseMode: "recovered" };
  }
}

export function numericRange(value) {
  if (!Array.isArray(value)) return [null, null];
  const numbers = value.slice(0, 2).map((item) => Number(item));
  return numbers.map((item) => Number.isFinite(item) && item > 0 ? item : null);
}

// 旧 KB frontmatter key -> Market Library 栏位。landSize / maintenance /
// blocksStoreys 公司 API 根本没有，这三个是纯新增。
const TEXT_FIELDS = [
  ["developer", "developer"],
  ["state", "state"],
  ["area", "area"],
  ["location", "location"],
  ["property_type", "propertyType"],
  ["tenure", "tenure"],
  ["land_title", "landTitle"],
  ["land_size", "landSize"],
  ["completion", "completion"],
  ["blocks_storeys", "blocksStoreys"],
  ["total_units", "totalUnits"],
  ["maintenance", "maintenance"],
];

// 公司那边把没填的地区写成 "Unassigned"，那也是空格。
const PLACEHOLDERS = new Set(["", "unassigned", "unknown", "not listed", "n/a", "-"]);

function isBlank(value) {
  if (value === null || value === undefined) return true;
  return PLACEHOLDERS.has(String(value).trim().toLowerCase());
}

function clean(value) {
  return String(value ?? "").trim();
}

// 正文里的户型/面积区。公司详情要逐个盘打 API 才有，没抓到的时候先用旧 KB 顶着。
// 只拿这一段 —— Sales Package 会过期，show unit / sales gallery 那些是内部操作资料，
// 都不该自动流进销售大脑。
const LAYOUT_HEADING_RE = /^##+\s*(?:户型|.*(?:built\s*up|layout)).*$/im;

function sectionUnderHeading(body, headingRe) {
  const lines = String(body ?? "").split(/\r?\n/);
  const start = lines.findIndex((line) => headingRe.test(line));
  if (start < 0) return "";
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##+\s/.test(line)) break;
    out.push(line);
  }
  return out.join("\n").trim();
}

export async function loadLegacyMarketKb(rootDir) {
  const dir = path.join(rootDir, ...LEGACY_KB_DIR);
  let files;
  try {
    files = (await fs.readdir(dir)).filter((file) => file.endsWith(".md") && !file.startsWith("_"));
  } catch {
    return new Map();   // 没放旧 KB = 不补空，不是错误
  }
  const byUid = new Map();
  for (const file of files) {
    let parsed;
    try {
      parsed = parseFrontmatter(await fs.readFile(path.join(dir, file), "utf8"));
    } catch {
      continue;
    }
    if (!parsed) continue;
    const fields = parsed.fields;
    const uid = clean(fields.uid);
    if (!uid) continue;
    // 规矩 2：Penang / Johor 的旧记录连读都不读，免得从 state/area 那条路渗进来。
    if (isExcludedMarketProject({ state: fields.state, area: fields.area, location: fields.location })) continue;
    byUid.set(uid, { file, fields, layout: sectionUnderHeading(parsed.body, LAYOUT_HEADING_RE) });
  }
  return byUid;
}

// 回传补好的 project；legacyFilled 列出哪几栏是旧 KB 补的，UI / 导出才讲得清楚
// 哪些数字还没人核对过。project 本身不改（照 publicProject 的习惯回新物件）。
export function fillFromLegacyKb(project, legacy) {
  if (!legacy) return project;
  const filled = [];
  const next = { ...project };

  for (const [key, target] of TEXT_FIELDS) {
    const incoming = clean(legacy.fields[key]);
    if (isBlank(next[target]) && !isBlank(incoming)) {
      next[target] = incoming;
      filled.push(target);
    }
  }

  const [priceMin, priceMax] = numericRange(legacy.fields.price_range_rm);
  if (!next.priceMin && priceMin) {
    next.priceMin = priceMin;
    next.priceMax = next.priceMax || priceMax;
    filled.push("priceMin");
  }
  const [buMin, buMax] = numericRange(legacy.fields.bu_range_sf);
  if (!next.buMin && buMin) {
    next.buMin = buMin;
    next.buMax = next.buMax || buMax;
    filled.push("buMin");
  }

  // Layout 不算 filled —— 它要等看得到公司详情才知道用不用得上，
  // 决定权留给读的人 (见 project-brain-export 的 safeMarketProject)。
  const legacyLayout = clean(legacy.layout);
  if (legacyLayout) next.legacyLayout = legacyLayout;

  if (!filled.length) return legacyLayout ? { ...next, legacySource: LEGACY_KB_LABEL, legacyFile: legacy.file } : project;
  return {
    ...next,
    // 补了价钱/栏位就要重算这两个衍生值，不然 price band 还挂着 "Missing"、
    // 完整度还是补空前的分数。
    priceBand: priceBand(next.priceMin),
    completeness: completenessOf(next),
    legacyFilled: filled,
    legacySource: LEGACY_KB_LABEL,
    legacyFile: legacy.file,
  };
}
