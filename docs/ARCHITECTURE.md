# Mamba Architecture

> 状态：Current + Target · 更新日期：2026-08-08
>
> 本文件说明 Mamba 现在如何运行，以及新增代码应该往哪里放。
> 数据架构的正式决策见
> [`MAMBA_ARCHITECTURE_ADR.md`](MAMBA_ARCHITECTURE_ADR.md)，每种资料的唯一来源见
> [`DATA_OWNERSHIP.md`](DATA_OWNERSHIP.md)。现有客户资料的旁路整理、SQL 修复、
> 工具与 cutover 原则见 [`CUSTOMER_DATABASE_REBUILD.md`](CUSTOMER_DATABASE_REBUILD.md)。

## 1. 系统目标

Mamba 是一套本机优先的房产销售系统，主要负责：

- WhatsApp Campaign 的 TEST、LIVE、Flow 与补发
- 客户回复追踪、STOP／Suppression 和人工接管
- SQLite 本机运行账本
- Campaign 完成后的 Notion 同步
- Telegram 通知与 AI 草稿批准
- Project Knowledge、Template 与图片资产管理

最高优先级依次是：

1. 不误发给错误收件人。
2. 不重复发送状态不明确的消息。
3. 运行资料先安全落地本机。
4. 外部系统失败不能破坏本机事实。
5. 代码结构必须让下一位维护者找得到入口。

## 2. 运行组件

```text
Browser / Mamba.app
        │ HTTP :8787
        ▼
campaign-app/server.mjs
        │
        ├── app/createApp.mjs ── routes/*
        ├── campaign_core.mjs / flow_sequence.mjs
        ├── lib/* services
        ├── campaign-data/mamba.sqlite
        └── integrations
             ├── Evolution API ── WhatsApp
             ├── Notion
             ├── Telegram
             ├── OpenAI / Gemini / Anthropic
             └── Cloudflare R2
```

本机 UI 的 HTML 与 `/assets` bundle 在 Server 启动时建立同一份静态快照。
运行中修改磁盘代码不会让旧 API router 配上新版 UI；新版本必须在没有 LIVE
Campaign 运行时重启后一起生效。Campaign 图片等业务资料仍按请求读取。

### Campaign Center UI shell

`campaign-app/send.html` 只负责发送台的工作区导航与共同状态展示。页面结构保持
单一标题区，右侧只保留一个 Campaign planning 入口：

- 独立 `/campaigns` Campaign Planning 页面已移除；旧网址转向 `/send`。操作员只从
  Campaign Center 规划和执行 Campaign，底层 migration 308 model 继续承担资料与归因。

- Flow 1 与 Flow 2–10 是同一个 Campaign planning workspace 内的两种安排类型；
  顶层不得再为两个 Flow 建立独立 page control。现有 iframe 保持存活，内部切换
  不会重建表单，embedded 页面不得重复自己的标题和导航。
- Multi-sender 是 Campaign Center 的平级工具。Refresh Customers 属于 Customers
  Sidebar，并使用独立 `/refresh` 页面；不得在 Campaign Center 再建立 Refresh tab
  或嵌入第二份 Refresh iframe。
- Monitor 是独立视图，集中显示 Campaign、SQLite、Notion outbox、sender queue，
  以及实际 run 的继续发送、异常重试、导出、时间线与逐位客户结果。
- Flow 1 与 Flow 2–10 的 setup 只选择客户、时间、sender 与模板；embedded setup
  不得显示运行日志或恢复控件。Monitor detail 按稳定 `runId` 使用同一套 status／
  resume／retry API，并从 run state 的 `flowLabel`／`templateFlow` 显示真实 Flow。
- 通用 monitor renderer 使用 `console.html` 的明确 view mode；setup 不得复制进度
  逻辑，Monitor 也不得复制发送规则。
- `READY`／`PREPARED` 只代表预览，不是正在执行的 Campaign。Monitor 没有运行中、
  排队中或可恢复 run 时必须隐藏详细执行区，不得显示 0% 假进度或空 Batch 卡。
- Monitor 的“隐藏全部”只是浏览器显示过滤，不改变 Campaign／Queue／Notion。
  “取消并清理全部”必须明确二次确认，只处理当时 UI 列出的 runId：先移除
  Queue，再把未结束 run 持久化为 `CANCELLED`，最后从 active monitor 移除。
  `campaign-data/runs/` 发送审计档、SQLite 证据和防重发资料不得删除。
