import assert from "node:assert/strict";
import { parsePastedLeads } from "./routes/import.routes.mjs";

function normalizePhone(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.startsWith("0")) digits = `60${digits.slice(1)}`;
  return /^\d{8,15}$/.test(digits) ? digits : "";
}

const parsed = parsePastedLeads(`
Name, Phone
Marcus, 60123456789
Chloe Choo\t011-5451 5334
陈小姐 012-345 6790
60168889999
Duplicate, +60 12 345 6790
broken customer
`, normalizePhone);

assert.deepEqual(parsed.leads.map(({ name, phone }) => ({ name, phone })), [
  { name: "Marcus", phone: "60123456789" },
  { name: "Chloe Choo", phone: "601154515334" },
  { name: "陈小姐", phone: "60123456790" },
  { name: "there", phone: "60168889999" },
]);
assert.equal(parsed.rejected.length, 2);
assert.equal(parsed.rejected[0].reason, "重复号码");
assert.equal(parsed.rejected[1].reason, "找不到有效电话号码");

const phoneFirst = parsePastedLeads("60177778888 | Alice Wong", normalizePhone);
assert.deepEqual(phoneFirst.leads.map(({ name, phone }) => ({ name, phone })), [
  { name: "Alice Wong", phone: "60177778888" },
]);

assert.throws(
  () => parsePastedLeads("x".repeat(2_000_001), normalizePhone),
  (error) => error.code === "PASTED_LEADS_TOO_LARGE",
);

console.log("✅ all pasted Flow 1 customer-list parsing tests passed");
