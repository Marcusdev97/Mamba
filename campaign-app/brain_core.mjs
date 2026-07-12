// brain_core.mjs — pure decision logic for the Sales Brain service (Task B6).
//
// Everything here is side-effect free and covered by test_brain_core.mjs.
// brain_service.mjs does the wiring (HTTP, Evolution, Telegram, Anthropic,
// Notion); THIS file decides WHAT happens:
//
//   route  -> auto-send canned reply | AI/rule draft + human buttons | forced handoff
//   text   -> language guess (for the AI Reply Log)
//   event  -> the exact prompt the model sees (guardrails hardcoded HERE)
//   button -> ok / edit / take transition
//
// PHASE 1 RULE: complex routes are NEVER auto-sent. The only auto-send is the
// canned suggestedReply on simple routes. Changing a route from "ai" to "auto"
// is a policy decision — do it here, on purpose, with data (照发率 ≥ 90% for
// two consecutive weeks), never inside the service.

// ---------- route policy (缺口 3 数据流的核心分岔) ----------
//
// mode:
//   "auto"    -> send the classifier's canned suggestedReply immediately.
//   "ai"      -> model drafts when an AI key exists; otherwise rule suggestion ->
//                Telegram buttons -> human decides.
//   "handoff" -> no reply at all; Telegram alert; human takes over (情绪负面).
// tier: which model drafts ("complex" = high-value negotiation, "simple" = routine).
export const ROUTE_POLICY = {
  STOP_DNC: { mode: "auto" },
  COMPLAINT: { mode: "handoff" },
  VIEWING_REQUEST: { mode: "ai", tier: "complex" }, // booking = money, use the better model
  PRICE_REQUEST: { mode: "ai", tier: "complex" },
  LOAN_MONTHLY_REQUEST: { mode: "ai", tier: "complex" },
  // 2026-07-11 (P1): content routes 从 auto 降级为 ai。原因: classifier 的罐头
  // 回复写死了 Gen Starz 的资料 (例: LOCATION 罐头讲 Old Klang Road), 多盘运行
  // 下 auto 直发会把错的盘的资料发给客户; DETAILS 罐头承诺"send 资料"但系统不会
  // 真的发附件。降为 ai 后走 Layer 2 (按盘知识) 起草 + Telegram 按钮人工批准。
  // 只有不含盘资料的告别语 routes 保留 auto。
  LAYOUT_REQUEST: { mode: "ai", tier: "simple" },
  LOCATION_REQUEST: { mode: "ai", tier: "simple" },
  DETAILS_REQUEST: { mode: "ai", tier: "simple" },
  NOT_INTERESTED: { mode: "auto" },
  AGENT_OR_WRONG_TARGET: { mode: "auto" },
  LATER_BUSY: { mode: "ai", tier: "simple" },
  UNKNOWN_MANUAL_REVIEW: { mode: "ai", tier: "simple" },
};

export function decideAction(route) {
  return ROUTE_POLICY[route] ?? { mode: "ai", tier: "simple" }; // unknown route -> safest: human-approved AI
}

// classifier route -> "Route" select option in Mamba | AI Reply Log.
const ROUTE_TO_LOG = {
  STOP_DNC: "Not Interested", // log DB has no separate Stop option; Action column carries the truth
  COMPLAINT: "Complaint",
  VIEWING_REQUEST: "Viewing",
  PRICE_REQUEST: "Price",
  LOAN_MONTHLY_REQUEST: "Loan",
  LAYOUT_REQUEST: "Layout",
  LOCATION_REQUEST: "Location",
  DETAILS_REQUEST: "Details",
  NOT_INTERESTED: "Not Interested",
  AGENT_OR_WRONG_TARGET: "Unknown",
  LATER_BUSY: "Later Busy",
  UNKNOWN_MANUAL_REVIEW: "Unknown",
};
export function logRouteOf(route) {
  return ROUTE_TO_LOG[route] ?? "Unknown";
}

