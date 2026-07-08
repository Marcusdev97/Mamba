import { httpError, json } from "../lib/http.mjs";

function requireProjects(runtime) {
  if (!runtime.projects) {
    throw httpError(500, "Projects service 没有载入。请重启 Mamba server。");
  }
  return runtime.projects;
}

function friendlyProjectError(error) {
  const message = String(error?.message || "");
  if (message.includes("projects.json")) {
    return "找不到 project 配置。请检查 campaign-assets/projects.json 是否存在，而且里面至少有一个 project。";
  }
  return `读取 project 配置失败: ${message || "没有明确原因。"}`;
}

function fallbackTemplates(projects, config, templateError) {
  const variants = projects.firstFlowVariants(config).map((variant) => ({
    id: variant.id,
    language: variant.language,
    name: variant.id,
    status: "Local",
  }));

  return {
    templateSource: "local-fallback",
    templateError: templateError || "Notion templates 暂时拉不到，已使用本地 fallback 模板。",
    templates: variants,
  };
}

export function registerProjectsRoutes(router) {
  router.get("/api/projects", async (_req, res, runtime) => {
    const projects = requireProjects(runtime);
    let list;
    try {
      list = await projects.loadProjects();
    } catch (error) {
      throw httpError(500, friendlyProjectError(error));
    }
    if (!list.length) {
      throw httpError(500, "没有任何 project。请在 campaign-assets/projects.json 至少加入一个 project。");
    }

    json(res, 200, {
      ok: true,
      projects: list.map((project) => ({
        id: project.id,
        name: project.name,
        senders: project.senders ?? [],
        excel: project.excel ?? "",
      })),
      alias: projects.alias || {},
    });
  });

  router.get("/api/config", async (req, res, runtime) => {
    const projects = requireProjects(runtime);
    const url = new URL(req.url, `http://${runtime.host}:${runtime.port}`);
    const requestedProject = url.searchParams.get("project") ?? undefined;

    let project;
    let config;
    try {
      ({ project, config } = await projects.getProject(requestedProject));
    } catch (error) {
      throw httpError(500, friendlyProjectError(error));
    }

    let templatePack;
    try {
      templatePack = {
        templateSource: "notion",
        templateError: "",
        templates: await projects.getFirstFlowTemplateOptions(project.name),
      };
      if (!templatePack.templates.length) {
        templatePack = fallbackTemplates(projects, config, "Notion 没有 Flow 1 Active 模板，已使用本地 fallback。");
      }
    } catch (error) {
      templatePack = fallbackTemplates(projects, config, error.message);
    }

    json(res, 200, {
      ok: true,
      project: project.id,
      projectName: project.name,
      campaignName: config.campaignName,
      partGapSeconds: config.delivery.partGapSeconds,
      contactGapSeconds: config.delivery.contactGapSeconds,
      senders: project.senders ?? [],
      excel: project.excel ?? "",
      leadsLoaded: projects.getLeadsCache()?.projectId === project.id ? projects.getLeadsCache().leads.length : 0,
      templateSource: templatePack.templateSource,
      templateFlow: projects.firstFlowLabel,
      templateError: templatePack.templateError,
      templates: templatePack.templates,
    });
  });
}
