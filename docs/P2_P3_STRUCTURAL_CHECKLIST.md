# Mamba P2 / P3 Structural Checklist

> 更新日期：2026-07-30

## P2 — Runtime Folder Hygiene

- [x] 定义 SQLite、Runs、Conversation、Logs、Backups 的保留边界。
- [x] 建立默认 dry-run 的 Runtime Folder 检查工具。
- [x] Apply 前检查活动 Campaign。
- [x] 使用可恢复归档，不永久删除。
- [x] `.fuse_hidden*` 只报告，不自动处理。
- [x] 为清理分类、活动 Run 阻挡和幂等行为加入测试。
- [ ] 当前 LIVE Campaign 完成后，由操作员确认并运行 `--apply`。
- [ ] 验证归档 manifest 后，再决定是否建立长期 log 压缩政策。

## P3 — Configuration and Test Structure

- [x] 建立 Campaign Assets 审计：主配置、缺失媒体、重复内容、legacy config。
- [x] 建立单一完整测试入口 `npm test`。
- [x] 建立不启动本机测试 Server 的入口 `npm run test:safe`。
- [x] 建立架构防回退测试，限制 Route 直接 external fetch／`process.env` 和 Runtime DDL 扩散。
- [x] 保留现有 legacy baseline，不在 LIVE 时进行大型搬迁。
- [ ] 修复审计发现的缺失媒体引用。
- [ ] 逐一确认未登记的 Campaign config 是迁移来源还是可归档旧版。
- [ ] 建立图片 canonical name，再改引用并归档完全相同的副本。
- [ ] 在 Campaign 空档将 `settings.routes.mjs` 的 Provider test 移入 integration adapter。
- [ ] 在 Campaign 空档继续缩小 `server.mjs` 的 legacy orchestration。

## 验收命令

```bash
node scripts/maintenance/runtime-folder-hygiene.mjs
node scripts/maintenance/audit-campaign-assets.mjs
cd campaign-app && npm run test:safe
cd campaign-app && npm test
git diff --check
```
