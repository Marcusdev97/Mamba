# Mamba — Local-first WhatsApp Sales Operations

Mamba 是一套为房产销售流程设计的本机优先系统。它把 WhatsApp Campaign、多轮
Flow、客户回复、人工 Follow-up、AI 建议、SQLite 运行账本与 Notion 业务面板整合
在同一个 Control Center。

Mamba 不只是“批量发送工具”。它的核心目标是：

1. 不发给错误的人。
2. 不重复发送状态不明确的消息。
3. 每条发送与客户操作先安全保存在本机。
4. Notion、Telegram 或 AI 暂时不可用时，不破坏 Campaign 事实。
5. 自动化必须有明确的人工开关、STOP 规则和恢复路径。

> 本仓库不应包含 `.env`、API Key、WhatsApp session、客户名单、电话、对话、
> SQLite 主库或运行日志。真实资料只留在本机，并由 `.gitignore` 隔离。

---

## 1. 系统目前可以做什么

| 模块 | 主要能力 |
|---|---|
| Control Center | 查看今日发送、回复、Follow-up、AI 待审核、系统健康与当前 Campaign |
| Campaign Center | 同一个 Campaign 工作区内安排 Flow 1 与 Flow 2–10；另有 Multi-sender 与独立发送监控视图 |
| Multi-sender | 同一台电脑管理多个 OPEN WhatsApp sender，并保留客户原 sender 归属 |
| Refresh Customers | 从 Customers Sidebar 检查长期未回复的旧客并建立安全重联名单 |
| Scheduler | 在已明确 arm 的情况下，自动处理进入 Sequence 的 Flow 2–10 |
| Customer Inbox | 汇总客户回复、待处理状态与人工工作队列 |
| Chat Room | 查看文字、图片、影片，人工发消息，建立 Follow-up 与 Quick Remark |
| Manual Leads | 从 ChatRoom 建立 Blasting、Recycle、Ads 或 Others 客户 |
| Templates & Flows | 管理项目话术、多 Part、语言、图片与 Flow 顺序 |
| Sales Brain | 规则／AI 判断客户意图，产生建议草稿，复杂回复交由人工批准 |
| Notion Sync | Campaign 完成后，把 SQLite outbox 幂等同步到 Notion |
| Telegram Ops | 高价值通知、人工批准与异常提醒；持续健康时不发送 Watchdog 心跳 |
| System Health | 分开检查 Docker、Evolution API 与实际 WhatsApp instance |
| Project Brain | 项目 Knowledge、Golden Conversations、Objection 与学习资料 |
| Local Database | 客户、对话、发送证据、Flow、Follow-up、Campaign 与 Sync 的本机账本 |

---

## 2. 核心架构

```text
Browser / Mamba.app
        │ HTTP :8787
        ▼
campaign-app/server.mjs
        │
        ├── app/ + routes/            HTTP 与 runtime 组装
        ├── lib/                      业务 service、repository、adapter（过渡结构）
        ├── campaign_core.mjs         Campaign engine
        ├── flow_sequence.mjs         Flow 与回复规则的单一来源
        │
        ├── SQLite                    本机运行事实
        │     ├── contacts / project_leads
        │     ├── conversations / messages
        │     ├── campaign_runs / send_jobs
        │     └── sync_jobs
        │
        └── External integrations
              ├── Evolution API :8080 ── WhatsApp
              ├── Notion
              ├── Telegram
              ├── OpenAI / Gemini / Anthropic
              └── Cloudflare R2
```

依赖方向：

```text
Routes
  ↓
Application Services
  ↓
Domain Rules

Services
  ├── Repositories ── SQLite / controlled files
  └── Integrations ── Evolution / Notion / Telegram / AI / R2
```

当前仓库正在从大型 legacy 文件逐步迁移到这个边界。`server.mjs` 与 `lib/` 仍有
过渡职责；新增功能应放入正确模块，但不要为了目录外观一次性搬迁全部旧代码。

Mamba 不使用 Global PostgreSQL 汇总层；跨设备可见的业务资料通过受控 Notion sync
处理。`evolution-pilot` 内的 PostgreSQL 只属于 Evolution API 的内部储存，不保存
Mamba 的客户、Campaign 或发送账本，不能与已经退役的 Global 汇总层混为一谈。

