# Dashboard AI Auditor（Migration 309）

## 目标与边界

`/dashboard` 是 action-first 的本机经营视图。Dashboard 的数字、funnel、Campaign
performance、opportunity board、同步健康和 action queue 全部直接读取 SQLite；页面请求
不会查询 Notion，也不会因为 AI Provider 离线而失效。

页面视觉直接复用 Settings／Campaign 共用的 `assets/mamba.css` tokens 与 card、button、
badge、input 组件。它不建立独立配色或另一套控件。当 migration 308／309 尚未完成时，
页面先读取 `/api/dashboard/status` 并显示 `Setup Required`，不会请求 dashboard 查询，也
不会把 SQLite table name、SQL 或 stack trace 当成操作员错误信息显示。

规则候选先由 `domain/lead-auditor.mjs` 筛选。AI 只可以总结、分类、评分、建议下一步与草拟
消息。它没有发送、修改 STOP、推进 Sales Stage、预约、删除、合并或修改 commission 的接口。
实际业务修改仍由原有 Sales／Eligibility service 完成。

## 结构

- Domain：`domain/lead-auditor.mjs` 负责候选规则、隐私清理、cache key 与严格输出 validation。
- Integration：`integrations/ai/structured-json-client.mjs` 只把已清理、有限长度的 package
  送给配置的 Provider，并统一 timeout／错误分类／JSON normalization。
- Repository：`lib/dashboard-ai-auditor-repository.mjs` 负责 SQLite dashboard 查询、分析 cache、
  append-only events 与 human feedback。
- Service：`lib/dashboard-ai-auditor-service.mjs` 编排 rules → cache → AI → validate → ledger。
- Route：`routes/dashboard-ai-auditor.routes.mjs` 提供只读 dashboard 与显式 audit／feedback API。

Cache key 是 `customer_id + conversation_last_message_id + analysis_version` 的不可逆 digest。
同一个输入不会重复计费。AI 失败会写 `FAILED` 审计，但 Dashboard 仍显示 rule candidate 和
本机业务数据。

## 数据与质量

Migration 309 新增：

- `lead_audit_analyses`：结构化结果、Provider／model／token、错误和人类反馈。
- `lead_audit_events`：`ANALYSED`、`CACHE_HIT`、`FAILED`、feedback／outcome 事件。

质量指标来自 reviewed analyses，包括 acceptance、usefulness 与 classification accuracy。
AI score 与 human stage／probability 并列显示；AI 永远不覆盖 human-owned fields。

## Migration

```bash
npm run db:dashboard-ai:dry-run
# 仅在 migration 308 已应用且没有活动 Campaign 后：
node ../scripts/maintenance/migrate-dashboard-ai-auditor.mjs --apply \
  --confirm APPLY_DASHBOARD_AI_AUDITOR_V1
```

Apply 前会检查 RUNNING／SENDING／QUEUED Campaign、建立 SQLite backup，完成后验证
`quick_check`、foreign keys 与 required tables。Server 启动不会自动迁移。