- 发送模式入口保持在 shell 顶部，并按 sender 保存节奏；真正的 interval validation
  和 Campaign snapshot 仍由后端 service 负责。

UI shell 不得复制 eligibility、suppression、resume 或 sync 规则。Monitor 只读取状态
并触发已有的明确操作，不可以成为 Campaign 状态的事实来源。

### 主要本机进程

| 组件 | 默认位置／端口 | 责任 |
|---|---|---|
| Mamba Server | `campaign-app/server.mjs`, `127.0.0.1:8787` | UI、API、Campaign 编排 |
| Evolution API | `127.0.0.1:8080` | WhatsApp 连接与消息收发 |
| Brain Service | `campaign-app/brain_service.mjs` | 入站理解、AI 草稿、Telegram 审批 |
| Phone View | `campaign-app/phone-view-server.mjs` | 本机手机查看入口 |
| SQLite | `campaign-data/mamba.sqlite` | 本机运行真相源 |

Mamba 不再维护 SQLite → Global PostgreSQL 的跨机汇总层。跨设备业务可见性由
Notion CRM 承担；Evolution API 自己的 PostgreSQL 仅保存 provider 内部资料，
不属于 Mamba 的业务数据库或 reporting source。

## 3. 当前代码结构

Mamba 正在从大型入口文件逐步迁移到模块化结构。当前真实结构是：

```text
campaign-app/
├── server.mjs             # 当前 composition root；仍有部分 legacy orchestration
├── app/
│   ├── createApp.mjs      # 注册 routes 和统一 HTTP dispatch
│   ├── loadRuntime.mjs    # 建立 runtime
│   └── state.mjs          # 最小 app state
├── routes/                # HTTP endpoints
├── lib/                   # services、repositories、integration wrappers 的过渡目录
├── campaign_core.mjs      # Campaign 核心与 Evolution client
├── flow_sequence.mjs      # Flow 顺序和回复分类规则
├── brain_core.mjs         # Brain 的纯规则
├── brain_service.mjs      # Brain 独立运行服务
├── *.html / assets/       # 本机 UI
└── test_*.mjs             # 当前测试套件

campaign-data/
├── mamba.sqlite           # 不进入 Git
├── runs/                  # Campaign run state
├── brain/                 # Brain pending、archive、cache
├── logs/                  # 本机运行日志
└── maintenance-archive/   # 可恢复的维护归档；不进入 Git

evolution-pilot/
├── .env                   # Secret 与本机配置，不进入 Git
└── .env.example           # 空值／无效示例，可进入 Git

scripts/
└── maintenance/           # 默认 dry-run 的维护工具
```

`services/`、`domain/`、`integrations/`、`repositories/` 和 `jobs/` 是目标边界，
不是要求现在一次性搬迁全部旧文件。修改旧功能时逐步从 `server.mjs` 或大型
route 提取，禁止只为了目录好看进行大规模移动。

## 4. 目标依赖方向

```text
UI / HTTP
    ↓
Routes
    ↓
Application Services
    ↓
Domain Rules

Application Services
    ├── Repositories ── SQLite / files
    └── Integration Adapters ── external APIs
```

约束：

- Route 负责输入验证、权限／安全闸门和 HTTP response。
- Service 负责一个完整 use case，例如 prepare、start、complete、sync。
- Domain 负责纯判断，例如 suppression、resend guard、flow transition。
- Repository 负责本机数据读写。
- Integration adapter 负责外部协议、timeout、重试分类和 response mapping。
- Domain 不得 import HTTP、filesystem、`.env`、SQLite 或第三方 API。
- 外部 API response 不得成为内部 domain model。

## 5. Campaign 生命周期

### Campaign planning model（migration 308）

Campaign 与 Run 已分离：`campaigns` 保存销售活动计划，`campaign_steps` 表示 Flow／人工动作，
`campaign_members` 保存每位客户在该 Campaign 内的 pause／exit 生命周期，`campaign_runs`
只代表一次 TEST／LIVE 执行，`send_jobs` 仍是最小发送证据，`campaign_outcomes` 保存可审计归因。
同一 Campaign 可以执行多次 Run；TEST Run 不读取 LIVE Members。第一阶段只把旧 Flow 1–10
投影到新模型，不改变实际发送、Scheduler 或恢复行为。完整规则见
[`CAMPAIGN_MODEL.md`](CAMPAIGN_MODEL.md)。

