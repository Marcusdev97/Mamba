# Mamba Integrations

> 状态：Current · 更新日期：2026-08-05
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
- `campaign-app/lib/evolution-reconnect-service.mjs`
- `campaign-app/integrations/evolution/provider-normalizer.mjs`
- `campaign-app/lib/campaign-safety-service.mjs`
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
- Webhook 同时订阅 `MESSAGES_UPSERT` 与 `MESSAGES_UPDATE`。前者写对话，后者按
  Evolution message id 更新原本的 SQLite 出站消息；投递状态与
  `serverAckAt`／`deliveredAt`／`readAt` 保存在 `messages.payload_json`。
- 手机人工 Follow-up 的即时 webhook 若因断网漏失，定时 history reconciliation
  会用相同 Evolution message id 幂等补写 SQLite，再将 Notion `Follow Up At`
  安排到下一天 10:00（Asia/Kuala_Lumpur）。本机写入失败时不得先推进 Notion，
  防止 ChatRoom 仍显示旧日期但业务面板已经当作完成。补查使用最后回复时间与
  当前 Follow-up 到期时间作为下界，允许跨午夜恢复，但不会重复采用已经处理的消息。
- `SERVER_ACK` 只代表 WhatsApp 服务器收到（单勾），`DELIVERY_ACK` 才代表客户
  装置收到（双勾）。长期没有双勾只能列为「疑似未送达」，不得自动判定客户封锁。
- 入站范围与发送权限分离：接收所有本机 OPEN 号码不代表 Campaign 可以任选号码发送。
- 发送前必须完成 recipient normalization。
- 人工 LIVE `/api/start` 前会重新读取所有 OPEN instance 的 owner phone，并与本批
  收件人比较；命中自己的其他号码时必须在最终风险弹窗明确确认。前端确认不能取代
  后端 token 校验，收件人选择改变后必须重新确认。
- Timeout 后状态不明确时，不得自动重发。
- `fetch failed`、socket／connection 中断、HTTP 408／425／429／5xx 与 timeout
  一样视为发送结果不明确。Mamba 必须把该 Part attempt 标成 `UNKNOWN` 并停止；
  只有操作员检查客户 WhatsApp 后明确确认，才允许建立下一笔 attempt。
- 同一 `runId` 使用 process-local execution lease；同一 Part 使用 run state 内的
  稳定 `sendKey` 与 attempt history。两层保护共同防止双击、双 route 或断网恢复
  造成并发重复发送。
- ChatRoom 不得把整段对话的 base64 媒体一次塞进页面：图片只在接近可视区时
  读取缩图，影片必须由操作员点击后才读取，且禁止 autoplay。
- Evolution 媒体先写入 `campaign-data/inbox-media`，浏览器再从受限的本机 binary
  endpoint 读取；档名必须经过路径验证，不能接受任意 filesystem path。
- ChatRoom 新号码只可使用当前 Device 上 OPEN 的 sender；第一次发送必须由
  操作员再次确认，且发送结果写入本机 conversation ledger。
- Evolution 的 PostgreSQL 不存放 Mamba 业务 schema。
- 已退役的 Mamba Global PostgreSQL 汇总工具与 Evolution 内部数据库无关；维护
  Evolution compose 时不得因为移除 Global 汇总层而删除其数据库或 volume。
- Instance name 不是客户或 sender 的永久业务 ID。
- Settings 的「重新扫码」只对未连接 instance 开放：先 logout 失效的 Baileys
  session，再向 `/instance/connect/<name>` 请求新 QR。它不得调用 instance delete，
  因此原 instance name、Mamba connection key 与本机 conversation ledger 保持不变。
- LIVE Campaign 正在发送时禁止重置 session。Evolution logout 回报错误时，只有重新
  查询确认 instance 已非 OPEN 才能继续取 QR；状态不明确时 fail closed。
