# Mamba Data Ownership Matrix

> 状态：Current + Target · 更新日期：2026-08-08
>
> 一种业务资料只能有一个权威来源。Cache、镜像和恢复文件可以存在，但不得反向覆盖
> 已确认的本机事实。

## 1. 权威资料表

| 业务资料 | 权威来源 | Cache／恢复 | 外部镜像 | 写入时机 |
|---|---|---|---|---|
| Contact／全局 STOP／回复摘要 | SQLite `customers` + `contacts` + `global_suppressions` | suppression JSON 兼容快照 | Notion 部分字段 | 收到回复或人工操作时 |
| 稳定客户身份与 aliases | SQLite `customers` + `customer_identities` | `lid_map` lookup cache | Notion 只镜像 `customer_id` | 收到可验证 identity evidence 时 |
| Project 内 Flow／状态 | SQLite `project_leads` | Notion import cache | Notion Blast Leads | 每位客户发送完成时 |
| Others 联系人 | SQLite `own_leads` + `lead_origins(OWN)` | 无 | 不同步 | ChatRoom 人工建立或安全分类 |
| 私人联系人边界 | `work_inbox_ignore.json` | 无 | 不同步 | Settings 人工设置 |
| Conversation／Messages | SQLite `conversations` + `messages` | 少量 JSONL 兼容记录 | 不作为主账 | 每条消息进入系统时 |
| Lead Group | SQLite `lead_groups` + members | 上传文件只作输入 | 不同步 | 名单确认时 |
| Campaign plan／steps | SQLite `campaigns` + `campaign_steps` | 无 | Notion Campaign 摘要 | Draft 保存／明确修改时 |
| Campaign membership | SQLite `campaign_members` | 无 | Notion 只镜像汇总 | enroll／reply／snooze／exit 时 |
| Campaign Run | SQLite `campaign_runs` | `campaign-data/runs/*.json` 恢复回执 | Notion Campaign Run 视图 | 客户 checkpoint + terminal commit |
| 每个发送动作 | SQLite `send_jobs` | Run JSON provider evidence | Notion 汇总 | Provider 确认后 |
| Campaign outcomes／attribution | SQLite `campaign_outcomes` | 无 | Notion Campaign metrics | 有相关 activity 且在 attribution window 内 |
| 发送许可／阻止原因 | SQLite `send_eligibility_decisions` | Run JSON summary | CSV 只读导出 | 每次 preview 与 final check |
| Campaign customer lock | SQLite `send_eligibility_locks` | 无 | 不同步 | check／lock／release 时 |
| Global suppression／follow-up task | SQLite `global_suppressions` + `customer_follow_up_tasks` | suppression JSON 兼容快照 | Notion CRM summary | STOP／reply／snooze 时 |
| Sales stage／temperature／customer needs | SQLite `project_leads` migration 307 columns | 无 | Notion Project Leads human fields | 自动 evidence 或人工确认时 |
| Qualified opportunity／commission | SQLite `sales_opportunities` | 无 | Notion Sales Opportunities | qualified intent／人工 promotion 后 |
| Sales activity timeline | SQLite `sales_activities` | 无 | Notion 只镜像摘要 | 每个 meaningful sales event |
| Lead Auditor analysis／feedback | SQLite `lead_audit_analyses` + `lead_audit_events` | 无 | 不同步 | 显式 audit／feedback 时 |
| AI engineering Task Contract／evidence | SQLite `ai_change_*` | Git 只读 snapshot | 不同步 | 每个批准、step、file、test、review／rollback event |
| Notion 同步任务 | SQLite `sync_jobs` | 无 | Notion 是目标 | 本机业务 transaction 内排队 |
| Notion 拉取／映射／冲突 | SQLite `sync_inbox` + `notion_entity_map` + `sync_conflicts` | 无 | Notion human-owned fields | 20 分钟 polling／人工同步 |
| Template | Notion 人工内容 | SQLite `templates` 本机快照 | Notion 是编辑入口 | 明确 Refresh 时 |
| Project Knowledge | Notion／受控 YAML 人工内容 | SQLite／Brain JSON 快照 | Notion 是编辑入口 | 明确 Refresh 时 |
| Project Registry | Project repository 配置 | SQLite `projects` 运行快照 | Notion content | Project 载入时 |
| WhatsApp sender binding | SQLite `devices` + `whatsapp_connections` | `instance_identity` 辅助映射 | Evolution 是健康来源 | Phone Health refresh |
| LID → Phone evidence | SQLite `customer_identities`；`lid_map` 是兼容 lookup | 内存 cache | 无 | 收到可验证证据时；冲突不覆盖 |
| Secret／TEST_LEADS | `.env` | Settings masked view | 无 | Settings 保存时 |
| System log | JSONL system logs | UI 查询 cache | 无 | 事件发生时 |