详细设计：

- [Architecture](docs/ARCHITECTURE.md)
- [Integrations](docs/INTEGRATIONS.md)
- [Data Ownership](docs/DATA_OWNERSHIP.md)
- [Architecture ADR](docs/MAMBA_ARCHITECTURE_ADR.md)
- [Engineering Instructions](AGENTS.md)

---

## 3. Campaign 与 Flow

默认自动序列只有一份来源：`campaign-app/flow_sequence.mjs`。

```text
Flow 1 Project Template
  → Flow 2 Layout
  → Flow 3 Location
  → Flow 4 Package
  → Flow 6 Price
  → Flow 7 Facilities
  → Flow 8 Invitation
  → Flow 10 Surrounding
  → Completed
```

Flow 5（Furnished）与 Flow 9（Rental）是条件型模板，不属于默认自动序列。

### Refresh Campaign

`③ Refresh · 旧客重联` 是独立的 `RECYCLE` Campaign，不属于 Flow 1–10
Scheduler。它会强制刷新 Notion，并排除 STOP、Not Interested、已有回复、已人工
Follow-up、私人联系人、预约／成交、正在其他 Campaign，以及 14／21／30 天冷却期
内刚联系过的人。

Refresh 必须使用 Notion 中独立的 `Refresh - Reconnect` Active 模板。发送结果先
写入 SQLite，最终同步只更新 `Last Blast At`、sender 与 Run ID，不修改客户原本的
`Last Flow Sent`、`Next Flow`、`Sequence Status` 或 `Follow Up Due`。

| Flow | Cohort | 下一轮间隔 |
|---|---:|---:|
| Flow 1 | Day 0 | 2 天 |
| Flow 2 | Day 2 | 2 天 |
| Flow 3 | Day 4 | 2 天 |
| Flow 4 | Day 6 | 3 天 |
| Flow 6 | Day 9 | 3 天 |
| Flow 7 | Day 12 | 3 天 |
| Flow 8 | Day 15 | 3 天 |
| Flow 10 | Day 18 | 完成 |

一个 Flow 可以包含 Part 1、Part 2、Part 3+。每个 Part 发送前都会重新检查：

- 当前 sender 是否健康并且 OPEN；
- 客户是否回复；
- 是否进入 STOP／Suppression；
- 是否超过固定时间窗；
- 该 Part 是否已经有发送证据或不明确 attempt。

---

## 4. Campaign 生命周期

```text
选择 Project / Lead Group / Sender
        ↓
号码格式、sender ownership、suppression、resend guard
        ↓
生成最终预览
        ↓
TEST 或 LIVE 确认
        ↓
Evolution / WhatsApp 分 Part 发送
        ↓
每位客户完成后写 SQLite checkpoint
        ↓
Campaign 到达 terminal state
        ↓
Notion outbox 才允许最终同步
```

运行期间 SQLite 是权威来源。Notion 是最终一致的业务镜像，不在 WhatsApp 发送
事务的关键路径上。

### 防重复发送

Mamba 使用多层防线：

- 同一个 `runId` 只能持有一份 execution lease，双击或两条 route 不能并发跑同一批。
- 每个 Part 都有稳定 `sendKey` 与本机 attempt history。
- Provider 确认成功后才记录 message id 与 `sentAt`。
- timeout、`fetch failed`、socket 中断、HTTP 408／425／429／5xx 都属于
  `UNKNOWN`，不会自动重发。
- 操作员必须先检查客户 WhatsApp，再明确确认是否补发不确定的 Part。
- 同一个 Flow 在 resend cooldown 内已有本机发送记录时会跳过。

“发送 API 报错”不等于“客户一定没收到”。因此状态不明确时，安全暂停优先于
自动 retry。

---

## 5. TEST 与 LIVE

### TEST

- 唯一收件人来源是 `evolution-pilot/.env` 的 `TEST_LEADS`。
- Settings 是编辑界面，但最终仍写回同一个 env key。
- `TEST_LEADS` 为空时 fail closed，不允许启动。
- Request body 不可临时覆盖 TEST 名单。
- 仓库没有任何内建真人测试号码。

