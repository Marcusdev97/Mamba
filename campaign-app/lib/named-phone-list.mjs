import { normalizePhone } from "../suppression.mjs";

function cleanName(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
}

export function parseNamedPhoneEntries(value) {
  const lines = Array.isArray(value) ? value : String(value ?? "").split(/\r?\n/);
  const seen = new Set();
  const entries = [];

  for (const raw of lines) {
    if (raw && typeof raw === "object") {
      const phone = normalizePhone(raw.phone);
      if (!phone || seen.has(phone)) continue;
      seen.add(phone);
      entries.push({ name: cleanName(raw.name), phone });
      continue;
    }

    const line = String(raw ?? "").trim();
    if (!line || line.startsWith("#")) continue;
    const phoneMatch = line.match(/\+?\d[\d\s().-]{6,}\d/);
    const phone = normalizePhone(phoneMatch?.[0] ?? line);
    if (!phone || seen.has(phone)) continue;
    seen.add(phone);
    const name = cleanName(phoneMatch
      ? line.replace(phoneMatch[0], "").replace(/^[,;|\s-]+|[,;|\s-]+$/g, "")
      : "");
    entries.push({ name, phone });
  }

  return entries;
}

export function formatNamedPhoneEntries(entries) {
  return parseNamedPhoneEntries(entries)
    .map((entry) => entry.name ? `${entry.name}, ${entry.phone}` : entry.phone)
    .join("\n");
}
