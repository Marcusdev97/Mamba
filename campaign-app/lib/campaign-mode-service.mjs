// 发送节奏模式（保守 / 普通 / Crazy），存在本机、每台电脑各自设。
//
// 背景：两个 WhatsApp 号码跑在两台电脑上，本来就是并行的 —— 「让号码同时跑」
// 不需要做任何事。真正要的是「每个号码有自己的节奏」，而一个号码 = 一台电脑，
// 所以 mode 就是一个本机设定值。campaign-data 每台各一份、不同步，天生不打架。
//
// mode 只换一组节奏预设塞进 config.delivery，不动其他逻辑。没有每日上限。
//
//   保守 = 新号养号，慢慢发
//   普通 = 现在的节奏（稳定号）
//   Crazy = 老号冲量，间隔压到 20-30 秒

import fs from "node:fs/promises";
import path from "node:path";

export const MODES = {
  conservative: {
    key: "conservative",
    label: "保守",
    emoji: "🐢",
    tagline: "养号 · 慢慢发",
    description: "新号码或刚被限制过的号码用这个。间隔拉长，降低被 WhatsApp 盯上的机率。",
    // 客户与客户之间的间隔（秒）
    contactGapSeconds: { min: 90, max: 150 },
    // Part 1 与 Part 2 之间的间隔（秒）
    partGapSeconds: { min: 8, max: 20 },
    // 硬底线：任何两次发送之间至少隔这么久（秒）
    minBlastGapSeconds: 180,
  },
  normal: {
    key: "normal",
    label: "普通",
    emoji: "🐍",
    tagline: "稳定号 · 现在的节奏",
    description: "已经养稳、平常在用的号码。速度和安全的平衡点，也是预设。",
    contactGapSeconds: { min: 45, max: 75 },
    partGapSeconds: { min: 5, max: 12 },
    minBlastGapSeconds: 120,
  },
  crazy: {
    key: "crazy",
    label: "Crazy",
    emoji: "🔥",
    tagline: "老号 · 冲量",
    description: "只给用了很久、很稳的老号码。间隔压到 20-30 秒，量大但封号风险明显较高 —— 别用在新号上。",
    contactGapSeconds: { min: 20, max: 30 },
    partGapSeconds: { min: 4, max: 8 },
    minBlastGapSeconds: 45,
  },
};

export const DEFAULT_MODE = "normal";
export const MODE_ORDER = ["conservative", "normal", "crazy"];

export function isValidMode(key) {
  return Object.prototype.hasOwnProperty.call(MODES, String(key));
}

// mode 转成 runner 看得懂的 delivery 设定（给 UI 显示用，物件形状）。
export function deliveryForMode(key) {
  const mode = MODES[isValidMode(key) ? key : DEFAULT_MODE];
  return {
    contactGapSeconds: { ...mode.contactGapSeconds },
    partGapSeconds: { ...mode.partGapSeconds },
    minBlastGapSeconds: mode.minBlastGapSeconds,
  };
}

// 把某个 mode 的节奏套进 campaign config，回一份新 config（不改原本的）。
//
// 关键：campaign_core 的节奏读的是 config.delivery，而它的形状跟 mode 不完全一样 ——
//   contactGapSeconds 是 {min,max} 物件（contactGapRange 读 .min/.max）
//   partGapSeconds 是纯数字 + partGapMaxSeconds（partGapRange 读这两个纯数字）
// 所以这里做形状转换。只覆盖节奏三项，其他 delivery 设定（防重发冷却、回复回看
// 天数等）原样保留。
export function applyModeDelivery(config, key) {
  const mode = MODES[isValidMode(key) ? key : DEFAULT_MODE];
  return {
    ...(config || {}),
    campaignMode: mode.key,   // 记下这条车道用了哪个 mode，之后 checkpoint / 显示用得上
    delivery: {
      ...((config || {}).delivery || {}),
      contactGapSeconds: { min: mode.contactGapSeconds.min, max: mode.contactGapSeconds.max },
      partGapSeconds: mode.partGapSeconds.min,
      partGapMaxSeconds: mode.partGapSeconds.max,
      minBlastGapSeconds: mode.minBlastGapSeconds,
    },
  };
}

