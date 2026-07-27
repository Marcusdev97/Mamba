# tools/ —— 数据库面板 & Postgres 导出

两个互不依赖的小工具，都**只读**打开 `campaign-data/mamba.sqlite`，永远不会写生产库。
不属于运行时代码，删掉也不影响发送。

日常只有一个入口：双击 `launchers/SQL 面板.command`，菜单里选 1-4：

```
1  看全部数据（两台合起来 · Global Postgres）
2  只看这台（本机 SQLite）
3  给另一台电脑看     4  收另一台的数据     5  立刻同步一次
```

选 1 会从 Global Postgres 现读现生成 `mamba-sql-global.html`(约 19 MB,含
`source_device_key`,每一行看得出是哪台电脑的);选 2 是本机 SQLite 的
`mamba-sql.html`。

---

## 1. SQL 面板 (`mamba-sql.html`)

```bash
node tools/sql-html/build.mjs                     # 带真实数据快照(约 11 MB)
node tools/sql-html/build.mjs --no-data           # 空壳,可以分享给别人
node tools/sql-html/build.mjs --db path/to.sqlite # 看另一台电脑的库
node tools/sql-html/build.mjs --max-rows 2000     # 每张表最多导多少行
node tools/sql-html/build.mjs --global            # 改读 Global Postgres(两台合起来)
```

生成的是**单个 HTML 文件**：不连服务器、不连 CDN、不引用 Mamba 任何代码，双击就能开。
里面能看每张表的结构（列 / 主键 / CHECK / 外键 / 中文注释）、建表 SQL、以及分页的数据，
也能做 INSERT / UPDATE / DELETE —— 但**改动只留在浏览器**（快照只读，改动存成一层很小的
overlay），要真的落库得用页面上的「导出 SQL」。

表结构以**真实库**（`sqlite_master`）为准，注释从 `docs/mamba-schema*.sql` 贴回去；
只存在于文档、库里还没建的表（比如没迁的 v4）会置灰标成「设计中」。

> ⚠️ 带数据的 `mamba-sql.html` 含客户电话和对话内容，已在 `.gitignore` 里，别提交也别外发。

## 2. 让另一台电脑连过来看(同一个 Wi-Fi)

菜单选 **2**,或者:

```bash
node tools/sql-html/serve.mjs
node tools/sql-html/serve.mjs --port=8900
node tools/sql-html/serve.mjs --new-token     # 换存取码,旧网址立刻失效
```

终端机会印出一条 `http://192.168.x.x:8900/?key=xxxx`,贴进另一台电脑的浏览器就能看,
那台不用装任何东西,手机平板也行。存取码第一次启动自己产生,存在
`tools/sql-html/.access-token`(权限 0600、已 gitignore),之后网址固定不变。

和 [hub-server](../hub-server/README.md) 同一个安全模型,区别是 hub-server 给你看**客户对话**,
这个给你看**整个数据库**(所有表的结构 + 数据)。

- **只读**:开库时钉死 `readOnly`,由 SQLite 自己拒绝写入;那台电脑在页面上的增删改只留在
  他自己的浏览器里,不会回写主机的 `mamba.sqlite`
- **实时**:按数据库的 mtime 快取。app 一写进去,下次开就是新的;没变动就直接给快取(2ms)
- **省流量**:gzip 后 12 MB → 约 0.7 MB,第一次约 1.4 秒,之后秒开
- 只接受 GET;没带或带错存取码一律 401

## 3. 让另一台电脑把它的数据传过来

菜单选 **3**(或 `serve.mjs --allow-upload`)。
终端机会印出一条 `http://192.168.x.x:8900/upload?key=xxxx`,发给那台电脑,
那边**开网址 → 选档案 → 上传**就完事,不用装 Node、不用会命令行。

