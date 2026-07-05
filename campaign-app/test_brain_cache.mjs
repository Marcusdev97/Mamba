// test_brain_cache.mjs — offline tests for brain_cache_sync.mjs.
// Run: node test_brain_cache.mjs
// Tests the property mapping and — most importantly — the Verified/Valid-Until
// guardrail that decides what the AI is ALLOWED to see.

import { mapKnowledgePage, mapGoldenPage, mapObjectionPage, splitUsableFacts } from "./brain_cache_sync.mjs";

let fail = 0;
function check(label, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) { console.log(`❌ ${label}:\n   got      ${JSON.stringify(got)}\n   expected ${JSON.stringify(expected)}`); fail += 1; }
}

// --- fixtures shaped exactly like Notion API pages ---
const knowledgePage = {
  properties: {
    "Fact": { title: [{ plain_text: "E2 全栋只有 290 units" }] },
    "Project": { select: { name: "Enlace" } },
    "Category": { select: { name: "Layout" } },
    "Verified": { checkbox: true },
    "Source": { rich_text: [{ plain_text: "KB row 24" }] },
    "Valid Until": { date: { start: "2026-12-31" } },
  },
};
check("mapKnowledgePage", mapKnowledgePage(knowledgePage), {
  fact: "E2 全栋只有 290 units", project: "Enlace", category: "Layout",
  verified: true, source: "KB row 24", validUntil: "2026-12-31",
});

const goldenPage = {
  properties: {
    "Conversation": { title: [{ plain_text: "价格砍价拿到 viewing" }] },
    "Scenario": { select: { name: "Price Objection" } },
    "Project": { select: { name: "Enlace" } },
    "Customer Type": { select: { name: "Investor" } },
    "Outcome": { select: { name: "Viewing Booked" } },
    "Conversation Text": { rich_text: [{ plain_text: "客户: 太贵了\n我: ..." }] },
    "Why It Worked": { rich_text: [{ plain_text: "先接情绪再给 psf 锚" }] },
    "Language": { select: { name: "Mixed" } },
  },
};
check("mapGoldenPage", mapGoldenPage(goldenPage), {
  title: "价格砍价拿到 viewing", scenario: "Price Objection", project: "Enlace",
  customerType: "Investor", outcome: "Viewing Booked",
  text: "客户: 太贵了\n我: ...", why: "先接情绪再给 psf 锚", language: "Mixed",
});

const objectionPage = {
  properties: {
    "Customer Says": { title: [{ plain_text: "太贵了" }] },
    "Real Intent": { rich_text: [{ plain_text: "说服我为什么值" }] },
    "Response Direction": { rich_text: [{ plain_text: "psf 对比 + 全配价值,不是道歉降价" }] },
    "Handoff Required": { checkbox: false },
    "Scenario": { select: { name: "Price Objection" } },
    "Language": { select: { name: "ZH" } },
  },
};
check("mapObjectionPage", mapObjectionPage(objectionPage), {
  says: "太贵了", intent: "说服我为什么值",
  direction: "psf 对比 + 全配价值,不是道歉降价",
  handoff: false, scenario: "Price Objection", language: "ZH",
});

// Missing/empty properties must not crash — they become null/""/false.
check("empty page is safe", mapKnowledgePage({ properties: {} }), {
  fact: "", project: null, category: null, verified: false, source: "", validUntil: null,
});

// --- THE guardrail: what is the AI allowed to see ---
const today = "2026-07-05";
const facts = [
  { fact: "verified, no expiry", verified: true, validUntil: null },
  { fact: "verified, future expiry", verified: true, validUntil: "2026-08-01" },
  { fact: "verified, expires today (still valid)", verified: true, validUntil: "2026-07-05" },
  { fact: "verified but EXPIRED", verified: true, validUntil: "2026-07-01" },
  { fact: "NOT verified", verified: false, validUntil: null },
  { fact: "", verified: true, validUntil: null }, // empty fact -> dropped silently
];
const { usable, unverified, expired } = splitUsableFacts(facts, today);
check("guardrail: usable count", usable.length, 3);
check("guardrail: usable facts", usable.map((f) => f.fact), [
  "verified, no expiry", "verified, future expiry", "verified, expires today (still valid)",
]);
check("guardrail: unverified count", unverified, 1);
check("guardrail: expired count", expired, 1);

console.log(fail ? `${fail} test(s) failed` : "✅ all brain-cache tests passed");
process.exitCode = fail ? 1 : 0;
