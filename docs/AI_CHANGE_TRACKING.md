# AI Change Tracking（Migration 310）

## Task Contract

每项 AI 工程工作先记录：Task ID、title、goal、allowed scope、protected scope、allowed files、
acceptance criteria、risk、branch、step、status 和 rollback plan。Planner、Builder、Reviewer 与
Human 是不同 actor；页面和 API 记录流程，但不会执行 `git commit`、merge 或 rollback command。

状态为：`PLANNED → APPROVED → IN_PROGRESS → COMPLETED steps → REVIEW → COMPLETED`。
`BLOCKED`、`ROLLED_BACK` 与 `CANCELLED` 保留真实终止语义。

## 强制暂停

以下情况写事件并变成 `BLOCKED`：

- 文件超出 `allowed_files`（scope drift）；
- protected path 没有明确 human approval；
- test failed；
- data loss、duplicate send、requirement conflict 或活动 LIVE Campaign 风险。

同一 Task 同时只允许一个 `IN_PROGRESS` step。Step 完成必须有 passing test evidence 与明确
commit SHA。Reviewer checklist 必须覆盖 requirements、scope、data loss、duplicate send、tests、
rollback 和 docs；最终完成仍要求人类身份。

## Evidence 与恢复

Migration 310 新增：

- `ai_change_requests`：Task Contract 与批准／blocker 状态；
- `ai_change_steps`：小步、commit SHA 与 rollback ref；
- `ai_change_events`：append-only actor timeline；
- `ai_change_files`：file path、line count、reason 与 scope decision；
- `ai_change_tests`：command、result、summary 与 duration。

Resume Package 组合 Task、current step、events、files、tests 与只读 Git snapshot。Rollback API 只记录
human-approved rollback ref；它不会自动改 working tree。

## Migration

```bash
npm run db:ai-changes:dry-run
# 仅在 migration 309 已应用且没有活动 Campaign 后：
node ../scripts/maintenance/migrate-ai-change-tracking.mjs --apply \
  --confirm APPLY_AI_CHANGE_TRACKING_V1
```

Server 启动不会自动建表或执行 Git 操作。