- 重新扫码只能恢复已登出或损坏的 session，不能绕过 WhatsApp 账号的 Restricted
  状态。账号仍受限时必须先通过 WhatsApp 官方流程恢复。
- WhatsApp 发送 pacing 属于 Mamba domain/config，不由 Evolution 决定。每个 sender
  可选择预设或自定义客户 gap；保存后由 Campaign prepare 读取，Scheduler 与人工
  Campaign 共用同一规则。这个设置用于控制合规发送节奏，不能替代 opt-in、STOP、
  suppression、回复检查或 WhatsApp 官方限制。
- Evolution instance response 会被 normalize 为 `META_CLOUD_API`、`BAILEYS` 或
  `UNKNOWN`。Settings 会明确显示 provider；`BAILEYS` 是 WhatsApp Web session，
  不能假装成官方 Cloud API。当前版本只完成 provider-aware 诊断与安全边界，实际
  切换至 Meta Cloud API 仍需要 WABA、phone number ID、access token 和 webhook
  配置，不会自动把现有号码迁移。
- Sender Health circuit breaker 读取 SQLite 中带 `deliveryStatus` 的 Blast 出站证据。
  旧 payload 没有 delivery status 的消息不进入失败率或连续失败统计。Sender 达到
  策略阈值后写入 `sender_safety_state=PAUSED`；新 Start、Queue、Resume 与 Retry
  都 fail closed，直到操作员明确恢复。

### 本机健康与睡眠边界

Mamba 不再把所有 `fetch failed` 都显示成「Evolution 掉线」，而是分三层检查：

1. `Docker Engine`：Docker daemon 是否存在。
2. `Evolution API`：`:8080` 是否可访问并通过 API key。
3. `WhatsApp Instances`：本批实际使用的 `wa_01`／`wa_03` 是否为 `OPEN`。

任一发送所需层连续两次异常，运行中的 Campaign 进入 `INTERRUPTED`，写入明确
错误码并通知 Ops；不得自动 reconnect、自动 retry 状态不明的发送，或在恢复后
自动继续。macOS Campaign 运行期间会阻止 idle sleep，但合上 MacBook 仍会触发
系统强制睡眠，操作员必须保持屏幕打开，或改用不会睡眠的常驻主机。

常驻 Watchdog 可以在 Mamba Server 离线时独立读取这三层 transport 状态，但默认
只报警，不自动重启 Server。这样 Scheduler 与中断的 LIVE run 不会因为服务恢复
而在无人确认时重新发送。检查间隔、异常持续多久才 Telegram 报警，以及持续异常的
重复提醒间隔，统一由 Settings 写入中央 Watchdog config；运行中的 Watchdog 会在
每轮检查前重读，不必重启 Campaign。默认每 30 秒检查、异常持续 1 分钟后首次报警、
同一次异常不重复提醒，并在恢复时通知一次；正常启动与持续健康检查不会发送心跳消息。
首次报警和重复提醒都可使用分钟或小时设置，最长 24 小时（例如 6 小时）；状态文件
仍按检查节奏更新，供 Control Center 判断健康状态。Settings 另有独立的 Watchdog
Telegram 总开关；关闭后只停止异常、重复提醒与恢复通知，健康检查、状态文件和外部
dead-man heartbeat 仍继续运行，不影响 Sales Brain 审批或手动 Telegram 测试。

## 3. Notion

### 责任

- 给人查看和维护的业务面板
- 人工维护的 Template、Project Knowledge 和部分备注
- Campaign 完成后的运行资料镜像

### 代码入口

- `campaign-app/lib/notion-service.mjs`
- `campaign-app/lib/notion-outbox-service.mjs`
- `campaign-app/lib/notion-outbox-worker.mjs`
- `campaign-app/lib/notion-crm-sync-engine.mjs`
- `campaign-app/lib/notion-crm-sync-repository.mjs`
- `campaign-app/lib/notion-crm-sync-coordinator.mjs`
- `campaign-app/routes/notion-crm-sync.routes.mjs`
- `campaign-app/lib/blast-cache-service.mjs`
- `campaign-app/notion_sync.mjs`

