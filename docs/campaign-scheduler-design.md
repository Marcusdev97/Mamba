# Campaign Scheduler — Design Doc

> 状态: Draft v0.2 · 2026-07-19 · Owner: Marcus
> 一句话: Campaign Center 的自动化进阶版 —— 一个每天 10:00 上班、21:00 下班的智能体(agent),自己把该发的 Flow 发完,有人回复就停下来交给你。

---

## 1. 目标 (Goal)

**外面最简单,里面功能扎实。**

- 你平时只做一件事:选 `关闭 / TEST / LIVE`。
- 其他全部写死成安全默认,agent 自己搞定;出事了它停下来叫你。
- 简单是指"你要碰的东西少",不是"把好功能砍掉"。

---

## 2. 核心原则 (Core Principles)

### 2.1 一个引擎,两种对象 (One engine, two audiences)
TEST 和 LIVE **不是两套逻辑**,是同一个引擎:

- TEST = 引擎跑在 4 个测试号码上,LIVE 阀门关。
- LIVE = 同一个引擎跑在真实到期客户上,阀门开。

只要共用一套代码,TEST 通过就代表 LIVE 会一样跑。**TEST 是 LIVE 的镜子,不是另一个功能。**

### 2.2 员工上班模型 (The shift model)
不是"10 点一次性炸完",而是一个 agent **10:00 上班、21:00 下班**,一整天值班。三个硬理由:

1. **防封号** —— 发送摊在 11 小时里,带拟人节奏,不是同一秒炸几十个人。
2. **尊重营业时间** —— 不半夜打扰客户;9 点后不发。
3. **对回复实时反应** —— agent 还在"上班",客户中途回复,能在下一条发出去之前撤掉。

### 2.3 内容与时机分家 (Templates vs Scheduler)
- **Templates = 发什么**(讯息文字,按 Flow / 语言)。你在 `/templates` 维护。
- **Scheduler = 几时发、发给谁**(时机 + 对象)。
- **"隔几天发"写在 Flow 链**(`flow_sequence.mjs`),不在 Templates。
- 发送时才合起来: `到期的人 → 查下一个 Flow → 去 Templates 取文字 → 发`。

### 2.4 两扇门:谁开第一炮 / agent 跟完剩下 (Lead intake boundary)
选"哪个楼盘 + 哪群新客户"**不在 Scheduler 做**,是人的决定:

- **人开第一炮** —— 在 Campaign Center 的「Flow 1 · 新名单群发」:`选楼盘(Binastra/Enlace)→ 选/导入客户群 → 安全检查 → 群发第一轮`。发出去这群人就"进链"(Sequence Running、Next Flow = Flow 2)。
- **agent 跟完剩下** —— Scheduler 从 Flow 2 自动接手,一路跟到 Flow 10。

为什么分开:选楼盘/推哪群人是**生意判断**;Flow 1 是对全新的人第一次接触,风险最高、最该人亲手按。坏客户群就在这道"选群 + 安全检查"关卡挡掉(进链之前),不是发到一半再喊停。

- 新**楼盘** = 项目配置里加。新**客户群** = 导入 / 贴名单,在 Flow 1 群发那边选。
- UI: Automations 页放一个链接「开新一批 → Campaign Center」,一键跳去开第一炮。

---

## 3. 底层模型:per-lead 状态机

不管 24 天还是 30 天,底层很简单。每个 lead 带四样东西:

| 字段 | 意思 |
|---|---|
| `currentFlow` | 现在在哪个 Flow |
| `nextFlow` | 下一个 Flow |
| `nextDueDate` | 下次该发的日期 = 上次发送 + 该 Flow 的 `dueDays` |
| `status` | active / replied / stopped / completed |

每天上班那一下就一句话:**"今天谁到期了 → 发下一个 Flow;除非他回复过,那就交给人。"**

真实客户已经在用这套(状态存在 Notion)。TEST cohort 是同一个状态机的迷你版:4 个号码,存在一个小 JSON 里,自己往前推。所以"跟着 Flow 链、多久跑多久"是天然的 —— 天数从链算出来,不写死。

### Flow 链 (当前)
自动主链是 `Flow 1 → 2 → 3 → 4 → 6 → 7 → 8 → 10`,即 `Day 0 / 2 / 4 / 6 / 9 / 12 / 15 / 18`。
Flow 5(Furnished)、Flow 9(Rental)保留为条件式模板,不进入每天自动排程,也不出现在 Lifecycle Day 里。

