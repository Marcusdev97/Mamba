import fs from "node:fs/promises";
import path from "node:path";

const FLOW_META = [
  { no: 1, topic: "Project Template", day: "Day 0" },
  { no: 2, topic: "Layout", day: "Day 2" },
  { no: 3, topic: "Location", day: "Day 4" },
  { no: 4, topic: "Package", day: "Day 6" },
  { no: 5, topic: "Furnished List", day: "" },
  { no: 6, topic: "Price", day: "Day 9" },
  { no: 7, topic: "Facilities", day: "Day 12" },
  { no: 8, topic: "Invitation", day: "Day 15" },
  { no: 9, topic: "Rental", day: "" },
  { no: 10, topic: "Surrounding", day: "" },
];

const FIRST_FLOW_LABEL = "Flow 1 - Project Template";

function flowTopicOf(flowLabel) {
  const text = String(flowLabel || "");
  return text.includes(" - ") ? text.split(" - ").slice(1).join(" - ").trim() : text.trim();
}

function pickTemplateVariant(variants) {
  return variants[Math.floor(Math.random() * variants.length)];
}

function sortedTemplatePartNumbers(languageTemplates) {
  return Object.keys(languageTemplates?.parts || {})
    .map(Number)
    .filter((number) => (languageTemplates.parts[number] || []).length)
    .sort((a, b) => a - b);
}

function findTemplateVariant(byLang, pageId) {
  const id = String(pageId || "");
  if (!id) return null;
  for (const [language, pack] of Object.entries(byLang || {})) {
    for (const [partNo, variants] of Object.entries(pack?.parts || {})) {
      const variant = (variants || []).find((item) => item.pageId === id);
      if (variant) return { language, partNo: Number(partNo), variant };
    }
  }
  return null;
}

