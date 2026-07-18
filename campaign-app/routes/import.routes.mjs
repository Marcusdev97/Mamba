import fs from "node:fs/promises";
import path from "node:path";
import { httpError, json, readJson } from "../lib/http.mjs";

function requireImport(runtime) {
  if (!runtime.imports) {
    throw httpError(500, "Import service 没有载入。请重启 Mamba server。");
  }
  return runtime.imports;
}

function safeUploadFilename(filename) {
  const raw = path.basename(String(filename || "leads.xlsx"));
  const ext = path.extname(raw).toLowerCase();
  if (![".xlsx", ".xlsm", ".xls", ".csv", ".tsv"].includes(ext)) {
    throw httpError(400, "只支持 .xlsx / .xlsm / .xls / .csv / .tsv 文件。请先把名单导出成这些格式。");
  }
  const base = path.basename(raw, ext).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "leads";
  return `${Date.now()}_${base}${ext}`;
}

function readableImportError(error) {
  const message = String(error?.message || "");
  if (message.includes("Name and Phone columns")) {
    return "Excel 格式不对：第一行必须有 Name 和 Phone 两个 column。";
  }
  if (message.includes("lead rows")) {
    return "Excel 里面没有客户资料。请确认第一张 sheet 有标题行和至少一行客户。";
  }
  if (message.includes("ENOENT")) {
    return "找不到 Excel 文件。请拖文件进来，或确认路径正确。";
  }
  return `导入 Excel 失败: ${message || "没有明确原因。"}`;
}

async function loadSuppressedPhones() {
  const { syncSuppressionList, loadSuppressionSync } = await import("../suppression.mjs");
  try {
    return (await syncSuppressionList()).set;
  } catch {
    return loadSuppressionSync().set;
  }
}

