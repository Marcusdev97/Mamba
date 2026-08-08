# MAMBA — 状态总览 & 剩余任务

> 更新: 2026-08-08。上一版停在 2026-07-06,期间发生的事都补在下面。
> 一句话现状: **两台电脑的资料已经合并到这台、备份机制建起来了;
> 但 Sales Brain 还没真正跑起来,而客户跟进有一个持续在漏人的破口。**

---

## 一、2026-08-07/08 这两天做完的事

### 跨机器资料合并(原本 1,176 位客户困在另一台)
- 那台 MacBook Air 的 `sender-a` 全部搬进本机 v3 运行库
- 客户 519 → **1,751** · 对话 874 → **2,113** · 讯息 7,514 → **16,726**
- 外键检查 ✓ 完整性检查 ✓ 孤儿讯息 0
- 工具: `scripts/maintenance/merge-remote-number.mjs`(dry-run 预设,自动备份)

### 修掉「代号当身份」这个结构性错误
- `wa_01` 这类 instance 代号是**每台机器自己的叫法**:那台的 wa_01 是 sender-a,
  这台的 wa_01 是 sender-b —— 8,775 条对话差点被归到错的号码底下
- ChatRoom 的分页筛选从「比对代号」改成「比对号码」
  ([conversation-log-service.mjs](campaign-app/lib/conversation-log-service.mjs) `inboxThreads`)
- 回填 6,166 条旧讯息的 `connection_key`(100% 解得出,0 条用猜的)
- 顺带并回 381 位客户被劈成两半的对话
- **原则: 号码是跨机器不变的身份,代号只是显示用的标签**

### Notion 归属章同步
- 1,176 页 Blast Leads 的 `Assigned Sender Key` / `Last Sender Key` /
  `Last Sent By Device` / `Sender Instance` 改成本机 —— 0 失败
- 工具: `scripts/maintenance/restamp-notion-ownership.mjs`(先存还原档才动手)

### 长期档案(按号码分,不按电脑分)
- `tools/archive-mamba.mjs` —— 导出 blast 记录 / 完整对话 / 客户资料成自解释 JSONL,
  按号码分目录、按月分片、每片带 sha256,外加整库加密快照
- 两台各存一份完整档案(2,207 blast · 17,126 对话 · 1,758 客户 · 28 分片校验全过)
- **deviceId 在导出时丢掉** —— 两台导到同一棵树会自然合并,不会打架
- ⚠️ **还没自动化** —— 今天的档案是今天的,明天就开始过期

### 客户画像(评估阶段,刻意不碰 schema)
- `tools/export-for-profiling.mjs` —— 导出有回过话、在 blast 名单里的客户 + 完整对话
- `docs/LEAD_PROFILING_PROMPT.md` —— 抽取指令(这份档案就是以后接 API 时直接用的 prompt)
- `tools/import-profiles.mjs` —— 校验 + merge 写进 `campaign-data/contact_profiles.json`
- 已完成 **23 份画像**,每个字段都要有客户原话,没有原话就留空
- `FOLLOWUP-2026-08-08.md` —— 26 位的跟进文案,照每个客户自己的语言写

---

## 二、这两天挖出来的问题(比工具重要)

### 🔴 Human Takeover 黑洞 —— 客户在这里持续流失
17 位真客户在等回覆,其中 **12 位卡在 `sequence_status = Human Takeover` 且
`follow_up_due` 是空的**。系统标了「需要人工处理」,然后:

- 没有安排任何跟进
- 没有自动送出客户点选的那份资料
- Flow 2–10 也停了

**5 位是直接回答了投票**(`Layout` / `Price package`)之后什么都没收到,已经 26–28 天。

> 这不是「忘记回复」,是**回路断了**。要查:投票被点之后,谁负责把资料送出去。

### 🟡 名单里 62% 不是客户
206 位「有回过话」的联络人里,**128 位从来不在 blast 名单**(`project_leads` 无记录)
—— 保险、牙医、同行、自动回复、自己的公司。

工作号同时是生活号,任何商家发讯息进来 `reply_count` 就 > 0,而且最后一句永远是他们说的。

**判准应该是「有没有在 blast 名单里」,不是「有没有讲过话」。**

### 🟡 Follow-up 工作台只知道「谁」,不知道「说什么」
工作台从 Notion 快取读,有回复且无跟进日期的客户会自动显示为「今天」——
那 23 位其实**已经在工作台里**。缺的是判断:为什么卡住、该说什么、先打谁。

快取有 `salesNotes` / `aiSummary` 栏位可以放,但目前是空的。

