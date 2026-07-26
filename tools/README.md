# tools/ —— 数据库面板 & Postgres 导出

两个互不依赖的小工具，都**只读**打开 `campaign-data/mamba.sqlite`，永远不会写生产库。
不属于运行时代码，删掉也不影响发送。

日常用双击就好：`launchers/SQL 面板.command`、`launchers/导出数据给 Postgres.command`。

---

## 1. SQL 面板 (`mamba-sql.html`)

```bash
node tools/sql-html/build.mjs                     # 带真实数据快照(约 11 MB)
node tools/sql-html/build.mjs --no-data           # 空壳,可以分享给别人
node tools/sql-html/build.mjs --db path/to.sqlite # 看另一台电脑的库
node tools/sql-html/build.mjs --max-rows 2000     # 每张表最多导多少行
```

生成的是**单个 HTML 文件**：不连服务器、不连 CDN、不引用 Mamba 任何代码，双击就能开。
里面能看每张表的结构（列 / 主键 / CHECK / 外键 / 中文注释）、建表 SQL、以及分页的数据，
也能做 INSERT / UPDATE / DELETE —— 但**改动只留在浏览器**（快照只读，改动存成一层很小的
overlay），要真的落库得用页面上的「导出 SQL」。

表结构以**真实库**（`sqlite_master`）为准，注释从 `docs/mamba-schema*.sql` 贴回去；
只存在于文档、库里还没建的表（比如没迁的 v4）会置灰标成「设计中」。

> ⚠️ 带数据的 `mamba-sql.html` 含客户电话和对话内容，已在 `.gitignore` 里，别提交也别外发。

## 2. Postgres 导出

```bash
node tools/pg/build-postgres.mjs                  # → docs/mamba-schema.postgres.sql
node tools/pg/dump-data.mjs                       # → mamba-data.pg.sql(全量数据)
node tools/pg/dump-data.mjs --if-newer            # 第二台电脑合并进同一个库时用
```

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f docs/mamba-schema.postgres.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f mamba-data.pg.sql
```

建表脚本会把 SQLite 方言翻成 Postgres：`AUTOINCREMENT` → `IDENTITY`、外键统一挪到末尾的
`ALTER TABLE`（避开前向引用）、`PRAGMA` 丢掉、注释转成 `COMMENT ON`。时间列**故意保持 TEXT**
（代码到处写 ISO 字符串），0/1 标志位保持 `INTEGER + CHECK`。两个文件都可以重复执行。

### 两台电脑合并时务必加 `--if-newer`

`contact_key` 是电话、`project_lead_key` 是 `项目:电话`，两台机器一定会撞主键。
默认 upsert 是「后跑 psql 的那台赢」，会把另一台**更新**的 `next_flow` / `send_lock` 盖掉；
`--if-newer` 加上 `WHERE EXCLUDED.updated_at > 表.updated_at`，按最后修改时间决胜。

不会撞的：`devices` / `whatsapp_connections`（`device_key` 是每台机器的 UUID）、
`messages`（Evolution message id）、`conversations`（id 里嵌了机器 UUID）、
`lead_groups`（uuid）、`campaign_runs` / `send_jobs`（毫秒时间戳）。

另一台电脑如果 schema 版本不同，先在**那台**上跑一次 `build-postgres.mjs` 再 apply
——它会把那台独有的表并进建表脚本。

### 定位：Postgres 是只读汇总镜像，不是真相源

按 [MAMBA_ARCHITECTURE_ADR.md](../docs/MAMBA_ARCHITECTURE_ADR.md) 第七节，迁移到 Postgres 的
三个条件目前一条都没满足。这套导出是给报表 / 对账 / 跨机汇总用的，**不要在 Postgres 里改数据**
——两个写者零个仲裁者，跨机送锁要等有原子 Arbiter 那一步。

---

`lib/parse-schema.mjs` 是两边共用的 SQLite schema 解析器（列、主键、CHECK 枚举、外键、索引、
以及 `.sql` 里贴着的中文注释），改它两边都会受影响。
