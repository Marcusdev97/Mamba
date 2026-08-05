# tools/ —— 本机 SQLite 面板与安全维护工具

这些工具不在 Campaign 发送路径内。Mamba 的运行事实只保存在本机
`campaign-data/mamba.sqlite`，线上 CRM 与人工追踪使用 Notion。

原本用于两台电脑汇总的 Global PostgreSQL、Sync Agent、schema exporter 和
Global SQL 面板已经退役。Evolution API 自己使用的数据库不属于这些工具，也不保存
Mamba 业务 schema。

日常入口是双击 `launchers/SQL 面板.command`：

```text
1  查看本机数据库（SQLite 只读快照）
2  备份本机数据库（建立新档案并执行 quick_check）
3  打开 Notion CRM
```

## 1. 本机 SQL 面板

```bash
node tools/sql-html/build.mjs
node tools/sql-html/build.mjs --no-data
node tools/sql-html/build.mjs --db path/to/backup.sqlite
node tools/sql-html/build.mjs --max-rows 2000
node tools/sql-html/build.mjs --out /safe/local/path/panel.html
```

输出是 `mamba-sql.html`。它是一个不连服务器或 CDN 的单页快照，数据库通过
SQLite read-only connection 读取。页面里的 INSERT、UPDATE、DELETE 只写浏览器
overlay；如需保留草稿，可以导出 SQLite SQL 或 JSON，但不会回写运行中的数据库。

带数据的 HTML、SQL 和 JSON 会包含客户资料，因此已由 `.gitignore` 排除，不得提交
或对外发送。

## 2. 备份本机 SQLite

```bash
node tools/backup-local-database.mjs
node tools/backup-local-database.mjs --db path/to/source.sqlite
node tools/backup-local-database.mjs --out-dir /safe/local/path
```

工具使用 SQLite online backup command 建立一致快照，不覆盖来源或已有备份。完成后会打开备份执行
`PRAGMA quick_check`；只有结果为 `ok` 才报告成功。默认输出到
`campaign-data/backups/`，不会进入 Git。

## 3. 区域网路只读查看

```bash
node tools/sql-html/serve.mjs
node tools/sql-html/serve.mjs --port=8900
node tools/sql-html/serve.mjs --new-token
```

Server 只读打开 SQLite，并用本机 `tools/sql-html/.access-token` 保护网址。区域网路
仍是明文 HTTP，只应在可信 Wi-Fi 临时使用；完成后按 Control-C 停止。

`--allow-upload` 只保留作人工离线恢复：收到的 SQLite 会进入
`campaign-data/incoming/`，不会覆盖或自动合并本机主库，也不会触发任何线上同步。
需要比较另一个备份时，明确指定 `--db` 只读打开；日常跨设备可见资料应通过 Notion。

## 4. SQLite 离线合并

`tools/merge-db.mjs` 是灾难恢复／人工迁移工具，不是跨设备同步服务：

```bash
node tools/merge-db.mjs --from campaign-data/incoming/example.sqlite
node tools/merge-db.mjs --from campaign-data/incoming/example.sqlite --apply
```

预设只报告。`--apply` 也只建立新的 `mamba.merged.sqlite`，不会改写生产
`mamba.sqlite`。合并后必须人工核对，再决定是否在安全维护窗口采用。

`lib/parse-schema.mjs` 是本机 SQL viewer 与离线 SQLite maintenance 共用的 schema
解析器；它不连接任何外部数据库。

相关自动化验证：

```bash
node tools/test-local-database-tools.mjs
```
