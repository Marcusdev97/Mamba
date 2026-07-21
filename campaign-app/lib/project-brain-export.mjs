// Project Brain 导出：把 Active Brain 盘资料 + Market Library 打包成一份可以直接
// 喂给外部 AI (ChatGPT 等) 的档案。
//
// 安全线：导出档只放"可以对客户讲"的资料。以下永远不进导出档 ——
//   · project.raw          公司 API 原始 payload
//   · salesChart 登入资料   网址 / 帐号 / 密码 (密码本来就只在记忆体里)
// Sales Chart 要看还是回 Project Brain 页面按「显示」，不经过导出。

import { createRequire } from "node:module";
import * as XLSX from "xlsx";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");

export const EXPORT_FORMAT = "mamba-project-brain-export-v1";

const MARKET_FIELDS = [
  ["Developer", "developer"],
  ["State", "state"],
  ["Area", "area"],
  ["Location", "location"],
  ["Property type", "propertyType"],
  ["Tenure", "tenure"],
  ["Land title", "landTitle"],
  ["Completion", "completion"],
  ["Land size", "landSize"],
  ["Blocks / storeys", "blocksStoreys"],
  ["Total units", "totalUnits"],
  ["Maintenance", "maintenance"],
  ["Status", "status"],
];

function clean(value) {
  return String(value ?? "").trim();
}

