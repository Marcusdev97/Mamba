# MAMBA — 状态总览 & 剩余任务

> 更新: 2026-07-06。取代旧的 MAMBA_GAPS_FOR_COWORK。
> 一句话现状: **Track B Phase 1 代码 100% 写完、测试全绿、知识库已灌注。
> 只差 .env 两把钥匙 + 一次端到端验收,就上线。**

---

## 一、已完成 ✅(不用再碰)

### 地基(之前就有)
- 出站 blast 系统(Track A)— production 级
- A1 全局 suppression(STOP 名单,三道闸门)
- B5 brain cache sync(Notion → 本地 JSON,Verified/Valid-Until 闸门)
- flow_sequence.mjs 12-route 分类器 — 35/35 测试通过

### 缺口 2 — Telegram 按钮 ✅(2026-07-05 完成)
- `telegram.mjs`: `sendWithButtons()` 三按钮、`answerCallback()`、
  `editMessageText()`、长轮询 `getUpdates()`
- 验收脚本: `node campaign-app/telegram_buttons_demo.mjs`

### 缺口 4 — 单一回复者 ✅(2026-07-05 完成)
- 方案: **brain 收全部**。brain service 是系统里唯一会回 WhatsApp 的模块
- tracker 降级为只记录统计,brain 自动转发数据给它,面板照常
- 共用解析抽成 `reply_intake.mjs`(含 poll 投票解析)

### 缺口 3 — Brain Service 本体 (B6) ✅(2026-07-05 完成)
- `brain_core.mjs`(纯决策逻辑)+ `brain_service.mjs`(主服务, port 8799)
- 数据流: webhook → suppression → 分类器 →
  - 简单 route(资料/地点/户型/不感兴趣/STOP)→ 罐头直接发
  - 复杂 route(价格/贷款/看房 = Sonnet,其他 = Haiku)→ AI 草稿 →
    Telegram 三按钮(✅照发 / ✏️改后发 / 🙋接管)→ 人批准才发
  - 投诉/情绪负面 → 静默 + Telegram 告警,强制人工
- STOP 自动回执 + Notion Stop Flag + 本地立即封锁
- 每个决定先写本地 `campaign-data/brain/reply_log.jsonl`,再 best-effort
  写 Notion「AI Reply Log」
- Guardrail: AI 只准用 Verified facts;报不出的数字一律「check 了回你」
- 离线彩排: `node campaign-app/brain_service.mjs --simulate "这个多少钱?"`

### 缺口 1 — 知识灌注 ✅(部分)
- Project Knowledge: **30 条 Enlace facts**(25 Verified ✓ / 5 待 PE ✗)
- Objection Bank: **20 条**(Cowork 起草,砍价/贷款/情绪负面已标 Handoff)
- 本地缓存已 sync: 25 facts + 20 objections ✓(2026-07-06)
- brain_cache_sync 已改逐库容错,一个库挂不拖死全部

### 测试纪律 ✅
6 个 offline 测试套件全绿:
classifier (35) / suppression / brain_cache / telegram_buttons /
reply_intake(含 poll)/ brain_core

---

## 二、还没做 🔴(按顺序做)

### 1. .env 补两把钥匙(5 分钟,只有你能做)🔑
- [ ] `ANTHROPIC_API_KEY` — console.anthropic.com 拿,手动加进
      `evolution-pilot/.env`
- [ ] 跑一次 **Setup Telegram** → 写入 `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`
- 没有这两样 brain 起不来。

### 2. 按钮小验收(2 分钟)
- [ ] `node campaign-app/telegram_buttons_demo.mjs`
- 过关标准: 手机收到三按钮消息,按下后终端打印你按了哪个。

### 3. 端到端一条龙验收(Phase 1 上线判定)🏁
- [ ] 起服务: `node campaign-app/brain_service.mjs`
      (tracker 同时跑的话用 `--no-webhook`)
- [ ] 用别的号发「这个多少钱?」给测试号
- [ ] Telegram 弹草稿 → 按 ✅ → 客户收到报价方向 → AI Reply Log 出一行
- **这条跑通 = Track B Phase 1 正式上线。**

### 4. Golden Conversations(不挡上线,持续补)
- [ ] 目前 0 条,目标 ≥20 段真实成功对话
- 你从 WhatsApp 翻出来贴给 Cowork,Cowork 整理入库
- [ ] 顺便: 5 条 ✗ 的 facts 等 PE 确认后勾 Verified

### 5. Mac Mini 常驻(⏸ 搁置 — 还没买机器)
- 脚本已备好: `launchd/install_launchd.sh`,机器到了跑一次装 4 个常驻服务
- 过渡期: 笔电开着跑 brain service 就行,合盖会停

### 6. Git 历史旧号码(🟡 可选)
- 保持 repo private 即可;要彻底清才用 git filter-repo

---

## 三、日常操作备忘

| 要做什么 | 命令 |
|---|---|
| 起 brain(唯一回复出口) | `node campaign-app/brain_service.mjs` |
| 起 tracker 面板 | `node campaign-app/blaster_tracker.mjs --no-webhook` |
| 同步知识缓存 | Sync Brain.command 或 `node campaign-app/brain_cache_sync.mjs` |
| 同步 STOP 名单 | `node campaign-app/suppression.mjs` |
| 离线彩排 brain | `node campaign-app/brain_service.mjs --simulate "<客户消息>"` |
| 跑全部测试 | `node campaign-app/test_*.mjs` 逐个跑 |

## 四、纪律(不变)
- Phase 1 复杂 route 绝不自动发,一律 Telegram 人工按钮
- AI 只引用 Verified fact,报不出就「check 了回你」
- 升级自动发送看数据: 照发率连续两周 ≥ 90%,不看日历
- 改 flow_sequence 的 regex 必跑 test_classifier
- 真号只在 .env,永不进 source