收到的档案存进 `campaign-data/incoming/<时间戳>_mamba.sqlite`,
**绝不覆盖主机自己的 `mamba.sqlite`** —— 两台电脑写同一个库是 ADR 明确否决的做法。
传完主机的终端机会印出这个档案的行数、来自哪台机器,以及下一步命令:

```bash
node tools/sql-html/serve.mjs --db=campaign-data/incoming/xxx.sqlite   # 看它
node tools/pg/dump-data.mjs --db=campaign-data/incoming/xxx.sqlite --if-newer   # 合并到 Postgres
```

守住的几条:只接受真的 SQLite 档案(检查档头魔术字)、档名洗过(挡路径穿越)、
512MB 上限、一样要存取码。**不加 `--allow-upload` 时 `/upload` 直接 404**,
纯看数据的场景 server 还是完全只读。

> 那台电脑上传前要先关掉 Mamba:程式还开着的话最新几笔可能还在 `-wal` 里没落主库。
> 上传页顶部有这句提醒。

## 4. 架构:每台电脑各自跑,Global Postgres 只收不发

```
电脑 A                          电脑 B
├── WhatsApp A                  ├── WhatsApp B
├── Leads A (lead_groups 绑 device_key)
├── SQLite A  ← 本机真相源       ├── SQLite B  ← 本机真相源
├── Morning Reply Sync A        ├── …
├── Scheduler A (launchd)       │
└── Sync Agent A ──────┐        └── Sync Agent B ──┐
                       ▼                            ▼
                  Global PostgreSQL(只读汇总,不回写任何一台)
```

两台各管各的号码和名单,**不共编同一批客户**,所以不需要原子 Arbiter ——
这跟 [ADR 第七节](../docs/MAMBA_ARCHITECTURE_ADR.md)警告的场景是两回事。

### 归属追踪:哪个号码发的、哪台电脑发的

`project_leads` 和 `send_jobs` 本来就记了(`last_sender_phone` / `last_sent_by_device` /
`connection_key`,实测 100% 填充)。但 `messages` 没有归属栏位,`conversations.connection_key`
也有三分之一是空的。

补法不是改 app,而是**同步那一刻给每一行盖章**:每台电脑只同步自己的资料,
所以「这行来自哪台」在同步当下就是事实。每张表都有:

| 栏位 | 意思 |
|---|---|
| `source_device_key` | 哪台电脑传上来的 |
| `synced_at` | 什么时候传的 |
| `sync_runs`(表) | 每台每次同步一行:设备、号码、时间、行数 |

于是这类问题一句 SQL 就能答:

```sql
-- 哪个电话 blast 过多少讯息
select r.device_name, r.sender_phone, m.source, count(*)
from messages m
join (select distinct source_device_key, device_name, sender_phone from sync_runs) r
  on r.source_device_key = m.source_device_key
group by 1,2,3;
```

### Sync Agent

```bash
node tools/pg/sync-agent.mjs              # 同步本机 + 吸收 incoming/ 里别台传来的
node tools/pg/sync-agent.mjs --dry-run    # 只说会做什么
bash launchd/install_sync_agent.sh        # 装排程(每天 07:30 / 13:30 / 23:30)
bash launchd/install_sync_agent.sh --status
```

连线字串放仓库根目录的 `.env.pg`(一行,已 gitignore),或环境变数 `DATABASE_URL`。

Agent 做的事:跑一次建表脚本(幂等,新栏位自动补)→ 同步本机 → 把
`campaign-data/incoming/` 里别台上传的 `.sqlite` 一并同步并归档到 `incoming/done/`
→ 最后重新生成 `mamba-sql.html`。所以早上打开面板,看到的就是昨晚 23:30 的最新资料。
面板重建失败只会警告,不影响已经完成的 Postgres 同步(`--no-panel` 可关掉这步)。
有锁档,排程和手动跑撞在一起不会同时跑两份;任何一步失败就非 0 结束,launchd 的
`.err.log` 里看得到。

## 5. Postgres 导出

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
