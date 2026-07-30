# Mamba Architecture

> 状态：Current + Target · 更新日期：2026-07-28
>
> 本文件说明 Mamba 现在如何运行，以及新增代码应该往哪里放。
> 数据架构的正式决策见
> [`MAMBA_ARCHITECTURE_ADR.md`](MAMBA_ARCHITECTURE_ADR.md)，每种资料的唯一来源见
> [`DATA_OWNERSHIP.md`](DATA_OWNERSHIP.md)。

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

### 主要本机进程

| 组件 | 默认位置／端口 | 责任 |
|---|---|---|
| Mamba Server | `campaign-app/server.mjs`, `127.0.0.1:8787` | UI、API、Campaign 编排 |
| Evolution API | `127.0.0.1:8080` | WhatsApp 连接与消息收发 |
| Brain Service | `campaign-app/brain_service.mjs` | 入站理解、AI 草稿、Telegram 审批 |
| Phone View | `campaign-app/phone-view-server.mjs` | 本机手机查看入口 |
| SQLite | `campaign-data/mamba.sqlite` | 本机运行真相源 |

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

```text
Select Project / Lead Group
        ↓
Safety checks
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
- Campaign sender policy 只限制出站发送；Tracker／Brain 必须接收本机 Evolution
  上所有 OPEN instances 的入站 webhook，避免辅助号码回复遗失。
- 运行期间不得被维护任务重启、补发或改写状态。
- 状态不明确的 WhatsApp 请求不得自动重发。

## 7. 数据所有权

| 数据 | 权威来源 | 说明 |
|---|---|---|
| Campaign 运行结果 | SQLite | 每位客户发送后立即写入 |
| Sync jobs | SQLite | 幂等、重试、冲突状态 |
| Notion 展示资料 | Notion mirror | Campaign 完成后最终一致 |
| 人工维护的模板／Knowledge | Notion | 拉入本机缓存后供运行读取 |
| 当前 run state | `campaign-data/runs` + SQLite | 用于恢复和诊断 |
| TEST 收件人 | `.env` 的 `TEST_LEADS` | Settings 是编辑界面 |
| 私人联系人名单 | `campaign-data/work_inbox_ignore.json` | 本机工作 Inbox 边界，不等于 suppression |
| Secret | `evolution-pilot/.env` | 不进入 Git |

不要让同一种资料同时拥有两个可以互相覆盖的真相源。

私人联系人名单与 Telegram Filter、STOP／Suppression 是三个不同规则：

- Telegram Filter 只关闭 Telegram 通知，Tracker 与 Notion 行为不变。
- 私人联系人仍保留本机消息证据，但不进入 ChatRoom、Sales Brain、STOP 判断或
  Notion 客户回复同步。
- STOP／Suppression 才会阻止 Campaign 发送；把朋友加入私人联系人不会改变
  Campaign eligibility，也不会删除历史对话。

ChatRoom／Customer Desk 的人工 Quick Remark 属于操作员即时决定，不等待
Campaign 收尾：先写 SQLite，再把相同的 Status、Sequence、Next Action 与
Follow Up 状态直接镜像到 Notion。`Do Not Contact` 还必须在 Notion 请求前
写入本机全局 suppression；`Not Interested` 只停止该客户的自动 Flow，不等于
全局 STOP。若客户只有本机 Project Lead、尚无 Notion page，Quick Remark 仍须
安全写入 SQLite 并明确回报 `notionSynced: false`；不得因为缺少 Notion page 而
丢掉操作员的决定，也不得擅自建立 Notion 客户。

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