---

## 4. 写死 vs 可调 (Hardcoded vs configurable)

**判断法则: 安全规则写死,生意选择留活口。** 目前为求极简,以下全部写死:

| 写死的常量 | 值 |
|---|---|
| `WORK_START` / `WORK_END` | `10:00` / `21:00` |
| `TEST_RECIPIENTS` | CCLIU / Mark / Chin / Anson(`TEST_LEADS`) |
| `PROJECTS` | `Binastra`, `Enlace` |
| `FLOW_CHAIN` | 自动主链 Flow 1/2/3/4/6/7/8/10；Flow 5/9 条件式 |
| `SEND_FLOOR` | 两发之间最小间隔(防封号),默认 ~60 秒(可调 TBD) |
| `SAFE_DAILY_PER_SENDER` | 每个号码每天安全上限(**待你确认**) |
| 安全默认 | 闸门全开、不重发、回复即停、拟人铺发、只补最近漏发 |

> 上班/下班时间目前**写死 10–21**。将来若真要不同窗口,再放出成设定即可(YAGNI —— 用不到先不做)。

---

## 5. 变量 (Variables)

### 5.1 你能碰的(唯一控制)
- `schedulerMode` : `OFF | TEST | LIVE`(内部 = `enabled` + `mode` 合成一个)

### 5.2 实时状态(页面只读显示)
- `shiftStatus`(on-shift / off-shift / closed)、`now`、`offAt`、`remaining`
- `todayProject`、`todayFlow`、`dueCount`
- `sent` / `pending` / `failed`
- `repliesToHandle`(要你出手的回复)
- `cohort`(Day 0…Day 18 / completed / replied / stopped)
- `lastRunSummary`(上一班总结)

---

## 6. 功能 (Functions)

1. **10:00 上班** —— 过安全闸门 → 算今天到期的人(`/api/next-flow/list`)→ 规划这一班。
2. **10:00–21:00 值班** —— 拟人铺发(复用现有 jitter/window pacing)、边发边盯回复、失败自动重试。
3. **回复处理** —— 有人回复(tracker 抓到)→ 移出链、暂停、转 Customer Inbox / Brain;STOP 类关键词由 Bot Rules 硬停。
4. **21:00 下班** —— Notion 收尾 + Telegram 发当天总结。
5. **漏发保护** —— 睡过头/重启后**只补最近该发的**,太旧不补。
6. **停按钮** —— 提前收工(今天不发了,顺延明天)。
7. **模式切换** —— `关闭 / TEST / LIVE`。

---

## 7. 铺发算法 与 今天发多少 (Pacing & daily capacity)

### 7.1 怎么铺(判断时间)
一句话:`今天窗口 ÷ 人数 = 平均间隔`,每一发加随机抖动,压着最小间隔兜底。

- **平均间隔** = (`WORK_END` − `WORK_START`) ÷ 今天要发的人数。
- **每一发** = 上一发 + `max(SEND_FLOOR, 平均间隔 ± 抖动)`。
- **抖动 (jitter)** = 随机浮动,装成人手在发,不是机器精准每 X 秒。
- **最小间隔 (`SEND_FLOOR`)** = 两发之间硬底线,再多人也不挤密(防封号)。
- **排序**:越早到期的先、Flow 越靠前的先。
- **发之前实时复查**:这人回复了就跳过、掉线 / 出窗口就停 —— 不是死排程。

### 7.2 今天发多少(capacity)
**期限不是"9 点前发完 500",而是"今天安全能发多少"。为赶死线把 500 硬塞进一天 = 封号头号原因。**

```
今天发 = min(时间上限, 安全上限) × 号码数
发不完的 → 顺延明天
```

- **时间上限** = 窗口 ÷ `SEND_FLOOR`(11 小时 ÷ 60 秒 ≈ 660 / 号)。
- **安全上限** = `SAFE_DAILY_PER_SENDER`,每号每天封号红线 —— **关键约束,通常远低于时间上限**。
- 想 500 今天全发完 → 唯一安全解是**加号码**(例:4 号 × 125),**不是**缩短间隔硬挤。

例(假设 `SAFE_DAILY_PER_SENDER = 150`):

