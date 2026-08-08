# Mamba Customer Database Rebuild Plan

> 状态：Batch 1 工具已建好并完成 dry-run；尚未对生产库做任何写入。
>
> 更新日期：2026-08-08
>
> 目标：把现有客户、身份、对话、发送证据与销售资料安全整理进一份新的 SQLite，
> 在完整验证前不覆盖 `campaign-data/mamba.sqlite`。

## 1. 结论

可以重新整理客户数据库，但不能只把电话号码和名字复制到一个新 SQL。

Mamba 的客户资料同时包含：

- 稳定 Customer Identity
- Project Lead 与销售状态
- WhatsApp Conversations／Messages
- STOP、Suppression、Consent
- Campaign membership 与发送结果
- Follow-up、预约、成交与 commission
- Notion mapping、sync、conflict 与 audit

推荐使用 **side-by-side rebuild**：旧数据库保持只读，在旁边建立新数据库，完成导入、
去重、验证和人工抽样后才切换。旧数据库和 backup 不删除。

```text
旧 mamba.sqlite（只读证据）
        │
        ├── audit / export / classify
        ▼
rebuild staging package
        │
        ├── identity resolution
        ├── message deduplication
        ├── relation rebuild
        └── conflict queue
        ▼
mamba.rebuild.sqlite（新 schema 304–310）
        │
        ├── counts / hashes / foreign keys
        ├── STOP / send evidence verification
        └── human sample review
        ▼
明确确认后 cut over
```

## 2. 当前已确认的问题

以下数字是 2026-08-08 的诊断 snapshot；执行前必须重新 audit，不能写死成未来事实。

| 范围 | 当前情况 | 影响 |
|---|---|---|
| Schema | `schema_migrations` 只到 303 | 304–310 功能代码已载入，但生产表不存在 |
| Campaign ledger | 6 条旧 run 仍标成 `RUNNING`，另有 5 条 `PARTIAL` | 只有 `RUNNING` 会以 `active_campaigns` 阻止 migration；`PARTIAL` 不阻止 |
| Terminal reconciliation | 共 9 条 terminal run 可修复，当前没有真实 active run | SQLite ledger 与 run JSON 不一致 |
| 无证据的 ledger run | 2 条 `PARTIAL` 在 `campaign-data/runs/` 没有对应 run JSON | 没有 terminal 证据，reconcile 不会碰；需人工决定 |
| 缺失的 ledger row | 18 个 terminal run JSON 在 `campaign_runs` 没有对应 row | 发送证据只存在于磁盘，未进入账本 |
| Message identity | 5,170 个重复 group／5,170 条 extra rows | Migration 305 无法建立唯一约束 |
| Customer Identity | `customers` 等 migration 305 表不存在 | Customer Identity 页面不可用 |
| Eligibility | migration 306 表不存在 | 新统一发送许可尚未成为运行账本 |
| Sales Pipeline | migration 307 表不存在 | Sales 页面和 follow-up task 不可用 |
| Campaign Model | migration 308 表不存在 | Campaign／Run／Member 新模型不可用 |
| Dashboard／AI Changes | migration 309／310 表不存在 | 页面只能显示 Setup Required |

重复 message group 的现有分类（2026-08-08 由 `audit-customer-database-rebuild.mjs` 实测确认）：

| 类型 | Groups | 可自动合并 | 需人工 | 处理原则 |
|---|---:|---:|---:|---|
| inbound `evolution + evolution` | 3,041 | 3,041 | 0 | 内容、方向、时间、conversation 完全相同，可自动合并 |
| outbound `phone + phone` | 2,107 | 2,107 | 0 | 内容相同；少数时间差 1–10 秒，保留一条并合并 payload |
| outbound `blast + phone` | 17 | 11 | 6 | 保留 `blast` 的 Campaign／delivery evidence，同时补入 provider history evidence |
| outbound `manual + phone` | 5 | 5 | 0 | 保留 `manual` 业务来源，同时补入 provider history evidence |
| **合计** | **5,170** | **5,164** | **6** | |

### 2.1 `message_type` 降级（原计划未预见）

审计发现其中 592 组的两条 row `message_type` 不同：**恰好一条是 `text`，另一条是真实媒体
类型**（image／sticker／document／video），且文字完全相同，媒体那条额外带有
`mediaKind`／`mediaFileName`／`mime`。