```text
Select Project / Lead Group
        ↓
Safety checks
  ├── suppression / resend guard
  ├── Consent evidence
  ├── cross-Campaign contact budget
  └── Sender Health circuit breaker
        ↓
Prepare preview
        ↓
TEST or LIVE confirmation
        ↓
Send through Evolution
        ↓
Campaign acquires macOS idle-sleep guard
        ↓
Commit each recipient result to SQLite
        ↓
Campaign reaches terminal state
        ↓
Notion outbox becomes eligible
        ↓
Final Notion Sync
```

Campaign 的 terminal state 包括正常完成，以及经过明确处理的停止／中断状态。
当 Campaign 仍在发送时，Notion outbox job 必须保持 `PENDING`／deferred，
不能将部分状态当成最终同步。

macOS 上，Campaign 从真正进入 `RUNNING` 到 terminal state 期间会持有
`caffeinate` idle-sleep lease；多条 sender lane 共用一个进程并按 runId
reference count。这个 lease 只能避免闲置睡眠，不能绕过 MacBook 合盖睡眠。
Transport Guard 每 15 秒分别检查 Docker daemon、Evolution API 和本批实际 sender
instance；连续两次异常会把 run 标为 `INTERRUPTED`。恢复连接后仍必须由操作员
人工继续，系统不得自动重连号码或恢复发送。

P0 Campaign Safety 由 `domain/campaign-safety.mjs` 保存纯判断，
`lib/campaign-safety-service.mjs` 编排 SQLite、conversation ledger 与 Evolution
instance 资料，`routes/campaign-safety.routes.mjs` 只提供验证过的设置入口。
它会在新 LIVE、sender lane、Queue 接力、Resume 与 Retry 真正发送前重新检查。
已经建立的 run snapshot、已发送 Part 和 SQLite 回执不会被 migration 改写。

### Refresh Campaign（RECYCLE）

Refresh 是与 Flow 1–10 分开的手动 Campaign：

```text
Force-refresh Notion mirror
  → domain eligibility（STOP / reply / follow-up / private / cooldown）
  → create device-scoped local lead group
  → dedicated Refresh template preview
  → start-time eligibility recheck + LIVE recipient-risk token
  → per-recipient SQLite checkpoint
  → deferred Notion evidence-only sync
```

资格规则唯一来源是
`campaign-app/domain/refresh-campaign-eligibility.mjs`，编排位于
`campaign-app/lib/refresh-campaign-service.mjs`。Route 和 UI 不得复制规则。

Refresh 的不变量：

- `campaignType = RECYCLE`，模板必须是 `Refresh - Reconnect`。
- 不由 Flow 2–10 Scheduler 自动建立或启动。
- Notion／suppression／本机活动读取失败时 fail closed。
- SQLite checkpoint 只更新发送证据、最后发送时间与 sender ownership。
- 不得修改 `Last Flow Sent`、`Next Flow`、`Sequence Status` 或 `Follow Up Due`。
- 开始 LIVE 前必须重新跑 eligibility；预览 token 不一致就要求重新建批次。

## 6. TEST 与 LIVE

TEST 与 LIVE 使用同一套 Campaign engine，差异只在收件人来源和安全确认。

### TEST

- 唯一收件人来源是 Settings 写入 `.env` 的 `TEST_LEADS`。
- 没有配置时 fail closed。
- API request 不得临时覆盖 TEST 名单。
- 不得在源码或 `.env.example` 放入可发送的默认真人号码。

### LIVE

- 名单必须来自明确的 Project 和 Lead Group。
- 必须确认 opt-in。
- 发送前必须经过 suppression、resend guard 和 sender ownership。
- Campaign Automations 的 LIVE 必须由操作员明确 arm；旧版仅展示的 LIVE
  配置不得在升级后自动取得真实发送权限。
- Scheduler 只接手已经进入 Sequence 的 Flow 2–10；Flow 1 新客户首次接触
  仍必须由操作员选择 Project／Lead Group 并亲自启动。
- Scheduler 不在当前批运行时预建下一批。当前批完整落地 SQLite 后，值班 tick
  才重新读取到期名单、执行深度回复检查并自动启动下一批，避免同一批客户被重复选中。
