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
    let result;
    try {
      result = await imports.importLeads(source);
    } catch (error) {
      throw httpError(400, readableImportError(error));
    }

    let skippedAlreadyBlasted = 0;
    let leads = result.leads;
    if (imports.hasBlastDatabase && !body.includeBlasted) {
      try {
        const blasted = await imports.fetchBlastedPhones(project.name);
        leads = result.leads.filter((lead) => {
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

    imports.setLeadsCache({ projectId: project.id, ...result, leads });
    json(res, 200, {
      ok: true,
      project: project.id,
      imported: leads.length,
      skippedAlreadyBlasted,
      skippedSuppressed,
      rejected: result.rejected.length,
      sourcePath: result.sourcePath,
      sample: leads.slice(0, 8).map((lead) => ({ name: lead.name, phone: lead.phone })),
    });
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
      leads: leadsCache.leads.map((lead) => ({ id: lead.id, name: lead.name, phone: lead.phone })),
    });
  });

  router.post("/api/leads/update", async (req, res, runtime) => {
    const imports = requireImport(runtime);
    const runner = runtime.getRunner?.();
    if (runner && runner.running) {
      throw httpError(409, "Campaign 正在运行，请先停止再改名字。");
    }
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
