export const AUTO_SCHEDULE = "AUTO";
export const FIXED_SCHEDULE = "FIXED";

export function scheduleModeForEnd(value) {
  return String(value ?? "").trim() ? FIXED_SCHEDULE : AUTO_SCHEDULE;
}

export function campaignPacing(config = {}) {
  const delivery = config.delivery || {};
  const partGapSeconds = Number(delivery.partGapSeconds) || 0;
  const contactMinSeconds = Number(delivery.contactGapSeconds?.min) || 45;
  const minBlastGapSeconds = Number(delivery.minBlastGapSeconds) || 120;
  const floorSeconds = Math.max(minBlastGapSeconds, partGapSeconds + contactMinSeconds);
  return {
    partGapMs: partGapSeconds * 1000,
    floorMs: floorSeconds * 1000,
  };
}

// AUTO mode reserves one full pacing slot per lead. The last slot is a safety
// buffer for Part 2 and API latency, so the end-time cutoff cannot clip it.
export function estimateAutoEnd(startAt, leadCount, config = {}) {
  const count = Math.max(1, Number(leadCount) || 0);
  const { floorMs } = campaignPacing(config);
  return new Date(new Date(startAt).getTime() + count * floorMs);
}

export function scheduleDurationMinutes(startAt, endAt) {
  return Math.max(0, Math.ceil((new Date(endAt).getTime() - new Date(startAt).getTime()) / 60000));
}
