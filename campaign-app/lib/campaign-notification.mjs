import { senderPhoneForInstance } from "./device-identity.mjs";

function instanceName(item) {
  return String(item?.name || item || "").trim();
}

export function campaignSenderSummary(state = {}) {
  // Current runs use assignments. jobs is kept only as a compatibility fallback
  // for old run files created by earlier Mamba versions.
  const jobs = Array.isArray(state.assignments) && state.assignments.length
    ? state.assignments
    : Array.isArray(state.jobs) ? state.jobs : [];
  let names = [...new Set(jobs.map((job) => instanceName(job?.instanceName || job?.instanceKey)).filter(Boolean))];

  // A prepared/empty run can still identify its selected sender from instances.
  if (!names.length) {
    names = [...new Set((state.instances || []).map(instanceName).filter(Boolean))];
  }

  const labels = names.map((name) => {
    const phone = senderPhoneForInstance(state.instances, name);
    return phone ? `+${phone} (${name})` : name;
  });
  return labels.join(", ") || "-";
}