这说明早期 ingest 在媒体尚未解析时把消息记成了 `text`，之后 Evolution history 补回同一条
消息时才带上真实类型。因此这是**可判定的证据升级，不是冲突**：canonical row 取媒体类型并
合并媒体证据。只有出现两种以上非 `text` 类型才算真冲突。

### 2.2 占位符文字（原计划未预见，且反转了规则 3）

剩下 6 组 `TEXT_MISMATCH` 逐条查过，是两种**方向相反**的占位符：

| 模式 | Groups | 现象 | 取哪一版 |
|---|---:|---|---|
| `PLACEHOLDER_ONLY_TEXT` | 3 | history 侧整条只有 `[reply]`，等于没记内容 | `blast` |
| `UNRENDERED_TEMPLATE_TEXT` | 3 | `blast` 侧是变量替换**之前**的模板（含 `[Phone_Number]`），history 侧才是客户实际收到的渲染结果 | `phone` |

第二种直接反转了 §3.2 规则 3。「blast／manual 优先于 phone」对 Campaign 元数据
（runId、template、flow）成立，但**对消息正文不成立**：如果按业务来源无条件优先，
就会把未渲染的 `[Phone_Number]` 写成「客户收到了什么」的正式记录。

因此正文与身份分开决定：

- **canonical row**（身份、Campaign 元数据）→ 业务来源优先，规则不变。
- **正文** → 取客户实际收到的那一版。

判定条件很窄，只在两边文字**仅在「一侧是方括号占位符」这一点上不同**时成立；
模式 2 还要求模板骨架在另一版里按顺序原样出现。任何其他文字差异仍然进 conflict。

任何执行报告都不得输出完整电话号码、客户姓名、原始消息文字、Token 或 API Key。

## 3. 哪些 SQL 需要修理

### 3.1 `campaign_runs` terminal state

问题：run JSON 已经是 `COMPLETED`、`STOPPED` 或 `CANCELLED`，但 SQLite 仍是
`RUNNING`／`PARTIAL`。

> **Schema 顺序陷阱（2026-08-08 实测）**
>
> base schema 的 CHECK 约束是
> `status IN ('QUEUED','RUNNING','PARTIAL','COMPLETED','FAILED','STOPPED')`，
> **不接受 `CANCELLED`**；接受它的是 migration 308（`308-campaign-model.sql`）。
> 但 reconcile 是第 2 步，308 是第 8 步。
>
> 因此 reconcile 不能把 `CANCELLED` 写进 308 之前的账本。工具现在会先读出当前
> schema 允许的状态集合，把不被接受的 run 归入 `deferredBySchema` 跳过，其余照常修。
> 待 308 应用后重跑，这些 run 会自动补上。
>
> 这不是可选的优化：所有 UPDATE 在同一个事务里，一条 `CANCELLED` 触发约束失败会
> 让整批回滚——本来能修的 6 条也一起失败，而工具此前会把这次失败报告成成功。

处理：

- 只接受 run JSON 中已经有 terminal status 和 `finishedAt` 的记录。
- 当前真实 runtime 必须没有 active Campaign。
- 已经是 terminal、但两边 terminal status 不同的记录进入 conflict，不自动覆盖。
- Apply 前建立 SQLite online backup。
- 更新 status、finished time、requested／sent／failed summary；不改写 send jobs。

现有工具：

```bash
# dry-run
node scripts/maintenance/reconcile-campaign-terminal-state.mjs

# 只有 dry-run 显示 activeRuns=[]、terminalConflicts=[] 后才允许
node scripts/maintenance/reconcile-campaign-terminal-state.mjs --apply
```

当前 dry-run：`repairable=6`（全部是挡住 migration 的 `RUNNING`）、
`deferredBySchema=3`（全部是 `PARTIAL → CANCELLED`，不挡 migration）、
`terminalConflicts=0`。

### 3.2 `messages` canonical identity

问题：同一 `(connection_key, external_message_id)` 有多条 row，而且旧
`idempotency_key` 可能是在 connection identity 完整前生成。

目标唯一键：

```text
connection_key + Evolution external_message_id
```

处理规则：

