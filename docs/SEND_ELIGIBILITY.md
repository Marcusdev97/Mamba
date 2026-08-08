# Unified Send Eligibility

> 状态：Implemented in code · Migration 306 required · 更新日期：2026-08-08

## 1. 目的

Mamba 只有一个发送许可来源：

```text
domain/send-eligibility.mjs
  → lib/send-eligibility-repository.mjs
  → lib/send-eligibility-service.mjs
  → final provider call
```

页面筛选、Notion View、Campaign preview、Queue 状态和 AI 草稿都不能授权发送。每次实际
WhatsApp request 前必须重新检查、取得 customer lock、再检查一次；任何一步失败都不发送。

## 2. 决策顺序

`decideSendEligibility()` 使用固定优先顺序：

1. merged／unresolved identity
2. global STOP
3. invalid number
4. Booking／SPA／Won（只阻止 marketing）
5. meaningful inbound reply requiring handoff
6. active snooze
7. appointment
8. exited campaign membership
9. duplicate pending send／active customer lock
10. recent same-flow resend guard
11. AI proposal without human approval
12. unavailable connection
13. outside approved schedule
14. eligible

STOP 优先于所有低层原因。人工 reply、人工 appointment confirmation 和经人工批准的 AI
草稿不是 marketing action，但仍受 identity、STOP、invalid number、duplicate lock 和
connection availability 约束。

## 3. 强制入口

- Flow 1、Flow 2–10、Campaign Queue、Daily Campaign
- manual continue、restart recovery、retry failed
- scheduled follow-up
- Inbox text／image
- Mobile Template Preview（并且只允许 `TEST_LEADS`）
- Sales Brain proposal 与 Telegram 人工批准
- legacy terminal campaign launcher
- Campaign／bulk import preview

自动 Brain 的 rule reply 与 AI reply 都只建立 Telegram 待批准草稿。`AI_PROPOSED_SEND`
会产生 `AI_APPROVAL_REQUIRED` 审计，不会调用 Evolution；只有 `AI_APPROVED_REPLY` 才能进入
最终 lock。

## 4. SQLite 资料

Migration 306 新增：

- `campaign_members`（migration 308 后）：每位客户在 Campaign 内的 pause／exit 状态；308 前兼容 `campaign_memberships`。
- `send_eligibility_decisions`：每一次 allow／block 的 append-only 解释。
- `send_eligibility_locks`：同一 customer／recipient 同时只有一个 ACTIVE lock。
- `global_suppressions`：SQLite 全局 STOP 主账；JSON suppression 只保留兼容快照。
- `customer_follow_up_tasks`：reply handoff、snooze due、appointment／transaction task。
- `customer_state_events`：STOP／reply 等状态事件审计。
- `project_leads.snooze_until`：人工确认的暂停截止时间。

审计只保存业务状态，不保存 message body 或完整客户资料。Skipped CSV 可由：

```text
GET /api/send-eligibility/export?runId=<run_id>
```

导出。

## 5. STOP 与 Reply

STOP transaction 会同步更新：

- `customers.global_status = Stop`
- 所有 `contacts.stop_flag`
- 所有 active `project_leads`
- 所有 active `campaign_members`（308 前为 `campaign_memberships`）
- 尚未发送的 `send_jobs`
- `global_suppressions`
- `customer_state_events`
- `crm_customer_profiles` 与一个幂等 Notion outbox job

Meaningful reply 会将自动序列改成 `PAUSED_REPLY`、取消 future `PENDING` jobs、建立
`REPLY_HANDOFF` task。它不会自动标成 Warm。业务分类仍可记录为 `INTERESTED`、
`QUESTION`、`LATER`、`NOT_INTERESTED`、`STOP`、`WRONG_NUMBER`、`ALREADY_BOUGHT`、
`PRICE_CONCERN`、`LOCATION_CONCERN`、`LOAN_CONCERN`、`APPOINTMENT` 或 `OTHER`。

Snooze 到期只让 `SNOOZE_DUE` task 到期；不会自行启动发送。新的 Campaign action 仍必须
重新经过完整 eligibility。

Migration 307 的 `sales_stage` 是销售阶段主账。Sales Pipeline service 会同时维护
eligibility 兼容的 `project_leads.status`（例如 `SPA_SIGNED → SPA`）；因此 Booking、SPA、
Won 仍由这里的最终发送闸门阻止，UI stage 不能自行绕过。

## 6. Migration

只读预检：

```bash
node scripts/maintenance/migrate-send-eligibility.mjs --dry-run
```

Apply 必须等所有 Campaign 完成／停止，并明确确认：

```bash
node scripts/maintenance/migrate-send-eligibility.mjs \
  --apply --confirm APPLY_SEND_ELIGIBILITY_V1
```

工具要求 migration 305，检测 run JSON 与 SQLite 活动 Campaign，先建立 online backup，
最后执行 `quick_check`、foreign key 和必要表／字段验证。Server 不会在启动时偷偷 Apply。
