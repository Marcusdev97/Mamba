# MAMBA 数据库表结构(SQLite)—— Systematic Schema

> **配套文件**:`docs/mamba-schema.sql`(可直接运行的建表脚本)
> **日期**:2026-07-17 · **Schema 版本**:v3
> **原则来源**:`docs/MAMBA_ARCHITECTURE_ADR.md`(本地优先)+ `docs/MAMBA_DATABASE_KEYS.md`(键规则)

这份文档回答"我的数据库要怎么写":把你现在 Notion 里的每个库,系统化地映射成一套干净的 SQLite 表。

---

## 0. 三条设计铁律

1. **双键策略**(最重要的决定):
   - `contact_key = 归一化电话` —— 回答"这是谁"。**STOP / 退订 / 对话历史**都按它走。
   - `project_lead_key = project_code:phone` —— 回答"这个人在哪个盘"。**flow 序列状态**(下一轮、到期日)按它走。
   - 一个人可以同时在 Binastra 和 Gen Starz,互不覆盖。
2. **路由只用稳定 key**:`project_code`(gen_starz)、`device_key`(cici_macbook_pro)、`connection_key = device_key::真实号码`。`wa_01` 只是本机 Evolution instance 名,两台电脑可以重复,**永远不当跨电脑唯一键**。
3. **Notion 里驱动业务的字段全部提升为一等列**(`next_flow`、`follow_up_due`、`stop_flag`、`reply_count`…),不再塞进 `payload_json`。`payload_json` 只留"其它不常查的原始字段",做同步兜底。

---

## 1. 一览:Notion 库 → SQLite 表

| Notion 库 | SQLite 表 | 唯一键 | 说明 |
|---|---|---|---|
| Blast Leads(人) | **`contacts`** | `contact_key` = phone | 全局身份,承载 STOP |
| Blast Leads(项目状态) | **`project_leads`** | `project_lead_key` | flow 序列状态,核心表 |
| Ads Leads | `ads_leads` | `ad_lead_key` | 广告来源线索 |
| Recycle Leads | `recycle_leads` | `recycle_lead_key` | 旧名单/回收 |
| Campaign Templates | `templates` | `template_key` | 话术,多 Active = 变体轮换 |
| Images | `images` | `asset_key` = image_name | 素材 + 云端 URL |
| Campaign Runs | `campaign_runs` | `run_id` | 一次群发一行 |
| Project Knowledge | `project_knowledge` | `fact_key` | AI 只引用 `verified=1` |
| Golden Conversations | `golden_conversations` | `golden_key` | 成功对话样本 |
| Objection Bank | `objection_bank` | `objection_key` | 异议解码 |
| AI Reply Log | `ai_reply_log` | `reply_log_key` | robot 草稿 + 人工终版 |
| WhatsApp Connections(Settings) | `whatsapp_connections` | `connection_key` = device::phone | 号码 registry;`wa_01` 只作本机 instance 名 |
| Devices(本地配置) | `devices` | `device_key` | 送锁 + 审计 |
| Projects(projects.json) | `projects` | `project_code` | 项目 registry |
| 对话历史(jsonl) | `conversations` + `messages` | id | 按"人"归档 |

另有系统表:`sync_jobs`、`operations`、`ownership_changes`、`import_runs`、`system_logs`、`sync_worker_state`、`metadata`、`schema_migrations`。

---

## 2. 核心表:`project_leads` 字段映射

这是最重要的表。Notion `Blast Leads` 字段 → SQLite 列:

| Notion 字段 | SQLite 列 | 备注 |
|---|---|---|
| Phone | `phone` / `contact_key` | 归一化数字 |
| Project | `project_code` | 存 code,不存 display |
| Project Lead Key | `project_lead_key`(PK) | `project_code:phone` |
| Name | `name` | |
| Sequence Status | `sequence_status` | ACTIVE/PAUSED/EXITED |
| Last Flow Sent | `last_flow_sent` | |
| Next Flow | `next_flow` | |
| Cohort Day | `cohort_day` | |
| Follow Up Due | `follow_up_due` | 选人页按它筛"今天该发" |
| First/Last Blast At | `first_blast_at` / `last_blast_at` | |
| Assigned Sender Key | `assigned_sender_key` | → device_key::真实号码 |
| Last Sender Key / Phone | `last_sender_key` / `last_sender_phone` | 审计 |
| Last Sent By Device | `last_sent_by_device` | → device_key |
| Campaign Run ID | `campaign_run_id` | → campaign_runs |
| Send Lock / Locked By / Lock Until | `send_lock` / `locked_by_device` / `lock_until` | 多机送锁 |
| Reply Count | (在 `contacts.reply_count`,人级别) | |
| AI Category / AI Summary | `ai_category` / `ai_summary` | |
| Stop Flag | (在 `contacts.stop_flag`,人级别) | |
| Priority / Follow Up At / Assigned Sales / Sales Notes | 同名列 | 人工跟进 |
| Appointment Date/Time/Place/Status | `appointment_*` | 约看 |
| 其它零散字段 | `payload_json` | 同步兜底 |

**为什么 Stop Flag / Reply Count 放 `contacts` 不放 `project_leads`**:退订和回复是"这个人"的属性,跨所有项目生效。一个人退订了,他在所有盘都不该再收。放人级别表天然做到这点。