1. 不跨 connection 合并。同一个 provider message ID 在不同 sender 上可以是不同消息。
2. 同一 group 必须保持相同 direction 与 conversation；任何一项不同直接进入 conflict。
2b. `message_type` 例外：一条 `text` ＋ 恰好一种非 `text` 类型时取媒体类型（见 §2.1）；
   出现两种以上非 `text` 类型才算 conflict。
2c. 文字例外：仅在一侧是方括号占位符时可判定（见 §2.2）；其余文字差异进 conflict。
3. `blast`／`manual` 业务来源优先于 history 的 `phone` 标签——**但只限身份与 Campaign
   元数据**。正文取客户实际收到的那一版，见 §2.2。
4. `phone` row 的 provider timestamp、remote JID、LID、media evidence 可以补入 canonical row。
5. Delivery status 采用等级较高且时间较新的证据，不可把 READ 降回 SERVER_ACK。
6. Campaign `runId`、flow topic、template、send result 不得被空 history payload 覆盖。
7. 被合并 row 先写入 maintenance archive／manifest，再从 active table 移除。
8. 无法自动判断的 group 写入 conflict package，等待人工决定。
9. 重跑同一 repair 必须得到 `0 changes`。

工具：`scripts/maintenance/repair-duplicate-message-identity.mjs`（已建好）。

接口：

```bash
# 只报告；默认行为
node scripts/maintenance/repair-duplicate-message-identity.mjs --dry-run

# 先建立 backup + archive manifest，再合并
node scripts/maintenance/repair-duplicate-message-identity.mjs \
  --apply --confirm APPLY_MESSAGE_IDENTITY_REPAIR_V1
```

工具输出只允许包含 group count、source pair、时间差、内容 hash、row ID 和 conflict code；
不得输出客户文字或电话号码。

### 3.3 Customer Identity（Migration 305）

需要建立／回填：

- `customers`
- `customer_identities`
- `identity_conflicts`
- `identity_unresolved_events`
- `customer_merge_events`
- `identity_backfill_state`
- `contacts.customer_id`
- `conversations.customer_id`
- `messages.customer_id`
- `project_leads.customer_id`

原则：

- `customer_id` 是永久身份；phone、JID、LID 只是 alias。
- Display name 不得作为自动合并证据。
- 同一 phone／LID 指向不同 customer 时进入 conflict。
- Merge 可逆；必须有 merge event 和 source customer snapshot。
- Phone 改变不得产生一个新的客户，除非证据确定是不同的人。

### 3.4 Notion Sync（Migration 304）

需要建立：

- `crm_customer_profiles`
- `notion_entity_map`
- `sync_inbox`
- `sync_conflicts`
- `sync_audit_events`
- `sync_reconciliation_runs`

Migration 304 必须先于 305。Apply 后 sync 仍保持 paused，不能因为表建立完成就自动 push
或 pull Notion。

### 3.5 Send Eligibility（Migration 306）

需要建立：

- `campaign_memberships`（兼容阶段）
- `send_eligibility_decisions`
- `send_eligibility_locks`
- `global_suppressions`
- `customer_follow_up_tasks`
- `customer_state_events`

STOP、Consent、Suppression、reply pause 与 resend evidence 必须完整迁移。缺少 evidence 时
fail closed，不能用“新数据库比较干净”作为允许发送的理由。

### 3.6 Sales Pipeline（Migration 307）

需要建立／扩充：

- `project_leads.sales_stage`
- `project_leads.temperature`
- `project_leads.next_action`
- `project_leads.next_follow_up_at`
- `project_leads.assigned_agent`
- `project_leads.lost_reason`
- `sales_opportunities`
- `customer_follow_up_tasks`
- `sales_activities`

导入客户不等于自动建立 opportunity。只有客户 evidence 或人工 promotion 才能进入销售机会。

### 3.7 Campaign Model（Migration 308）

需要建立／扩充：

- `campaigns`
- `campaign_members`
- `campaign_steps`
- `campaign_outcomes`
- `campaign_runs.campaign_id`
- `campaign_runs.step_id`
- `campaign_runs.connection_id`
- `campaign_runs.device_id`
- `campaign_runs.summary_json`

旧 run 只做历史 projection，不得因为 import 而重新进入 Queue 或发送。

### 3.8 Dashboard 与 Change Tracking（Migration 309–310）

