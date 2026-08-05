export const DEFAULT_WATCHDOG_SETTINGS = Object.freeze({
  telegramNotificationsEnabled: true,
  checkIntervalSeconds: 30,
  failureDelayMinutes: 1,
  reminderMinutes: 0,
});

export const WATCHDOG_SETTING_LIMITS = Object.freeze({
  checkIntervalSeconds: Object.freeze({ min: 15, max: 600 }),
  failureDelayMinutes: Object.freeze({ min: 1, max: 1440 }),
  reminderMinutes: Object.freeze({ min: 0, max: 1440 }),
});

function boundedInteger(value, { name, min, max, fallback }) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${name} 必须是 ${min}–${max} 的完整数字。`);
  }
  return number;
}

function booleanSetting(value, { name, fallback }) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  if (value === true || value === "1" || value === 1 || value === "true") return true;
  if (value === false || value === "0" || value === 0 || value === "false") return false;
  throw new Error(`${name} 必须是开启或关闭。`);
}

export function validateWatchdogSettings(input = {}, fallback = DEFAULT_WATCHDOG_SETTINGS) {
  return {
    telegramNotificationsEnabled: booleanSetting(input.telegramNotificationsEnabled, {
      name: "Watchdog Telegram 通知",
      fallback: fallback.telegramNotificationsEnabled,
    }),
    checkIntervalSeconds: boundedInteger(input.checkIntervalSeconds, {
      name: "Watchdog 检查间隔（秒）",
      ...WATCHDOG_SETTING_LIMITS.checkIntervalSeconds,
      fallback: fallback.checkIntervalSeconds,
    }),
    failureDelayMinutes: boundedInteger(input.failureDelayMinutes, {
      name: "Telegram 异常确认时间（分钟）",
      ...WATCHDOG_SETTING_LIMITS.failureDelayMinutes,
      fallback: fallback.failureDelayMinutes,
    }),
    reminderMinutes: boundedInteger(input.reminderMinutes, {
      name: "Telegram 重复提醒间隔（分钟）",
      ...WATCHDOG_SETTING_LIMITS.reminderMinutes,
      fallback: fallback.reminderMinutes,
    }),
  };
}

export function watchdogSettingsFromEnv(env = {}) {
  try {
    return validateWatchdogSettings({
      telegramNotificationsEnabled: env.MAMBA_WATCHDOG_TELEGRAM_ENABLED,
      checkIntervalSeconds: env.MAMBA_WATCHDOG_INTERVAL_SECONDS,
      failureDelayMinutes: env.MAMBA_WATCHDOG_TELEGRAM_DELAY_MINUTES,
      reminderMinutes: env.MAMBA_WATCHDOG_TELEGRAM_REMINDER_MINUTES,
    });
  } catch {
    // A malformed hand-edited .env must not stop the safety monitor. Settings
    // performs strict validation; runtime falls back to the quiet safe defaults.
    return { ...DEFAULT_WATCHDOG_SETTINGS };
  }
}

export function watchdogSettingsToEnv(settings) {
  const validated = validateWatchdogSettings(settings);
  return {
    MAMBA_WATCHDOG_TELEGRAM_ENABLED: validated.telegramNotificationsEnabled ? "1" : "0",
    MAMBA_WATCHDOG_INTERVAL_SECONDS: String(validated.checkIntervalSeconds),
    MAMBA_WATCHDOG_TELEGRAM_DELAY_MINUTES: String(validated.failureDelayMinutes),
    MAMBA_WATCHDOG_TELEGRAM_REMINDER_MINUTES: String(validated.reminderMinutes),
  };
}