export async function createTemplateService({
  rootDir,
  notionConfig,
  notion,
  nfTitle,
  nfText,
  nfSelect,
  personalize,
  firstFlowVariants,
  firstFlowPart2Variants,
}) {
  let imageAliases = {};
  const aliasPath = path.join(rootDir, "campaign-assets", "image_aliases.json");
  try {
    imageAliases = JSON.parse(await fs.readFile(aliasPath, "utf8"));
  } catch {
    // No aliases means templates can still send plain text; image attachments just stay empty.
  }

  function resolveTemplateProject(name) {
    return notionConfig?.projectAlias?.[name] || name;
  }

  function resolveMedia(imageName) {
    if (!imageName) return "";
    const alias = imageAliases[imageName];
    if (alias) return `images/${alias}`;
    if (/\.(png|jpe?g|webp|gif|mp4|mov|3gp|m4v)$/i.test(imageName)) return `images/${imageName}`;
    return "";
  }

  function flowMetaByTopic(topic) {
    return FLOW_META.find((flow) => flow.topic === String(topic || "").trim()) || null;
  }

  function buildTemplateTitle({ project, flowTopic, language, part, version = "v1" }) {
    const meta = flowMetaByTopic(flowTopic);
    const flowLabel = meta ? `Flow ${String(meta.no).padStart(2, "0")} - ${meta.topic}` : (flowTopic || "Flow");
    return `[${project || "?"}][${flowLabel}][${String(language || "EN").toUpperCase()}][${part || "Part 1"}][${version}]`;
  }

  async function fetchFlowTemplates(projectName, flowLabel, { includeTesting = false } = {}) {
    const templateDbId = String(notionConfig?.databases?.templates ?? "").replace(/[^a-fA-F0-9]/g, "");
    if (!templateDbId) throw new Error("notion_config 里没有 templates database。");
    const topic = flowTopicOf(flowLabel);
    const project = resolveTemplateProject(projectName);
    const statusFilter = includeTesting
      ? { or: [
          { property: "Status", select: { equals: "Active" } },
          { property: "Status", select: { equals: "Testing" } },
        ] }
      : { property: "Status", select: { equals: "Active" } };

    const data = await notion("POST", `/databases/${templateDbId}/query`, { filter: { and: [
      { property: "Flow Topic", select: { equals: topic } },
      { property: "Project", select: { equals: project } },
      statusFilter,
    ] }, page_size: 100 });

    const byLang = {};
    for (const row of data?.results ?? []) {
      const language = (nfSelect(row, "Language") || "EN").toUpperCase();
      const part = nfSelect(row, "Part");
      const status = (nfSelect(row, "Status") || "").trim();
      const text = nfText(row, "Message Text");
      const imageName = nfText(row, "Image Name");
      const media = resolveMedia(imageName);
      if (!text && !media) continue;

      const match = /(\d+)/.exec(part || "");
      const partNo = match ? Number(match[1]) : (/follow\s*up/i.test(part || "") ? 900 : 1);
      byLang[language] = byLang[language] || { parts: {} };
      byLang[language].parts[partNo] = byLang[language].parts[partNo] || [];
      byLang[language].parts[partNo].push({
        name: nfTitle(row, "Template Name"),
        part,
        partNo,
        text,
        media,
        pageId: row.id,
        imagePageId: row.properties?.["Images"]?.relation?.[0]?.id || null,
        status,
      });
    }

    for (const language of Object.keys(byLang)) {
      for (const partNo of Object.keys(byLang[language].parts)) {
        byLang[language].parts[partNo].sort((a, b) =>
          (a.status === "Active" ? 0 : 1) - (b.status === "Active" ? 0 : 1));
      }
      byLang[language].p1 = byLang[language].parts[1] || [];
      byLang[language].p2 = byLang[language].parts[2] || [];
    }
    return byLang;
  }

  async function getFirstFlowTemplateOptions(projectName) {
    const byLang = await fetchFlowTemplates(projectName, FIRST_FLOW_LABEL);
    const templates = [];
    for (const [language, pack] of Object.entries(byLang || {})) {
      for (const item of pack?.parts?.[1] || []) {
        templates.push({
          id: item.pageId,
          language: language.toLowerCase(),
          name: item.name || item.pageId,
          status: item.status,
        });
      }
    }
    return templates;
  }

  async function applyNotionFlowTemplatesToState(state, { projectName, flow, overrides = [], markFlowRun = true, credit = true } = {}) {
    const byLang = await fetchFlowTemplates(projectName, flow);
    if (!Object.keys(byLang).length) {
      throw new Error(`没有 Active 的「${flow}」模板(${projectName})。去 Templates 库确认 Flow Topic 对得上、Status=Active。`);
    }

    const overrideById = new Map((Array.isArray(overrides) ? overrides : []).map((item) => [String(item.id), item]));
    const slug = flow.replace(/[^A-Za-z0-9]+/g, "").toLowerCase();
    const tally = {};
    let overridden = 0;

    for (const job of state.assignments || []) {
      const override = overrideById.get(String(job.id));
      const requested = override?.part1Variant ? findTemplateVariant(byLang, override.part1Variant) : null;
      let language = requested?.language || String(job.language || "en").toUpperCase();
      if (!byLang[language]) language = byLang.EN ? "EN" : Object.keys(byLang)[0];
      const pack = byLang[language];
      const partNumbers = sortedTemplatePartNumbers(pack);
      if (!partNumbers.length) continue;

      const mainPartNo = partNumbers.includes(1) ? 1 : partNumbers[0];
      const main = (requested && requested.language === language && requested.partNo === mainPartNo)
        ? requested.variant
        : pickTemplateVariant(pack.parts[mainPartNo]);
      const chosen = [
        main,
        ...partNumbers.filter((number) => number !== mainPartNo).map((number) => pickTemplateVariant(pack.parts[number])),
      ].filter(Boolean);
      const second = chosen[1] || null;
      const rest = chosen.slice(2);

      job.language = language.toLowerCase();
      job.part1Variant = main.pageId || `flow_${slug}_p1`;
      job.part1Text = personalize(main.text, job.lead.name);
      job.part1Media = main.media || "";
      if (second) {
        job.part2Variant = second.pageId || `flow_${slug}_p2`;
        job.part2Text = personalize(second.text, job.lead.name);
        job.part2Media = second.media || "";
      } else {
        job.part2Variant = null;
        job.part2Text = "";
        job.part2Media = "";
      }
      job.extraParts = rest.map((variant, index) => ({
        variant: variant.pageId || `flow_${slug}_p${index + 3}`,
        text: personalize(variant.text, job.lead.name),
        media: variant.media || "",
        sentInfo: null,
      }));
      job.tplCredit = chosen
        .filter((item) => item && item.pageId)
        .map((item) => ({ pageId: item.pageId, imagePageId: item.imagePageId }));
      for (const creditItem of job.tplCredit) {
        tally[creditItem.pageId] = tally[creditItem.pageId] || { count: 0, imagePageId: creditItem.imagePageId };
        tally[creditItem.pageId].count += 1;
      }
      overridden += 1;
    }

    state.templateSource = "notion";
    state.templateFlow = flow;
    state.templateProject = resolveTemplateProject(projectName);
    state.templateLanguages = Object.keys(byLang);
    if (markFlowRun) {
      state.flowLabel = flow;
      state.advanceDone = false;
    }
    if (credit) {
      state.creditPlan = Object.entries(tally).map(([pageId, value]) => ({
        pageId,
        imagePageId: value.imagePageId,
        count: value.count,
      }));
      state.creditByLang = byLang;
      state.credited = false;
    }
    return { byLang, overridden, tally };
  }

  function pickPreviewLanguage(byLang, requestedLanguage) {
    const languages = Object.keys(byLang || {});
    if (!languages.length) return { language: "", parts: [] };
    const preferred = String(requestedLanguage || "EN").trim().toUpperCase();
    const language = byLang[preferred] ? preferred : (byLang.EN ? "EN" : languages[0]);
    const parts = Object.keys(byLang[language]?.parts || {})
      .map(Number)
      .filter((number) => (byLang[language].parts[number] || []).length)
      .sort((a, b) => a - b)
      .map((number) => byLang[language].parts[number][0])
      .filter(Boolean);
    const usedTesting = parts.some((part) => part && part.status === "Testing");
    return { language, parts, usedTesting };
  }

  async function shortPause(ms = 650) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  function assertFirstConsoleRunUsesFlow1Only(config, state) {
    if (state?.flowLabel) return;
    if (state?.templateSource === "notion") {
      if (state.templateFlow !== FIRST_FLOW_LABEL) {
        throw new Error(`这个预览不是 Flow 1 模板(${state.templateFlow || "未知"})，请重新「生成预览」。`);
      }
      return;
    }

    const allowedP1 = new Set(firstFlowVariants(config).map((variant) => variant.id));
    const byP1 = new Map((config?.part1?.variants || []).map((variant) => [variant.id, variant]));
    const bad = [];
    for (const job of state?.assignments || []) {
      if (job.part1Variant && !allowedP1.has(job.part1Variant)) {
        bad.push(`${job.lead?.name || job.name || job.id}: ${job.part1Variant}`);
        continue;
      }
      if (job.part2Variant) {
        const part1 = byP1.get(job.part1Variant);
        const allowedP2 = new Set(firstFlowPart2Variants(config, part1).map((variant) => variant.id));
        if (!allowedP2.has(job.part2Variant)) bad.push(`${job.lead?.name || job.name || job.id}: ${job.part2Variant}`);
      }
    }
    if (bad.length) {
      throw new Error(`这个预览混到非 Flow 1 模板，请重新「生成预览」。例子: ${bad.slice(0, 3).join(" / ")}`);
    }
  }

  async function addProjectOption(dbId, name) {
    const database = await notion("GET", `/databases/${dbId}`);
    const prop = database?.properties?.Project;
    if (!prop) return "no Project prop";
    const kind = prop.type;
    const config = prop[kind];
    if (!config) return "not select";
    const options = (config.options || []).slice();
    if (options.some((option) => option.name === name)) return "existed";
    options.push({ name });
    await notion("PATCH", `/databases/${dbId}`, { properties: { Project: { [kind]: { options } } } });
    return "added";
  }

  async function setImageAlias(key, filename) {
    imageAliases[key] = filename;
    await fs.writeFile(aliasPath, `${JSON.stringify(imageAliases, null, 2)}\n`);
  }

  return {
    firstFlowLabel: FIRST_FLOW_LABEL,
    flowMetaByTopic,
    buildTemplateTitle,
    resolveTemplateProject,
    resolveMedia,
    fetchFlowTemplates,
    getFirstFlowTemplateOptions,
    applyNotionFlowTemplatesToState,
    pickPreviewLanguage,
    shortPause,
    assertFirstConsoleRunUsesFlow1Only,
    addProjectOption,
    setImageAlias,
  };
}