格式：

```text
Name:<international-phone>:en,Name 2:<international-phone>:zh
```

建议直接在 Settings 的 TEST recipients 表格维护，不要手改格式。

### LIVE

LIVE 启动前必须：

- 确认所有收件人已经 opt in；
- 绑定明确 Project、Lead Group 与 sender；
- 通过全局 STOP、suppression 与 resend guard；
- 显示最终收件人数和风险提示；
- 标出命中本机其他号码、私人联系人或历史 Blast 的收件人；
- 由操作员确认与本批实际名单绑定的 confirmation token。

维护工具、同步操作或页面刷新不得自动恢复一个中断的 LIVE Campaign。

### 每个号码的发送节奏

在发送台顶部打开「发送模式」，每个 WhatsApp sender 可以选择保守、普通、Crazy，
或填写自定义客户间隔。自定义范围是 30–3600 秒，例如 `120–240` 表示一位客户的
所有 Part 完成后，随机等待 120–240 秒才开始下一位。

设置存在本机并由人工 Campaign 与 Scheduler 共用，只影响之后建立的批次。已经
RUNNING／QUEUED 的 Campaign 会继续使用建立时冻结的节奏。多个号码如果使用独立
Lane，会各走自己的范围；共用同一个旧式队列时采用其中最慢的安全范围。

如果电脑在发送途中关机或休眠，Mamba 不会自行恢复 LIVE 发送。重新打开后按
「继续发送」，系统会从当前时间为剩余客户建立新的恢复时间窗，并继续使用该 run
已冻结的客户间隔。旧时间窗仍保留在记录里；已发送的客户、已完成的 Part，以及
结果不明确但未经人工确认的请求都不会自动重发。

### 发送台工作区

`/send` 保留 Control Center Sidebar。顶部只有一个「Campaign 安排」入口，Flow 1
新名单与 Flow 2–10 跟进作为该工作区内的两种安排类型，不再占用两个顶层页面。
两者使用内部切换，不会因为换页面而清掉已经填写的表单。
Multi-sender 仍是独立 Campaign 工具；发送进度、SQLite 落盘、Notion outbox 和
号码队列集中放在 `/send#monitor`，避免监控卡片长期占用 Campaign 操作空间。
Refresh Customers 属于 Customers Sidebar，并以独立 `/refresh` 页面管理旧客重联，
不再出现在 Campaign Center 顶部。

Flow 1 与 Flow 2–10 的操作页都只负责选择客户、发送配置和最终预览。启动或排入
队列后，页面会切到「发送监控」；继续发送、异常重试、CSV 导出、运行时间线和逐位
客户结果都在该处处理。监控视图按 `runId` 读取实际 Flow 名称并复用原有组件与 API，
不另建第二套发送状态或恢复规则。
只生成预览、尚未启动的 `PREPARED` 批次不会出现在监控；没有运行中、排队中或可以
恢复的 Campaign 时，详细进度区域完全隐藏，不显示 0% 占位卡。

顶部「发送模式」属于整个发送台，不绑定某一个 Flow。每个 WhatsApp sender 仍可
独立选择预设或填写自定义随机间隔；设置只影响之后建立的 Campaign。

---

## 6. Scheduler

Scheduler 只处理已经进入 Sequence 的 Flow 2–10。Flow 1 是首次接触，仍必须由
操作员选择名单并启动。

LIVE Scheduler 的规则：

- 必须在 Campaign Automations 明确选择 LIVE 并 arm。
- 默认工作窗口为 Kuala Lumpur 时间 `10:00–21:00`。
- 安全闸门未通过时保持 HOLD，之后重新检查。
- 当前批完整写入 SQLite 后，下一次 worker tick 才重新读取到期名单。
- 不要求操作员在页面按“下一批”才能继续。
- 不自动绕过 Tracker、sender ownership、回复判断或 STOP。
- 服务或 WhatsApp 恢复后不会无人确认地续发一个结果不明确的旧请求。

---

## 7. Chat Room、Lead 来源与 Follow-up

Chat Room 会按实际 WhatsApp sender 分页显示对话，并支持文字、图片与影片：

