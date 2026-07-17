# Project Brain ⇄ Property 213 — 对比结果(实拉一次)

> 日期:2026-07-17 · 来源:Property 213 隐藏 JSON API(实测拉取 154 个在售项目)
> 这是"刷新按钮"会给你看的东西:自动比对公司官网数据 vs 你的 Project Brain,挑出要确认的变化。

## 数据来源(可复用)

- **项目列表**:`app_api.property213.com/v22/accounts/{account}/projects?limit=500&active=true` → 返回干净 JSON,今天 **154 个在售项目**。
- **单项目详情**:`.../projects/{ProjectUID}` → 200,含该项目全部字段;`.../projects/{ProjectUID}/units` → 户型/单位(部分项目有)。「Unit Plan / Facilities / FAQ / 价格表 / rebate」等更深资料是各自的子接口,下一步再抓准确路径。
- **认证**:`appkey` + `token` + `userid`(会话令牌,会过期)。⚠️ 属机密,存 `evolution-pilot/.env`,不进 git。

## 对比:你 Brain 里的 3 个项目

| Brain 项目 | Brain 现有 | 公司 API 现值(2026-07-17) | 判定 |
|---|---|---|---|
| **Binastra** | 价钱文案 "RM 2,XXX 级别"(月供级,do_not_say 规定不报死价) | **Binastra Cochrane @ Cheras** · RM 721,800–1,428,800 · 649–1026 sqft · Freehold · Under Construction | ✅ 可补官方总价区间/面积/状态(仅内部参考;客户文案继续守 do_not_say) |
| **Gen Starz** | "月供约 RM2100 起";freehold 低密度、MRT 楼下、全装修 | **Gen Starz @ Old Klang Road** · RM 593,000–873,000 · Pre Launch | ✅ 可补官方总价区间 + 状态 = Pre Launch |
| **Enlace** | **RM 514k–1723k** | 官方拆成两栋:**Enlace Suites 1** · RM 600,000–2,000,000 · Pre Launch;**Enlace Suites 2** · RM 686,000–3,002,000 · Pre Launch | ⚠️ **价格对不上 + 多一栋** |

## ⚠️ 抓到的真问题(这就是刷新的价值)

**Enlace 的 Brain 底价 RM514k,低于官方现价 RM600k 起。** 如果 rep 照 Brain 报 "514k 起",就是**报错价**。而且官方现在是 **Suites 1 + Suites 2 两栋**,Brain 只当一个 Enlace。
→ 建议:把 Brain 的 Enlace 标为 **Possibly Outdated**,并把「Suites 2」列为**候选新子盘**,你确认后再更新。

## 候选新项目

公司目录 **154 个**,你 Brain 只跟 **3 个**。真正"新盘上线"会在这 154 里出现(例如附近品牌盘 Gen Rise @ JBCC、Tangen Residences @ North Kiara 等)。刷新时按 **ProjectUID** 比对,冒出来的就是候选,列给你确认要不要进 Brain。

## 每条数据的出处戳(写进 Brain 时附上)

```
source_type   = property213_api
source_url    = app_api.property213.com/v22/accounts/{account}/projects/{ProjectUID}
collected_at  = 2026-07-17
data_version  = v22
status        = mirror       → 仅 Market Dashboard 的镜像状态,与 Brain 无关
```

## 结论

可行性 + 效果都验证了:**有稳定 API、字段齐全、对比键(ProjectUID)可靠,而且第一次跑就抓到一个 Enlace 报错价风险。** 下一步做成 Mamba 里的「🔄 从公司刷新」按钮:按一下 → 拉 154 → 写进 **Market Dashboard** → 跟 Brain 比对 → 列出「⚠️价格变动 / 🆕候选新盘」+ 摘要 **作为提醒**。

> ⚠️ **铁律:刷新只写 Market Dashboard,只对 Brain 报警,绝不自动写 Brain。** 卖点和 net price 永远由你手动在 Project Editor 写(尤其 Enlace 不动)——因为那是训练 bot 的脑子。详见 `MAMBA_MARKET_DASHBOARD.md`。