需要建立：

- `lead_audit_analyses`
- `lead_audit_events`
- `ai_change_requests`
- `ai_change_steps`
- `ai_change_events`
- `ai_change_files`
- `ai_change_tests`

这些表不影响发送授权。AI 只能建议，不能因为 rebuild 自动发消息或修改 human-owned stage。

## 4. 需要什么工具

### 4.1 已经存在，可以复用

| 工具 | 用途 | 默认安全行为 |
|---|---|---|
| `reconcile-campaign-terminal-state.mjs` | 修复 terminal run ledger | dry-run |
| `migrate-sqlite-notion-sync.mjs` | Migration 304 | dry-run + confirmation |
| `migrate-customer-identity.mjs` | Migration 305 | dry-run + confirmation |
| `migrate-send-eligibility.mjs` | Migration 306 | dry-run + confirmation |
| `migrate-sales-stage-followup.mjs` | Migration 307 | dry-run + confirmation |
| `migrate-campaign-model.mjs` | Migration 308 | dry-run + confirmation |
| `migrate-dashboard-ai-auditor.mjs` | Migration 309 | dry-run + confirmation |
| `migrate-ai-change-tracking.mjs` | Migration 310 | dry-run + confirmation |
| `evolution-history-sync.mjs` | 补回 Evolution history | 幂等读取／本机写入；不发送 |
| `backfill_lid_map.mjs` | 建立 LID evidence mapping | 必须先审计 unresolved／conflict |

### 4.2 必须新增

状态：A 与 B 已建好并通过测试（`campaign-app/test_customer_database_rebuild_tools.mjs`）；
C–G 尚未开始。共用的只读检查集中在
`scripts/maintenance/lib/customer-database-inspection.mjs`，避免 audit、repair、verify
三边对「重复」「孤儿」的定义漂移。

#### A. `audit-customer-database-rebuild.mjs` ✅ 已建好

统一只读 audit：

- schema versions／checksums
- active Campaign／Queue／runner
- duplicate message identity
- customer／phone／LID conflicts
- orphan conversation／message／project lead
- STOP／suppression／consent counts
- Notion mapping conflicts
- migration readiness

输出汇总 JSON 和 Markdown，不包含 PII；报告写入
`campaign-data/maintenance-archive/audits/`。有阻塞问题时 exit code 为 2。

```bash
node scripts/maintenance/audit-customer-database-rebuild.mjs
```

注意：审计把「真的在发送」（runtime state file）和「账本没收尾」（`campaign_runs` 里的
非 terminal row）分开报告。前者要等它跑完，后者用 reconcile 修；混成一个数字会让人以为
必须等 Campaign 结束，实际上运行时是空闲的。

#### B. `repair-duplicate-message-identity.mjs` ✅ 已建好

执行第 3.2 节的 message merge，支持 dry-run、backup、archive、conflict、verification、
idempotent rerun。完整 merge 明细写进 archive 文件，终端只打摘要。

#### C. `export-customer-rebuild-package.mjs`

从旧库导出 versioned staging package：

- `manifest.json`
- `customers.jsonl`
- `identities.jsonl`
- `project-leads.jsonl`
- `conversations.jsonl`
- `messages.jsonl`
- `permissions.jsonl`
- `campaign-evidence.jsonl`
- `sync-mappings.jsonl`
- `conflicts.jsonl`

Package 保存在 `campaign-data/maintenance-archive/`，不得进入 Git。

#### D. `build-clean-customer-database.mjs`

建立 `campaign-data/mamba.rebuild.sqlite`：

- 产生新的 database ID。
- 顺序安装 base schema 与 migrations 301–310。
- 不复制 secret、queue lock 或运行中 process state。
- 默认不更改当前 Mamba database path。

#### E. `import-customer-rebuild-package.mjs`

按 dependency order 幂等导入：

```text
customers
→ identities
→ projects / contacts / project_leads
→ connections / conversations / messages
→ permissions / suppression
→ campaigns / runs / jobs / outcomes
→ sync mappings / tasks / activities
```

重复导入不得增加 row count；conflict 不自动覆盖。

#### F. `verify-customer-database-cutover.mjs`

比较旧库与新库：