- LIVE 值班窗口为 10:00–21:00；安全闸门未通过时保持 HOLD，五分钟后再检查，
  不绕过 Tracker、Queue、sender ownership 或回复安全规则。
- 人工 LIVE 发送在最终启动前必须显示收件人风险确认：本批人数、本机已连接号码、
  Settings 私人联系人，以及 SQLite 中任何历史 Blast 记录。确认 token 绑定当前
  run 与实际未跳过的 recipient IDs；名单或风险资料改变后旧 token 立即失效。
- 同一个确认 token 还绑定 Consent 与跨 Campaign 联系预算结果。`REVOKED` 永远
  `BLOCK`；旧客户缺少 Consent 证据初次上线默认 `WARN`，操作员完成 evidence
  backfill 后才可在 Settings 切到 `ENFORCE`。联系预算默认 7 天 2 批、30 天 5 批、
  连续 3 批未回复即警告；切到 `ENFORCE` 后由后端阻止，前端确认不能绕过。
- Sender Health 只使用含真实 `deliveryStatus` 的新出站证据。历史消息没有投递状态
  不算失败或 `UNKNOWN`，不得因为上线新规则而误暂停号码。达到连续失败或比例阈值时
  sender 写入 `PAUSED`，Queue 保持 HOLD；人工检查 WhatsApp 与 provider 后才可恢复。
- Campaign sender policy 只限制出站发送；Tracker／Brain 必须接收本机 Evolution
  上所有 OPEN instances 的入站 webhook，避免辅助号码回复遗失。
- 运行期间不得被维护任务重启、补发或改写状态。
- 状态不明确的 WhatsApp 请求不得自动重发。
- 同一个 `runId` 在单一 Server process 内只能持有一份 execution lease。即使
  Suppression refresh 或 transport check 尚未完成，第二次 Start／Resume 也只能
  等待原任务，不能建立另一条发送执行链。
- 每个 Part 在 run recovery state 保存稳定 `sendKey` 与 attempt history。
  `DISPATCHING`／`UNKNOWN` 没有操作员明确确认时不得再次调用 Evolution。
- 每个 sender 的发送节奏由 `campaign-mode-service.mjs` 单一管理并保存在本机。
  自定义客户 gap 只能是 30–3600 的完整秒数，且 `max >= min`；API request 不得
  临时覆盖已保存的 sender 设置。独立 sender lane 各自使用自己的节奏；旧式多
  sender 共用一个 queue 时采用所有已选号码中最慢的安全边界。
- 节奏在 Campaign prepare 时冻结进 run config。修改设置只影响之后建立的批次，
  不得在运行中重算时间或改变已经排好的 `scheduledAt`。
- 电脑休眠、关机或断线后的 LIVE run 不得自动续发。操作员明确按「继续发送」后，
  系统才为尚未完成的客户建立从当前时间开始的 recovery window；旧 `startAt/endAt`
  保存在 `resumeSession` 供审计，已完成或状态不明确的 Part 不得因此重发。
- Custom gap 是当前客户全部 Part 完成后到下一位开始前的随机等待范围。明确指定的
  fixed window 或 transport delay 可以令实际间隔更长，但任何 schedule calculation
  都不得为了赶上结束时间而把间隔压到配置下限以下。

## 7. 数据所有权

| 数据 | 权威来源 | 说明 |
|---|---|---|
| Campaign 运行结果 | SQLite | 每位客户发送后立即写入 |
| Sync jobs | SQLite | 幂等、重试、冲突状态 |
| Customer identity | SQLite `customers` + `customer_identities` | `customer_id` 稳定；phone／JID／LID 是 aliases |
| Notion 展示资料 | Notion mirror | Campaign 完成后最终一致 |
| 人工维护的模板／Knowledge | Notion | 拉入本机缓存后供运行读取 |
| 当前 run state | `campaign-data/runs` + SQLite | 用于恢复和诊断 |
| TEST 收件人 | `.env` 的 `TEST_LEADS` | Settings 是编辑界面 |
| 私人联系人名单 | `campaign-data/work_inbox_ignore.json` | 本机工作 Inbox 边界，不等于 suppression |
| Consent evidence | SQLite `contact_permission_events` | Append-only；Grant／Revoke 不覆盖历史 |
| Sender safety state | SQLite `sender_safety_state` | 熔断与人工恢复状态 |
| Campaign safety audit | SQLite `campaign_safety_checks` | 每次 preflight 的 ALLOW／WARN／BLOCK 证据 |
| P0 safety policy | `campaign-data/campaign_safety_policy.json` | Settings 编辑；不进入 Git |
| Watchdog 通知时间 | `evolution-pilot/.env` 的 `MAMBA_WATCHDOG_*` | Settings 编辑；Watchdog 每轮动态重读 |
| Secret | `evolution-pilot/.env` | 不进入 Git |

