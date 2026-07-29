# Mamba Integrations

> 状态：Current · 更新日期：2026-07-28
>
> 本文件记录外部系统的责任、资料方向、失败行为与修改边界。
> Secret value 不得写入本文。

## 1. Integration 总原则

所有 integration 都必须：

- 有明确 timeout。
- 将第三方 response 转换成 Mamba 内部结构。
- 将错误分类为 authentication、rate limit、network、conflict 或 permanent。
- 不在日志输出 Token、API Key 或完整客户资料。
- 写入操作尽量使用稳定 idempotency key。
- 不用无限 retry。
- 外部系统不可用时，优先保存本机状态并显示可行动的错误。

新增功能应复用现有 integration service，不要在新 route 里再写一套 `fetch()`。
现有 legacy 直连会逐步迁移，不要求在无关任务里一次重写。

## 2. Evolution API / WhatsApp

### 责任

- WhatsApp instance 管理
- QR login 和 connection health
- 文字／图片发送
- 入站 webhook 和历史消息读取
- ChatRoom 图片／影片按需读取与本机媒体缓存

### 代码入口

- `campaign-app/campaign_core.mjs`
- `campaign-app/lib/inbox-send-service.mjs`
- `campaign-app/lib/evolution-history-sync.mjs`
- `campaign-app/routes/instances.routes.mjs`

### 资料方向

```text
Mamba → Evolution API → WhatsApp
WhatsApp → Evolution webhook/history → Mamba
```

### 安全边界

- 只有 OPEN 且属于本机 device policy 的 sender 可以发送。
- 入站 webhook 必须覆盖这台电脑 Evolution 上所有 OPEN instances；不得使用
  Campaign 的 primary sender filter 排除 `wa_03` 等本机辅助号码。
- 入站范围与发送权限分离：接收所有本机 OPEN 号码不代表 Campaign 可以任选号码发送。
- 发送前必须完成 recipient normalization。
- Timeout 后状态不明确时，不得自动重发。
- ChatRoom 不得把整段对话的 base64 媒体一次塞进页面：图片只在接近可视区时
  读取缩图，影片必须由操作员点击后才读取，且禁止 autoplay。
- Evolution 媒体先写入 `campaign-data/inbox-media`，浏览器再从受限的本机 binary
  endpoint 读取；档名必须经过路径验证，不能接受任意 filesystem path。
- ChatRoom 新号码只可使用当前 Device 上 OPEN 的 sender；第一次发送必须由
  操作员再次确认，且发送结果写入本机 conversation ledger。
- Evolution 的 PostgreSQL 不存放 Mamba 业务 schema。
- Instance name 不是客户或 sender 的永久业务 ID。

## 3. Notion

### 责任

- 给人查看和维护的业务面板
- 人工维护的 Template、Project Knowledge 和部分备注
- Campaign 完成后的运行资料镜像

### 代码入口

- `campaign-app/lib/notion-service.mjs`
- `campaign-app/lib/notion-outbox-service.mjs`
- `campaign-app/lib/notion-outbox-worker.mjs`
- `campaign-app/lib/blast-cache-service.mjs`
- `campaign-app/notion_sync.mjs`

### 资料方向

```text
人工内容：Notion → local cache / SQLite
运行结果：SQLite outbox → Notion
```

### Campaign Sync 时机

1. 每位客户的发送结果先写入 SQLite。
2. 对应 Notion job 进入 outbox。
3. Campaign 仍在发送时，worker 必须 defer job。
4. Campaign 全部跑完后，job 才可同步。
5. 每晚默认 `22:00` 有一次兜底 drain；也可以人工触发。

“加入 outbox”不代表“已经同步到 Notion”。UI 和日志必须区分
`PENDING`、`RUNNING`、`RETRY`、`FAILED` 和 `COMPLETED`。

### 人工 Quick Remark

ChatRoom／Customer Desk 的人工 disposition 不是 Campaign 批次收尾：

1. 先更新 SQLite 的客户 Status、Sequence 与 Follow Up 状态。
2. `Do Not Contact` 先写入本机全局 STOP overlay。
3. 再立即 PATCH 对应 Notion page。
4. Notion 失败时保留本机决定并明确显示“本机已更新、Notion 未同步”，不得
   恢复自动 Flow。
5. 若客户尚无 Notion page，则只保存本机状态并回报 `notionSynced: false`；
   Quick Remark 不负责擅自建立 Notion row。

`Not Interested` 是 soft rejection，只停止自动 Flow；只有
`Do Not Contact` 会设置全局 `Stop Flag`。

### ChatRoom 人工新增客户

通话后从 ChatRoom 新增号码时，所选 `wa_01`／`wa_03` 是客户负责的 WhatsApp
connection。系统先写 SQLite，再按客户来源处理外部镜像：

| 来源 | 本机 SQLite | Notion | Campaign |
|---|---|---|---|
| Blasting Leads | `contacts` + `project_leads` + `lead_origins` | Blast Leads；必须有 Project | 不自动加入 |
| Recycle Leads | `contacts` + `recycle_leads` + `lead_origins` | Recycle Leads | 不自动加入 |
| Ads Leads | `contacts` + `ads_leads` + `lead_origins` | Ads Leads | 不自动加入 |
| Own Leads | `contacts` + `own_leads` + `lead_origins` | 不同步 | 不加入 |

规则：