## 2. 不允许的反向覆盖

- Notion 不得把较旧 Flow 覆盖已经由 WhatsApp provider 确认的 SQLite Flow。
- Run JSON 用于恢复和对账，但正常运行结束必须把 terminal state 写回 SQLite。
- Others 不得因为 Notion 找不到号码而自动升级成 Blasting Lead。
- Private Contact 不等于 STOP；从私人名单移除后，历史消息仍存在。
- Template cache 只能由明确的 Refresh 更新，Campaign 发送期间不得临时改版本。
- Evolution instance name 不是 sender 永久身份，必须解析到稳定 connection key。
- Display name 不是 identity；不得凭同名合并 customer。LID／phone 冲突必须进入人工队列。

## 3. Others 与未分类联系人

`Others` 的底层兼容 key 仍为 `OWN`，避免为了改产品名称进行生产 Schema 迁移。

- 显示在 ChatRoom。
- 允许人工发送与安排 Follow-up。
- 不写 Notion。
- 不进入自动 Flow 或 Campaign。
- ChatRoom 新增号码默认使用 Others。
- 旧的未分类联系人只能通过 maintenance dry-run 分类；活动 Campaign、STOP、私人联系人、
  无效号码及已有 Lead 来源全部排除。

## 4. Campaign terminal invariant

每位客户发送成功时：

1. SQLite 写入客户 Flow、发送证据和 Notion outbox。
2. Campaign 在发送期间保持 `RUNNING`。

整批结束时：

1. Runner 决定 `COMPLETED`、`STOPPED` 或 `FAILED`。
2. 同一最终状态和 requested／sent／failed 汇总再次幂等写入 SQLite。
3. 终态写入失败时，不得将下一批视为安全接力。
4. Run JSON 保留为恢复证据，但不代替 SQLite terminal state。

## 5. Schema change

- 正式基础 Schema：`docs/mamba-schema.sql`
- v3 Runtime Patch：`schema_migrations.version = 301`
- SQLite 稳定核心：`schema_migrations.version = 303`
- SQLite ↔ Notion CRM sync：`schema_migrations.version = 304`（默认 paused）
- Customer Identity：`schema_migrations.version = 305`（独立 dry-run/apply）
- Unified Send Eligibility：`schema_migrations.version = 306`（依赖 305；独立 dry-run/apply）
- Sales Stage + Follow-up：`schema_migrations.version = 307`（依赖 306；独立 dry-run/apply）
- Campaign Model：`schema_migrations.version = 308`（依赖 307；独立 dry-run/apply）
- Dashboard AI Auditor：`schema_migrations.version = 309`（依赖 308；独立 dry-run/apply）
- AI Change Tracking：`schema_migrations.version = 310`（依赖 309；独立 dry-run/apply）
- Runtime Service 只验证需要的表和字段，不在启动时执行 `CREATE`、`ALTER` 或 `RENAME`。
- Migration 默认 dry-run，Apply 前必须没有近期活动 Campaign，并先建立 SQLite backup。

## 6. Maintenance 顺序

以下工具默认全部只读：

```text
node scripts/maintenance/migrate-v3-runtime-schema.mjs --dry-run
node scripts/maintenance/reconcile-campaign-terminal-state.mjs --dry-run
node scripts/maintenance/classify-unassigned-contacts-as-others.mjs --dry-run
node scripts/maintenance/migrate-customer-identity.mjs --dry-run
node scripts/maintenance/migrate-send-eligibility.mjs --dry-run
node scripts/maintenance/migrate-sales-stage-followup.mjs --dry-run
node scripts/maintenance/migrate-campaign-model.mjs --dry-run
node scripts/maintenance/migrate-dashboard-ai-auditor.mjs --dry-run
node scripts/maintenance/migrate-ai-change-tracking.mjs --dry-run
```

真正 Apply 必须等待所有 Campaign 完成／明确停止，并保持 Scheduler 不再启动新批次：

1. Runtime Schema Migration
2. Campaign terminal reconciliation
3. Others classification
4. `PRAGMA quick_check` 与 `foreign_key_check`
5. Customer Identity migration 305
6. Unified Send Eligibility migration 306
7. Sales Stage + Follow-up migration 307
8. Campaign Model migration 308
9. Dashboard AI Auditor migration 309
10. AI Change Tracking migration 310
11. Restart Mamba，再恢复 Scheduler

任一工具看到 `RUNNING`／`SENDING`／`QUEUED_BATCH` Run 时都必须拒绝写入；不能只因
一段时间没有新日志就把 Campaign 当成 stale。