// ---------- language guess (EN / ZH / BM / Mixed) ----------
export function detectLanguage(text) {
  const value = String(text ?? "");
  const hasCjk = /[一-鿿]/.test(value);
  const hasLatinWord = /[a-zA-Z]{2,}/.test(value);
  if (hasCjk && hasLatinWord) return "Mixed";
  if (hasCjk) return "ZH";
  if (/\b(boleh|nak|tak|berapa|harga|bilik|dekat|mana|jangan|saya|awak|ada|macam|mana|nanti|sibuk)\b/i.test(value)) return "BM";
  return "EN";
}

// ---------- model pick ----------
export function pickModel(tier, env = {}, provider = env.BRAIN_AI_PROVIDER || "anthropic") {
  const isComplex = tier === "complex";
  if (provider === "openai") {
    return isComplex
      ? env.BRAIN_OPENAI_MODEL_COMPLEX || "gpt-5.4"
      : env.BRAIN_OPENAI_MODEL_SIMPLE || "gpt-5.4-nano";
  }
  if (provider === "gemini") {
    return isComplex
      ? env.BRAIN_GEMINI_MODEL_COMPLEX || "gemini-3.1-pro-preview"
      : env.BRAIN_GEMINI_MODEL_SIMPLE || "gemini-3.5-flash";
  }
  return isComplex
    ? env.BRAIN_ANTHROPIC_MODEL_COMPLEX || env.BRAIN_MODEL_COMPLEX || "claude-sonnet-4-5"
    : env.BRAIN_ANTHROPIC_MODEL_SIMPLE || env.BRAIN_MODEL_SIMPLE || "claude-haiku-4-5";
}

// ---------- project sheet formatting (Layer 2 -> prompt text, pure) ----------

export function formatProjectSheet(projectCtx) {
  const sheet = projectCtx?.sheet;
  if (!sheet) return "";
  const lines = [];
  if (sheet.one_liner) lines.push(`定位: ${sheet.one_liner}`);
  if (sheet.location) {
    const loc = [sheet.location.area, sheet.location.landmark].filter(Boolean).join(" · ");
    if (loc) lines.push(`地点: ${loc}`);
  }
  if (sheet.developer) lines.push(`发展商: ${sheet.developer}`);
  if (sheet.price_range?.length === 2) lines.push(`价格区间: RM${sheet.price_range[0].toLocaleString()} - RM${sheet.price_range[1].toLocaleString()}`);
  if (sheet.monthly_from) lines.push(`月供: 约 RM${sheet.monthly_from} 起 (以银行批核为准)`);
  for (const t of sheet.types ?? []) {
    lines.push(`户型: ${[t.layout, t.sqft ? `${t.sqft}sf` : null, t.from ? `from RM${Number(t.from).toLocaleString()}` : null].filter(Boolean).join(" · ")}`);
  }
  for (const s of sheet.selling_points ?? []) lines.push(`卖点: ${s}`);
  for (const p of projectCtx.promos ?? []) lines.push(`当期 PROMO: ${p.desc}${p.valid_until ? ` (截止 ${String(p.valid_until).slice(0, 10)})` : ""}`);
  if (sheet.gallery?.address) lines.push(`Sales Gallery: ${sheet.gallery.address}${sheet.gallery.hours ? ` (${sheet.gallery.hours})` : ""}`);
  if (sheet.gallery?.slot_style) lines.push(`约看方式: ${sheet.gallery.slot_style}`);
  for (const f of sheet.faq ?? []) {
    if (f?.q && f?.a) lines.push(`FAQ: ${f.q} -> ${f.a}`);
  }
  // TODO 值是还没核对的占位, AI 不准引用
  const structured = lines.filter((l) => !/TODO/i.test(l)).map((l) => `- ${l}`).join("\n");
  // Obsidian .md 的人话正文 (读入时已剔除 TODO 行): 原样给 AI, 让草稿带上
  // 业务员自己的讲法和 FAQ 语气。上限 6000 字 — 认真写的 playbook (like Enlace
  // 的 2300 字) 要完整进 prompt, 尤其结尾的收 showroom 段落; 6000 足够 3 倍余量,
  // 又不至于一个盘撑爆 prompt。超过的话优先砍正文开头以外的重复内容。
  const body = typeof sheet.body === "string" && sheet.body.trim()
    ? sheet.body.trim().slice(0, 6000)
    : "";
  return body ? `${structured}\n\n${body}` : structured;
}