- customer、message、conversation、project lead 数量
- 每个 sender 的 inbound／outbound 数量
- STOP／suppression／consent 数量和 digest
- Campaign sent／failed／unknown 数量
- orphan、duplicate、foreign key、`quick_check`
- 随机抽样 customer timeline（本机显示，不写报告内容）
- 所有 migration checksum 和 required index

#### G. `cutover-customer-database.mjs`

最后一步；必须：

- 确认没有 active LIVE／TEST／Queue／Sync。
- 要求明确 confirmation token。
- graceful stop Mamba。
- 对旧库做最后 online backup 和 manifest。
- 原子切换文件；旧库改名归档，不删除。
- 启动后只做 read-only smoke test。
- 任一 smoke test 失败立即 rollback 到旧库。

## 5. Migration 顺序

有两条路径，不能混在同一次 apply 中。

> **决定（2026-08-08）：改走 Path A。**
>
> 计划原本默认 Path B，但那是在数据库状况未知时定的。审计完成后
> `quick_check` ok、foreign key 0、orphan 全 0、重复 identity 已清零——
> 当初选 Path B 的前提消失了。改判理由：
>
> 1. **工具存量相反。** Path A 用的 7 个 migration 工具已存在、有测试、每步自带
>    dry-run + confirmation + 备份 + 事后验证。Path B 还需新写 5 个工具（C–G），
>    风险集中在 import 要重建全部关系。
> 2. **STOP 存活方式不同。** 见 §9「STOP 证据在两条路径下的存活方式」。
>    Path A 自动存活；Path B 取决于新写的 import 代码。
> 3. **破坏性只有一处。** 304／306／309／310 纯新增，305／307 新增 + 回填，
>    只有 308 会重建 `campaign_runs`（copy → drop），且有备份与事后校验。
>
> 工具 C–G 暂不实现。若日后需要迁移到别的机器或做灾难恢复，再按 Path B 补。

### Path A 执行清单（token 以工具源码为准）

每个工具的 confirmation token **不能靠迁移名推测**，例如 304 是
`APPLY_SQLITE_NOTION_SYNC_V1` 而不是 `APPLY_NOTION_SYNC_V1`。token 错了工具会
抛 `*_CONFIRMATION_REQUIRED` 并以 exit 1 退出，**什么都不做**——从数据库看不出
区别，很容易误以为已经跑过。

| 步骤 | 命令 | Confirmation token |
|---|---|---|
| 304 | `migrate-sqlite-notion-sync.mjs` | `APPLY_SQLITE_NOTION_SYNC_V1` |
| 305 | `migrate-customer-identity.mjs` | `APPLY_CUSTOMER_IDENTITY_V1` |
| 306 | `migrate-send-eligibility.mjs` | `APPLY_SEND_ELIGIBILITY_V1` |
| 307 | `migrate-sales-stage-followup.mjs` | `APPLY_SALES_PIPELINE_V1` |
| 308 | `migrate-campaign-model.mjs` | `APPLY_CAMPAIGN_MODEL_V1` |
| 309 | `migrate-dashboard-ai-auditor.mjs` | `APPLY_DASHBOARD_AI_AUDITOR_V1` |
| 310 | `migrate-ai-change-tracking.mjs` | `APPLY_AI_CHANGE_TRACKING_V1` |

每步跑完用 `schema_migrations` 确认版本真的写进去了：

```bash
/usr/bin/sqlite3 -readonly campaign-data/mamba.sqlite \
  "SELECT version,name FROM schema_migrations ORDER BY version;"
```

Migration 308 之后重跑一次 `reconcile-campaign-terminal-state.mjs --apply`，
补上 3 条 `PARTIAL → CANCELLED`（见 §3.1）。

页面不需要重启服务器：schema 状态是每次请求实时查的，表建好后自动恢复。

### Path A：原地修复现有数据库

```text
Audit
  ↓
Reconcile terminal Campaign ledger
  ↓
Migration 304
  ↓
Repair duplicate message identity
  ↓
Migration 305
  ↓
Migration 306
  ↓
Migration 307
  ↓
Migration 308
  ↓
Migration 309
  ↓
Migration 310
```

这条路可以较快恢复新页面，但所有 migration 都直接作用在当前数据库；即使有 backup，
风险仍高于旁路重建。

### Path B：旁路建立新数据库（推荐）

