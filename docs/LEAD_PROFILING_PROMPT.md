# 客户画像抽取 — 指令

> 用途:读完一个客户的完整 WhatsApp 对话,抽出结构化事实,供筛选名单与跨项目重配使用。
> 输入:`tools/export-for-profiling.mjs` 产出的 JSONL,一行一个客户。
> 输出:一行一个客户的 JSON,schema 见下。
>
> 这份档案同时是**未来接 API 时直接使用的 prompt**。先在真实客户身上验证,再自动化。

---

## 最高原则:只抽客户自己说过的

**每一个有值的字段,都必须附上客户的原话。**没有原话就填 `null`。

不要推断、不要补全、不要「合理猜测」。抽错一个预算,比留空一个预算糟糕得多——留空只是没资讯,抽错会让人打错电话。

- 客户说「我看看」→ 不是意向,是敷衍
- 客户问「多少钱」→ 是价格询问,**不是**预算
- 只有客户讲出数字或范围,才算预算

**销售自己说的话不算证据。**销售说「你预算 70 万对吧」而客户没确认,预算就是 `null`。

## 语言

对话混用英文、马来文、中文、口语缩写(`bila`、`brp`、`几钱`、`boleh`)。
原话照抄,不要翻译。抽出的字段值用中文或标准英文皆可,保持一致。

## 字段

| 字段 | 型别 | 说明 |
|---|---|---|
| `budget` | `{min, max, raw, quote}` | 单位 MYR。「70万以内」→ `{min:null, max:700000}`。只给单一数字就 min=max。 |
| `purpose` | `own_stay` / `investment` / `both` / `null` | |
| `bedrooms` | 数字或 `null` | 「2房2卫」→ 2 |
| `property_type` | 字串或 `null` | condo / serviced apartment / landed / semi-D / shoplot… 照客户说的 |
| `location_wants` | 字串阵列 | 想要的区域、地标、交通线 |
| `location_avoids` | 字串阵列 | 明确说不要的 |
| `financing` | `{concern, quote}` | 贷款、头期、月供方面讲过的顾虑 |
| `timeline` | 字串或 `null` | 「明年」「等 loan 批」「不急」 |
| `blocker` | 字串或 `null` | **卡在哪。**价格?地点?贷款?家人不同意?还在比较? |
| `other_facts` | 字串阵列 | 其他有用的事实(家庭人数、职业、已看过哪些楼盘) |

每个有值的字段都要有对应 `quote`——客户原话,可截取但不可改写。

## 先判断这是谁

在抽任何买房条件之前,先定 `contact_type`。抽错这个,后面全部字段都没意义。

| 值 | 是谁 | 线索 |
|---|---|---|
| `buyer` | 想买新项目的客户 | 问价、问户型、问贷款、约看房 |
| `owner` | 业主 —— 你帮他出租或转售的单位持有人 | 提到「我的单位」「我的租客」、谈租金收入、谈交屋 |
| `tenant` | 想租房的人 | 讲月租预算、入住日期、租期 |
| `agent_partner` | 同行 —— 转介、co-broke、带客户来 | 自称 agent、发客户需求给你、谈分佣 |
| `not_relevant` | 不是生意关系 | 保险、牙医、商家推广、你自己的公司、打错号码 |

**一个人可以有两种身分**(业主同时是同行经纪)。`contact_type` 填主要那个,另一个写进 `contact_type_note`。

`not_relevant` 要标出来 —— 那是在帮忙清名单,跟找出热客户一样有价值。

## 判断(两个轴,不要合成一个分数)

| 字段 | 值 | 定义 |
|---|---|---|
| `intent_level` | `hot` | 约过看房、给过预算、问过具体单位 |
| | `warm` | 问过价或户型,有具体问题 |
| | `cold` | 只回过「ok」「thanks」「看看先」 |
| | `not_a_lead` | 不是买家(同行、找工作、打错、广告) |
| `relationship` | `waiting_on_you` | 最后一句是客户说的,你没回 |
| | `waiting_on_them` | 你回了,他没再回 |
| | `dormant` | 超过 60 天没有任何往来 |

再加两个:

- `next_step` — **一句话**,具体到能直接做。不要写「跟进」,要写「发 2 房 65 万的单位给她,提她说过预算 70 万以内自住」
- `reusable_for_other_projects` — `true` / `false` + `reusable_why`:这个人的条件够不够清楚,新楼盘进来时能不能配对?

## 输出格式

一行一个客户,不要包在阵列里,不要加说明文字。

```json
{
  "customer_phone": "60120000001",
  "budget": {"min": null, "max": 700000, "raw": "below 700k", "quote": "My budget is below 700k"},
  "purpose": "own_stay",
  "purpose_quote": "For own stay",
  "bedrooms": null,
  "property_type": null,
  "location_wants": [],
  "location_avoids": [],
  "financing": null,
  "timeline": null,
  "blocker": "Type C 超出客户明确预算,销售改推 Type A 后没有回应",
  "blocker_quote": "What is the price for Type C?",
  "other_facts": [],
  "intent_level": "warm",
  "relationship": "waiting_on_them",
  "next_step": "发 2 房 2 卫 RM6xx k 的实际单位与月供试算,开头提她说过自住、预算 70 万以内",
  "reusable_for_other_projects": true,
  "reusable_why": "预算与自住用途明确,缺地点偏好;新项目若在 70 万以下的 2 房可直接配对",
  "confidence": "high"
}
```

`confidence`:`high` = 关键字段都有原话;`medium` = 部分靠上下文;`low` = 对话太短,几乎抽不出东西。

## 不要做的事

- 不要因为对话短就编内容——短就是 `cold` + 大量 `null`
- 不要把销售的话当客户的话
- 不要把 `next_step` 写成通用建议
- 不要漏掉 `not_a_lead`:同行、求职、打错号码要标出来,那是在帮忙清名单