### 资料方向

```text
人工内容：Notion → local cache / SQLite
运行结果：SQLite outbox → Notion
```

CRM v1 的 Customers 与 Project Leads 使用双向受控同步：SQLite row version 扫描把
dirty entity 加入既有 `sync_jobs`；Notion `last_edited_time` polling 先写 durable inbox，
再套用 human-owned 字段。system-owned 字段只允许 SQLite → Notion。同步默认 20 分钟，
另有 nightly reconciliation 和人工「立即同步／暂停／恢复／重试／对账」入口。

### CRM v1 Structure

新的在线 CRM 使用 8 个独立 databases；legacy Blast／Ads／Recycle／Templates／Images
在迁移期保留原配置。CRM database IDs 只写入 `notion_config.json -> crm.databases`，
不得覆盖 legacy keys。Schema 与 relations 由
`domain/notion-crm-schema.mjs` 单一定义，maintenance provisioner 默认只 dry-run。
任何同名 property type／relation 冲突都必须停止 apply；Notion 和 SQLite 同时修改
human-owned field 时标记 `Conflict`，不采用 last-write-wins。完整规则见
[`NOTION_CRM_V1.md`](NOTION_CRM_V1.md)。

### Campaign Sync 时机

1. 每位客户的发送结果先写入 SQLite。
2. 对应 Notion job 进入 outbox。
3. Campaign 仍在发送时，worker 必须 defer job。
4. Campaign 全部跑完后，job 才可同步。
5. 每晚默认 `22:00` 有一次兜底 drain；也可以人工触发。

“加入 outbox”不代表“已经同步到 Notion”。UI 和日志必须区分
`PENDING`、`RUNNING`、`RETRY`、`FAILED` 和 `COMPLETED`。

### Refresh Campaign Sync

Refresh (`campaignType=RECYCLE`) 使用独立 outbox key
`LOCAL_TO_NOTION:campaign_run:<runId>:refresh_sync`。它不是 Flow 1 upload，也
不是 Flow advance：

- 每位客户发送完成后先把 Refresh send job 与最新 sender 写入 SQLite。
- Campaign 未结束时 outbox 继续 defer。
- 最终 Notion PATCH 只允许 `Last Blast At`、`Sender Instance`、
  `Assigned/Last Sender Key`、`Last Sender Phone`、`Last Sent By Device` 与
  `Campaign Run ID`。
- PATCH 不得包含 `Last Flow Sent`、`Next Flow`、`Sequence Status` 或
  `Follow Up Due`。
- 找不到 Notion page 时保留 SQLite 证据并进入明确失败／重试，不得建立一个会
  重置 Flow 的新客户 row。

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
| Others（底层 `OWN`） | `contacts` + `own_leads` + `lead_origins` | 不同步 | 不加入 |

规则：

1. 建立客户不等于发送消息；第一次发送仍需要操作员确认。
2. 所有类型都保存 normalized phone、稳定 contact key、selected sender key 和备注。
3. Notion 写入失败时保留本机客户，并把状态标成 `FAILED`；不得假装已经同步。
4. 已有 `Do Not Contact`／全局 suppression 不得因再次 Setup 而被重新启用。
5. 手工建立的 Blasting Lead 不得插入正在运行的 Campaign；后续只能通过明确的
   Project／Lead Group 选择进入新的 LIVE run。
6. ChatRoom 默认使用 Others；它仍显示在工作 ChatRoom，但不进入 Notion、自动
   Flow 或 Campaign。真正不想在工作页面出现的朋友应另设为 Private Contact。

### 冲突与重试

