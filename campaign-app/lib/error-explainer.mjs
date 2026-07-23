// 把技术错误翻成「发生什么事 / 影响谁 / 我现在该做什么」。
//
// 起因：system logs 里一半的错误长这样 ——
//   "读取 Notion Next Flow 名单失败: The operation was aborted due to timeout"
//   "Could not check sales replies sent from WhatsApp."
// 看得到出事，看不出严不严重、要不要现在处理、处理什么。真正好用的那几条
// (NOTION_LEAD_NOT_FOUND 那些) 全部来自 notion-reply-queue 里的
// explainNotionReplyError —— 这支就是把那个写法推广成全站通用。
//
// 四个栏位，缺一不可：
//   message  一句话讲发生什么事（不要贴原始堆叠）
//   why      为什么会这样（这是最常被漏掉的一段）
//   impact   谁受影响、什么东西现在是坏的 —— 决定你要不要马上处理
//   action   你现在具体做什么（可以照做的动作，不是「请检查设定」这种废话）
//
// 判断顺序由具体到笼统：先看错误码，再看讯息特征，都不中才回通用的。
// 通用那条仍然会带上原文，绝不吞掉资讯。

const RULES = [
  // ---------- WhatsApp instance 管理 ----------
  //
  // Evolution 的「名称已占用」也是 HTTP 403，但它跟 Notion 完全无关。
  // 这条必须放在 Notion 的通用 403 规则前面，否则新增号码失败会被误报成
  // database 没分享给 integration。
  {
    code: "WHATSAPP_INSTANCE_NAME_CONFLICT",
    test: (text) => /this name\s+["']?.+?["']?\s+is already in use|instance name.*already in use|名称.*已(被)?使用/i.test(text),
    message: "这个 WhatsApp 号码标签已经被 Evolution 使用。",
    why: "Evolution 里已经存在同名 instance；它可能已在号码清单里，也可能是另一台 Mamba 建立的旧 instance。",
    impact: "只影响这次新增号码；没有建立新 instance，也没有改动 SQLite、Notion 或任何发送纪录。",
    action: "回 Settings 刷新号码清单。若该标签已出现就直接使用或重新取二维码；若要新增，请改用画面建议的下一个标签。确认旧 instance 不再使用前不要删除它。",
  },

  // ---------- 本机数据库 ----------
  {
    code: "SQLITE_BUSY",
    test: (text, error) => error?.code === "SQLITE_BUSY" || /database is locked|database table is locked|SQLITE_BUSY/i.test(text),
    message: "本机数据库正被其他动作占用，这次写入没成功。",
    why: "同一时间有另一个 Mamba 程序在写同一个档案（常见于 server 和 tracker 同时动到，或上一个大批次还没写完）。",
    impact: "这一笔资料没写进去，但来源档案还在，补写就会回来。其他功能不受影响。",
    action: "等几秒重试。一直出现的话，确认没有开着两个 Mamba server（`pgrep -fl campaign-app/server.mjs` 应该只有一个）。",
  },
  {
    code: "SQLITE_DRIVER_NOT_FOUND",
    test: (text, error) => error?.code === "SQLITE_DRIVER_NOT_FOUND" || /找不到 sqlite3/i.test(text),
    message: "这台电脑找不到 sqlite3，本机数据库完全用不了。",
    why: "Mamba 靠系统的 sqlite3 指令读写本机数据库，这台机器上没有，或不在预期的路径。",
    impact: "客户名单、对话纪录、防重发检查全部停摆。防重发查不到纪录会跳过发送（宁可不发也不重发），所以 campaign 会大量 SKIPPED。",
    action: "装上 sqlite3（`brew install sqlite`），或用 MAMBA_SQLITE3_PATH 指到正确位置，然后重启 Mamba。",
  },
  {
    code: "SQLITE_COMMAND_TIMEOUT",
    test: (text, error) => error?.code === "SQLITE_COMMAND_TIMEOUT" || /SQLite command timeout/i.test(text),
    message: "本机数据库这次查询太久，被中断了。",
    why: "资料量太大或磁碟很忙。批次写入几万笔时偶尔会碰到。",
    impact: "这一次操作没完成，资料没有半写半不写（整批在同一个 transaction 里）。",
    action: "重跑一次。补写脚本都是幂等的，重复跑不会写重复。",
  },

  // ---------- Notion ----------
  {
    code: "NOTION_AUTH_FAILED",
    test: (text) => /HTTP 401|unauthori[sz]ed|invalid.*token|token.*invalid/i.test(text),
    message: "Notion 拒绝了这次连线：身份验证失败。",
    why: "Notion token 过期、被撤销，或填错了。",
    impact: "所有跟 Notion 有关的动作都会失败：名单读不到、发送结果写不回去。⚠️ 写不回去代表那批客户在名单上看起来没发过，下一批可能重复发送。",
    action: "打开 Settings 重新填 Notion token，确认那个 integration 还在。修好后到发送台按「立即同步」把积压的推出去。",
  },
  {
    code: "NOTION_DATABASE_ACCESS_FAILED",
    test: (text) => /object_not_found|database.*not found|could not find.*database|notion.*HTTP (403|404)|HTTP (403|404).*notion/i.test(text),
    message: "Notion 找得到服务，但打不开那个 database。",
    why: "database 没有分享给 Mamba 的 integration，或 notion_config.json 里的 id 不对（换过 workspace、复制过 database 都会这样）。",
    impact: "跟那个 database 有关的功能全部失效。若是 Blast Leads，发送结果写不回去，下一批可能重复发送。",
    action: "在 Notion 打开该 database → Share → 加入 Mamba integration；再核对 campaign-data/notion_config.json 的 database id。",
  },
  {
    code: "NOTION_RATE_LIMITED",
    test: (text) => /HTTP 429|rate.?limit/i.test(text),
    message: "Notion 暂时限制了请求速度。",
    why: "短时间送出太多请求（大批次回写时常见）。",
    impact: "这一批暂时慢下来，资料不会丢。",
    action: "不用处理，也不要重复点击 —— Mamba 会自动降速重试。",
  },
  // ---------- WhatsApp / Evolution ----------
  //
  // ⚠️ 这一段必须排在 NOTION_NETWORK_FAILED 前面。
  // Evolution 在 127.0.0.1:8080，连不上时抛的是 ECONNREFUSED —— 而那条规则
  // 也认 /ECONN/。顺序反了的话「WhatsApp 掉线」会被讲成「Notion 网路问题」，
  // 使用者就跑去查网路，实际上要做的是重新扫 QR。
  {
    code: "WHATSAPP_NOT_CONNECTED",
    test: (text) => /ECONNREFUSED.*8080|127\.0\.0\.1:8080|Evolution.*(refused|unavailable)|instance.*not.*(found|connected)/i.test(text),
    message: "连不上 Evolution（WhatsApp 发送服务）。",
    why: "Evolution 没在跑，或 WhatsApp 装置已经登出（手机上「已连结的装置」被移除也会这样）。",
    impact: "完全发不出讯息。进行中的 campaign 会整批失败。",
    action: "确认 Evolution 有在跑（127.0.0.1:8080），再到 Settings 看 Phone Health；装置被登出的话要重新扫 QR。",
  },
  {
    code: "RECIPIENT_NOT_ON_WHATSAPP",
    test: (text) => /exists.*false|not.*on.*whatsapp|号码未注册/i.test(text),
    message: "这个号码没有注册 WhatsApp。",
    why: "号码打错、是市话，或对方从来没用过 WhatsApp。",
    impact: "只影响这一个客户，其他人照常发。系统不会重试（重试也没用）。",
    action: "到名单核对这个号码。确认无效的话在 Notion 标成 Invalid，免得每一轮都再试一次。",
  },
  {
    code: "SEND_TIMEOUT_UNCONFIRMED",
    test: (text) => /send timeout|发送 timeout/i.test(text),
    message: "讯息送出去了，但 WhatsApp 没在时限内回覆确认。",
    why: "Evolution 或 WhatsApp 回应太慢。请注意：这**不代表没送出去** —— 很可能对方已经收到，只是确认回来得太晚。",
    impact: "这个客户的状态不明。系统已经停止自动重试，因为盲目重试会让对方收到两次。",
    action: "去 WhatsApp 看这个客户的对话确认收到没有，再决定要不要补发。",
  },

  // 放在 WhatsApp 之后：这条最笼统，任何网路错误都会中。
  {
    code: "NOTION_NETWORK_FAILED",
    test: (text) => /timeout|timed out|aborted|ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|network/i.test(text),
    message: "连线 Notion 时网路超时或中断。",
    why: "网路不稳，或 Notion 当下比较慢。跨国连线偶尔会这样。",
    impact: "这次读写没成功。已经发出去的讯息不受影响，本机纪录也都还在。",
    action: "检查网路。写入类的会自动重试；急的话到发送台按「立即同步」。",
  },

  // ---------- 档案 / 权限 ----------
  {
    code: "FILE_NOT_FOUND",
    test: (text, error) => error?.code === "ENOENT" || /ENOENT|no such file or directory/i.test(text),
    message: "要读的档案不存在。",
    why: "档案被移动或删除，或这台电脑从来没产生过它（例如还没跑过第一次同步）。",
    impact: "依赖这个档案的功能会用预设值或直接失败，其他不受影响。",
    action: "看讯息里的路径。属于 campaign-data/ 的资料档通常跑一次对应功能就会重新产生。",
  },
  {
    code: "FILE_PERMISSION_DENIED",
    test: (text, error) => ["EACCES", "EPERM"].includes(error?.code) || /EACCES|EPERM|permission denied/i.test(text),
    message: "没有权限读写这个档案。",
    why: "档案权限不对，或资料夹放在受系统保护的位置（桌面 / 文件 / 下载都可能触发 macOS 的保护）。",
    impact: "写入类的动作全部失败，资料停在上一次的状态。",
    action: "检查该档案的权限；macOS 的话到「系统设定 → 隐私与安全性 → 完全磁碟取用权」把终端机加进去。",
  },
  {
    code: "DISK_FULL",
    test: (text, error) => error?.code === "ENOSPC" || /ENOSPC|no space left/i.test(text),
    message: "磁碟满了，写不进去。",
    why: "这台电脑没有可用空间。",
    impact: "⚠️ 所有写入都会失败：对话纪录、发送进度、系统日志。发送进度存不下来的话，续跑会算不准。",
    action: "先清出空间再继续。campaign-data/runs/ 和 backups/ 里的旧档案可以先搬走。",
  },

  // ---------- 设定 ----------
  {
    code: "CONFIG_INVALID_JSON",
    test: (text) => /Unexpected token.*JSON|JSON.*position \d|is not valid JSON/i.test(text),
    message: "设定档格式坏掉，读不出来。",
    why: "JSON 语法有误 —— 多一个逗号、少一个括号，手动编辑后最常发生。",
    impact: "读不到设定的功能会退回预设值或停用。",
    action: "看讯息里的档名，用 JSON 检查工具找出错的位置；或从 campaign-data/backups/ 拿回上一版。",
  },
];

const GENERIC = {
  code: "UNEXPECTED_ERROR",
  message: "发生了预期外的错误。",
  why: "这个错误还没有对应的说明规则，下面是原始讯息。",
  impact: "影响范围不明。先看这个功能有没有正常运作再决定。",
  action: "把下面的原始讯息和错误码记下来；在 System Logs 用错误码搜寻可以看到前后文。",
};

function textOf(error) {
  return [error?.message, error?.code, error?.details].filter(Boolean).map(String).join(" ");
}

// 回传一个结构化说明。永远带 details（原文），绝不吞掉技术资讯 ——
// 使用者看上面四句，要 debug 的人看 details。
export function explainError(error, { area = "", event = "" } = {}) {
  const text = textOf(error);
  const rule = RULES.find((item) => {
    try { return item.test(text, error); } catch { return false; }
  });
  const base = rule ?? GENERIC;
  return {
    code: error?.explainCode || base.code,
    message: base.message,
    why: base.why,
    impact: base.impact,
    action: base.action,
    details: String(error?.message ?? error ?? "").slice(0, 600),
    area,
    event,
    matched: Boolean(rule),
  };
}

// 写进 system log 的那一行。四段用换行分开，logs 页面才排得好看，
// grep 起来也还是一行一笔。
export function formatExplanation(explanation) {
  return [
    explanation.message,
    `为什么：${explanation.why}`,
    `影响：${explanation.impact}`,
    `处理：${explanation.action}`,
    explanation.details ? `原始讯息：${explanation.details}` : "",
  ].filter(Boolean).join("\n");
}

// 一步到位：把错误写成一笔说得清楚的 system log。
export async function logExplainedError(systemLogs, error, { area = "system", event = "error", level = "error", context = {} } = {}) {
  const explanation = explainError(error, { area, event });
  await systemLogs?.write?.({
    level,
    area,
    event: explanation.code,
    message: formatExplanation(explanation),
    context: { ...context, sourceEvent: event, matched: explanation.matched },
  }).catch(() => {});
  return explanation;
}
