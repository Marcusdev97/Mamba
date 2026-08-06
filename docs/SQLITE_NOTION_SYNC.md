# SQLite ↔ Notion CRM Sync

## 边界

SQLite 是运行事实来源，Notion 是业务可见镜像。v1 同步 Customers 与 Project Leads；
其他 CRM databases 保留在既有 provisioned structure，尚未进入双向 worker。

- system-owned fields：只从 SQLite 推往 Notion。
- human-owned fields：可从 Notion 拉回 SQLite。
- raw messages、完整 conversation、secret、身份证明、银行文件与 recovery state：禁止同步。
- Notion 无对应 stable ID 时不会自动创造 SQLite 客户。

## 数据结构

- `sync_jobs`：复用既有 durable outbox。
- `sync_inbox`：Notion edit 的 durable inbox，idempotency key 包含 page id 与 edit time。
- `notion_entity_map`：SQLite key、stable CRM ID 与 Notion page id 的一对一映射。
- `sync_conflicts`：字段级三方合并冲突。
- `sync_audit_events`：只记录方向、entity、operation 与字段名，不记录原始对话。
- `sync_reconciliation_runs`：nightly／manual 对账报告。

## Migration 304

默认只 dry-run：

```bash
node scripts/maintenance/migrate-sqlite-notion-sync.mjs --dry-run
```

Apply 必须同时满足 migration 303 已应用、没有活动 Campaign、已提供确认 token。工具会先
建立 online backup，完成后运行 quick check 与 foreign key check。即使 apply 成功，worker
仍是 paused；到 `/notion-sync` 检查 health 后再人工恢复。

```bash
node scripts/maintenance/migrate-sqlite-notion-sync.mjs \
  --apply --confirm APPLY_SQLITE_NOTION_SYNC_V1
```

## 运行与失败

worker 每 20 分钟扫描 row version、推送到期 outbox、poll Notion edit，并在每日夜间对账。
Retry 曲线为 1 分钟、5 分钟、15 分钟、1 小时、6 小时，之后等待人工处理。认证、schema、
重复 stable ID 与字段冲突属于不可自动重试错误。

如果 SQLite 与 Notion 从同一个 base 同时修改同一 human field，只合并没有冲突的字段，
冲突字段保留 SQLite 当前值并进入 `sync_conflicts`。Dashboard 可查看 health、queue、失败与
冲突，并可暂停、恢复、立即同步、重试或运行 reconciliation。