```text
Audit old DB
  ↓
Reconcile terminal Campaign ledger
  ↓
Canonical export / duplicate classification
  ↓
Build mamba.rebuild.sqlite
  ↓
在新库顺序安装 301 → 310
  ↓
Import canonical package
  ↓
Verify old DB ↔ new DB
  ↓
Human approval → Cutover → Smoke test
```

Path B 不要求先把 304–310 apply 到旧生产库。Duplicate repair 可以发生在旧库的可恢复
maintenance transaction 中，也可以由 export 工具只输出 canonical row、把原 row 全部保留在
旧库；无论采用哪一种，必须得到相同的 conflict report 和 verification digest。

每一步完成后必须重新 dry-run 下一步。不得一次 shell command 把所有 migration 串起来；
任何一关失败都停止。

## 6. 不可违反的原则

### 数据原则

1. SQLite 是运行期间唯一事实来源；Notion 是受控 mirror。
2. 旧数据库只读保留，不原地覆盖，不永久删除。
3. `customer_id` 永久稳定；phone／JID／LID 是可变 alias。
4. Message identity 是 connection-scoped，不能跨 sender 去重。
5. STOP、Suppression、Consent 和发送证据比 CRM 展示字段优先。
6. 冲突进入明确 queue；不使用 display name 或 last-write-wins 猜答案。
7. 所有改变可追踪、可重复执行、可 rollback。

### 发送安全原则

1. Rebuild、import、verify、migration 都不得调用 Evolution send API。
2. 新数据库在 cutover 前 `LIVE` 必须 fail closed。
3. 缺少 TEST recipients 时继续 fail closed。
4. 状态不明确的发送不自动补发。
5. 旧 Campaign import 后永远不会自动 resume／retry／queue。

### 工具原则

1. 所有 maintenance 默认 dry-run。
2. Apply 必须有明确 `--apply` 和 confirmation token。
3. Apply 前 online backup；之后 `quick_check`、foreign key 和 required index 验证。
4. Report 默认只给 count、hash、row ID、error code，不给 PII。
5. Archive 与 manifest 存在 runtime folder，不进入 Git／Notion。
6. 工具失败不得留下半套 schema；transaction 或原子 file switch。

## 7. Cutover 验收条件

只有全部满足才可切换：

- [ ] 当前没有 active Campaign、Queue、Retry、Notion Sync。
- [ ] Migration 301–310 checksum 全部正确。
- [ ] `PRAGMA quick_check` 为 `ok`。
- [ ] Foreign key violations 为 0。
- [ ] Duplicate message identity 为 0。
- [ ] Orphan customer／conversation／message／project lead 为 0。
- [ ] 所有 STOP／suppression／consent digest 与旧库一致。
- [ ] Campaign sent／failed／unknown totals 与旧库一致。
- [ ] Customer 与 message count 差异都有 manifest reason。
- [ ] Identity conflicts 已解决或明确隔离，不影响其他客户。
- [ ] UI schema status 全部 `ready=true`。
- [ ] Dashboard、Customer Identity、Sales、Campaign、AI Changes smoke test 通过。
- [ ] Tracker webhook 与 bounded catch-up 正常，且 catch-up 重跑新增 0。
- [ ] Notion sync 仍为 paused，等待人工恢复。
- [ ] 旧数据库 backup 与 rollback 命令已验证。

## 8. 建议执行批次

### Batch 1：修理现有资料，但不 cut over

- 建 audit 工具。
- 修复 terminal Campaign ledger。
- 建 duplicate message repair 工具并先 dry-run。
- 修复所有页面的 Setup Required 状态。
- 不迁移、不重启、不发送。

### Batch 2：建立干净数据库

- 解决 message duplicate／identity conflict。
- 应用 migration 304–310 到 staging／rebuild database。
- export、import、verify。
- 旧生产数据库继续运行，只读保留。

### Batch 3：明确确认后 cut over

- 停止 Campaign／Queue／Sync。
- 最终 backup。
- 原子切换。
- 启动与 smoke test。
- 通过后人工恢复 Notion sync；LIVE 发送仍需正常确认。

## 9. 执行记录

### 2026-08-08 · Batch 1 工具完成，dry-run 通过

已建好：