不要让同一种资料同时拥有两个可以互相覆盖的真相源。

Notion CRM v1 使用 Customers、Project Leads、Follow-up Tasks、Sales Opportunities、
Campaigns、Campaign Runs、Conversation Summaries 和 AI Lead Reviews 八个固定 database。
字段所有权、relations、稳定 ID、privacy denylist 与 provisioning 流程见
[`NOTION_CRM_V1.md`](NOTION_CRM_V1.md)。Legacy Blast／Ads／Recycle databases 在迁移期
保持独立，CRM provisioner 不得覆盖它们的配置或把原始 message ledger 搬进 Notion。

SQLite ↔ Notion CRM 同步由 migration 304 的 `notion_entity_map`、`sync_inbox`、
`sync_conflicts` 与 `sync_audit_events` 支撑，并复用既有 `sync_jobs` outbox。同步 worker
每 20 分钟扫描 SQLite row version；push 与 pull 都使用稳定 idempotency key。人工字段
采用字段级三方合并，SQLite 与 Notion 同时修改同一字段时进入 `CONFLICT`，不得以整行
last-write-wins 覆盖。原始 messages、conversation payload、secret 与 recovery state 永不
进入 Notion。Dashboard 位于 `/notion-sync`；migration 304 应用后仍默认 paused，必须由
操作员明确恢复。

Customer Identity 由 migration 305 的 `customers`、`customer_identities`、
`identity_conflicts`、`identity_unresolved_events` 与 `customer_merge_events` 支撑。
Conversation／message／project lead 与 Notion Customer mapping 都引用稳定 `customer_id`；
display name 永远不是 identity evidence，同一 LID 指向两个 customer 时必须暂停归档并由
Settings 的 `Advanced Data Maintenance` 人工处理。Customer Search 仍是日常客户查找的唯一
入口；Identity API 与 repository 继续作为后台安全层。完整规则见
[`CUSTOMER_IDENTITY.md`](CUSTOMER_IDENTITY.md)。

### SQLite 启动与安全状态

SQLite 启动顺序固定为：确认数据库文件 → `quick_check`／foreign key 检查 →
核对 schema v3 与 runtime patch → 执行有编号的 pending migration → 审计必要索引 →
写入健康状态 → `READY`。Migration 303 会先用 SQLite online backup 建立备份，另写
包含 SHA-256、大小、原因和验证结果的 manifest；已应用 migration 的 checksum
不得改变。

Migration 304 使用独立的 default dry-run maintenance，并同时检查 run JSON 与
`campaign_runs` ledger；任一活动／发送中 Campaign 都会阻止 apply。

Migration 305 同样是独立 default dry-run maintenance，要求 304 已应用；它还会在建立
`(connection_key, external_message_id)` 唯一索引前检查历史重复，并在 apply 前建立 backup。

`metadata.database_id` 是数据库稳定身份，重启或重复 initialize 不得重建。Settings
显示 database ID、最后健康检查、最后备份、WAL 和索引状态。任何 migration、checksum、
`quick_check`、foreign key 或必要索引失败都会进入 safe mode；诊断与备份仍可使用，
但 LIVE start／resume／retry／queue relay／sender lane 全部 fail closed。只有
`health=ready` 且 `storage_mode=primary` 时才开放 LIVE；TEST 不依赖这条 recipient source。

`messages` 的业务幂等键由 connection scope 与 Evolution external message id 组成，
相同 provider message id 出现在不同 sender connection 时必须保存为两份不同证据。

Tracker 以 Evolution webhook 作为实时消息入口。每个新的 Tracker session ready 后，
Server 会触发一次 24 小时、最多 3 页的 bounded catch-up，把监听器离线期间的缺口按
相同 message id 幂等补进 SQLite；它不轮询、不发送，也不取代 Settings 中可人工启动的
完整 History Sync。catch-up 失败只记录明确的 System Log，不得令实时 Tracker 下线。

私人联系人名单与 Telegram Filter、STOP／Suppression 是三个不同规则：

