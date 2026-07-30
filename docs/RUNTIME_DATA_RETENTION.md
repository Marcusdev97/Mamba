# Mamba Runtime Data Retention

> 状态：Current policy · 更新日期：2026-07-30
>
> 本政策只定义保留与归档边界。它不会在 Server 启动时自动删除资料。

## 1. 原则

- SQLite、Campaign Run、Conversation 与 Sync outbox 是审计资料，不因 Folder 整理而删除。
- Maintenance 默认 dry-run；真正整理必须显式使用 `--apply`。
- 清理采取“移入本机归档 + manifest”，不永久删除。
- 有 `RUNNING`、`QUEUED_BATCH` 或 `SENDING` Campaign 时拒绝 Apply。
- `.fuse_hidden*` 可能仍是开启中的文件句柄，只报告，不自动移动。

## 2. 资料分类

| 路径／类型 | 保留政策 | 自动整理 |
|---|---|---|
| `campaign-data/mamba.sqlite*` | 永久；只由 migration／backup 工具处理 | 禁止 |
| `campaign-data/runs/*.json` | 永久保留 Campaign 审计 | 禁止 |
| `campaign-data/conversations/` | 永久保留本机消息证据 | 禁止 |
| `campaign-data/system-logs/` | 目前保留；未来可另做 90 天压缩政策 | 禁止 |
| `campaign-data/backups/` | 保留，直到有已验证的 restore + retention 流程 | 禁止 |
| `campaign-data/inbox-media/` | 保留被 conversation 引用的媒体 | 禁止 |
| `.DS_Store` | 无业务价值 | 可归档 |
| 超过 24 小时的 `*.tmp*` | 原子写入遗留 | 可归档 |
| backup folder 外的 `*.bak-*` | 旧人工副本 | 可归档 |
| `active-run.stale-*.json` | 历史人工快照 | 可归档 |
| 完全相同的 `name 2.ext` | Finder 重复副本 | 可归档 |
| 内容不同的 `name 2.ext` | 可能是有效版本 | 只报告 |
| `.fuse_hidden*` | 可能仍被进程开启 | 只报告 |

归档位置：

```text
campaign-data/maintenance-archive/runtime-hygiene-<timestamp>/
├── manifest.json
└── files/
```

`manifest.json` 会记录原路径、原因、大小和归档后的路径，方便人工恢复。

## 3. 使用方式

```bash
# 安全检查；不会写入
node scripts/maintenance/runtime-folder-hygiene.mjs

# Campaign 完全结束后才可运行；仍只归档，不永久删除
node scripts/maintenance/runtime-folder-hygiene.mjs --apply
```

Project Assets 采用另一条规则：重复图片或 legacy config 只审计，不自动整理，
因为 Template 可能仍引用旧档名。

```bash
node scripts/maintenance/audit-campaign-assets.mjs
```

必须先修正引用并通过完整测试，才可以在独立任务中合并或移除 Asset。
