# Customer Identity

> 状态：Migration 305 已实现，生产尚未 apply · 更新日期：2026-08-08

## 目标与真相源

`customers.customer_id` 是一个人的稳定业务身份。电话号码、WhatsApp JID、LID、
Evolution remote JID、import ID、Notion page ID 与旧 `contact_key` 都只是 alias，保存在
`customer_identities`。名字是显示资料，不是身份；系统禁止只凭同名自动建立关联或合并。

SQLite 是 identity、conversation、message、conflict、merge audit 与 backfill checkpoint
的唯一运行真相源。Notion 只同步 CRM 摘要；raw message、完整 payload 和 identity evidence
不会进入 Notion。

## 解析规则

| Evidence | Confidence | 自动行为 |
|---|---:|---|
| 同一事件内已验证 phone ↔ LID | 100 | 绑定到同一 customer |
| 稳定 phone WhatsApp JID | 90 | 绑定到同一 customer |
| conversation continuity／legacy contact key | 80 | 继承现有 customer |
| import phone | 60 | 没有冲突时建立或绑定 customer |
| display name only | 30 | 禁止自动绑定 |

Confidence 不能解决语义冲突。如果同一 LID 已属于 customer A，而新证据同时指向
customer B，系统写入 `identity_conflicts` 与 `identity_unresolved_events`，不覆盖 `lid_map`，
也不移动该事件的消息。操作员在 `/customer-identity` 选择 KEEP、明确 MOVE 或 DISMISS。

## Conversation 与 Message

- 一个 customer 可以有多个 `conversations`，每个 WhatsApp `connection_key` 各自保留一段。
- Evolution instance label 可以改名；稳定 sender 身份仍是 `connection_key`／WhatsApp number。
- `messages.customer_id` 连接统一时间线。
- 消息业务唯一键是 `(connection_key, external_message_id)`；同一 provider ID 在不同
  connection 出现时是两份不同证据。
- `remote_jid` 保留 normalized provider address；`raw_payload_ref` 只保存受控本机引用，
  不把 raw payload 扩散到 Notion 或日志。

## Backfill

Evolution history import 仍按 discover → import 两阶段运行，并在每页完成后保存断点。
Migration 305 另外把 identity 进度写入 `identity_backfill_state`。重放依靠消息幂等键，
中断后可继续；无法解析的 LID 不会被当作“同步完成”。旧的 display-name LID backfill
已经禁用。

## Merge 与还原

Customer merge 必须：

1. 先调用 dry-run plan，检查 contacts、conversations、messages、project leads 和 identities。
2. 没有 `RUNNING`／`SENDING`／`QUEUED_BATCH` Campaign。
3. 明确输入 `MERGE_CUSTOMER_IDENTITIES`。
4. 写入 `customer_merge_events` snapshot 与操作人／原因。
5. duplicate customer 标为 `Merged`，不删除。

还原需要 `REVERSE_CUSTOMER_MERGE`，并只还原 snapshot 中实际移动的 row。活动 Campaign
期间同样禁止还原。

## Migration 305

工具默认 dry-run，并要求 migration 304 已完成：

```bash
node scripts/maintenance/migrate-customer-identity.mjs --dry-run
```

Apply 会再次检查 run JSON、SQLite Campaign ledger、重复 message identity，建立 online
backup，执行 migration，再运行 `quick_check` 与 `foreign_key_check`：

```bash
node scripts/maintenance/migrate-customer-identity.mjs \
  --apply --confirm APPLY_CUSTOMER_IDENTITY_V1
```

不要在 LIVE Campaign 运行时 apply、merge、reverse 或 restart Mamba。Migration 完成后，
到 `/customer-identity` 检查 schema、冲突和 customer 数量，再决定是否恢复 Notion Sync。

## 代码入口

- `domain/customer-identity.mjs`：identity type、normalization 与 evidence 规则。
- `lib/customer-identity-repository.mjs`：解析、冲突、backfill state、merge 与 reverse。
- `lib/conversation-log-service.mjs`：message-time identity placement。
- `lib/lid-map-service.mjs`：LID evidence cache；冲突时不覆盖。
- `routes/customer-identity.routes.mjs`：本机 admin API。
- `customer-identity.html`：冲突和 merge 后台。
- `migrations/305-customer-identity.sql`：additive schema migration。