// ---------- media tags ----------
//
// 盘资料 frontmatter 的 media 表登记了这个盘"存在"的图 (tag -> 文件)。AI 草稿要
// 配图就写单独一行 [img:tag]; 这里把 tag 解析出来对表验证 — 列表外的 tag 直接
// 丢弃, 所以 AI 永远不可能发一张不存在/不属于这个盘的图。最多 2 张防轰炸。
export function parseMediaTags(draft, mediaMap = {}) {
  const lines = String(draft ?? "").split(/\r?\n/);
  const media = [];
  const invalid = [];
  const kept = [];
  for (const line of lines) {
    const m = /^\s*\[img:([a-z0-9_\-]+)\]\s*$/i.exec(line);
    if (!m) { kept.push(line); continue; }
    const tag = m[1].toLowerCase();
    const entry = mediaMap?.[tag];
    const file = typeof entry === "string" ? entry : entry?.file;
    if (file) media.push({ tag, file });
    else invalid.push(tag);
  }
  return { text: kept.join("\n").trim(), media: media.slice(0, 2), invalid };
}

// ---------- prompt build (guardrails live HERE, hardcoded) ----------
//
// The cache passed in is ALREADY Verified-only (brain_cache_sync enforces the
// Verified/Valid-Until gate at the data level). projectCtx (Layer 2) scopes
// facts + sheet to the ONE 盘 this lead was blasted under — cross-project fact
// leakage is prevented by construction, not by prompt discipline.
export function buildPrompt({ event, classified, cache, lead, projectCtx = null }) {
  const factList = projectCtx?.facts ?? cache?.knowledge?.facts ?? [];
  const facts = factList
    .map((f) => `- [${f.category ?? "General"}] ${f.fact}${f.validUntil ? ` (有效至 ${f.validUntil})` : ""}`)
    .join("\n");
  const objections = (cache?.objections?.objections ?? [])
    .slice(0, 20)
    .map((o) => `- 客户说: "${o.says}" | 真实意图: ${o.intent} | 回应方向: ${o.direction}${o.handoff ? " | ⚠️ 需人工" : ""}`)
    .join("\n");
  const projectKeyNorm = (v) => String(v ?? "").toLowerCase().replace(/[^a-z0-9一-鿿]+/g, "_");
  const golden = (cache?.golden?.conversations ?? [])
    .filter((g) => !projectCtx?.projectName || !g.project || projectKeyNorm(g.project) === projectKeyNorm(projectCtx.projectName))
    .slice(0, 5)
    .map((g) => `### ${g.title} (${g.scenario ?? "-"} -> ${g.outcome ?? "-"})\n${String(g.text || "").slice(-6000)}\n为什么有效: ${g.why}`)
    .join("\n\n");

  const projectName = projectCtx?.projectName ?? null;
  const sheetText = formatProjectSheet(projectCtx);
  const mediaMap = projectCtx?.sheet?.media ?? {};
  const mediaList = Object.entries(mediaMap)
    .map(([tag, v]) => `- [img:${tag}]${typeof v === "object" && v?.desc ? ` — ${v.desc}` : ""}`)
    .join("\n");
  const doNotSay = (projectCtx?.sheet?.do_not_say ?? []).map((d, i) => `${6 + i}. ${d}`).join("\n");
  const otherIndex = (projectCtx?.indexLines ?? [])
    .filter((line) => !projectName || !line.startsWith(projectName))
    .map((l) => `- ${l}`)
    .join("\n");

  const system = [
    `你是马来西亚 KL 房产项目的 WhatsApp 销售助理 (Sales Brain)。${projectName ? `这位客户是「${projectName}」这个盘 blast 出去的, 对话围绕它展开。` : ""}你替业务员起草回复,发送前一定有人工审核,所以专注写出最自然、最像真人业务员的草稿。`,
    "",
    "硬性规则 (违反任何一条 = 草稿作废):",
    "1. 只能引用下面「本盘资料」和 VERIFIED FACTS 里明确写着的数字和事实。列表里没有的数字(价格、面积、月供、折扣、日期)一律不准编,改说「这个我 check 最新的资料再回你」。",
    "2. 砍价、贷款细节、客户情绪负面 → 草稿只能安抚+承接,并以约人工跟进收尾,不准自行承诺任何数字或条件。",
    "3. 用客户的语言回复 (中文/English/BM/混搭跟着客户走),WhatsApp 口语风格,短句,不用敬语套话,不用列表,不用 emoji 轰炸 (最多 1 个)。",
    "4. 一条消息说完,长度控制在 3 句以内,结尾带一个自然的推进问题。",
    "5. 直接输出要发给客户的文本,不要解释,不要引号,不要前缀。",
    doNotSay ? `本盘红线:\n${doNotSay}` : "",
  ].filter(Boolean).join("\n");

  const user = [
    projectName && sheetText ? `## 本盘资料 — ${projectName} (只准用这些数字)\n${sheetText}\n` : "",
    mediaList ? `## 可用图片 (客户问户型/地点/package 时配图效果更好)\n${mediaList}\n规则: 要配图就在草稿「最后」单独一行写 [img:tag], 最多 2 张。只准用上面列表的 tag, 列表里没有合适的就不配图。\n` : "",
    `## VERIFIED FACTS (只准用这些)`,
    facts || "(库是空的 — 所有数字都说「我 check 了回你」)",
    "",
    otherIndex ? `## 手上其他盘 (客户明显不合适本盘时才提, 一句话带过并说可以介绍)\n${otherIndex}\n` : "",
    `## OBJECTION PLAYBOOK`,
    objections || "(暂无)",
    golden ? `\n## 成功对话参考\n${golden}` : "",
    "",
    `## 这个 LEAD`,
    `姓名: ${lead?.name ?? "未知"}`,
    `之前状态: ${lead?.lastBlastStatus ?? lead?.status ?? "未知"}`,
    lead?.replyText ? `上一条回复: ${lead.replyText}` : "",
    "",
    `## 客户刚发来 (分类: ${classified.route})`,
    `"${event.text}"`,
    "",
    `## 规则分类器的罐头建议 (可参考可超越)`,
    `"${classified.suggestedReply}"`,
    "",
    "写出你的草稿:",
  ].filter((line) => line !== "").join("\n");

  return { system, user };
}