- 图片接近可视区域时才读取缩图；
- 影片由操作员点击后才读取；
- 影片不会 autoplay；
- 媒体先进入受限本机 cache，不把整段 base64 对话一次塞进页面。

通话后新增号码时，必须先选择实际发送的 WhatsApp sender，再选择来源：

| 来源 | SQLite | Notion | 自动 Flow / Campaign |
|---|---|---|---|
| Blasting Leads | 是 | Blast Leads | 需要明确加入 |
| Recycle Leads | 是 | Recycle Leads | 不会因建立动作自动发送 |
| Ads Leads | 是 | Ads Leads | 不会因建立动作自动发送 |
| Others | 是 | 否 | 否 |

`Others` 的底层兼容 key 是 `OWN`。它是人工联系人／自己找来的 Lead 的默认分类，
可以留在 ChatRoom 和安排 Follow-up，但不会进入 Notion 或自动 Campaign。

建立客户本身不会发送消息。第一次人工发送仍需要 OPEN sender、号码格式、
suppression 检查与操作员确认。

### Quick Remark

- `Not Interested`：停止该客户自动 Flow，不加入全局 STOP。
- `Do Not Contact`：先写入本机全局 suppression，再尝试同步 Notion。
- 其他人工状态：先写 SQLite，再即时镜像 Notion。
- 没有 Notion page 的本机客户仍会保留操作结果，并明确显示
  `notionSynced: false`，不会丢掉人工决定。

### 私人联系人

Settings 的私人联系人名单只定义“工作 Inbox 边界”：

- 消息仍保存在本机；
- 不显示在工作 ChatRoom；
- 不触发 Sales Brain、STOP 判断或 Notion 回复同步；
- 不会自动加入 Campaign suppression。

私人联系人、Telegram Filter 与 Campaign STOP 是三套不同规则。

---

## 8. 数据所有权

| 资料 | 权威来源 | 说明 |
|---|---|---|
| Contact、STOP、回复摘要 | SQLite | 收到消息或人工操作时写入 |
| Project Flow 状态 | SQLite `project_leads` | Notion 只是镜像 |
| Others | SQLite | 不同步 Notion |
| 私人联系人边界 | 本机 JSON | 不等于 STOP |
| Conversation / Message | SQLite | 包含 sender、direction 与 provider evidence |
| Campaign Run | SQLite | Run JSON 是恢复证据 |
| 每个发送动作 | SQLite / run attempt evidence | Provider 确认后落账 |
| Sync Job | SQLite outbox | 幂等、有限 retry |
| Template | Notion 人工内容，本机 snapshot | 明确 Refresh 时更新 |
| Project Knowledge | Notion／受控 YAML，本机 snapshot | AI 只读验证过的内容 |
| Secret / TEST_LEADS | `.env` | 不进入 Git |

禁止把 `mamba.sqlite` 放进 Git、iCloud、Dropbox 或其他多电脑同步目录。多台电脑不
可以同时写同一个 SQLite 文件。

---

## 9. Repository 结构

```text
Mamba/
├── AGENTS.md                    工程、安全与 Definition of Done
├── README.md                    系统入口与操作总览
├── campaign-app/
│   ├── server.mjs               composition root；仍含部分 legacy orchestration
│   ├── app/                     HTTP app、runtime、state
│   ├── routes/                  API 输入、验证与 response
│   ├── lib/                     当前 services / repositories / adapters 过渡目录
│   ├── campaign_core.mjs        Campaign engine
│   ├── flow_sequence.mjs        Flow 与 reply rules
│   ├── brain_core.mjs           Brain 纯规则
│   ├── brain_service.mjs        Tracker / AI 服务
│   ├── *.html                   本机 UI
│   ├── assets/                  UI CSS / JS / fonts
│   ├── test_*.mjs               当前测试套件
│   └── run-tests.mjs            test runner
├── campaign-assets/
│   ├── projects.json            Project registry
│   ├── *.json                   Project / Campaign 配置
│   ├── knowledge/               受控 Project Knowledge
│   └── images/                  Campaign 媒体
├── campaign-data/
│   ├── mamba.sqlite             本机主库，不进入 Git
│   ├── runs/                    Run recovery evidence，不进入 Git
│   ├── brain/                   Brain cache / pending，不进入 Git
│   ├── logs/                    本机日志，不进入 Git
│   └── notion_config.json       Notion database IDs，不含 token
├── evolution-pilot/
│   ├── docker-compose.yml       Evolution / PostgreSQL / Redis
│   ├── .env.example             安全配置模板
│   └── .env                     本机 secret，不进入 Git
├── scripts/maintenance/         默认 dry-run 的维护工具
├── launchers/                   macOS 双击入口
├── Mamba.app/                   macOS app wrapper
├── docs/                        Architecture、ADR、Schema、标准与审计
├── assets/                      Cloudflare R2 上传入口
├── hub-server/                  Remote / team access 辅助服务
└── ios/                         MambaView iOS client
```

