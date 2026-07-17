# MAMBA Market Dashboard 设计(公司数据 → 只镜像 + 只报警)

> 状态:Phase 1 公司只读刷新 + Phase 1.1 按项目读取 Information / Plans 已实现 · 日期:2026-07-17
> 来源:Property 213 隐藏 JSON API(实测 154 个在售项目)
> 相关:`property213-brain-diff-2026-07-17.md`(实拉对比结果)

## 0. 一条铁律(整份文档的地基)

> **刷新只写 Market Dashboard;只对 Brain 报警;绝不自动写 Brain / Project Editor。**
> 卖点(selling points)和 **net price** 永远由**人手动**在 Project Editor 写。机器只当"眼线",不当"脑子"。**Enlace 不动。**

## 1. 两层分开,谁都别越界

| 层 | 是什么 | 谁写 | 内容 |
|---|---|---|---|
| **Brain / Project Editor** | 训练 bot 的脑子 | **只有人** | 卖点、话术、**net price**(扣完 rebate 的真实价)、do_not_say 规则 |
| **Market Dashboard** | 公司官网数据的镜像 + 报警板 | **只有机器(刷新)** | 官方 **list price**、状态、面积、新盘/新子盘 —— 参考 & 提醒用 |

**为什么必须分开(关键区别):**
- 公司 API 给的是 **list price**(牌价,例:Enlace 600k 起)。
- Brain 要的是 **net price**(人算出来的真实价)+ 卖点。**机器算不出 net price,也写不出卖点** → 所以 Brain 必须人写。
- Market Dashboard 的唯一职责:**发现官方数据变了 → 提醒你 → 你自己决定要不要手动更新 Brain。**

## 2. 数据源(可复用)

- 列表:`app_api.property213.com/v22/accounts/{account}/projects?limit=500&active=true` → 154 个项目 JSON。
- 基础详情:`v22/.../projects/{ProjectUID}` → 单项目基础字段。
- Information:`v7/.../projects/{ProjectUID}/details` → Layout、Sales Package、Sales Chart 等按 Sequence 排列的章节。
- Unit Plan:`v7/.../projects/{ProjectUID}/units/plans` → 户型名称、面积、房/厕/车位和图片。
- Site / Floor Plan:`v7/.../projects/{ProjectUID}/units/plans/site` → 项目有上传才返回；空数组表示公司端暂无资料，不是 Mamba 报错。
- 认证:`appkey` + `token` + `userid`(会话令牌,会过期)。**存 `evolution-pilot/.env`,不进 git。** token 过期 → 按钮提示重新登录。

## 3. Market Dashboard 数据表(全部独立,不碰 Brain 文件)

> 这些表只存在于 Market Dashboard 自己的存储(可用 SQLite 里的独立表,或独立 JSON)。**没有任何写路径指向 `campaign-data/brain/`。**

### 3.1 `market_projects`(公司项目镜像,键 = ProjectUID)
```
project_uid    TEXT PK        -- Property 213 ProjectUID(稳定)
name, developer, property_type, tenure, land_title
price_from, price_to         -- ⚠️ LIST price(非 net!)
sqft_from, sqft_to, total_unit
project_status, state, area, location, picture_url
active         INTEGER        -- 是否仍在公司目录
source_type    TEXT           -- property213_api
source_url     TEXT
first_seen_at, last_seen_at, collected_at TEXT
raw_json       TEXT           -- 完整原始记录(备查)
```

### 3.2 `market_changes`(append-only:每次刷新发现的变化)
```
id, project_uid, field, old_value, new_value,
change_type   -- NEW_PROJECT / PRICE_CHANGE / STATUS_CHANGE / DISAPPEARED
detected_at
```

### 3.3 `brain_alerts`(给人的提醒 —— 只读信号,永不写 Brain)
```
id, brain_project        -- binastra / gen_starz / enlace
market_project_uid
alert_type               -- PRICE_MISMATCH / NEW_SUBPROJECT / STATUS_CHANGE / NEW_PROJECT_CANDIDATE
brain_value, market_value, detail
status                   -- OPEN / ACKED / DISMISSED(人点的,不影响 Brain)
created_at
```

### 3.4 `brain_project_links`(人确认一次:Brain 项目 ↔ 公司 ProjectUID)
```
brain_project   TEXT     -- enlace
project_uid     TEXT     -- 42d0aa81…(Enlace Suites 2)/ 另一条 Suites 1
confirmed_by_human INTEGER
```
> 例:`enlace` ↔ [Enlace Suites 1 uid, Enlace Suites 2 uid]。这个映射**由你确认**,机器不猜死。

