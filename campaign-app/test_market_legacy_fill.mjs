import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fillFromLegacyKb, LEGACY_KB_DIR, loadLegacyMarketKb } from "./lib/market-legacy-kb.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "mamba-legacy-kb-"));
const kbDir = path.join(root, ...LEGACY_KB_DIR);
await fs.mkdir(kbDir, { recursive: true });

const sheet = (fields) => `---\n${fields}\n---\n\n# body\n`;

await fs.writeFile(path.join(kbDir, "klang_valley.md"), sheet([
  'name: "Cochrane Tower @ Cheras"',
  'uid: "kv-1"',
  'developer: "Legacy Developer Sdn Bhd"',
  'state: "Kuala Lumpur"',
  'area: "Cheras"',
  'tenure: "Freehold"',
  'land_size: "1.16 acre"',
  'completion: "Q3 2027"',
  'blocks_storeys: "1 Block, 38 Storey"',
  'total_units: "278"',
  'maintenance: "RM0.50 psf including sinking fund"',
  "price_range_rm: [700000, 900000]",
  "bu_range_sf: [650, 900]",
].join("\n")));

// Penang / Johor 的旧记录必须整笔挡掉，不能只挡 state 栏。
await fs.writeFile(path.join(kbDir, "penang.md"), sheet([
  'name: "Island Tower @ Georgetown"',
  'uid: "pg-1"',
  'state: "Penang"',
  'completion: "Q1 2028"',
].join("\n")));
await fs.writeFile(path.join(kbDir, "johor.md"), sheet([
  'name: "Straits View @ JB"',
  'uid: "jb-1"',
  'state: "Johor"',
  'completion: "Q2 2028"',
].join("\n")));
// 底线开头的是索引档，不是盘。
await fs.writeFile(path.join(kbDir, "_INDEX.md"), sheet('name: "index"\nuid: "idx-1"'));

const kb = await loadLegacyMarketKb(root);
assert.deepEqual([...kb.keys()], ["kv-1"], "Penang / Johor / 索引档都不该进补空表");

// --- 只补空格，不覆盖 ---
const company = {
  uid: "kv-1",
  name: "Cochrane Tower @ Cheras",
  developer: "Company Developer Sdn Bhd",
  state: "Kuala Lumpur",
  area: "Unassigned",
  tenure: "",
  completion: "",
  landSize: "",
  totalUnits: "500",
  priceMin: 750000,
  priceMax: 750000,
  priceBand: "RM600k - RM800k",
  buMin: null,
  buMax: null,
  completeness: 60,
};
const filled = fillFromLegacyKb(company, kb.get("kv-1"));

assert.equal(filled.developer, "Company Developer Sdn Bhd", "公司已有的 developer 不可以被旧 KB 覆盖");
assert.equal(filled.totalUnits, "500", "公司已有的 total units 不可以被旧 KB 覆盖");
assert.equal(filled.priceMin, 750000, "公司已有价钱不可以被旧 KB 覆盖");
assert.equal(filled.priceBand, "RM600k - RM800k");

assert.equal(filled.completion, "Q3 2027", "空的 completion 要补上");
assert.equal(filled.landSize, "1.16 acre");
assert.equal(filled.blocksStoreys, "1 Block, 38 Storey");
assert.equal(filled.maintenance, "RM0.50 psf including sinking fund");
assert.equal(filled.tenure, "Freehold");
assert.equal(filled.area, "Cheras", "Unassigned 算空格");
assert.equal(filled.buMin, 650, "公司没给面积就用旧 KB 的");
assert.equal(filled.buMax, 900);

assert.deepEqual(
  filled.legacyFilled.sort(),
  ["area", "blocksStoreys", "buMin", "completion", "landSize", "maintenance", "tenure"],
  "补了哪几栏要列清楚，导出和 UI 才讲得出这些数字没核对过",
);
assert.match(filled.legacySource, /2026-06-02/);
assert.ok(filled.completeness > 60, "补空之后完整度要重算");

// --- 价钱是空的时候才补，补完 price band 要重算 ---
const noPrice = fillFromLegacyKb({ ...company, priceMin: null, priceMax: null, priceBand: "Missing" }, kb.get("kv-1"));
assert.equal(noPrice.priceMin, 700000);
assert.equal(noPrice.priceMax, 900000);
assert.equal(noPrice.priceBand, "RM600k - RM800k", "补了价钱就不该还挂着 Missing");

// --- 旧 KB 没有的盘，原样回传 ---
const untouched = { uid: "not-in-kb", completion: "" };
assert.equal(fillFromLegacyKb(untouched, kb.get("not-in-kb")), untouched);

// --- 没放旧 KB 也不该炸 ---
assert.equal((await loadLegacyMarketKb(path.join(root, "nope"))).size, 0);

await fs.rm(root, { recursive: true, force: true });
console.log("✅ all market legacy KB fill tests passed");