// 盘资料正文里的 ## 标题会跟导出档自己的 Part 层级打架，压两级下去。
function demoteHeadings(body) {
  return clean(body).replace(/^(#{1,4})\s/gm, (_match, hashes) => `${"#".repeat(Math.min(hashes.length + 2, 6))} `);
}

// 公司镜像的 body 是我们自己合成的提醒句，价钱/状态上面已经列过了，
// 132 个盘重复 132 次只会稀释真正的资料。
const BOILERPLATE_BODY_RE = /^(?:Official project status:|Official list price:|(?:This is a )?[Rr]ead-only company mirror)/;

function meaningfulBody(body) {
  const kept = clean(body).split(/\r?\n/).filter((line) => !BOILERPLATE_BODY_RE.test(line.trim()));
  return kept.join("\n").trim();
}

function moneyRange(min, max) {
  if (!min) return "Not listed";
  const short = (value) => value >= 1000000
    ? `RM${(value / 1000000).toFixed(value % 1000000 ? 2 : 0)}m`
    : `RM${Math.round(value / 1000)}k`;
  return max && max !== min ? `${short(min)} - ${short(max)}` : short(min);
}

function sizeRange(min, max) {
  if (!min) return "Not listed";
  return max && max !== min ? `${min} - ${max} sq ft` : `${min} sq ft`;
}

// 只留 AI 用得上的栏位，顺手把 raw / salesChart 挡在外面。
function safeMarketProject(project, detail) {
  const {
    raw, pictureUrl, detailKey, parseMode, companyDetail, legacyLayout, ...rest
  } = project ?? {};
  const safeDetail = detail ? safeCompanyDetail(detail) : null;
  // 公司详情还没抓到就用旧 KB 的户型区顶着，并且记进 legacyFilled ——
  // 这样导出档和 UI 都看得出这段面积/价钱不是公司现况。
  const useLegacyLayout = !clean(safeDetail?.layout) && clean(legacyLayout);
  const merged = useLegacyLayout
    ? { refreshedAt: null, salesPackage: "", unitPlans: [], sitePlans: [], ...safeDetail, layout: clean(legacyLayout) }
    : safeDetail;
  return {
    ...rest,
    ...("body" in rest ? { body: meaningfulBody(rest.body) } : {}),
    ...(useLegacyLayout ? { legacyFilled: [...(rest.legacyFilled ?? []), "layout"] } : {}),
    priceLabel: moneyRange(project?.priceMin, project?.priceMax),
    builtUpLabel: sizeRange(project?.buMin, project?.buMax),
    ...(merged ? { companyDetail: merged } : {}),
  };
}

function safeCompanyDetail(detail) {
  const plan = (item) => ({
    name: clean(item?.name),
    builtUp: item?.builtUp ?? null,
    bedrooms: clean(item?.bedrooms),
    bathrooms: clean(item?.bathrooms),
    carParks: clean(item?.carParks),
    imageUrl: clean(item?.imageUrl),
  });
  return {
    refreshedAt: detail?.refreshedAt ?? null,
    layout: detail?.layout?.value ? clean(detail.layout.value) : "",
    salesPackage: detail?.salesPackage?.value ? clean(detail.salesPackage.value) : "",
    unitPlans: (detail?.unitPlans ?? []).map(plan),
    sitePlans: (detail?.sitePlans ?? []).map(plan),
  };
}

export function buildProjectBrainExport({
  generatedAt = new Date().toISOString(),
  scope = "all",
  source = "",
  company = {},
  marketProjects = [],
  details = {},
  activeProjects = [],
  genericFacts = [],
} = {}) {
  const market = marketProjects.map((project) => safeMarketProject(project, details[project?.uid]));
  return {
    format: EXPORT_FORMAT,
    generatedAt,
    scope,
    usage: [
      "Active Brain = 已经人工核对、可以直接拿来回客户的盘资料。",
      "Market Library = 公司/市场参考资料，报价前一定要人工核对，不可以当成成交价。",
      "所有价钱都是 list price，不是 net price。Sales Chart 登入资料不在这份档案里。",
    ],
    activeBrain: {
      count: activeProjects.length,
      projects: activeProjects,
    },
    genericFacts,
    marketLibrary: {
      count: market.length,
      source,
      collectedAt: company?.collectedAt ?? null,
      projects: market,
    },
  };
}

function renderSheet(entry) {
  const { body, ...fields } = entry.sheet ?? {};
  const lines = [`### ${entry.name}`, "", `- 档案: \`${entry.file}\``];
  if (entry.promos?.length) lines.push(`- 目前有效 promo: ${entry.promos.length} 个`);
  lines.push("", "```yaml", yaml.dump(fields, { lineWidth: 100, noRefs: true }).trimEnd(), "```");
  if (clean(body)) lines.push("", demoteHeadings(body));
  if (entry.facts?.length) {
    lines.push("", "**已核实事实 (Notion Verified)**", "");
    for (const fact of entry.facts) {
      lines.push(`- ${clean(fact.fact)}${fact.category ? ` _(${clean(fact.category)})_` : ""}`);
    }
  }
  return lines.join("\n");
}

function renderMarketProject(project, index) {
  const lines = [`### ${index}. ${clean(project.name) || "Unnamed project"}`, ""];
  for (const [label, key] of MARKET_FIELDS) {
    const value = clean(project[key]);
    if (value && value !== "Unassigned") lines.push(`- ${label}: ${value}`);
  }
  lines.push(`- Price (list): ${project.priceLabel}`);
  lines.push(`- Built-up: ${project.builtUpLabel}`);
  if (project.tags?.length) lines.push(`- Tags: ${project.tags.join(", ")}`);
  lines.push(`- 资料状态: ${project.qaReady ? "QA Ready" : "Needs review"}${project.verified ? " · Verified" : ""} · 完整度 ${project.completeness ?? 0}%`);
  if (project.activeBrain) lines.push("- ⚠️ 这个盘同时在 Active Brain，以 Active Brain 的资料为准。");
  if (project.legacyFilled?.length) {
    lines.push(`- ⚠️ 以下栏位来自${clean(project.legacySource)}，公司系统没有，未经核对: ${project.legacyFilled.join(", ")}`);
  }
  if (clean(project.source)) lines.push(`- 来源: ${clean(project.source)}`);

  const detail = project.companyDetail;
  if (detail?.layout) lines.push("", "**Layout / Built-up**", "", "```", detail.layout, "```");
  if (detail?.salesPackage) lines.push("", "**Sales Package**", "", "```", detail.salesPackage, "```");
  const plans = [...(detail?.unitPlans ?? []), ...(detail?.sitePlans ?? [])].filter((item) => item.name);
  if (plans.length) {
    lines.push("", "**Plans**", "");
    for (const item of plans) {
      const bits = [item.name];
      if (item.builtUp) bits.push(`${item.builtUp} sq ft`);
      if (item.bedrooms) bits.push(`${item.bedrooms} room`);
      if (item.bathrooms) bits.push(`${item.bathrooms} bath`);
      if (item.carParks) bits.push(`${item.carParks} parking`);
      lines.push(`- ${bits.join(" · ")}`);
    }
  }
  const body = meaningfulBody(project.body);
  if (body) lines.push("", demoteHeadings(body));
  return lines.join("\n");
}

export function renderProjectBrainMarkdown(payload) {
  const parts = [
    "# Mamba Project Brain Export",
    "",
    `> 生成时间: ${payload.generatedAt}`,
    `> 范围: ${payload.scope}`,
    "",
    "## 怎么用这份资料",
    "",
    ...payload.usage.map((line) => `- ${line}`),
  ];

  if (payload.activeBrain.count || payload.scope !== "market") {
    parts.push(
      "",
      "---",
      "",
      `## Part 1 · Active Brain (${payload.activeBrain.count} 个盘 · 可直接回客户)`,
      "",
    );
    if (!payload.activeBrain.count) parts.push("_目前没有 Active Brain 盘资料。_");
    else parts.push(payload.activeBrain.projects.map(renderSheet).join("\n\n"));

    if (payload.genericFacts.length) {
      parts.push("", "### 通用事实 (不限盘)", "");
      for (const fact of payload.genericFacts) {
        parts.push(`- ${clean(fact.fact)}${fact.category ? ` _(${clean(fact.category)})_` : ""}`);
      }
    }
  }

  if (payload.scope !== "active") {
    parts.push(
      "",
      "---",
      "",
      `## Part 2 · Market Library (${payload.marketLibrary.count} 个盘 · 参考用，报价前要核对)`,
      "",
      `_来源: ${payload.marketLibrary.source || "未知"}${payload.marketLibrary.collectedAt ? ` · 收集于 ${payload.marketLibrary.collectedAt}` : ""}_`,
      "",
    );
    if (!payload.marketLibrary.count) parts.push("_目前没有市场库资料。_");
    else parts.push(payload.marketLibrary.projects.map((project, index) => renderMarketProject(project, index + 1)).join("\n\n"));
  }

  return `${parts.join("\n").trimEnd()}\n`;
}

// ---------- Excel ----------
//
// 一个盘一行，价钱/面积保持数字型态，Excel 才排得了序、做得了 pivot。
// 长文字 (Sales Package / 正文) 各占一栏，不换行拆行。

const MARKET_COLUMNS = [
  ["Project", (p) => clean(p.name), 30],
  ["Developer", (p) => clean(p.developer), 24],
  ["State", (p) => clean(p.state), 16],
  ["Area", (p) => clean(p.area), 18],
  ["Location", (p) => clean(p.location), 40],
  ["Property Type", (p) => clean(p.propertyType), 18],
  ["Tenure", (p) => clean(p.tenure), 12],
  ["Land Title", (p) => clean(p.landTitle), 12],
  ["Status", (p) => clean(p.status), 14],
  ["Completion", (p) => clean(p.completion), 14],
  ["Land Size", (p) => clean(p.landSize), 16],
  ["Blocks / Storeys", (p) => clean(p.blocksStoreys), 20],
  ["Total Units", (p) => numberOrText(p.totalUnits), 11],
  ["Maintenance", (p) => clean(p.maintenance), 26],
  ["Price Min (RM)", (p) => p.priceMin ?? "", 14],
  ["Price Max (RM)", (p) => p.priceMax ?? "", 14],
  ["Price Band", (p) => clean(p.priceBand), 16],
  ["Built-up Min (sf)", (p) => p.buMin ?? "", 15],
  ["Built-up Max (sf)", (p) => p.buMax ?? "", 15],
  ["Tags", (p) => (p.tags ?? []).join(", "), 24],
  ["QA Ready", (p) => yesNo(p.qaReady), 10],
  ["Verified", (p) => yesNo(p.verified), 10],
  ["Completeness %", (p) => p.completeness ?? 0, 13],
  ["In Active Brain", (p) => yesNo(p.activeBrain), 14],
  ["Legacy-filled Fields", (p) => (p.legacyFilled ?? []).join(", "), 30],
  ["Legacy Source", (p) => clean(p.legacySource), 24],
  ["Layout / Built-up", (p) => clean(p.companyDetail?.layout), 40],
  ["Sales Package", (p) => clean(p.companyDetail?.salesPackage), 50],
  ["Plans", (p) => planLabels(p.companyDetail).join(" | "), 40],
  ["Notes", (p) => clean(p.body), 40],
  ["Source", (p) => clean(p.source), 30],
  ["UID", (p) => clean(p.uid), 20],
];

const ACTIVE_COLUMNS = [
  ["Project", (entry) => clean(entry.name), 22],
  ["File", (entry) => clean(entry.file), 18],
  ["One-liner", (entry) => clean(entry.sheet?.one_liner), 50],
  ["Area", (entry) => clean(entry.sheet?.location?.area), 20],
  ["Landmark", (entry) => clean(entry.sheet?.location?.landmark), 40],
  ["Price Min (RM)", (entry) => entry.sheet?.price_range?.[0] ?? "", 14],
  ["Price Max (RM)", (entry) => entry.sheet?.price_range?.[1] ?? "", 14],
  ["Monthly From (RM)", (entry) => entry.sheet?.monthly_from ?? "", 16],
  ["Layouts", (entry) => (entry.sheet?.types ?? []).map((type) => clean(type?.layout)).filter(Boolean).join(", "), 20],
  ["Target Buyer", (entry) => (entry.sheet?.target_buyer ?? []).join(", "), 26],
  ["Active Promos", (entry) => (entry.promos ?? []).map((promo) => clean(promo?.desc)).filter(Boolean).join(" | "), 40],
  ["Do Not Say", (entry) => (entry.sheet?.do_not_say ?? []).join(" | "), 50],
  ["Verified Facts", (entry) => (entry.facts ?? []).length, 13],
  ["Body", (entry) => clean(entry.sheet?.body), 60],
];

const FACT_COLUMNS = [
  ["Project", (fact) => clean(fact.project) || "(通用)", 20],
  ["Category", (fact) => clean(fact.category), 16],
  ["Fact", (fact) => clean(fact.fact), 80],
  ["Verified", (fact) => yesNo(fact.verified), 10],
  ["Source", (fact) => clean(fact.source), 30],
  ["Valid Until", (fact) => clean(fact.validUntil), 14],
];

function yesNo(value) {
  return value ? "Yes" : "No";
}

// "278" 要变数字才排得了序，"278 units" 这种就原样留着。
function numberOrText(value) {
  const text = clean(value);
  if (!text) return "";
  return /^\d+$/.test(text) ? Number(text) : text;
}

function planLabels(detail) {
  return [...(detail?.unitPlans ?? []), ...(detail?.sitePlans ?? [])]
    .filter((plan) => plan?.name)
    .map((plan) => [plan.name, plan.builtUp ? `${plan.builtUp}sf` : "", plan.bedrooms ? `${plan.bedrooms}R` : ""].filter(Boolean).join(" "));
}

function sheetFrom(columns, rows) {
  const data = [columns.map(([label]) => label), ...rows.map((row) => columns.map(([, read]) => read(row)))];
  const sheet = XLSX.utils.aoa_to_sheet(data);
  sheet["!cols"] = columns.map(([, , width]) => ({ wch: width }));
  sheet["!freeze"] = { xSplit: 0, ySplit: 1 };
  if (rows.length) {
    sheet["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: columns.length - 1 } }) };
  }
  return sheet;
}

export function buildProjectBrainWorkbook(payload) {
  const workbook = XLSX.utils.book_new();
  const readme = [
    ["Mamba Project Brain Export"],
    ["生成时间", payload.generatedAt],
    ["范围", payload.scope],
    [],
    ...payload.usage.map((line) => [line]),
    [],
    ["Active Brain 盘数", payload.activeBrain.count],
    ["Market Library 盘数", payload.marketLibrary.count],
    ["Market Library 来源", payload.marketLibrary.source || ""],
    ["Market Library 收集时间", payload.marketLibrary.collectedAt || ""],
  ];
  const readmeSheet = XLSX.utils.aoa_to_sheet(readme);
  readmeSheet["!cols"] = [{ wch: 24 }, { wch: 60 }];
  XLSX.utils.book_append_sheet(workbook, readmeSheet, "README");

  if (payload.scope !== "market") {
    XLSX.utils.book_append_sheet(workbook, sheetFrom(ACTIVE_COLUMNS, payload.activeBrain.projects), "Active Brain");
    const facts = [
      ...payload.activeBrain.projects.flatMap((entry) => entry.facts ?? []),
      ...payload.genericFacts,
    ];
    XLSX.utils.book_append_sheet(workbook, sheetFrom(FACT_COLUMNS, facts), "Verified Facts");
  }
  if (payload.scope !== "active") {
    XLSX.utils.book_append_sheet(workbook, sheetFrom(MARKET_COLUMNS, payload.marketLibrary.projects), "Market Library");
  }
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}
