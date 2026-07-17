export const AUTO_SCHEDULE = "AUTO";
export const FIXED_SCHEDULE = "FIXED";

export function scheduleModeForEnd(value) {
  return String(value ?? "").trim() ? FIXED_SCHEDULE : AUTO_SCHEDULE;
}

function positive(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

export function partGapRange(config = {}) {
  const delivery = config.delivery || {};
  const minSeconds = positive(delivery.partGapSeconds, 45);
  const maxSeconds = Math.max(minSeconds, positive(delivery.partGapMaxSeconds, minSeconds));
  return { minSeconds, maxSeconds };
}

export function contactGapRange(config = {}) {
  const delivery = config.delivery || {};
  const minSeconds = positive(delivery.contactGapSeconds?.min, 45);
  const maxSeconds = Math.max(minSeconds, positive(delivery.contactGapSeconds?.max, minSeconds));
  return { minSeconds, maxSeconds };
}

export function randomGapSeconds(range, random = Math.random) {
  const min = positive(range?.minSeconds, 0);
  const max = Math.max(min, positive(range?.maxSeconds, min));
  return Math.round(min + Math.max(0, Math.min(1, Number(random()) || 0)) * (max - min));
}

export function campaignPacing(config = {}, partCount = 2) {
  const parts = Math.max(1, Number(partCount) || 1);
  const part = partGapRange(config);
  const contact = contactGapRange(config);
  const averagePartSeconds = (part.minSeconds + part.maxSeconds) / 2;
  const averageContactSeconds = (contact.minSeconds + contact.maxSeconds) / 2;
  const minBlastGapSeconds = positive(config.delivery?.minBlastGapSeconds, 120);
  const floorSeconds = Math.max(
    minBlastGapSeconds,
    (parts - 1) * averagePartSeconds + averageContactSeconds,
  );
  return {
    partGapMs: part.minSeconds * 1000,
    partGapMinMs: part.minSeconds * 1000,
    partGapMaxMs: part.maxSeconds * 1000,
    contactGapMinMs: contact.minSeconds * 1000,
    contactGapMaxMs: contact.maxSeconds * 1000,
    floorMs: floorSeconds * 1000,
  };
}

// AUTO mode reserves one full pacing slot per lead. The last slot is a safety
// buffer for Part 2 and API latency, so the end-time cutoff cannot clip it.
export function estimateAutoEnd(startAt, leadCount, config = {}, partCount = 2) {
  const count = Math.max(1, Number(leadCount) || 0);
  const { floorMs } = campaignPacing(config, partCount);
  return new Date(new Date(startAt).getTime() + count * floorMs);
}

export function scheduleDurationMinutes(startAt, endAt) {
  return Math.max(0, Math.ceil((new Date(endAt).getTime() - new Date(startAt).getTime()) / 60000));
}
