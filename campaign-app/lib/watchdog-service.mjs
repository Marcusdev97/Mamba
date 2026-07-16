const CRITICAL_COMPONENTS = ["server", "whatsapp", "tracker", "brain"];

function cleanHealthItem(item) {
  return {
    id: String(item?.id || "").trim(),
    label: String(item?.label || item?.id || "Unknown").trim(),
    ok: item?.ok === true,
    detail: String(item?.detail || "").trim(),
  };
}

export function summarizeWatchdogHealth(payload, {
  checkedAt = new Date().toISOString(),
  serverUrl = "http://127.0.0.1:8787",
} = {}) {
  const health = Array.isArray(payload?.health) ? payload.health.map(cleanHealthItem) : [];
  const byId = new Map(health.map((item) => [item.id, item]));
  const components = CRITICAL_COMPONENTS.map((id) => byId.get(id) || {
    id,
    label: id,
    ok: false,
    detail: "Health signal missing",
  });
  const notion = byId.get("notion") || null;
  const failed = components.filter((item) => !item.ok);
  return {
    checkedAt,
    serverUrl,
    reachable: payload?.ok === true,
    healthy: payload?.ok === true && failed.length === 0,
    components,
    failed,
    notion,
  };
}

export function unreachableWatchdogHealth(error, {
  checkedAt = new Date().toISOString(),
  serverUrl = "http://127.0.0.1:8787",
} = {}) {
  const detail = String(error?.message || error || "Mamba did not answer").trim();
  return {
    checkedAt,
    serverUrl,
    reachable: false,
    healthy: false,
    components: CRITICAL_COMPONENTS.map((id) => ({
      id,
      label: id,
      ok: false,
      detail: id === "server" ? detail : "Cannot check while Mamba Server is offline",
    })),
    failed: [{ id: "server", label: "Mamba Server", ok: false, detail }],
    notion: null,
  };
}

export function watchdogSignature(snapshot) {
  if (!snapshot?.reachable) return "server:down";
  return snapshot.components
    .map((item) => `${item.id}:${item.ok ? "up" : "down"}`)
    .join("|");
}

export function watchdogTransition(previous, current, { failureThreshold = 2 } = {}) {
  const previousFailures = Math.max(0, Number(previous?.consecutiveFailures) || 0);
  const consecutiveFailures = current.healthy ? 0 : previousFailures + 1;
  const previousReported = String(previous?.reportedSignature || "");
  const signature = watchdogSignature(current);
  const shouldReportFailure = !current.healthy
    && consecutiveFailures >= failureThreshold
    && signature !== previousReported;
  const shouldReportRecovery = current.healthy
    && Boolean(previousReported)
    && previousReported !== signature;

  return {
    consecutiveFailures,
    signature,
    shouldReportFailure,
    shouldReportRecovery,
    reportedSignature: shouldReportFailure || shouldReportRecovery ? signature : previousReported,
  };
}

export function formatWatchdogStatus(snapshot) {
  const lines = snapshot.components
    .map((item) => `${item.ok ? "OK" : "DOWN"} ${item.label}${item.detail ? ` - ${item.detail}` : ""}`);
  if (snapshot.notion) {
    lines.push(`${snapshot.notion.ok ? "OK" : "WARN"} ${snapshot.notion.label}${snapshot.notion.detail ? ` - ${snapshot.notion.detail}` : ""}`);
  }
  return lines.join("\n");
}

export { CRITICAL_COMPONENTS };