| 号码数 | 今天发 | 顺延 |
|---|---|---|
| 1 | 150 | 350 |
| 3 | ~450 | ~50 |
| 4 | 500 | 0 |

> **待你确认两个数** →(1)在用的发送号码数;(2)每号每天你安心的上限 `SAFE_DAILY_PER_SENDER`。给了就能算出确切"今天发 X、剩下顺延几天"。

### 7.3 中途喊停
正常 blasting **不需要**中途喊停 —— 过滤"客户群不好"应在**进链之前**做,不是发到一半才发现。所以只保留一颗**普通"停"**当紧急刹车(已发的收不回,只是让后半别再发)。**不做**"顺延 / 退出"的复杂分支。

---

## 8. 界面 (UI) —— 控制塔,不是设定页

**只回答三个问题: 今天做了什么?有没有出错?有没有人要我出手?**

页面结构:

- 顶部: 标题 + 值班状态 + `关闭/TEST/LIVE` 切换
- 当天时间线: 10:00–21:00,现在几点、还剩几条、几点收工
- 三张卡: 今天在发哪个 Flow / 进度(已发·待发·失败)/ 待你出手的回复(最显眼)
- 生命周期看板: 整批人在 Flow 链上的分布(Day 0…完成 / 回复 / 停止)
- 底部: 一颗"停·提前收工"按钮 + 跳转链接

**不放进来的(保持干净):** 讯息全文、聊天记录、Flow 细节设定、技术数字(端口、runId)——都用链接跳去它本来的页面。

### 需要的链接 (Links)
必要:
- 开新一批(选楼盘 + 新客户群)→ **Campaign Center** (`/send`,Flow 1 新名单群发)
- 讯息内容 → **Templates** (`/templates`)
- 回复对话 → **Customer Inbox** (`/conversations`)
- 历史 / 审计 → **Logs** (`/logs`)

可选:
- 看整条链 → **Flow Map** (`/flow-map`)
- 测试号码 / 发送号码 → **Settings** (`/settings`)

---

## 9. 安全设计 (Safety)

保留现有全部 Launch Gate,再加护栏:

- 闸门: WhatsApp 在线、没有 campaign 在跑、队列空、tracker 心跳。
- **幂等**: 同一 Flow 绝不重发给同一人。
- **静默时段硬停**: 窗口外(<10:00 或 >21:00)一律不发。
- **异常自停**: 失败率飙高 → 自动暂停 + 报警。
- **每次通知**: 即使全自动,每天也 Telegram 汇报做了什么。
- **总开关**: `关闭` 直接停。
- LIVE 需明确 arm("我知道这会发真实客户"),默认关。

---

## 10. 复用的现成模块 (Reuse)

| 需求 | 已有 |
|---|---|
| 谁今天到期 | `routes/next-flow.routes.mjs` → `/api/next-flow/list` |
| 每日 tick + 闸门 | `lib/daily-campaign-service.mjs` |
| 拟人铺发 pacing | `campaign_core.mjs`(jitter / window / floor) |
| 回复记录 | `blaster_tracker.mjs`(Reply Tracker) |
| 回复分类 / 是否续链 | `morning_followup.mjs` |
| STOP 关键词 | Bot Rules (`bot_rules.json`) |
| Flow 链定义 | `flow_sequence.mjs` |

---

## 11. 落地顺序 (Build order)

1. **只读控制塔** —— 先接真实数据、只显示不发送,把界面看懂。
2. **TEST cohort 引擎** —— 状态机 + 4 个测试号码走完整条链(真实 24 天时序)+ 回复即停。
3. **接真实客户 = LIVE** —— 同一个引擎打开阀门,补上每日通知 + 总开关。
4. **值班循环** —— 把"10–21 铺发 + 边发边盯回复"接上。

> 先 TEST 跑通、看板看得懂,再开 LIVE。

---

## 12. 待定 / 将来 (Open questions)

- **每项目不同链长**: 现在 `FLOW_SEQUENCE` 是全局单链(所有项目共用 24 天)。若要 Binastra 24 天、别的项目 30 天,需把 Flow 链做成**每项目数据驱动** —— 较大改动,用到时再做。
- **上班/下班时间可调**: 现写死 10–21;需要时再放出成设定。
- **工作日**: 现每天上班;将来或加"只工作日"。