目标结构是 `routes → services → domain`，再由 service 调用 repositories 与
integrations。现有 `lib/` 会在修改相关功能时逐步迁移。

---

## 10. 首次安装

### 要求

- macOS
- Node.js 20 或更新的 LTS
- Docker Desktop 或 Colima
- Git
- 可访问的 Evolution API
- 如需同步：Notion integration
- 如需通知：Telegram bot

### 1. 安装 Node dependencies

```bash
cd /path/to/Mamba/campaign-app
npm install
```

### 2. 建立本机 `.env`

```bash
cd /path/to/Mamba
cp evolution-pilot/.env.example evolution-pilot/.env
```

至少为 Evolution 配置安全的 API key 与 database password。其他 integration
可按需要填写：

| Key | 用途 |
|---|---|
| `AUTHENTICATION_API_KEY` | Evolution API authentication |
| `DATABASE_CONNECTION_URI` | Evolution 自己的 PostgreSQL |
| `NOTION_API_KEY` | Notion integration |
| `TEST_LEADS` | 唯一 TEST recipients |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Ops 通知与批准 |
| `MAMBA_BRAIN_ENABLED` | Sales Brain 总开关，默认 `0` |
| `BRAIN_AI_PROVIDER` | `rules` / `openai` / `anthropic` / `gemini` / `auto` |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` | 可选 AI provider |
| `CF_*` | 可选 Cloudflare R2 |

Kimi／Moonshot 已从系统移除。

### 3. 启动 Evolution

```bash
cd /path/to/Mamba/evolution-pilot
docker compose up -d
```

在 Mamba Settings 的 Phone Health 确认：

1. Docker Engine 正常；
2. Evolution API 可访问；
3. 实际发送的 `wa_*` instance 为 `OPEN`。

### 4. 启动 Mamba

推荐双击：

```text
Mamba.app
```

或：

```text
launchers/Mamba Control Center.command
```

Terminal 启动方式：

```bash
cd /path/to/Mamba
node campaign-app/server.mjs
```

默认入口：

```text
http://127.0.0.1:8787/control-center
```

UI 与 API route 在 Server 启动时建立同一份静态 snapshot。修改代码后必须等待所有
LIVE Campaign 完成或明确停止，再重启 Mamba 才会完整生效。

### 5. 首次安全检查

- 在 Settings 填写 TEST recipients；
- 验证 Notion 与 Telegram identity；
- 检查本机 device 与 sender ownership；
- 确认私人联系人名单；
- 先执行 TEST；
- TEST 收件人、sender、文案与媒体都正确后才考虑 LIVE。

---

## 11. 日常操作

### Flow 1 新名单

1. 打开 Campaign Center。
2. 选择 Project 与现有 Lead Group，或建立新客户群。
3. 选择 OPEN sender 与发送时段。
4. 查看 suppression、历史 Blast、本机号码与私人联系人风险。
5. 先运行 TEST。
6. LIVE 时确认 opt-in 与最终收件人名单。
7. 启动后到「发送监控」查看进度、异常与逐位客户结果；需要恢复时也在该处操作。
8. 发送期间保持 Mamba、Docker 与电脑在线。
9. 完成后由 SQLite outbox 等待 Notion 同步。

### Flow 2–10

- 手动：在 Campaign Center 选择到期 Flow 并启动。
- 自动：在 Campaign Automations 设置 TEST／LIVE，并对 LIVE 明确 arm。
- 客户回复、STOP、Not Interested 或人工接管后会退出自动序列。

### 客户回复

1. Customer Inbox 查看待回复客户。
2. Chat Room 查看完整对话与实际 sender。
3. 使用 AI 建议或人工编辑，但建议不会自动发送。
4. 建立 Follow-up、Appointment 或 Quick Remark。
5. Not Interested 与 Do Not Contact 使用不同按钮和规则。

### Notion

- 每位客户完成后先建立本机 outbox。
- Campaign 未完成时不做最终同步。
- 默认每晚 `22:00` 有一次兜底 drain。
- 可在 Campaign Center 使用“立即同步”处理已完成资料。
- `PENDING`、`RUNNING`、`RETRY`、`FAILED`、`CONFLICT` 与 `COMPLETED`
  是不同状态；队列为 0 不代表历史失败不存在。

---

## 12. Integrations

### Evolution / WhatsApp

- Instance login、健康、消息发送、webhook、history 与媒体。
- 未连接的既有 instance 可在 Settings → Phone Setup 使用「重新扫码」；系统只
  重置旧 session 并生成新 QR，不删除 instance 或 Mamba 本机对话资料。
- 正在发送 LIVE Campaign 时禁止重置 session；WhatsApp 账号仍处于 Restricted
  时，重新扫码不能解除官方限制。
- 入站接收覆盖本机所有 OPEN instance，包括辅助 sender。
- `MESSAGES_UPSERT` 写消息，`MESSAGES_UPDATE` 更新 delivery evidence。
- `SERVER_ACK` 不是客户已收到；`DELIVERY_ACK` 才代表送达客户装置。
- 长期没有双勾只显示“疑似未送达”，不能自动判定客户 block。

### Notion

- 人工维护 Template、Knowledge 与业务可见资料。
- Campaign 结果由 SQLite outbox 在完成后同步。
- 旧任务不得把客户 Flow 从较新状态倒退。
- 冲突保持可见，不为了显示成功而覆盖语义。

### Telegram

- Ops 异常、人工批准与必要通知。
- Watchdog 同一异常连续确认后只报警一次，恢复时通知一次。
- 正常启动与持续健康不会不断发送心跳。

### AI

- 支持 rules、OpenAI、Gemini 与 Anthropic。
- AI 只生成 draft 和建议，不直接发送复杂客户回复。
- Project fact 必须来自验证过的 Knowledge。

### Cloudflare R2

- 用于受控同步 Campaign assets。
- 检查：

  ```bash
  cd campaign-app
  npm run check:cloudflare-assets
  ```

- 上传：

  ```bash
  npm run sync:cloudflare-assets
  ```

Secret 只放 `.env`；远端删除属于破坏性操作，不在普通同步中自动执行。

---

## 13. 主要页面

| 页面 | URL |
|---|---|
| Control Center | `/control-center` |
| Campaign Center（Flow 1–10） | `/send#campaign-flow1`、`/send#campaign-next` |
| Campaign Monitor | `/send#monitor` |
| Flow 1 legacy view | `/flow-1` |
| Multi-sender lanes | `/lanes` |
| Customer Inbox | `/conversations` |
| Chat Room | `/inbox` |
| Follow-up Desk | `/follow-up` |
| Customer Search | `/lookup` |
| Refresh Customers | `/refresh` |
| Templates & Flows | `/templates` |
| Campaign Automations | `/campaign-todo` |
| Project Brain | `/project-brain` |
| Learning Queue | `/brain-learning` |
| Bot Rules | `/bot-rules` |
| Flow Map | `/flow-map` |
| Team View | `/team-view` |
| Settings | `/settings` |
| System Logs | `/logs` |
| AI Changes | `/ai-changes` |

