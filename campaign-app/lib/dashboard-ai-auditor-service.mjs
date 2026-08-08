import { LEAD_AUDIT_VERSION, buildLeadAuditCacheKey, fingerprintAuditInput, ruleAuditCandidate, sanitizeAuditInput, validateLeadAuditOutput } from "../domain/lead-auditor.mjs";

const SYSTEM_PROMPT = `You are an advisory-only real-estate lead auditor. You may summarize, classify, score, suggest a next action and draft a message. You must never claim to send, change STOP, change sales stage, book an appointment, delete or merge a customer, or change commission. Return only JSON with: interest_level HOT|WARM|COLD|NURTURE; score integer 0-100; closing_probability 0-1; forgotten_followup boolean; buying_purpose, budget, timeline, main_objection strings; recommended_action CALL|WHATSAPP|FOLLOW_UP|REVIEW|NONE; recommended_due_at ISO datetime or null; suggested_message string; reasons and risk_flags arrays; confidence 0-1.`;

export function createDashboardAiAuditorService({ repository, provider, clock = () => new Date(), analysisVersion = LEAD_AUDIT_VERSION } = {}) {
  if (!repository) throw new TypeError("Dashboard AI Auditor repository is required.");

  async function dashboard(filters = {}) {
    const [health, actions, funnel, campaigns, opportunities, quality] = await Promise.all([
      repository.health(), repository.actions({ now: clock(), filters }), repository.funnel(filters),
      repository.campaignPerformance(filters), repository.opportunities(filters), repository.quality(),
    ]);
    return { generatedAt: clock().toISOString(), source: "SQLITE_ONLY", health, actions, funnel, campaigns, opportunities, quality };
  }

  async function analyze({ projectLeadKey } = {}) {
    const raw = await repository.buildInput(projectLeadKey);
    const rules = ruleAuditCandidate({ ...raw.lead, now: clock() });
    if (!rules.eligible) throw Object.assign(new Error("Lead is not an eligible audit candidate."), { code: "AI_AUDIT_CANDIDATE_INELIGIBLE" });
    const input = sanitizeAuditInput({ lead: raw.lead, recentMessages: raw.recentMessages, openTasks: raw.openTasks });
    const cacheKey = buildLeadAuditCacheKey({ customerId: raw.lead.customerId, lastMessageId: raw.lastMessageId, analysisVersion });
    const existing = await repository.cached(cacheKey);
    if (existing) return { ok: true, analysis: existing, rules };
    const common = { cacheKey, customerId: raw.lead.customerId, projectLeadKey: raw.lead.projectLeadKey, lastMessageId: raw.lastMessageId, analysisVersion, inputFingerprint: fingerprintAuditInput(input) };
    try {
      const generated = await provider.generateJson({ system: SYSTEM_PROMPT, input });
      const output = validateLeadAuditOutput(generated.json);
      return { ok: true, analysis: await repository.saveAnalysis({ ...common, output, provider: generated.provider, model: generated.model, usage: generated.usage }), rules };
    } catch (error) {
      await repository.saveFailure({ ...common, error });
      return { ok: false, error: { code: error.code || "AI_AUDIT_FAILED", message: error.message }, rules };
    }
  }

  return {
    schemaStatus: () => repository.schemaStatus(),
    providerStatus: () => provider.status?.() || { configured: true, provider: "injected" },
    dashboard,
    candidates: (options) => repository.candidates({ now: clock(), ...options }),
    analyze,
    feedback: (input) => repository.feedback(input),
    quality: () => repository.quality(),
  };
}