### 🟡 「own stay or investment?」是对话杀手
ZA · WONG · ALFRED TEO · Louis · TAN 五位,同一个死法:
**你答完他的问题 → 接一个 qualifying question → 静音 21–28 天。**

---

## 三、还没做(按急迫度)

### 1. 🔴 Repo 还是 Public
`github.com/Marcusdev97/Mamba` 未登入也读得到。
`campaign-data/` 与 `mamba-archive/` 已经 gitignore,但**这件事本身该处理**。
(旧版 T3 从 7 月就挂着没做)

### 2. 🔴 那台 MacBook Air 的 wa_05
两台同时连着 `sender-a`。已经手动处理,但**没有制度上的保证** ——
v4 的 `send_permission_guard` 还没接进运行路径。

### 3. 🟠 备份自动化
`tools/archive-mamba.mjs` 要挂 launchd 每晚跑。`launchd/` 有现成模式可抄。
**不做的话档案会慢慢过期,等于没有备份。**

### 4. 🟠 Sales Brain 还没真的跑起来
```
.env 钥匙      2/3            (缺一把)
brain_service  没在跑
ai_reply_log   0 笔
golden_conv    1 条           (目标 ≥20)
followup_log   0 笔
```
Phase 1 的端到端验收(客户发问 → Telegram 三按钮 → 人工批准 → 客户收到)
**从 7 月挂到现在没跑过**。

### 5. 🟠 Project Brain 知识库一个月没同步
`campaign-data/brain/meta.json` 停在 **2026-07-10**,25 条 facts 全是 Enlace 的。
Market Library 有 **132 个楼盘**(Property 213 API)但只有 **3 个进 Active Brain**。
→ 画像配对要用到市场库,先跑一次 Sync Brain。

### 6. 🟡 6 条卡住的 RUNNING campaign_runs
7 月 23–30 的记录,`sent_count = 1 / requested = 1` 但状态没结清。
`scripts/maintenance/reconcile-campaign-terminal-state.mjs` 可以清。

### 7. 🟡 Notion Sync 未启用
Health 显示 `MIGRATION_REQUIRED · schema migration 304 required · paused`。
本机 migration 停在 303。不急。

### 8. ⏸ Mac Mini 常驻(还没买机器)
### 9. 🟡 instance_identity 没有历史表
主键是 `instance_name`,一个代号只有一行 —— 只能回答「wa_01 现在是谁」,
永远回答不了「去年 12 月 wa_01 是谁」。要根治得加 append-only 历史表(走正规 migration)。

---

## 四、日常操作备忘

| 要做什么 | 命令 |
|---|---|
| 备份档案(按号码分) | `node tools/archive-mamba.mjs` |
| 看客户画像 | `node tools/import-profiles.mjs --list` |
| 导出客户给 AI 抽画像 | `node tools/export-for-profiling.mjs --number <号码> --limit 40` |
| 写回画像 | `node tools/import-profiles.mjs --file <档> --apply` |
| 合并另一台的号码 | `node scripts/maintenance/merge-remote-number.mjs --source <快照> --number <号码>` |
| 改 Notion 归属章 | `node scripts/maintenance/restamp-notion-ownership.mjs --number <号码>` |
| 起 brain(唯一回复出口) | `node campaign-app/brain_service.mjs` |
| 起 tracker 面板 | `node campaign-app/blaster_tracker.mjs --no-webhook` |
| 同步知识缓存 | Sync Brain.command 或 `node campaign-app/brain_cache_sync.mjs` |
| 同步 STOP 名单 | `node campaign-app/suppression.mjs` |
| 离线彩排 brain | `node campaign-app/brain_service.mjs --simulate "<客户消息>"` |

> 所有 `scripts/maintenance/` 与合并类工具**预设都是 dry-run**,要 `--apply` 才真的写,
> 而且写之前自动 `.backup`。这个惯例不要打破。

---

## 五、纪律

**原本的(不变)**
- Phase 1 复杂 route 绝不自动发,一律 Telegram 人工按钮
- AI 只引用 Verified fact,报不出就「check 了回你」
- 升级自动发送看数据: 照发率连续两周 ≥ 90%,不看日历
- 改 flow_sequence 的 regex 必跑 test_classifier
- 真号只在 .env,永不进 source

**这两天加的**
- **号码是身份,代号不是。** 任何跨机器的判断都用号码,不要用 `wa_0X`
- **档案按号码分,不按电脑分。** deviceId 是运行时的东西,不该进档案
- **评估阶段不碰 schema。** 新东西先写成档案,验证有价值再走正规 migration
- **抽出来的客户事实必须附原话。** 没有原话就留空 —— 抽错一个预算比留空糟得多
- **先证明,再自动化。** prompt 在真实客户身上验过,接 API 才安全