## 4. 刷新流程(按一下按钮)

```
1. 拉:调 projects API(翻页拿全 154)
   → 在写缓存前排除 State/Area/Location 属于 Penang、Pulau Pinang、Johor 的项目
2. 写镜像:upsert 进 market_projects;跟上次快照比 → 变化写 market_changes
       （只写 market_* 表）
3. 比对 Brain:对每个 brain_project_links 里的项目,把官方 list/status 跟上次比
       → 有变化 / 官方底价低于/高于 Brain 记录 / 出现新子盘 → 写 brain_alerts(提醒)
4. 摘要:输出「本次:X 个价格变动、Y 个候选新盘、Z 条 Brain 提醒」
5. 结束。❌ 全程不写 campaign-data/brain/,不改 Project Editor。
```

**报警是"建议",不是"判决"**:因为 list ≠ net,机器只说"官方数据变了,值得你去核对",不断言"Brain 错了"。要不要改卖点 / net price,你手动决定。

## 5. 首次实拉抓到的例子(2026-07-17)

- ⚠️ `PRICE_MISMATCH` — **Enlace**:Brain 底价 RM514k;官方 Enlace Suites 1 = RM600k 起、Suites 2 = RM686k 起 → 提醒你去核对 net price。**(只提醒,Enlace 的 Brain 我不动。)**
- 🆕 `NEW_SUBPROJECT` — **Enlace Suites 2** 官方新增,Brain 只当一个 Enlace → 候选,等你决定。
- ✅ Binastra / Gen Starz:官方 list + 状态可入 Market Dashboard 作参考(Brain 卖点/net price 仍你手写)。

## 6. UI(Mamba 面板)

- **Market Dashboard 页**:一张公司项目表(list price / 状态 / 新盘),顶部一个「🔄 从公司刷新」按钮 + 上次刷新时间。
- **提醒区**:`brain_alerts` 列表,每条一句话 + 「去 Project Editor 手动改」的链接(点了跳到人工编辑,**不代写**)。
- Brain / Project Editor 页保持原样,**没有任何"从 Market 自动填充"的按钮**。

## 7. 落地顺序(先只读,零风险)

1. 建 `market_projects` / `market_changes` / `brain_alerts` / `brain_project_links` 四张表(独立,不碰 Brain)。
2. 做「刷新」:拉 → 写 market_* → 出 market_changes + 摘要(先不做 brain_alerts)。
3. 人确认一次 `brain_project_links`(Binastra / Gen Starz / Enlace ↔ 官方 UID)。
4. 加 brain_alerts(只读提醒)。
5. ✅ Market Dashboard 保留原 `project-brain.html` UI,加入「从公司刷新」按钮;token 只由后端从 `.env`/本机 ignored secret 读取,不会送进浏览器。

## 8. Phase 1 实际结果(2026-07-17)

- 公司 API 实拉:154 个 Active projects。
- Dashboard 保留:132 个。
- 已排除:Penang 1 个、Johor 21 个。
- 缓存:`campaign-data/market-dashboard/property213-projects.json`(本机运行资料,不进 git)。
- 刷新只更新 Market Dashboard cache/change history;没有任何写路径进入 Brain / Project Editor。

> 全程只读公司数据、只写 Market 层。**Brain 永远人写。**

## 9. Phase 1.1 Project Information / Plans

- 楼盘列表仍只拉轻量基础资料；不会对 132 个楼盘一次发出数百个详情请求。
- 用户点开某个楼盘时，Mamba 才按需读取该项目的 Information、Unit Plan 与 Site / Floor Plan。
- 详情栏新增 Layout / Built-up、Unit Plans、Site / Floor Plans、Sales Package 和 Sales Chart。
- 每个项目有独立「刷新详情」按钮；可只更新正在看的楼盘，不必重拉全部项目。
- Sales Chart 网站和账号可以直接查看；密码默认遮挡，只有用户按「显示」才读取，并提供「隐藏 / 复制」。
- Sales Chart 密码不会写进项目列表、系统日志、Git 或硬盘详情缓存；只在 Mamba 当前进程内短暂保存。详情安全缓存权限为 `0600`。
- 三个详情接口独立处理错误；例如 Unit Plan 成功但 Site Plan 失败时，已拿到的资料仍会显示，并明确标出失败的部分。
- 真实验证楼盘 `Residensi Aurora @ Shah Alam`:Layout、Sales Package、Sales Chart 均有资料，Unit Plan 3 个，Site / Floor Plan 0 个（公司端确实返回空）。
