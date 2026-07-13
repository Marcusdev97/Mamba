import fs from "node:fs/promises";
import path from "node:path";
import { httpError, json, readJson } from "../lib/http.mjs";

function requireTemplates(runtime) {
  if (!runtime.templates) {
    throw httpError(500, "Templates service 没有载入。请重启 Mamba server。");
  }
  return runtime.templates;
}

function cleanPageId(value) {
  return String(value ?? "").replace(/[^a-fA-F0-9]/g, "");
}

function readableNotionError(error, action) {
  const message = String(error?.message || "");
  if (message.includes("401")) {
    return `${action}失败: Notion token 无效。请到 Settings 重新设置 Notion token。`;
  }
  if (message.includes("404")) {
    return `${action}失败: 找不到 Notion database/page。请确认 database 已 share 给 Mamba integration。`;
  }
  if (message.includes("rate") || message.includes("429")) {
    return `${action}失败: Notion rate limit。等几秒再试。`;
  }
  return `${action}失败: ${message || "Notion 没有返回明确原因。"}`;
}

function templateDatabaseId(templates) {
  return String(templates.notionConfig?.databases?.templates ?? "").replace(/[^a-fA-F0-9]/g, "");
}

export function registerTemplatesRoutes(router) {
  router.post("/api/templates/mobile-preview", async (req, res, runtime) => {
    const templates = requireTemplates(runtime);
    const body = await readJson(req);
    const projectName = String(body.projectName ?? "").trim();
    const phone = templates.normalizePhone(body.phone);
    const name = String(body.name ?? "").trim() || "there";
    const requestedLanguage = String(body.language ?? "EN").trim().toUpperCase();
    const requestedInstance = String(body.instanceName ?? "").trim();
    const includeTesting = body.includeTesting === true;
    if (!projectName) throw httpError(400, "请选择项目。");
    if (!phone) throw httpError(400, "电话号码格式不对。例子: 60123456789。");

    const opened = await templates.openInstances();
    const sender = requestedInstance ? opened.find((item) => item.name === requestedInstance) : opened[0];
    if (!sender) throw httpError(400, "没有已连接的 WhatsApp sender。请先到 Settings / Phone Setup 扫码连接。");

    const previewRunner = templates.createPreviewRunner();
    const flowResults = [];
    let sentMessages = 0;

    await previewRunner.sendText(
      sender.name,
      phone,
      `Mamba Mobile Preview\nProject: ${projectName}\nLanguage: ${requestedLanguage}\nSender: ${sender.name}\n\n下面会发送自动序列的真实模板。这个测试不会更新 Notion。`,
    );
    sentMessages += 1;
    await templates.shortPause();

    for (const flow of templates.flowSequence) {
      const byLang = await templates.fetchFlowTemplates(projectName, flow.label, { includeTesting });
      const picked = templates.pickPreviewLanguage(byLang, requestedLanguage);
      if (!picked.parts.length) {
        flowResults.push({ flow: flow.label, cohortDay: flow.cohortDay, language: picked.language, sent: 0, skipped: true, draft: false });
        continue;
      }

      const draftTag = picked.usedTesting ? " · Testing 草稿" : "";
      await previewRunner.sendText(sender.name, phone, `${flow.label} (${flow.cohortDay})${draftTag}`);
      sentMessages += 1;
      await templates.shortPause();

      let flowSent = 0;
      for (const part of picked.parts) {
        await previewRunner.sendMediaWithRetry(
          sender.name,
          phone,
          templates.personalize(part.text || "", name),
          part.media || "",
        );
        sentMessages += 1;
        flowSent += 1;
        await templates.shortPause();
      }
      flowResults.push({ flow: flow.label, cohortDay: flow.cohortDay, language: picked.language, sent: flowSent, skipped: false, draft: picked.usedTesting });
    }

    json(res, 200, {
      ok: true,
      projectName,
      phone,
      instanceName: sender.name,
      requestedLanguage,
      sentMessages,
      flows: flowResults,
      skippedFlows: flowResults.filter((flow) => flow.skipped).length,
      draftFlows: flowResults.filter((flow) => flow.draft).length,
      includeTesting,
    });
  });

  router.get("/api/templates/list", async (req, res, runtime) => {
    const templatesSvc = requireTemplates(runtime);
    const tplDbId = templateDatabaseId(templatesSvc);
    if (!tplDbId) {
      json(res, 200, { ok: true, project: "", projects: [], templates: [] });
      return;
    }
    const url = new URL(req.url, `http://${runtime.host}:${runtime.port}`);
    const projectQ = String(url.searchParams.get("project") ?? "").trim();

    const all = [];
    let cursor;
    do {
      const body = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      let data;
      try {
        data = await templatesSvc.notion("POST", `/databases/${tplDbId}/query`, body);
      } catch (error) {
        throw httpError(500, readableNotionError(error, "读取模板列表"));
      }
      for (const page of data?.results ?? []) all.push(page);
      cursor = data?.has_more ? data?.next_cursor : null;
    } while (cursor);

    let projects = [];
    try {
      const db = await templatesSvc.notion("GET", `/databases/${tplDbId}`);
      const projectProp = db?.properties?.Project;
      projects = (projectProp?.select?.options || projectProp?.multi_select?.options || []).map((option) => option.name);
    } catch {
      // Fall back to existing rows below.
    }
    if (!projects.length) projects = all.map((page) => templatesSvc.nfSelect(page, "Project")).filter(Boolean);
    projects = [...new Set(projects)]
      .filter((name) => !/^mid\s*valley$/i.test(String(name || "").trim()))
      .sort();
    const project = projectQ || templatesSvc.resolveTemplateProject(templatesSvc.notionConfig?.project) || projects[0] || "";

    const items = [];
    for (const page of all.filter((item) => templatesSvc.nfSelect(item, "Project") === project)) {
      const imageName = templatesSvc.nfText(page, "Image Name");
      const mediaPath = templatesSvc.resolveMedia(imageName);
      let mediaExists = false;
      if (mediaPath) {
        try {
          await fs.access(path.join(templatesSvc.rootDir, "campaign-assets", mediaPath));
          mediaExists = true;
        } catch {
          // Not local; the UI will show this as missing.
        }
      }
      items.push({
        pageId: page.id,
        name: templatesSvc.nfTitle(page, "Template Name"),
        flowTopic: templatesSvc.nfSelect(page, "Flow Topic"),
        flowNo: page.properties?.["Flow No"]?.number ?? null,
        language: templatesSvc.nfSelect(page, "Language"),
        part: templatesSvc.nfSelect(page, "Part"),
        status: templatesSvc.nfSelect(page, "Status"),
        imageName,
        hasImageName: !!imageName,
        mediaUrl: mediaExists ? `/${mediaPath}` : "",
        mediaExists,
        text: templatesSvc.nfText(page, "Message Text").slice(0, 4000),
        url: `https://www.notion.so/${String(page.id).replace(/-/g, "")}`,
      });
    }
    json(res, 200, { ok: true, project, projects, templates: items });
  });

  router.post("/api/templates/update", async (req, res, runtime) => {
    const templates = requireTemplates(runtime);
    const body = await readJson(req);
    const pageId = cleanPageId(body.pageId);
    if (!pageId) throw httpError(400, "缺少 template pageId。");
    const props = {};
    if (typeof body.messageText === "string") props["Message Text"] = { rich_text: [{ text: { content: body.messageText.slice(0, 1900) } }] };
    if (body.status) props.Status = { select: { name: String(body.status) } };
    if (typeof body.imageName === "string") props["Image Name"] = { rich_text: [{ text: { content: String(body.imageName).slice(0, 300) } }] };
    if (body.flowTopic) props["Flow Topic"] = { select: { name: String(body.flowTopic).slice(0, 100) } };
    if (body.flowNo !== undefined && body.flowNo !== null && body.flowNo !== "") props["Flow No"] = { number: Number(body.flowNo) };
    if (body.part) props.Part = { select: { name: String(body.part).slice(0, 100) } };
    if (body.language) props.Language = { select: { name: String(body.language).slice(0, 20).toUpperCase() } };
    if (body.flowTopic) {
      const meta = templates.flowMetaByTopic(body.flowTopic);
      if (meta) {
        props["Flow No"] = { number: meta.no };
        if (meta.day) props["Cohort Day"] = { select: { name: meta.day } };
      }
      const page = await templates.notion("GET", `/pages/${pageId}`);
      const project = String(body.project || templates.nfSelect(page, "Project") || "").trim();
      const language = String(body.language || templates.nfSelect(page, "Language") || "EN").trim();
      const part = String(body.part || templates.nfSelect(page, "Part") || "Part 1").trim();
      props["Template Name"] = { title: [{ text: { content: templates.buildTemplateTitle({ project, flowTopic: body.flowTopic, language, part }).slice(0, 200) } }] };
    }
    if (!Object.keys(props).length) throw httpError(400, "没有要更新的内容。");
    try {
      await templates.notion("PATCH", `/pages/${pageId}`, { properties: props });
    } catch (error) {
      throw httpError(500, readableNotionError(error, "更新模板"));
    }
    json(res, 200, { ok: true });
  });

  router.post("/api/templates/create", async (req, res, runtime) => {
    const templates = requireTemplates(runtime);
    const tplDbId = templateDatabaseId(templates);
    if (!tplDbId) throw httpError(400, "没有 templates database。请检查 campaign-data/notion_config.json。");
    const body = await readJson(req);
    const name = String(body.templateName ?? "").trim()
      || templates.buildTemplateTitle({ project: body.project, flowTopic: body.flowTopic, language: body.language, part: body.part });
    const props = { "Template Name": { title: [{ text: { content: name.slice(0, 200) } }] } };
    if (body.project) props.Project = { select: { name: String(body.project) } };
    if (body.flowTopic) props["Flow Topic"] = { select: { name: String(body.flowTopic) } };
    if (body.language) props.Language = { select: { name: String(body.language) } };
    if (body.part) props.Part = { select: { name: String(body.part) } };
    const meta = templates.flowMetaByTopic(body.flowTopic);
    if (meta) {
      props["Flow No"] = { number: meta.no };
      if (meta.day) props["Cohort Day"] = { select: { name: meta.day } };
    }
    if (typeof body.messageText === "string") props["Message Text"] = { rich_text: [{ text: { content: body.messageText.slice(0, 1900) } }] };
    props.Status = { select: { name: String(body.status || "Testing") } };
    if (body.imageName) props["Image Name"] = { rich_text: [{ text: { content: String(body.imageName).slice(0, 300) } }] };
    try {
      const page = await templates.notion("POST", "/pages", { parent: { database_id: tplDbId }, properties: props });
      json(res, 200, { ok: true, pageId: page.id });
    } catch (error) {
      throw httpError(500, readableNotionError(error, "创建模板"));
    }
  });

  router.post("/api/templates/upload-image", async (req, res, runtime) => {
    const templates = requireTemplates(runtime);
    const body = await readJson(req);
    const imageName = String(body.imageName ?? "").trim();
    const rawName = String(body.filename ?? "").trim();
    const base64 = String(body.base64 ?? "");
    if (!imageName) throw httpError(400, "缺少图片名 alias key。");
    if (!rawName || !base64) throw httpError(400, "缺少图片文件。请重新选择图片。");
    const comma = base64.indexOf(",");
    const b64 = base64.startsWith("data:") && comma >= 0 ? base64.slice(comma + 1) : base64;
    const prefix = cleanPageId(body.pageId) || Math.random().toString(16).slice(2, 12);
    const safe = prefix + "_" + rawName.replace(/[^A-Za-z0-9._-]/g, "_");
    const imagesDir = path.join(templates.rootDir, "campaign-assets", "images");
    await fs.mkdir(imagesDir, { recursive: true });
    await fs.writeFile(path.join(imagesDir, safe), Buffer.from(b64, "base64"));

    const fullPid = cleanPageId(body.pageId);
    const baseKey = imageName.replace(/\s*\[[0-9a-fA-F]{6,}\]\s*$/, "").trim();
    const key = fullPid ? `${baseKey}[${fullPid}]` : imageName;
    await templates.setImageAlias(key, safe);

    if (body.pageId) {
      const pageId = cleanPageId(body.pageId);
      try {
        await templates.notion("PATCH", `/pages/${pageId}`, { properties: { "Image Name": { rich_text: [{ text: { content: key.slice(0, 300) } }] } } });
      } catch (error) {
        throw httpError(500, readableNotionError(error, "图片已存本地，但更新 Notion Image Name"));
      }
    }
    json(res, 200, { ok: true, filename: safe, imageName: key });
  });

  router.post("/api/templates/delete", async (req, res, runtime) => {
    const templates = requireTemplates(runtime);
    const body = await readJson(req);
    const pageId = cleanPageId(body.pageId);
    if (!pageId) throw httpError(400, "缺少 template pageId。");
    try {
      await templates.notion("PATCH", `/pages/${pageId}`, { archived: true });
    } catch (error) {
      throw httpError(500, readableNotionError(error, "删除模板"));
    }
    json(res, 200, { ok: true });
  });

  router.post("/api/templates/add-project", async (req, res, runtime) => {
    const templates = requireTemplates(runtime);
    const body = await readJson(req);
    const name = String(body.name ?? "").trim();
    if (!name) throw httpError(400, "缺少项目名。");
    const dbs = {
      templates: String(templates.notionConfig?.databases?.templates ?? "").replace(/[^a-fA-F0-9]/g, ""),
      blastLeads: String(templates.notionConfig?.databases?.blastLeads ?? "").replace(/[^a-fA-F0-9]/g, ""),
      campaignRuns: String(templates.notionConfig?.databases?.campaignRuns ?? "").replace(/[^a-fA-F0-9]/g, ""),
    };
    const result = {};
    for (const [key, id] of Object.entries(dbs)) {
      if (!id) {
        result[key] = "no db";
        continue;
      }
      try {
        result[key] = await templates.addProjectOption(id, name);
      } catch (error) {
        result[key] = "err: " + error.message;
      }
    }
    json(res, 200, { ok: true, name, result });
  });
}
