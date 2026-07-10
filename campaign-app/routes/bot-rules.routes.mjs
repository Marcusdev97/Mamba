import fs from "node:fs/promises";
import path from "node:path";
import { classifyReplyText } from "../flow_sequence.mjs";
import { httpError, json, readJson } from "../lib/http.mjs";

function rulesPath(runtime) {
  return path.join(runtime.paths.rootDir, "campaign-data", "bot_rules.json");
}

async function readRules(runtime) {
  try {
    const payload = JSON.parse(await fs.readFile(rulesPath(runtime), "utf8"));
    return { updatedAt: payload.updatedAt || null, rules: Array.isArray(payload.rules) ? payload.rules : [] };
  } catch {
    return { updatedAt: null, rules: [] };
  }
}

function cleanRule(rule, index) {
  const id = String(rule.id || rule.label || `rule_${index + 1}`).trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || `rule_${index + 1}`;
  const keywords = Array.isArray(rule.keywords)
    ? rule.keywords.map((item) => String(item || "").trim()).filter(Boolean)
    : String(rule.keywords || "").split(/\n|,/).map((item) => item.trim()).filter(Boolean);
  return {
    id,
    enabled: rule.enabled !== false,
    order: Number.isFinite(Number(rule.order)) ? Number(rule.order) : (index + 1) * 10,
    label: String(rule.label || id).trim(),
    match: ["contains", "regex", "exact_short"].includes(rule.match) ? rule.match : "contains",
    keywords,
    route: String(rule.route || "CUSTOM_RULE").trim(),
    status: String(rule.status || "Replied").trim(),
    sequenceStatus: String(rule.sequenceStatus || "Human Takeover").trim(),
    nextAction: String(rule.nextAction || "Human Takeover").trim(),
    aiCategory: String(rule.aiCategory || "Unknown").trim(),
    signal: ["GREEN", "GREY", "RED"].includes(rule.signal) ? rule.signal : "GREY",
    stopFlag: rule.stopFlag === true,
    suggestedReply: String(rule.suggestedReply || "人工查看客户回复。").trim(),
  };
}

export function registerBotRulesRoutes(router) {
  router.get("/api/bot-rules", async (_req, res, runtime) => {
    json(res, 200, { ok: true, ...(await readRules(runtime)) });
  });

  router.post("/api/bot-rules", async (req, res, runtime) => {
    const body = await readJson(req);
    if (!Array.isArray(body.rules)) throw httpError(400, "rules 必须是 array。");
    const payload = {
      updatedAt: new Date().toISOString(),
      rules: body.rules.map(cleanRule).sort((a, b) => Number(a.order || 100) - Number(b.order || 100)),
    };
    await fs.mkdir(path.dirname(rulesPath(runtime)), { recursive: true });
    await fs.writeFile(rulesPath(runtime), `${JSON.stringify(payload, null, 2)}\n`);
    await runtime.systemLogs?.write({
      level: "info",
      area: "brain",
      event: "bot_rules_saved",
      message: "Bot classifier rules were saved.",
      context: { rules: payload.rules.length },
    }).catch(() => {});
    json(res, 200, { ok: true, ...payload });
  });

  router.post("/api/bot-rules/test", async (req, res) => {
    const body = await readJson(req);
    const text = String(body.text || "");
    if (!text.trim()) throw httpError(400, "请输入测试句子。");
    json(res, 200, { ok: true, text, verdict: classifyReplyText(text) });
  });
}
