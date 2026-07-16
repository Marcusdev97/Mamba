(() => {
  if (window.top !== window.self || document.querySelector(".mamba-shell")) return;

  const groups = [
    { title: "Overview", links: [
      { code: "CC", label: "Control Center", href: "/control-center", paths: ["/control-center"] },
    ] },
    { title: "Customers", links: [
      { code: "IN", label: "Customer Inbox", href: "/conversations", paths: ["/conversations"] },
      { code: "FU", label: "Follow-up & Appointments", href: "/follow-up", paths: ["/follow-up"] },
      { code: "CS", label: "Customer Search", href: "/lookup", paths: ["/lookup"] },
    ] },
    { title: "Campaigns", links: [
      { code: "CP", label: "Campaign Center", href: "/send", paths: ["/", "/send", "/next-flow"] },
      { code: "TF", label: "Templates & Flows", href: "/templates", paths: ["/templates"] },
      { code: "NC", label: "Next Campaign · TODO", href: "/campaign-todo", paths: ["/campaign-todo"] },
    ] },
    { title: "Mamba Brain", links: [
      { code: "PB", label: "Project Brain", href: "/project-brain", paths: ["/project-brain", "/knowledge"] },
      { code: "LQ", label: "Learning Queue", href: "/brain-learning", paths: ["/brain-learning"] },
      { code: "BR", label: "Bot Rules", href: "/bot-rules", paths: ["/bot-rules"] },
      { code: "FM", label: "Flow Map", href: "/flow-map", paths: ["/flow-map"] },
    ] },
    { title: "System", links: [
      { code: "LG", label: "System Logs", href: "/logs", paths: ["/logs"] },
      { code: "RM", label: "Remote Mamba", href: "/remote-mamba", paths: ["/remote-mamba"] },
      { code: "ST", label: "Settings", href: "/settings", paths: ["/settings", "/numbers"] },
    ] },
  ];

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
  const current = window.location.pathname;
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = "/assets/mamba-shell.css";
  document.head.appendChild(css);

  const nav = groups.map((group) => `
    <div class="mamba-shell-group">
      <div class="mamba-shell-group-title">${escapeHtml(group.title)}</div>
      ${group.links.map((link) => {
        const active = link.paths.includes(current);
        return `<a class="mamba-shell-link${active ? " active" : ""}" href="${link.href}" title="${escapeHtml(link.label)}">
          <span class="mamba-shell-icon" aria-hidden="true">${link.code}</span>
          <span class="mamba-shell-link-label">${escapeHtml(link.label)}</span>
        </a>`;
      }).join("")}
    </div>`).join("");

  document.body.insertAdjacentHTML("afterbegin", `
    <aside class="mamba-shell" aria-label="Mamba navigation">
      <div class="mamba-shell-brand">
        <div class="mamba-shell-mark"><strong>MAMBA</strong><small>Control Panel</small></div>
        <button class="mamba-shell-collapse" type="button" title="Collapse navigation" aria-label="Collapse navigation">‹</button>
      </div>
      <nav class="mamba-shell-scroll">${nav}</nav>
      <div class="mamba-shell-footer"><strong>Mamba Workspace</strong><small>Local operations console</small></div>
    </aside>
    <div class="mamba-mobile-bar"><button type="button" aria-label="Open navigation">≡</button><strong>MAMBA</strong><span style="width:34px"></span></div>`);

  document.body.classList.add("mamba-has-shell");
  if (localStorage.getItem("mamba-shell-collapsed") === "1") document.body.classList.add("mamba-shell-collapsed");
  const collapse = document.querySelector(".mamba-shell-collapse");
  collapse.addEventListener("click", () => {
    if (window.matchMedia("(max-width: 900px)").matches) {
      document.body.classList.remove("mamba-shell-open");
      return;
    }
    document.body.classList.toggle("mamba-shell-collapsed");
    localStorage.setItem("mamba-shell-collapsed", document.body.classList.contains("mamba-shell-collapsed") ? "1" : "0");
  });
  document.querySelector(".mamba-mobile-bar button").addEventListener("click", () => document.body.classList.toggle("mamba-shell-open"));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") document.body.classList.remove("mamba-shell-open");
  });
})();
