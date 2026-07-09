export function createProjectService({
  blastDatabaseId,
  loadProjects,
  loadProjectConfig,
  notion,
  normalizePhone,
}) {
  async function getProject(id) {
    const projects = await loadProjects();
    const project = projects.find((item) => item.id === id) || projects[0];
    if (!project) throw new Error("campaign-assets/projects.json 里没有配置任何 project。");
    return { project, config: await loadProjectConfig(project) };
  }

  async function fetchBlastedPhones(projectName) {
    const phones = new Set();
    if (!blastDatabaseId || !projectName) return phones;
    let cursor;
    do {
      const data = await notion("POST", `/databases/${blastDatabaseId}/query`, {
        filter: { property: "Project", select: { equals: projectName } },
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      });
      for (const page of data?.results ?? []) {
        const phone = normalizePhone(page.properties?.["Phone"]?.phone_number);
        if (phone) phones.add(phone);
      }
      cursor = data?.has_more ? data?.next_cursor : null;
    } while (cursor);
    return phones;
  }

  return {
    getProject,
    fetchBlastedPhones,
  };
}