// ---------- Telegram draft card ----------
export function draftCard({ event, classified, draft, lead, tier, project = null, mediaMap = {} }) {
  const esc = (v) => String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const source = tier === "rules" ? " (Rule-only)" : tier === "complex" ? " (Sonnet)" : "";
  const { media } = parseMediaTags(draft, mediaMap);
  return [
    `🧠 <b>${esc(classified.route)}</b>${project ? ` · 🏢 ${esc(project)}` : ""} · ${esc(lead?.name ?? event.pushName ?? "Unknown")} (${esc(event.phone)})`,
    `💬 客户: ${esc(event.text)}`,
    "",
    `📝 <b>草稿${source}</b>:`,
    esc(draft),
    media.length ? `\n📎 <b>附图</b>: ${media.map((m) => esc(m.tag)).join(", ")} (批准后图+文字一起发)` : "",
    "",
    `✏️ 要改的话: 按「改后发」再 <b>回复这条消息</b> 输入新文本 (可加 [img:tag] 行配图)。`,
  ].filter((l) => l !== "").join("\n");
}

export function draftButtons(pendingId) {
  return [
    { text: "✅ 照发", data: `ok:${pendingId}` },
    { text: "✏️ 改后发", data: `edit:${pendingId}` },
    { text: "🙋 接管", data: `take:${pendingId}` },
  ];
}

// "ok:abc123" -> { action:"ok", pendingId:"abc123" } | null
export function parseCallbackData(data) {
  const m = /^(ok|edit|take):(.+)$/.exec(String(data ?? ""));
  return m ? { action: m[1], pendingId: m[2] } : null;
}

// button action -> AI Reply Log "Action" select
export function logActionOf(action) {
  return { ok: "Sent As-Is", edit: "Edited", take: "Takeover" }[action] ?? null;
}