1. 建立客户不等于发送消息；第一次发送仍需要操作员确认。
2. 所有类型都保存 normalized phone、稳定 contact key、selected sender key 和备注。
3. Notion 写入失败时保留本机客户，并把状态标成 `FAILED`；不得假装已经同步。
4. 已有 `Do Not Contact`／全局 suppression 不得因再次 Setup 而被重新启用。
5. 手工建立的 Blasting Lead 不得插入正在运行的 Campaign；后续只能通过明确的
   Project／Lead Group 选择进入新的 LIVE run。

### 冲突与重试

- 使用 `sync_jobs.idempotency_key` 防止重复写入。
- 网络、限流等暂时问题使用有限次数 backoff。
- 字段缺失、客户匹配冲突或语义冲突不能盲目覆盖。
- 无法自动解决的资料必须保留错误码和人工处理入口。
- Notion 失败不得回滚已经完成的 WhatsApp 发送记录。

### 私人联系人

Settings 的「私人联系人 / 不进入工作 Inbox」是本机工作边界，不是 Notion
客户分类，也不是 Campaign suppression：

1. 入站消息先写入本机 conversation ledger，保留审计证据。
2. 命中私人名单后，不查询／写入 Notion，也会清除该号码旧的 Notion 回复重试。
3. 不触发 Sales Brain、Telegram 客户通知或自动 STOP 判断。
4. ChatRoom 清单与单一 thread API 都不显示该号码。
5. 历史消息不删除；从私人名单移除后可以重新在工作 ChatRoom 查看。

## 4. Telegram

### 责任

- Campaign／系统通知
- Brain 草稿的人工批准、编辑、拒绝和接管
- Inbox 与 Ops channel 分流

### 代码入口

- `campaign-app/telegram.mjs`
- `campaign-app/telegram_hub.mjs`
- `campaign-app/lib/settings-service.mjs`
- `campaign-app/lib/telegram-filter-service.mjs`
- `campaign-app/brain_service.mjs`

### 配置

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- 可选 Hub 配置：`TELEGRAM_HUB_BOT_TOKEN`、`TELEGRAM_INBOX_CHAT_ID`、
  `TELEGRAM_OPS_CHAT_ID`

### 安全边界

- 未配置时不得假装通知成功。
- Filter 号码仍可进入 Tracker／Notion，只是不发 Telegram 通知。
- 私人联系人名单是另一套设置；不得用 Telegram Filter 代替。
- Telegram approval 必须绑定稳定 pending ID。
- 过期 approval 应归档，不能永久留在 active pending。

## 5. AI Providers

### 支持范围

- OpenAI
- Google Gemini
- Anthropic
- Rule-only fallback

Kimi／Moonshot 已从产品和配置中移除，不得重新加入 fallback。

### 代码入口

- `campaign-app/brain_core.mjs`
- `campaign-app/brain_service.mjs`
- `campaign-app/routes/settings.routes.mjs`
- `campaign-app/lib/settings-service.mjs`

### 安全边界

- AI 只生成 draft，不直接决定发送。
- 复杂回复必须经过 Telegram 人工批准。
- Provider 缺 Key 或请求失败时，回到明确的下一个 Provider 或 rules。
- Project fact 必须来自已验证 Knowledge。
- 不把完整 API response 或 secret 写入 log。

## 6. Cloudflare R2

### 责任

- Campaign 图片资产上传和公共 URL

### 代码入口

- `campaign-app/cloudflare_assets_sync.mjs`
- `campaign-assets/`

### 安全边界

- 上传工具必须支持 dry-run。
- Secret 只放 `.env`。
- Asset key 必须稳定，避免同一内容产生大量重复对象。
- 删除远端资产属于破坏性操作，必须明确确认。

## 7. SQLite 与本机文件

SQLite 不是外部 integration，但它是所有 integration 的安全边界。

### 责任

- Campaign 运行账本
- Conversation 和 reply ledger
- Notion outbox
- Device／sender binding
- Idempotency 和 retry state

### 代码入口

- `campaign-app/lib/local-database-service.mjs`
- `campaign-app/lib/sqlite-cli.mjs`
- `campaign-data/mamba.sqlite`

### 规则

- `.sqlite` 不进入 Git、iCloud 或 Dropbox。
- Migration 必须可验证，不在启动时静默破坏资料。
- 大型 import／repair 先 dry-run。
- Notion 和 Evolution 都不能覆盖本机已确认的发送事实。

## 8. Configuration Ownership

| 配置 | 权威位置 | 编辑入口 |
|---|---|---|
| Secret | `evolution-pilot/.env` | Settings |
| TEST recipients | `TEST_LEADS` | Settings 的 TEST 表格 |
| Notion database IDs | `campaign-data/notion_config.json` | 安装／维护流程 |
| Device identity | 本机 campaign-data | Settings／device tools |
| Project config | repository project files + Notion content | 对应 Project 工具 |

`.env.example` 只记录 key 和安全的空值，不应包含可以误发的号码或真实 secret。

## 9. 修改 Integration 的验收清单

- [ ] 明确资料方向与权威来源
- [ ] 设置 timeout
- [ ] 分类 authentication／rate limit／network／conflict 错误
- [ ] 有限 retry 与 backoff
- [ ] 写入具备 idempotency
- [ ] Secret 不进入日志、测试 fixture 或 Git
- [ ] 外部失败不会破坏本机已确认状态
- [ ] 正在运行的 LIVE Campaign 不受影响
- [ ] 有成功、失败、timeout 和重复调用测试
- [ ] 更新本文件和 `.env.example`（如果配置改变）