// 给 UI 用的清单：三个模式的完整资料，照固定顺序。
export function modeCatalog() {
  return MODE_ORDER.map((key) => ({ ...MODES[key] }));
}

function cleanInstance(value) {
  return String(value ?? "").trim();
}

export function createCampaignModeService({ dataDir, clock = () => new Date() } = {}) {
  const configPath = path.join(dataDir, "campaign-mode.json");
  // 每个号码(instance)一个 mode：{ wa_01: "conservative", wa_02: "crazy" }。
  // 800 客户分 3 群、3 个号码各跑各的节奏 —— 老号 crazy、新号保守,同时并行。
  let cache = null;

  async function read() {
    if (cache) return cache;
    try {
      const saved = JSON.parse(await fs.readFile(configPath, "utf8"));
      const byInstance = {};
      // v2：每号一个。也兼容 v1 的单一 mode(以前每台一个),当作预设兜底。
      if (saved?.modes && typeof saved.modes === "object") {
        for (const [name, key] of Object.entries(saved.modes)) {
          if (cleanInstance(name) && isValidMode(key)) byInstance[cleanInstance(name)] = key;
        }
      }
      const fallback = isValidMode(saved?.default) ? saved.default
        : isValidMode(saved?.mode) ? saved.mode   // v1 迁移
        : DEFAULT_MODE;
      cache = { modes: byInstance, default: fallback, updatedAt: saved?.updatedAt ?? null };
    } catch {
      cache = { modes: {}, default: DEFAULT_MODE, updatedAt: null };
    }
    return cache;
  }

  async function persist(state) {
    const value = { version: 2, modes: state.modes, default: state.default, updatedAt: clock().toISOString() };
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    const temp = `${configPath}.tmp.${process.pid}.${Date.now()}`;
    await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
    await fs.rename(temp, configPath);
    cache = { modes: state.modes, default: state.default, updatedAt: value.updatedAt };
    return cache;
  }

  // 某个号码的 mode。没单独设过 → 用预设(普通)。发送时读这个。
  async function getMode(instanceName) {
    const state = await read();
    const name = cleanInstance(instanceName);
    return (name && state.modes[name]) || state.default;
  }

  async function setMode(instanceName, key) {
    const name = cleanInstance(instanceName);
    if (!name) {
      const error = new Error("要设定哪个号码的模式？缺少号码名称。");
      error.statusCode = 400;
      throw error;
    }
    if (!isValidMode(key)) {
      const error = new Error(`不认识的发送模式：${key}。只支持 ${MODE_ORDER.join(" / ")}。`);
      error.statusCode = 400;
      throw error;
    }
    const state = await read();
    return persist({ ...state, modes: { ...state.modes, [name]: key } });
  }

  // 某个号码的节奏设定。runner 发送时就读这个。
  async function deliveryForInstance(instanceName) {
    return deliveryForMode(await getMode(instanceName));
  }

  // UI 一次拿全部：每个号码现在选什么、三个模式的完整资料。
  // instanceNames 由呼叫端(从 Evolution)带进来 —— 这个 service 不认识有哪些号码,
  // 只负责记「哪个号选了什么」。没设过的号会用预设补上,让 UI 有东西显示。
  async function snapshot(instanceNames = []) {
    const state = await read();
    const names = [...new Set([...(instanceNames || []).map(cleanInstance).filter(Boolean), ...Object.keys(state.modes)])];
    const perInstance = names.map((name) => ({
      instance: name,
      mode: state.modes[name] || state.default,
      explicit: Boolean(state.modes[name]),   // false = 还没单独设,用的是预设
    }));
    return {
      default: state.default,
      updatedAt: state.updatedAt,
      instances: perInstance,
      modes: modeCatalog(),
    };
  }

  return { configPath, getMode, setMode, deliveryForInstance, snapshot, deliveryForMode };
}