---

## 14. 测试与验证

在 `campaign-app/`：

```bash
npm test
```

不依赖当前本机 Server 的安全套件：

```bash
npm run test:safe
```

只运行某类测试：

```bash
node run-tests.mjs --match campaign
```

提交前至少检查：

```bash
node --check server.mjs
git diff --check
git status -sb
```

任何发送、同步、重试、migration 或 secret 行为改变都必须有针对性测试，并运行
完整测试套件。

---

## 15. Maintenance

维护脚本位于 `scripts/maintenance/`，默认必须 dry-run：

```bash
node scripts/maintenance/migrate-v3-runtime-schema.mjs --dry-run
node scripts/maintenance/reconcile-campaign-terminal-state.mjs --dry-run
node scripts/maintenance/classify-unassigned-contacts-as-others.mjs --dry-run
node scripts/maintenance/runtime-folder-hygiene.mjs --dry-run
```

真正 Apply 前：

1. 所有 Campaign 必须完成或明确停止；
2. Scheduler 不再启动新批次；
3. 先备份 SQLite；
4. 查看 dry-run 的精确目标；
5. 使用脚本要求的显式 `--apply`；
6. 完成后执行数据库检查和相关测试。

Maintenance 不得用“很久没有日志”推断 Campaign 已结束。