- `scripts/maintenance/lib/customer-database-inspection.mjs` — 共用只读检查与合并规则
- `scripts/maintenance/audit-customer-database-rebuild.mjs` — 工具 A
- `scripts/maintenance/repair-duplicate-message-identity.mjs` — 工具 B
- `campaign-app/test_customer_database_rebuild_tools.mjs` — 覆盖合并规则、PII、
  幂等、confirmation、active-campaign 阻断与跨连接不合并

Dry-run 结果（生产库只读）：

| 项目 | 结果 |
|---|---|
| 真正在发送的 run | 0（运行时空闲） |
| Terminal ledger 可修复 | 9 条 |
| Terminal 冲突 | 0 |
| 重复 message group | 5,170 → 可自动合并 5,164、需人工 6 |
| `PRAGMA quick_check` | ok |
| Foreign key violations | 0 |
| Orphan（message／conversation／lead／send job） | 全部 0 |

### 2026-08-08 · Batch 1 apply

**Message identity 合并：成功。** 22,965 → 17,801（-5,164）。5,164 行原样归档、
6 组冲突留档，`quick_check` ok、foreign key 0、剩余可合并 group 0、重跑 0 changes。

**Terminal ledger reconcile：第一次失败，已修工具。** 失败原因是上面 §3.1 的 schema
顺序陷阱——`CANCELLED` 不被当前 CHECK 约束接受，整个事务回滚，9 条一条没改。
备份已建、数据未变、无损坏。工具修好后 dry-run 为 `repairable=6, deferred=3`，
待重跑。

同时修掉一个会掩盖此类失败的问题：写入路径原本没有 `-bail`，sqlite3 遇错会跳过
并以 0 退出，工具会把没生效的修复报告成成功。

重跑后 reconcile 成功：6 条 `RUNNING` 全部收尾（→ 4 COMPLETED、2 STOPPED），
`RUNNING` 归零，migration 304 的 `active_campaigns` 阻塞解除。

### 2026-08-08 · 占位符规则与路径决定

加入 §2.2 的占位符文字判定后，最后 6 组冲突全部可判定
（`PLACEHOLDER_ONLY_TEXT` 3 组、`UNRENDERED_TEMPLATE_TEXT` 3 组），
dry-run 冲突数归零。路径改判为 Path A，见 §5。

未做（等人工确认）：

- 最后 6 组合并尚未 apply。
- Migration 304–310 尚未开始。
- 3 条 `PARTIAL → CANCELLED` 待 migration 308 之后重跑 reconcile。
- 2 条无 run JSON 的 `PARTIAL` ledger row 未处理。
- 18 个「有 run JSON 但账本无 row」的 run 未回填。

### STOP 证据在两条路径下的存活方式（已核实）

`contact_permission_events` 目前是 **0 行**，STOP 证据只存在于 `contacts.stop_flag`
（61 个联系人）。

发送许可判断读三个独立来源，任一命中即拒发
（`domain/send-eligibility.mjs:98`）：

```js
if (globalStatus === "STOP" || customer.stopFlag === true || customer.isSuppressed === true)
```

- `stopFlag` ← `contacts.stop_flag`
- `globalStatus` ← `customers.global_status`
- `isSuppressed` ← `global_suppressions`

Migration 306 建了 `global_suppressions` 但**不会**从 `stop_flag` 回填它；305 会把
`stop_flag=1` 写成 `customers.global_status='Stop'`。

因此：

- **Path A（原地）**：`contacts.stop_flag` 原封不动，305 再补一份 `global_status`，
  两个来源都在，STOP 自动存活，无需额外工作。
- **Path B（旁路）**：STOP 能不能活下来，完全取决于 import 工具有没有把
  `stop_flag` 正确带过去。这是必须显式验证的一项，不能假设。

## 10. 明确不做

- 不从 Notion 重建完整 message ledger。
- 不把 Evolution PostgreSQL 当成 Mamba 业务数据库。
- 不把所有同号码 row 无条件合并。
- 不因为建立新库而清除 STOP／suppression。
- 不在 migration 完成后自动启动 Campaign、Retry、Sync 或 AI action。
- 不删除旧 SQLite、run JSON、send evidence 或 maintenance archive。
- 不把真实客户资料、电话、对话或 rebuild package commit 到 Git。
