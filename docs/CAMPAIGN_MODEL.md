# Campaign Model

> 状态：Current after migration 308 · 更新日期：2026-08-08

## 1. 边界

Campaign 是计划，Run 是一次执行。以下资料不可再混为同一个对象：

```text
Campaign → Campaign Steps
         → Campaign Members
         → Campaign Runs → Send Jobs
         → Campaign Outcomes
```

- `campaigns`：目标、项目、受众定义、目标数字、停止规则与 attribution window。
- `campaign_steps`：有顺序的 Flow／人工动作，不负责实际 Scheduler。
- `campaign_members`：一个客户在一个 Campaign 内的生命周期。
- `campaign_runs`：一次 TEST／LIVE 执行；同一 Campaign 可以有多个 Runs。
- `send_jobs`：最小发送动作，继续保存 provider 与 retry 证据。
- `campaign_outcomes`：Reply、Warm、Appointment、Viewing、Loan、Booking、SPA、Commission 的归因事实。

## 2. 安全不变量

- TEST Run 的 `requested_count` 不读取 LIVE Campaign Members；收件人仍只来自 `TEST_LEADS`。
- Draft Run 不发送消息；真正 Launch 继续走 Campaign Center 和 Send Eligibility。
- Global STOP 退出该 customer 所有 active memberships。
- Reply 只暂停最近有发送证据的相关 membership，不暂停同一 customer 的其它有效 Campaign。
- Appointment／Booking 只退出相关项目 Campaign；不等同 Global STOP。
- Outcome 必须发生在相关 Campaign activity 之后并位于 attribution window 内；人工 override 会明确保存 `HUMAN_OVERRIDE`。
- `campaign_outcomes.idempotency_key` 防止 webhook／reconciliation 重复计数。
- migration 308 只表示旧 Flow 行为，不改变模板、发送间隔、Scheduler 或恢复逻辑。

## 3. Legacy Flow adapter

Migration 会为每个已有 project 建立 `legacy:<project_code>` Campaign，并建立 Flow 1–10 Steps。旧 run 根据 `flow_no` 关联相应 Step。

Migration 后，旧 Campaign Center 每次完成本机 customer checkpoint，会幂等确保：

1. legacy Campaign 存在；
2. 当前 Flow Step 存在；
3. run 已关联 Campaign／Step；
4. customer 成为 active member，且 `last_activity_at` 来自已确认发送时间。

这只是本机 projection。它失败时不得重发已经由 WhatsApp provider 确认的消息。

## 4. Migration

```text
npm run db:campaign-model:dry-run
node scripts/maintenance/migrate-campaign-model.mjs --apply --confirm APPLY_CAMPAIGN_MODEL_V1
```

Apply 依赖 migration 307，并在任何 `RUNNING`／`SENDING`／`QUEUED_BATCH` run 存在时 fail closed。工具先备份，再执行 `quick_check` 与 `foreign_key_check`。

## 5. UI

`/campaigns` 是 Campaign Planning：建立 Draft、Steps、Members 与 Draft Runs，并显示 attribution metrics。它不取代 `/send`；当前版本仍由 Campaign Center 执行 TEST／LIVE。