---

## 3. "谁该发下一轮"——一条 SQL 说清楚

新结构下,这个核心判断不用再翻 payload:

```sql
SELECT project_lead_key, next_flow, follow_up_due
FROM project_leads
WHERE sequence_status = 'ACTIVE'
  AND follow_up_due <= date('now')            -- 到期
  AND send_lock = 0                            -- 没被别的电脑锁着
  AND contact_key NOT IN (                     -- 没退订
        SELECT contact_key FROM contacts WHERE stop_flag = 1
      );
```

发送前抢锁(多机安全):

```sql
UPDATE project_leads
SET send_lock = 1, locked_by_device = 'cici_macbook_pro',
    lock_until = datetime('now','+5 minutes')
WHERE project_lead_key = ? AND (send_lock = 0 OR lock_until < datetime('now'));
```

---

## 4. 模板匹配与轮换

`templates` 按 **Flow Topic + 项目 + Part + 语言 + 状态** 匹配(不是按天数):

```sql
SELECT template_key, message_text, image_name
FROM templates
WHERE project_code = ? AND flow_topic = ? AND part_no = ?
  AND language = ? AND status = 'Active';
-- 返回多条 = 变体,发送时随机抽一条(防 spam)
```

`template_key` 例:`gen_starz:f01:p1:en:v2`。改一点文案就是新 version,不复用旧 key。

---

## 5. 和现有 v2 壳的关系

你 07-17 建的 `local-database-service.mjs`(schema v2)已经实现了:`devices`、`sender_accounts`、`customers`、`conversations`、`messages`、`operations`、`ownership_changes`、`sync_jobs`、`import_runs`、`sync_worker_state`。

v3 相对 v2 的**主要变化**:

1. **拆双键**:v2 的 `customers`(把人和项目状态混在一起)拆成 `contacts`(人)+ `project_leads`(人×项目)。这是把 key-map 的「Most Important Decision」落地。
2. **提字段**:把 Notion 里 `next_flow` / `follow_up_due` / `stop_flag` 等从 blob 提成列。
3. **补业务表**:新增 `projects`、`whatsapp_connections`、`templates`、`images`、`campaign_runs`、`send_jobs`,以及四张 AI 大脑表。
4. **对齐命名**:身份用 `device_key` / `connection_key`,与 key-map 一致。

> **迁移不用一次做完**。建议按 key-map「Implementation Order」小步走:先加表和列(不改发送行为)→ 写审计字段 → 切 `project_lead_key` 去重 → 上送锁。每步都能单独测。

---

## 6. 怎么用这份 schema

```bash
# 在一个全新的空库上建表(不会碰你现有 mamba.sqlite):
sqlite3 /tmp/mamba-v3-test.sqlite < docs/mamba-schema.sql

# 检查:
sqlite3 /tmp/mamba-v3-test.sqlite ".tables"
sqlite3 /tmp/mamba-v3-test.sqlite "PRAGMA quick_check;"
```

脚本里所有 `CREATE ... IF NOT EXISTS` 都是幂等的,可安全重复跑。已在 SQLite 3.37 验证:25 张表、外键检查干净、`quick_check = ok`。

> ⚠️ 别直接拿它覆盖生产库。迁移用配套脚本 `campaign-app/migrate_v2_to_v3.mjs`(见下节)。

---

## 7. v2 → v3 数据迁移脚本

配套脚本:**`campaign-app/migrate_v2_to_v3.mjs`**。把旧库(v2 `customers` 混合表)拆进 `contacts` + `project_leads`,并迁移身份表与对话消息。

安全设计:
- 默认 **`--dry-run`**:只对账、只出报告,不写任何数据。
- **`--apply` 也绝不改动原库**,只生成一个新文件(默认 `mamba.v3.sqlite`)。
- apply 后自动跑 `quick_check` + `foreign_key_check`,任一失败即中止。
- SQLite 驱动自动选择:优先系统 `sqlite3`(和线上代码一致),找不到时回退 Node 内建 `node:sqlite`(Node ≥ 22.5)。

```bash
# 1) 先对账(不写数据),看拆分数量、冲突、跳过项
node campaign-app/migrate_v2_to_v3.mjs

# 2) 确认无误后生成新库(原库不动)
node campaign-app/migrate_v2_to_v3.mjs --apply

# 自定义路径
node campaign-app/migrate_v2_to_v3.mjs --db campaign-data/mamba.sqlite --out campaign-data/mamba.v3.sqlite --apply
```

脚本会处理这些情况:同一号码跨多个项目 → 1 个 contact + 多个 project_lead;`stop_flag` / `reply_count` 从 payload 提升到 `contacts`;`next_flow` / `follow_up_due` 等从 payload 提升到列;同 (项目, 号码) 多行 → 保留 `updated_at` 最新的一行并把其余记入冲突报告;无效电话 / 孤儿消息 → 跳过并计数。报告写在 `<out 目录>/migration-reports/`。

> 自动化迁移测试覆盖:同一号码跨两个项目 → 1 个 contact + 2 个 project_lead、STOP 聚合、对话消息、`device::phone` Sender Key、`quick_check`、外键检查，以及原库保持不动。测试文件:`campaign-app/test_migrate_v2_to_v3.mjs`。