- 使用 `sync_jobs.idempotency_key` 防止重复写入。
- Notion → SQLite 使用 page id + `last_edited_time` 组成 inbox idempotency key；重复 poll 不重复套用。
- Retry 为 1m → 5m → 15m → 1h → 6h；authentication、schema、duplicate ID 与字段冲突不盲目重试。
- 同一 human field 双边同时变化时写入 `sync_conflicts`，非冲突字段可继续合并，冲突字段等待人工处理。
- Notion payload 只保留 CRM 摘要字段；raw message、完整 conversation、token、证件与 recovery state 被 denylist 拒绝。
- 网络、限流等暂时问题使用有限次数 backoff。
- 字段缺失、客户匹配冲突或语义冲突不能盲目覆盖。
- 无法自动解决的资料必须保留错误码和人工处理入口。
- Notion 失败不得回滚已经完成的 WhatsApp 发送记录。

### 私人联系人

Settings 的「私人联系人 / 不进入工作 Inbox」是本机工作边界，不是 Notion
客户分类，也不是 Campaign suppression：

1. 入站消息先写入本机 conversation ledger，保留审计证据。
2. 命中私人名单后，不查询／写入 Notion，也会清除该号码旧的 Notion 回复重试。

延迟的 Campaign Flow 回写必须防止状态倒退：如果 Notion 当前的
`Last Flow Sent` / `Next Flow` 已组成一个有效且更后的自动 Flow 状态，
旧任务标记为 `SUPERSEDED_FLOW_STATE` 并结案，不得 PATCH 回旧 Flow。
无法组成有效状态对的 mismatch 仍保留为失败，等待人工检查。
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
- LIVE 发送前的历史 Blast 风险查询
- Consent Grant／Revoke append-only ledger
- 跨 Campaign 联系预算与 preflight audit
- Sender Health pause／resume state

### 代码入口

- `campaign-app/lib/local-database-service.mjs`
- `campaign-app/lib/sqlite-cli.mjs`
- `campaign-data/mamba.sqlite`

### 规则

- `.sqlite` 不进入 Git、iCloud 或 Dropbox。
- Migration 使用不可变编号与 SHA-256 checksum；应用前必须确认没有活动 LIVE，
  建立 online backup 与 manifest，应用后通过 `quick_check`、foreign key 和必要索引审计。
- SQLite 启动异常时 Server 可以保留诊断／备份能力，但所有 LIVE start、resume、retry、
  queue relay 与 sender lane 必须 fail closed；只有 READY + Primary 才能发送。
- `metadata` 保存稳定 `database_id`、建立／迁移／备份／健康检查时间和最后健康状态。
- Message idempotency 以 connection scope + Evolution external message id 为唯一业务键；
  不得假设不同 WhatsApp connection 的 provider message id 全局唯一。
- 大型 import／repair 先 dry-run。
- Notion 和 Evolution 都不能覆盖本机已确认的发送事实。
- LIVE 风险弹窗的「曾经 Blast」只读取 `messages` 中 `direction=outbound` 且
  `source=blast` 的完整本机历史；manual ChatRoom 发送不算 Campaign Blast。
- `contact_permission_events` 不允许 UPDATE 覆盖事实；新的 Grant 或 Revoke 必须
  追加 event，并记录来源、发生时间、可选证据参考及 expiry。
- `campaign_safety_checks` 使用稳定 scope／contact／check type idempotency key，
  重复读取同一个 preflight 不会堆积重复审计行。

## 8. Configuration Ownership

| 配置 | 权威位置 | 编辑入口 |
|---|---|---|
| Secret | `evolution-pilot/.env` | Settings |
| TEST recipients | `TEST_LEADS` | Settings 的 TEST 表格 |
| Notion database IDs | `campaign-data/notion_config.json` | 安装／维护流程 |
| Device identity | 本机 campaign-data | Settings／device tools |
| P0 Campaign safety | `campaign_safety_policy.json` + SQLite ledgers | Settings 的 WhatsApp Safety |
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
