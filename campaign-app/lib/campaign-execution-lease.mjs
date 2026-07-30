export function createCampaignExecutionLease() {
  const active = new Map();

  function start(runId, operation) {
    const key = String(runId || "").trim();
    if (!key) throw new Error("Campaign execution lease requires a runId.");
    if (typeof operation !== "function") throw new TypeError("Campaign execution lease requires an operation.");

    const existing = active.get(key);
    if (existing) return { started: false, task: existing };

    // Store the lease before the operation reaches its first await. Campaign
    // startup refreshes external safety data, so runner.running alone leaves a
    // short window where two resume requests could start the same run.
    const task = Promise.resolve()
      .then(operation)
      .finally(() => {
        if (active.get(key) === task) active.delete(key);
      });
    active.set(key, task);
    return { started: true, task };
  }

  function has(runId) {
    return active.has(String(runId || "").trim());
  }

  return { start, has };
}

export const campaignExecutionLease = createCampaignExecutionLease();