- Telegram Filter 只关闭 Telegram 通知，Tracker 与 Notion 行为不变。
- 私人联系人仍保留本机消息证据，但不进入 ChatRoom、Sales Brain、STOP 判断或
  Notion 客户回复同步。
- 一般 Flow Campaign 由统一 Send Eligibility 的 identity、STOP、reply、snooze、
  appointment／booking、membership、duplicate、connection 与 schedule 规则决定；
  把朋友加入私人联系人不会删除历史对话或加入全局 STOP。Refresh Campaign 额外把
  私人联系人当成本批排除项，避免旧客重联误发给朋友／家人。

ChatRoom／Customer Desk 的人工 Quick Remark 属于操作员即时决定，不等待
Campaign 收尾：先写 SQLite，再把相同的 Status、Sequence、Next Action 与
Follow Up 状态直接镜像到 Notion。`Do Not Contact` 还必须在 Notion 请求前
写入本机全局 suppression；`Not Interested` 只停止该客户的自动 Flow，不等于
全局 STOP。若客户只有本机 Project Lead、尚无 Notion page，Quick Remark 仍须
安全写入 SQLite 并明确回报 `notionSynced: false`；不得因为缺少 Notion page 而
丢掉操作员的决定，也不得擅自建立 Notion 客户。

业务员从手机 WhatsApp 完成 Follow-up 时，Evolution 的即时 webhook 会先把真实
出站消息写入 SQLite。若断网导致 webhook 漏失，定时 reconciliation 必须用稳定的
Evolution message id 补写同一份 conversation ledger，再把 Notion `Follow Up At`
安排到下一天 10:00（Asia/Kuala_Lumpur）。ChatRoom 的最后联系时间只读取 SQLite，
不得用计划时间伪造一条已发送消息；SQLite 补写失败时也不得先推进 Notion 提醒。
Reconciliation 以客户最后回复和本次 Follow-up 到期时间为证据边界，不以午夜为
边界，因此断线跨日仍能补回，同时已经推进后的提醒不会重复采用同一条旧消息。

ChatRoom 也允许操作员为通话后的号码建立 manual customer。操作员必须先选择
当前 WhatsApp sender，再选择客户来源：

- `Blasting Leads`：先写 SQLite，再即时镜像到 Blast Leads；必须选择 Project。
- `Recycle Leads`：先写 SQLite，再即时镜像到 Recycle Leads。
- `Ads Leads`：先写 SQLite，再即时镜像到 Ads Leads。
- `Others`（底层兼容 key 为 `OWN`）：只写 SQLite，保留在 ChatRoom，不进入
  Notion、自动 Flow 或 Campaign；作为人工新增号码的默认类型。

四种来源都会记录稳定的 contact key、所选 sender connection key、来源和备注，
但建立动作本身不发送消息，也不会自动加入当前或未来 Campaign。第一次人工发送
成功后才写入消息账本并显示为正常 conversation。新号码仍必须经过号码格式、
OPEN sender 与全局 suppression 检查；Notion 失败不得回滚已经建立的本机客户，
而应把 `lead_origins.notion_sync_status` 标成 `FAILED` 并显示可补同步的警告。

现有未分类联系人不得在 LIVE 运行时直接批量改写。Maintenance 必须先 dry-run，并排除
活动 Campaign、STOP、私人联系人、无效号码和已有 Lead 来源，确认后才可归入 Others。

## 8. 状态与失败原则

### Sales Stage 与 Follow-up（Migration 307）

销售状态的唯一规则位于 `domain/sales-pipeline.mjs`，由
`lib/sales-pipeline-service.mjs` 编排，SQLite 写入集中在
`lib/sales-pipeline-repository.mjs`。`project_leads.sales_stage` 与 `temperature`
是两个不同维度；导入号码和首次发送不会自动建立 `sales_opportunities`。

`jobs/sales-followup-job.mjs` 每五分钟只从 SQLite evidence 幂等建立或调整
`customer_follow_up_tasks`，不会自动联系客户。Stage 回退必须说明原因、Lost 必须有
Lost Reason、Won 不由一般编辑流程重新打开。所有 profile、stage、task 与 commission
改变写入 append-only `sales_activities`。完整规则见 [`SALES_PIPELINE.md`](SALES_PIPELINE.md)。

### 统一发送许可（Migration 306）

