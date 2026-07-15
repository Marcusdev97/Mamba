export async function resolveInboundProject(event, {
  resolveLocal,
  notion,
  onLog = () => {},
} = {}) {
  const phone = String(event?.phone ?? "").trim();
  if (!phone) return { project: null, source: "missing_phone" };

  const localProject = typeof resolveLocal === "function" ? resolveLocal(phone) : null;
  if (localProject) return { project: localProject, source: "local" };

  if (!notion?.enabled || typeof notion.findLeadProjectByPhone !== "function") {
    return { project: null, source: "notion_unavailable" };
  }

  try {
    const project = await notion.findLeadProjectByPhone(phone, event?.instanceName || event?.sender || "");
    return project
      ? { project, source: "notion" }
      : { project: null, source: "notion_not_found" };
  } catch (error) {
    onLog(`[hub] project lookup failed phone=${phone}: ${error.message}`);
    return { project: null, source: "notion_error" };
  }
}