function defaultGroupName(project, sourcePath) {
  const source = path.basename(String(sourcePath || ""), path.extname(String(sourcePath || "")))
    .replace(/^\d+_/, "")
    .replace(/[_-]+/g, " ")
    .trim();
  if (source && source.toLowerCase() !== "untitled spreadsheet") return source.slice(0, 80);
  const stamp = new Date().toLocaleString("en-MY", {
    timeZone: "Asia/Kuala_Lumpur",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${project.name} · ${stamp}`.slice(0, 80);
}

function manualCell(value) {
  return String(value || "").trim().replace(/^['"]|['"]$/g, "").trim();
}

function phoneLike(value) {
  return /^[+\d][\d\s().-]{6,}$/.test(manualCell(value));
}

export function parsePastedLeads(text, normalizePhone) {
  const raw = String(text || "");
  if (raw.length > 2_000_000) {
    const error = new Error("粘贴名单太大（最多约 2 MB）。请分成几个客户群导入。");
    error.code = "PASTED_LEADS_TOO_LARGE";
    throw error;
  }
  const leads = [];
  const rejected = [];
  const seen = new Set();
  const lines = raw.replace(/\r/g, "").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const original = lines[index].trim();
    if (!original) continue;
    const lower = original.toLowerCase();
    if (/(?:\b(?:name|customer)\b|姓名|客户)/.test(lower) && /(?:\b(?:phone|mobile|tel)\b|电话|号码)/.test(lower)) continue;

    let name = "";
    let phone = "";
    const cells = original.includes("\t") || /[,;|]/.test(original)
      ? original.split(original.includes("\t") ? "\t" : /[,;|]/).map(manualCell).filter(Boolean)
      : [];
    if (cells.length >= 2) {
      const phoneIndex = cells.findLastIndex((cell) => phoneLike(cell) && normalizePhone(cell));
      if (phoneIndex >= 0) {
        phone = normalizePhone(cells[phoneIndex]) || "";
        name = cells.filter((_, cellIndex) => cellIndex !== phoneIndex).join(" ").trim();
      }
    }
    if (!phone) {
      const match = original.match(/(?:^|\s)(\+?[\d][\d\s().-]{6,})$/);
      if (match && phoneLike(match[1])) {
        phone = normalizePhone(match[1]) || "";
        name = original.slice(0, match.index).replace(/[,;|:-]+$/g, "").trim();
      }
    }
    if (!phone && phoneLike(original)) phone = normalizePhone(original) || "";
    name = manualCell(name) || "there";
    if (!phone) {
      rejected.push({ row: index + 1, value: original.slice(0, 120), reason: "找不到有效电话号码" });
      continue;
    }
    if (seen.has(phone)) {
      rejected.push({ row: index + 1, value: original.slice(0, 120), reason: "重复号码" });
      continue;
    }
    seen.add(phone);
    leads.push({ id: `manual_${String(index + 1).padStart(5, "0")}`, name, phone, sourceRow: index + 1 });
  }
  return { leads, rejected, sourceRows: lines.filter((line) => line.trim()).length };
}

async function eligibleLeads(imports, project, sourceLeads, { includeBlasted = false } = {}) {
  let skippedAlreadyBlasted = 0;
  let leads = Array.isArray(sourceLeads) ? [...sourceLeads] : [];
  if (imports.hasBlastDatabase && !includeBlasted) {
    try {
      const blasted = await imports.fetchBlastedPhones(project.name);
      leads = leads.filter((lead) => {
        const phone = imports.normalizePhone(lead.phone);
        if (phone && blasted.has(phone)) {
          skippedAlreadyBlasted += 1;
          return false;
        }
        return true;
      });
    } catch (error) {
      console.warn(`[import] already-blasted check unavailable: ${error?.message}`);
    }
  }

  let skippedSuppressed = 0;
  try {
    const suppressed = await loadSuppressedPhones();
    leads = leads.filter((lead) => {
      const phone = imports.normalizePhone(lead.phone);
      if (phone && suppressed.has(phone)) {
        skippedSuppressed += 1;
        return false;
      }
      return true;
    });
  } catch (error) {
    console.warn(`[suppression] gate unavailable: ${error?.message}`);
  }
  return { leads, skippedAlreadyBlasted, skippedSuppressed };
}

export function registerImportRoutes(router) {
  router.post("/api/import", async (req, res, runtime) => {
    const imports = requireImport(runtime);
    const body = await readJson(req);
    let project;
    try {
      ({ project } = await imports.getProject(body.project));
    } catch (error) {
      throw httpError(500, `读取 project 失败: ${error.message}`);
    }

    const source = String(body.sourcePath ?? "").trim() || path.join(imports.rootDir, project.excel);
    console.log(`[import] retrieve excel project=${project.id} source=${source}`);
    let result;
    try {
      result = await imports.importLeads(source);
    } catch (error) {
      throw httpError(400, readableImportError(error));
    }

    let group;
    try {
      group = await imports.createLeadGroup({
        projectCode: project.id,
        projectName: project.name,
        name: String(body.groupName || "").trim() || defaultGroupName(project, result.sourcePath),
        sourceType: "file",
        sourceName: path.basename(result.sourcePath),
        leads: result.leads,
      });
    } catch (error) {
      throw httpError(400, `建立客户群失败: ${error.message}`);
    }

    const eligibility = await eligibleLeads(imports, project, group.leads, { includeBlasted: body.includeBlasted === true });
    imports.setLeadsCache({
      projectId: project.id,
      ...result,
      leads: eligibility.leads,
      leadGroupId: group.id,
      leadGroupName: group.name,
      groupMemberCount: group.memberCount,
    });
    console.log(`[import] customer group=${group.id} project=${project.id} members=${group.memberCount} eligible=${eligibility.leads.length} rejected=${result.rejected.length} skippedBlasted=${eligibility.skippedAlreadyBlasted} skippedSuppressed=${eligibility.skippedSuppressed}`);
    json(res, 200, {
      ok: true,
      project: project.id,
      group: { id: group.id, name: group.name, memberCount: group.memberCount },
      imported: eligibility.leads.length,
      skippedAlreadyBlasted: eligibility.skippedAlreadyBlasted,
      skippedSuppressed: eligibility.skippedSuppressed,
      rejected: result.rejected.length,
      sourcePath: result.sourcePath,
      sample: eligibility.leads.slice(0, 8).map((lead) => ({ name: lead.name, phone: lead.phone })),
    });
  });

  router.post("/api/lead-groups/create-manual", async (req, res, runtime) => {
    const imports = requireImport(runtime);
    const body = await readJson(req);
    let project;
    try {
      ({ project } = await imports.getProject(body.project));
    } catch (error) {
      throw httpError(500, `读取 project 失败: ${error.message}`);
    }
    let parsed;
    try {
      parsed = parsePastedLeads(body.text, imports.normalizePhone);
    } catch (error) {
      throw httpError(400, `整理粘贴名单失败: ${error.message}`);
    }
    if (!parsed.leads.length) {
      const examples = parsed.rejected.slice(0, 3).map((item) => `第 ${item.row} 行：${item.reason}`).join("；");
      throw httpError(400, `没有找到可用客户。每行请放“名字, 电话号码”。${examples ? ` ${examples}` : ""}`);
    }

    let group;
    try {
      group = await imports.createLeadGroup({
        projectCode: project.id,
        projectName: project.name,
        name: body.groupName,
        sourceType: "manual",
        sourceName: "Flow 1 pasted list",
        leads: parsed.leads,
      });
    } catch (error) {
      throw httpError(400, `建立客户群失败: ${error.message}`);
    }
    const eligibility = await eligibleLeads(imports, project, group.leads);
    imports.setLeadsCache({
      projectId: project.id,
      sourcePath: "manual-paste",
      importedAt: group.createdAt,
      rejected: parsed.rejected,
      leads: eligibility.leads,
      leadGroupId: group.id,
      leadGroupName: group.name,
      groupMemberCount: group.memberCount,
    });
    console.log(`[import] pasted customer group=${group.id} project=${project.id} rows=${parsed.sourceRows} members=${group.memberCount} eligible=${eligibility.leads.length} rejected=${parsed.rejected.length}`);
    json(res, 200, {
      ok: true,
      project: project.id,
      group: { id: group.id, name: group.name, memberCount: group.memberCount },
      imported: eligibility.leads.length,
      skippedAlreadyBlasted: eligibility.skippedAlreadyBlasted,
      skippedSuppressed: eligibility.skippedSuppressed,
      rejected: parsed.rejected.length,
      rejectedSample: parsed.rejected.slice(0, 5),
      sample: eligibility.leads.slice(0, 8).map((lead) => ({ name: lead.name, phone: lead.phone })),
    });
  });

  router.get("/api/lead-groups", async (req, res, runtime) => {
    const imports = requireImport(runtime);
    const url = new URL(req.url, `http://${runtime.host}:${runtime.port}`);
    let project;
    try {
      ({ project } = await imports.getProject(url.searchParams.get("project") ?? undefined));
      const groups = await imports.listLeadGroups({ projectCode: project.id });
      const cache = imports.getLeadsCache();
      json(res, 200, {
        ok: true,
        project: project.id,
        selectedGroupId: cache?.projectId === project.id ? cache?.leadGroupId || null : null,
        groups,
      });
    } catch (error) {
      throw httpError(400, `读取客户群失败: ${error.message}`);
    }
  });

  router.post("/api/lead-groups/select", async (req, res, runtime) => {
    const imports = requireImport(runtime);
    const body = await readJson(req);
    let project;
    try {
      ({ project } = await imports.getProject(body.project));
      const group = await imports.readLeadGroup({ groupId: body.groupId, projectCode: project.id });
      const eligibility = await eligibleLeads(imports, project, group.leads);
      imports.setLeadsCache({
        projectId: project.id,
        sourcePath: group.sourceName,
        importedAt: group.createdAt,
        rejected: [],
        leads: eligibility.leads,
        leadGroupId: group.id,
        leadGroupName: group.name,
        groupMemberCount: group.memberCount,
      });
      json(res, 200, {
        ok: true,
        project: project.id,
        group: { id: group.id, name: group.name, memberCount: group.memberCount },
        eligible: eligibility.leads.length,
        skippedAlreadyBlasted: eligibility.skippedAlreadyBlasted,
        skippedSuppressed: eligibility.skippedSuppressed,
      });
    } catch (error) {
      throw httpError(400, `选择客户群失败: ${error.message}`);
    }
  });

  router.post("/api/lead-groups/rename", async (req, res, runtime) => {
    const imports = requireImport(runtime);
    const body = await readJson(req);
    let project;
    try {
      ({ project } = await imports.getProject(body.project));
      const group = await imports.renameLeadGroup({ groupId: body.groupId, projectCode: project.id, name: body.name });
      const cache = imports.getLeadsCache();
      if (cache?.leadGroupId === group.id) cache.leadGroupName = group.name;
      json(res, 200, { ok: true, group: { id: group.id, name: group.name, memberCount: group.memberCount } });
    } catch (error) {
      throw httpError(400, `修改客户群名称失败: ${error.message}`);
    }
  });

  router.post("/api/import/upload-excel", async (req, res, runtime) => {
    const imports = requireImport(runtime);
    const body = await readJson(req);
    const safe = safeUploadFilename(body.filename);
    const base64 = String(body.base64 ?? "");
    const comma = base64.indexOf(",");
    const payload = base64.startsWith("data:") && comma >= 0 ? base64.slice(comma + 1) : base64;
    if (!payload) throw httpError(400, "没有收到文件内容。请重新选择 Excel 文件再导入。");

    const uploadDir = path.join(imports.rootDir, "campaign-data", "uploads");
    await fs.mkdir(uploadDir, { recursive: true });
    const target = path.join(uploadDir, safe);
    try {
      await fs.writeFile(target, Buffer.from(payload, "base64"));
    } catch (error) {
      throw httpError(500, `上传 Excel 失败: 无法写入 campaign-data/uploads。${error.message}`);
    }
    console.log(`[import] upload excel filename=${safe} path=${target}`);
    json(res, 200, { ok: true, sourcePath: target, filename: safe });
  });

  router.get("/api/leads", async (req, res, runtime) => {
    const imports = requireImport(runtime);
    const url = new URL(req.url, `http://${runtime.host}:${runtime.port}`);
    let project;
    try {
      ({ project } = await imports.getProject(url.searchParams.get("project") ?? undefined));
    } catch (error) {
      throw httpError(500, `读取 project 失败: ${error.message}`);
    }

    const leadsCache = imports.getLeadsCache();
    if (!leadsCache || leadsCache.projectId !== project.id) {
      json(res, 200, { ok: true, project: project.id, leads: [] });
      return;
    }
    json(res, 200, {
      ok: true,
      project: project.id,
      group: leadsCache.leadGroupId ? {
        id: leadsCache.leadGroupId,
        name: leadsCache.leadGroupName || "",
        memberCount: Number(leadsCache.groupMemberCount || leadsCache.leads.length),
      } : null,
      leads: leadsCache.leads.map((lead) => ({ id: lead.id, name: lead.name, phone: lead.phone })),
    });
  });

  router.post("/api/leads/update", async (req, res, runtime) => {
    const imports = requireImport(runtime);
    const body = await readJson(req);
    let project;
    try {
      ({ project } = await imports.getProject(body.project));
    } catch (error) {
      throw httpError(500, `读取 project 失败: ${error.message}`);
    }

    const leadsCache = imports.getLeadsCache();
    if (!leadsCache || leadsCache.projectId !== project.id) {
      throw httpError(400, "还没有导入这个 project 的 leads，请先导入 Excel。");
    }
    const edits = Array.isArray(body.edits) ? body.edits : [];
    const byId = new Map(leadsCache.leads.map((lead) => [lead.id, lead]));
    let updated = 0;
    if (leadsCache.leadGroupId) {
      try {
        await imports.updateLeadGroupMembers({
          groupId: leadsCache.leadGroupId,
          projectCode: project.id,
          edits,
        });
      } catch (error) {
        throw httpError(400, `客户名字未能保存到客户群: ${error.message}`);
      }
    }
    for (const edit of edits) {
      const lead = byId.get(String(edit.id));
      if (!lead) continue;
      const name = String(edit.name ?? "").trim();
      if (name && name !== lead.name) {
        lead.name = name;
        updated += 1;
      }
    }
    json(res, 200, { ok: true, updated });
  });
}