所有 WhatsApp 发送入口最终必须调用 `lib/send-eligibility-service.mjs`。纯规则只存在于
`domain/send-eligibility.mjs`；SQLite snapshot、审计、STOP propagation 和原子 customer
lock 由 `lib/send-eligibility-repository.mjs` 负责。固定顺序是 check → acquire lock →
re-check → record dispatch → provider → record result → release。Route、UI、Notion View、
Queue 和 AI draft 只可请求或显示决定，不可覆盖决定。

Customer lock 以稳定 `customer_id` 为优先 key；TEST fixture 或尚未建立 CRM row 的安全预览
使用不可逆 recipient digest。不同 sender／campaign 仍不能同时取得同一 customer 的 lock。
完整状态、入口与 migration 说明见 [`SEND_ELIGIBILITY.md`](SEND_ELIGIBILITY.md)。

### Action Dashboard 与 AI Auditor（Migration 309）

Dashboard 的 operational metrics 只读取 SQLite。候选判断、隐私清理、cache key 与 AI output
validation 位于 `domain/lead-auditor.mjs`；业务编排与资料存取分别位于专属 service／repository。
AI 是 advisory sidecar，没有发送、STOP、stage、booking、merge、delete 或 commission mutation
dependency。页面使用共享 `assets/mamba.css`；migration 308／309 未完成时只显示
`Setup Required`，不得把缺表或 SQL 错误原文显示给操作员。完整边界见
[`DASHBOARD_AI_AUDITOR.md`](DASHBOARD_AI_AUDITOR.md)。

### AI Change Tracking（Migration 310）

AI change Task Contract 与 step／file／test／event evidence 存在 SQLite。纯 scope／protected path／
review rules 位于 `domain/ai-change-tracking.mjs`；Git inspector 只读 branch、HEAD 与 diff，不执行
commit、merge 或 rollback。完整流程见 [`AI_CHANGE_TRACKING.md`](AI_CHANGE_TRACKING.md)。

- 所有外部写入必须可重试或明确标记不可重试。
- Sync 使用稳定 idempotency key。
- Retry 必须有上限和 backoff。
- 字段语义冲突进入 `RETRY`／`CONFLICT`／人工处理，不可静默覆盖。
- Maintenance script 默认只报告；修改资料必须显式 `--apply`。
- 清理历史资料应先归档，再从活动集合移除。
- Runtime Folder 的保留与整理边界见
  [`RUNTIME_DATA_RETENTION.md`](RUNTIME_DATA_RETENTION.md)。
- Project Assets 的重复内容、缺失引用与 legacy config 先使用
  `scripts/maintenance/audit-campaign-assets.mjs` 审计，不在运行中自动合并。

## 9. 新功能放置决策

| 新内容 | 应放位置 |
|---|---|
| 新 HTTP endpoint | `routes/<feature>.routes.mjs` |
| 新业务流程 | 新 service，过渡期可放 `lib/<feature>-service.mjs` |
| 纯业务判断 | domain module；过渡期放明确命名的 core module |
| SQLite 查询／写入 | repository；过渡期放专属 `*-service.mjs` |
| 第三方 API | integration adapter；过渡期复用现有统一 service |
| 定时任务 | job／worker，不放在 route |
| 一次性修复 | `scripts/maintenance/`，默认 dry-run |
| UI | 对应 `.html` 与 `assets/`，后端仍是规则权威来源 |
| 架构决定 | `docs/` 的 ADR，不藏在 comment |

## 10. 已知结构债务

这些是逐步改善项目，不是每次任务都要顺手重构：

- `server.mjs` 仍然承担过多 service wiring 和 legacy orchestration。
- `lib/` 同时包含 service、repository 和 integration wrapper。
- 部分 legacy CLI 各自实现 Notion 请求。
- 少数大型 route 仍直接调用已注入的 Notion client。
- 测试仍以 `test_*.mjs` 平铺在 `campaign-app/`。
- `.env` 读取仍同时存在 `env` object 与 `process.env` 两种入口。

处理这些问题时应使用小型、可验证的迁移，不做一次性“大重写”。

## 11. 修改架构文档的规则

- 当前行为改变时，同一个 commit 更新本文。
- 新的不可逆技术决定使用 ADR。
- 文档必须区分“当前已经实现”与“目标结构”。
- 不得为了让文档看起来正确而声称尚未实现的模块已经存在。