---

## 16. Git 与资料安全

会进入 Git：

- 程式码、测试和文档；
- Project config 与受控 Campaign assets；
- `.env.example`；
- 不含 token 的 Notion database IDs；
- Bot rules 与非机密 topic config。

不会进入 Git：

- `.env` 与任何 secret；
- 客户 Excel／CSV；
- `campaign-data/mamba.sqlite`；
- run、conversation、brain cache 与 logs；
- WhatsApp QR、session 与 instance credentials；
- Cloudflare generated manifest；
- SQL 数据快照。

提交前建议：

```bash
git status -sb
git diff --check
git diff --cached
```

不要使用 `git add -A` 盲目提交本机运行资料。

---

## 17. 常见问题

### Mamba 显示 Evolution 掉线

按顺序检查：

1. Docker daemon；
2. `http://127.0.0.1:8080` 的 Evolution API；
3. 实际 `wa_*` instance 是否 `OPEN`。

`fetch failed` 也可能是 Docker 或本机网络问题，不代表 WhatsApp 帐号被 restrict。

### Campaign 因断网暂停

不要立即补发。先查看客户 WhatsApp 和 Part attempt 状态。如果显示 `UNKNOWN`，
说明请求可能已经送达；确认客户没有收到后，才从 UI 明确补发。

### Scheduler 没有自动下一批

检查：

- Scheduler 是否为 LIVE 且已经 arm；
- 当前时间是否在 `10:00–21:00`；
- 是否有 RUNNING／INTERRUPTED run 占用 sender；
- Tracker、sender ownership、suppression 或 reply deep check 是否 HOLD；
- SQLite checkpoint 是否完成。

### Notion 显示红色但队列为 0

队列 0 只代表没有等待中的新任务。历史 `FAILED`／`CONFLICT` 仍会保留为可处理事项。
查看错误里的 task、phone／run 与原因，不要只看顶部数字。

### Chat Room 看不到某个 sender 的回复

确认该 instance 为本机 OPEN、webhook 同时订阅 `MESSAGES_UPSERT` 与
`MESSAGES_UPDATE`，并检查 Tracker 是否覆盖所有 OPEN instance。

### 修改 UI 后没有变化

Mamba 在启动时建立 UI／route snapshot。等待 LIVE Campaign 安全结束后重启 Server，
不要在发送途中重启。

### TEST 无法启动

到 Settings 填写 `TEST_LEADS`。空名单是刻意 fail closed，不会使用默认号码。

---

## 18. 开发原则

- `server.mjs` 只负责组装、启动、job 与 shutdown。
- Route 不直接决定 Campaign、Notion 或 suppression 业务规则。
- 同一个业务规则只有一个来源。
- SQLite 是运行期间的事实来源。
- Notion 是完成后的同步层。
- 所有发送动作需要稳定 idempotency／attempt identity。
- 状态不明确的 WhatsApp 请求不可自动重发。
- 外部 integration 必须有 timeout、错误分类与有限 retry。
- Secret、完整客户资料和 token 不进入日志或 Git。
- 修改 LIVE 行为前先确认当前是否有 Campaign 运行。
- 不自动 restart、commit、push 或发送真实消息，除非操作员明确要求。

完整工程规则见 [AGENTS.md](AGENTS.md)。
