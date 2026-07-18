# Golden Conversations · FactFind 深度审核版

> 状态：**只供 Marcus 审核，尚未写入 Brain / SQLite / Obsidian / Notion**  
> 来源：`Chat_1_Summary.pdf`、`Chat_2_Summary.pdf`、`gemini-code-1784365295010.txt`、`gemini-code-1784365289448.txt`  
> 隐私处理：客户姓名、电话、电邮与其他识别资料不进入训练内容。  
> 事实安全：价格、库存、促销、距离、完工时间、贷款计算及项目承诺只代表历史聊天；Brain 回答时必须重新读取 Verified Project Knowledge。

## 这次整理的重点

Golden Conversation 不应该只保存“客户问什么、Sales 回什么”。真正要保存的是 Sales 背后的判断过程：

1. 客户表面上在问什么。
2. 客户真正想解决什么生活问题。
3. Sales 为什么在这个时间问这个问题。
4. 客户答案如何改变筛选条件。
5. 为什么原项目不适合，为什么替代项目更接近需求。
6. 目前还缺什么资料，缺资料时不能作出什么结论。
7. 下一条最合理的问题或行动是什么。

因此，每个案例都拆成 `FactFind → Qualification → Matching → Recommendation → Next Step`，而不是让 Brain 背诵整段历史聊天。

---

## Mamba FactFind 标准

Brain 在推荐房源前，应尽量建立以下需求卡。不是每次都一次问完，而是随着对话自然补齐。

| FactFind 模块 | Brain 要确认什么 | 目的 |
| --- | --- | --- |
| 人与角色 | 谁出钱、谁入住、谁决定、是否替家人找 | 避免把询问者当成实际住户 |
| 购房目的 | 自住、投资、两者兼顾、短租或长期持有 | 决定空间、地点、回报与生活便利的权重 |
| 硬性条件 | 产权、房间数、交通、预算、交付时间等不可妥协项 | 不再推荐一开始就不合格的房源 |
| 弹性条件 | 可以调整的地点、面积、楼层、朝向、设施 | 用来扩展候选房源，而不是违反硬条件 |
| 生活与交通 | 工作／上学地点、有没有车、可接受通勤方式和时间 | 把“靠近”变成真实出行需求 |
| 空间需求 | 入住人数、房间、办公、阳台、停车位、未来家庭变化 | 避免只用 sqft 判断适合度 |
| 财务舒适度 | 舒适月供、现金准备、收入稳定性、现有负担 | 找到客户住得安心的方案，不是追求银行最高额度 |
| 时间线 | 何时入住、能否等在建项目、何时方便看房 | 过滤不符合交付和行动时间的项目 |
| 决策过程 | 还有谁要同意、比较哪些项目、当前主要顾虑 | 找到阻碍决定的真正问题 |
| 下一步 | 下一条最值得问的问题、要发哪一份资料、何时再联系 | 每次互动只推进一个清楚动作 |

### Brain 的重要原则

- 一次优先问 **1–2 个最能改变推荐方向的问题**，不要像填表一样连续审问。
- 已确认事实、合理推测和未知资料必须分开。
- 客户的硬性条件没有满足时，不应用宣传话术压过客户。
- 推荐必须附上“为什么符合”，也必须说清楚“哪里还没确认”。
- 财务 FactFind 是为了找舒适范围；贷款资格只能由银行正式评估。
- 如果一个家庭同时有两位使用者或两种需求，必须拆成两张需求卡。

---

# Candidate 01 · 从 Enlace 转向 Trinity Rainfora

## 1. 案例定位

| 字段 | 建议值 |
| --- | --- |
| Primary Project | Trinity Rainfora |
| Origin Project | Pantai Sentral Park / Enlace |
| Scenario | Project Mismatch → Needs Discovery → Alternative Recommendation |
| Customer Type | Parent / Family Representative |
| Primary Purpose | Child Own Stay |
| Outcome | Warm · Viewing Not Booked |
| Language | Mixed Chinese / English |
| Golden 类型 | **FactFind 与项目转换案例；不是成交案例** |

## 2. 客户表面问题与真实任务

客户一开始问的是：

- Enlace 是否 Leasehold。
- 有多少 Tower、什么 Layout、什么价格和面积。
- 朝向、森林、交通、是否会淹水。

但继续聊天后，真正任务变成：

> 一位不在吉隆坡的家长，要替在 KL 工作的孩子找一个适合自住、产权较符合家庭偏好，而且没有车也能出行的房子。

同时聊天里还出现了第二条完全不同的需求：替在 TRX intern 的女儿找短期租房。这个租房需求不应该与主要购房需求混在一起。

## 3. Household Demand Split

### 需求卡 A · 儿子购房／自住

| 项目 | 状态 | 从聊天得到的资料 |
| --- | --- | --- |
| 实际入住者 | 已确认 | 在 Bangsar 工作的孩子 |
| 询问与协调者 | 已确认 | 家长在外地协助寻找 |
| 用途 | 已确认 | 自住 |
| 产权 | 已确认硬条件 | 明确、重复要求 Freehold |
| 通勤 | 部分确认 | 工作地点在 Bangsar；希望靠公共交通 |
| 地点 | 有弹性 | Bangsar 优先，但可看 Cheras / Puchong / Bukit Jalil 等替代区 |
| 房间／面积 | 未确认 | 曾看 1–4 房资料，但没有明确最终入住人数和最低房间数 |
| 预算／月供 | 未确认 | 对话没有建立购买总价或舒适月供范围 |
| 入住时间 | 部分推测 | Sales 认为客户不想等到较迟交付，但客户没有明确确认 |
| 看房时间 | 部分确认 | 取决于孩子工作安排及家长来 KL 的时间 |
| 决策者 | 未完全确认 | 家长与孩子谁最后决定、谁申请贷款仍不清楚 |

### 需求卡 B · 女儿短期租房

| 项目 | 状态 | 从聊天得到的资料 |
| --- | --- | --- |
| 实际入住者 | 已确认 | 在 TRX intern 的女儿 |
| 用途 | 已确认 | 短期租房，不是购买 |
| 交通 | 已确认硬条件 | 没有车，需要公共交通方便 |
| 工作地点 | 已确认 | TRX |
| 地点探索 | 部分确认 | Chan Sow Lin / Kuchai Lama 一带 |
| 租金范围 | 只得到历史范围 | Sales 提到一个大房的大概租金，但客户预算没有确认 |
| 租期、入住日、房型 | 未确认 | 后来女儿自行上网找到房源 |

**Brain 学习点：** 同一位家长提到两个孩子时，必须建立两个独立需求，不可把 TRX 租房条件拿去推荐儿子的购买项目。

## 4. FactFind 推进地图

| 阶段 | 客户信号 | Sales 的动作 | 背后目的／判断 | 对推荐产生的影响 |
| --- | --- | --- | --- | --- |
| 初始兴趣 | 询问产权、Tower、面积和价格 | 提供项目资料与户型 | 判断客户是否在认真比较项目 | 确认客户不是只随便浏览 |
| 用途确认 | 客户说自住 | 询问面积和家庭人数方向 | 自住更重视空间、交通和长期适合度 | 不应再只用投资回报来卖 |
| 硬条件浮现 | 客户多次问 Freehold | 最后承认 Enlace 不符合，并寻找其他地区 | 产权是硬条件，不是普通异议 | 原项目应降级，不继续强推 |
| 使用者识别 | 客户说替孩子找，孩子在 Bangsar 工作 | 询问孩子是否在 KL、何时方便 | 识别询问者不是入住者 | 看房与决定都需要孩子参与 |
| 第二需求出现 | 女儿在 TRX intern，需要租房 | 探索 Chan Sow Lin / Kuchai Lama 和交通 | 先帮助解决实际问题，建立信任 | 但必须与购买需求分开 |
| 交通约束 | 女儿没有车；购房也要求靠轨道交通 | 发送路线和交通资料 | 公共交通是家庭的重要筛选条件 | 替代项目必须能解释真实通勤路径 |
| 地点放宽 | 客户愿意看 Bangsar 以外 Freehold | 提出 Cheras / Puchong / Bukit Jalil | 以硬条件换取地点弹性 | 候选池扩大到 Rainfora |
| 替代推荐 | 客户要求介绍、Layout、距离 | 推荐 Rainfora 并说明 Freehold、轨道交通和成熟社区 | 对齐产权、交通和生活便利 | 客户从拒绝原项目转为主动索取资料 |
| 行动推进 | 客户原本打算去看 | 询问 weekday / weekend，持续跟进 | 尝试把兴趣转为 Viewing | 因孩子生病而延期，不算已预约 |
| 关系保护 | 客户说孩子生病 | 先关心健康，不追着定时间 | 保护信任和未来回访可能 | Outcome 保持 Warm |

## 5. 推荐逻辑是否成立

### 已有匹配证据

| 客户条件 | Rainfora 匹配状态 | Brain 可怎样表达 |
| --- | --- | --- |
| Freehold 偏好 | 历史聊天称符合；正式回答仍须 Verified Knowledge | “这个项目可能更接近你的产权偏好，我先用最新资料再确认。” |
| 靠公共交通 | 历史聊天称靠近 BK5 站；距离须重新核实 | “交通方向看起来更符合孩子没车的需要，我会确认步行路线。” |
| 成熟生活区 | 历史聊天列出商店、银行和餐饮 | “周边生活便利是一个匹配点，但我会把实际位置和距离整理给你。” |
| Bangsar 以外可接受 | 客户明确愿意听替代地区 | “如果地点可以放宽，这个区可以进入候选名单。” |

### 仍不足以确认“最适合”的资料

- 购房预算和舒适月供。
- 最少房间数、入住人数和未来家庭安排。
- 谁负责贷款、谁是最终决定者。
- 可接受的交付日期／是否只考虑即将完工项目。
- 从项目到孩子工作地点可接受的门到门通勤时间。
- 停车位、日常驾车需求及其他生活条件。

因此更准确的说法应该是：

> Rainfora 是一个比原项目更接近现有硬条件的候选房源，但在预算、空间和入住时间没有确认前，不能称为最终最适合。

## 6. 上司真正值得学习的思路

1. **不把拒绝当作结束。** 客户拒绝的是 Leasehold，不是拒绝买房。
2. **从产品问题进入生活问题。** 从产权逐步了解入住者、工作地点、车辆和看房限制。
3. **让地点成为可协商项。** 保留 Freehold 和交通两个硬条件，放宽 Bangsar 地点。
4. **先帮忙，再销售。** 即使短租不是主要业务，也提供交通区域建议，累积信任。
5. **找到替代房源后解释匹配原因。** 不是只说“还有另一个项目”，而是把产权、交通、生活区与客户需求连接起来。
6. **客户遇到家庭状况时停止施压。** 保留关系比抢预约更重要。

## 7. 不能直接让 Brain 模仿的部分

- 客户第一次、第二次问 Freehold 时没有立刻正面回答，反而继续讲项目优势。
- “Bangsar 没有 Freehold”“不会淹水”“不会塞车”等绝对说法。
- 在预算和房间数还没确认前就发送大量项目资料。
- 两位孩子、购买与租房的需求在聊天中有一度混在一起。
- 多次重复邀请看房；Brain 应根据客户回应和约定日期再跟进。
- 历史价格、库存、交付日期、步行距离与促销不得当作长期事实。

## 8. Brain 应采用的安全话术演练

> 以下是根据案例整理的理想流程，不是原聊天逐字重建。凡原案例没有确认的资料，演练中必须继续提问，不可替客户补答案。

```text
CUSTOMER: 我是在帮孩子找房子。他在 Bangsar 工作，主要是自己住。我们比较想找 Freehold。

SALES: 明白。你是帮孩子做第一轮筛选，最后也会让他一起决定，对吗？Freehold 对你们是必须条件，还是如果地点和交通非常适合也愿意比较？

CUSTOMER: 最好是 Freehold。孩子上班方便也很重要。

SALES: 好，我先把 Freehold 当成硬条件。为了不要推荐错，我再确认两个重点：孩子平时有没有开车？最低需要几房？

CUSTOMER: 交通方式和房间数我还要跟他确认。

SALES: 明白。目前原本看的项目在产权上不符合，所以我不会继续把它当首选。如果地点可以从 Bangsar 放宽到 Bukit Jalil／Puchong 交界，我可以先筛选 Freehold，并把公共交通条件列为待确认项目。

CUSTOMER: 可以，有什么可以看？

SALES: Rainfora 可以先放进候选名单，因为它可能更接近产权和公共交通需求。我会先给你位置与 Layout；产权、实际步行路线、最新价格和库存会从最新项目资料确认。

CUSTOMER: 可以，给我看看。

SALES: 好。在我帮你比较户型前，还需要知道你们舒服的总价或月供范围，以及希望什么时候可以入住。这样我才能判断它是真的适合，还是只有地点和产权看起来适合。

CUSTOMER: 我先发给孩子看，之后再告诉你。

SALES: 没问题。你先和孩子确认房间、预算和入住时间；得到这些资料后，我可以把不合适的单位先过滤掉，留下两三个比较清楚的选择。

CUSTOMER: 我原本打算去看，但孩子生病了。我下次去 KL 再通知你。

SALES: 好的，先让孩子休息，身体比较重要。你们准备来 KL 时再告诉我，我再确认当时最新资料和适合的看房时间。
```

## 9. 下一轮最佳 FactFind

客户重新联系时，Brain 不应该马上再发宣传资料。建议依次确认：

1. “这次主要还是替在 Bangsar 工作的孩子买来自己住，对吗？”
2. “Freehold 仍然是必须条件吗？”
3. “最低几房、预计几个人住？”
4. “舒服的总价或月供范围大概在哪里？”
5. “希望什么时候入住，可以等在建项目多久？”
6. “孩子从家到工作地点，门到门最多能接受多久？”

## 10. Marcus 审核

- [ ] 两位孩子／两条需求的拆分正确
- [ ] Freehold 属于硬条件的判断正确
- [ ] Rainfora 只属于候选项目，不是已确认最终匹配
- [ ] Outcome = Warm · Viewing Not Booked 正确
- [ ] 可以作为 FactFind Golden 写入 Brain
- [ ] 需要修改

修改备注：

---

# Candidate 02 · 从高价 Enlace 转向 The Verando

## 1. 案例定位

| 字段 | 建议值 |
| --- | --- |
| Primary Project | The Verando |
| Origin Project | Pantai Sentral Park / Enlace |
| Scenario | Affordability Objection → Financial Comfort FactFind → Alternative Recommendation |
| Customer Type | Direct Buyer |
| Purpose | Investment + Own Stay |
| Outcome | Warm · Viewing Not Booked |
| Language | Mixed Chinese / English |
| Golden 类型 | **预算重定位与房型匹配案例；不是贷款批准案例** |

## 2. 客户表面问题与真实任务

客户表面上询问：

- Bangsar South 的项目价格、产权和户型。
- 1249 sqft 单位、首付和折扣。
- A / A1 / B / B1 的面积、阳台和价格差异。

真正任务是：

> 在投资与自住都可能的情况下，找到至少两房、月供最好不超过约 RM2.5k，而且不会令日常生活太紧张的房源；地点可以适当调整。

客户说“我负担不起”并不是退出市场，而是在拒绝不符合舒适财务范围的产品。

## 3. FactFind 需求卡

| 项目 | 状态 | 从聊天得到的资料 |
| --- | --- | --- |
| 购买者／入住者 | 大致确认 | 客户本人直接比较，但实际入住安排仍不完整 |
| 用途 | 已确认但需排序 | 投资和自住都有可能；哪个优先未明确 |
| 房间数 | 已确认硬条件 | 不喜欢 Studio，至少 2 房，接受 2–3 房 |
| 地点 | 已确认有弹性 | 不一定要 Bangsar，可考虑 PJ / Sunway 方向 |
| 月净收入 | 已确认（敏感资料） | 约 RM4k；应得到客户同意后才记录 |
| 舒适月供 | 已确认硬上限倾向 | 希望约 RM2.5k 以内，保留日常开销 |
| 现有负担 | 部分确认 | 无车贷、无 PTPTN；信用卡每月清；有人寿保险 |
| 产权关注 | 有信号、未确认偏好 | 客户主动问 Residential／Commercial，但未说明是否影响决定 |
| 首付能力 | 未确认 | 客户问过首付，但没有确认可动用现金、律师费与缓冲资金 |
| 工作与通勤 | 未确认 | 没有明确工作地点、出行方式和可接受通勤时间 |
| 入住／投资时间线 | 未确认 | 没有确认什么时候买、入住或开始出租 |
| 贷款条件 | 不完整 | 年龄、职业、工作年限、其他收入、信用记录与银行评估均未完成 |
| 决策过程 | 部分确认 | 愿意比较户型和尝试看房，但没有确定日期 |

## 4. FactFind 推进地图

| 阶段 | 客户信号 | Sales 的动作 | 背后目的／判断 | 对推荐产生的影响 |
| --- | --- | --- | --- | --- |
| 项目兴趣 | 问价格、产权和大户型 | 提供 Enlace 资料 | 判断项目与户型兴趣 | 客户喜欢空间，但尚未谈预算 |
| 负担异议 | 客户明确说月薪约 RM4k、负担不起 | 停止硬推大户型，确认是否净收入 | 把“买不起”转成可量化条件 | 原本 RM1m+ 级单位出局 |
| 产品底线 | 客户说 Studio 不理想 | 接受至少 2–3 房条件 | 房间数是硬条件，不能只推荐最便宜产品 | 必须换地点或项目才能兼顾预算 |
| 地点弹性 | 客户表示区域灵活 | 把搜索范围从 Bangsar 扩展至 PJ South | 用地点弹性换取更合适空间 | The Verando 进入候选池 |
| 舒适度 | 客户要月供控制在约 RM2.5k | 以月供作为筛选边界 | 客户关心生活平衡，不是最高贷款额度 | 应优先展示 Comfort Option |
| 财务资料 | 客户同意分享现有负担 | 询问车贷、PTPTN、信用卡 | 初步了解债务负担 | 只能用于初筛，不能保证贷款 |
| 空间比较 | 客户主动问 A、A1、B1、阳台和餐厅 | 比较 Layout 和剩余单位 | 兴趣从“价格”转向“如何生活” | 推荐已经成功引发进一步评估 |
| 预算压力再出现 | 客户说 Type B 有点吃紧 | 接受顾虑并邀请实地比较 | 客户已划出 Comfort vs Stretch 边界 | Type B 不应继续被说成轻松可负担 |
| 下一步 | 客户说会尝试安排 | 给 weekday / weekend 选择 | 尝试减少预约阻力 | 尚未选定日期，仍是 Warm |

## 5. 正确的房源排序逻辑

客户的目标不是“银行理论上可以批到最大的单位”，而是：

1. 至少两房。
2. 月供尽量不超过舒适范围。
3. 地点可以调整。
4. 自住和投资都能解释得通。

因此候选房源应该分层：

| 层级 | 定义 | Brain 应怎样说 |
| --- | --- | --- |
| Comfort Option | 最接近房间数与舒适月供，不压缩日常开销 | “这个先作为主要比较对象。” |
| Balanced Option | 空间更好，但可能接近月供上限 | “要结合最新净价、贷款方案与现金缓冲再确认。” |
| Stretch Option | 理论上可能申请，但客户已表示会吃紧 | “可以看空间差异，但不应当作首选。” |
| Not Suitable | 超出舒适月供或违反房间硬条件 | “直接排除，不浪费客户时间。” |

历史聊天里，客户对 Type B 已明确表示预算吃紧。因此 Brain 不应该回答“Type B 也可以负担”或“银行稳批”，而应把它降为 Stretch Option。

## 6. 推荐逻辑是否成立

### 已有匹配证据

| 客户条件 | The Verando 匹配状态 | Brain 可怎样表达 |
| --- | --- | --- |
| 至少两房 | 历史 Layout 看起来符合；须从最新资料确认 | “房型方向符合你不要 Studio 的要求。” |
| 地点可调整 | 客户明确同意灵活区域 | “地点放宽后，PJ South 可以进入比较。” |
| 舒适月供 | 部分候选可能接近；不可直接保证 | “我会先用最新净价估算，再由银行正式评估。” |
| 自住空间 | 客户主动比较客厅、餐厅、阳台 | “Layout 值得作为生活使用角度进一步比较。” |
| 投资可能 | 尚未完成租赁需求和回报 FactFind | “投资表现目前资料不足，不能只靠宣传判断。” |

### 仍缺的重要资料

- 自住与投资哪一个优先。
- 实际入住人数、停车位和工作地点。
- 可用于首付、费用及紧急缓冲的现金。
- 职业、受雇性质、工作年限和年龄等银行评估资料。
- 产权类型对客户是否属于硬条件。
- 预期持有年限、租客类型和可接受空置风险。
- 希望什么时候完成购买／入住。

此外，PDF 的项目摘要与聊天内容对 The Verando 的产权描述并不一致：一处写 Commercial HDA，聊天中另一处写 Residential Title。这个冲突必须交给 Verified Project Knowledge 处理，Golden 不得选择其中一个当作事实。

所以 The Verando 应被定位为“更接近空间和预算方向的候选项目”，不是已经完成贷款与投资适配的最终答案。

## 7. 上司真正值得学习的思路

1. **听见客户真正拒绝的原因。** 客户不是不想买，而是不想让月供破坏生活平衡。
2. **把硬条件具体化。** Studio 不接受、至少两房，是比“喜欢大一点”更有用的筛选条件。
3. **用地点弹性解决预算与空间冲突。** 不再死守 Bangsar 的高单价。
4. **得到允许后做财务 FactFind。** 收入、负担和信用卡情况帮助建立初步舒适范围。
5. **替代方案出现后，客户开始主动比较 Layout。** 这是推荐方向更匹配的强信号。
6. **把线上兴趣推进到实地体验。** 户型空间差异适合在 Showroom 验证。

## 8. 不能直接让 Brain 模仿的部分

- 在完整财务资料和银行评估前说“银行稳批”“肯定能批”。
- 用固定 70% DSR 当成适用于所有银行和所有客户的结论。
- 先推荐房源，之后才补问关键财务与生活资料；更聪明的做法是先确认硬条件。
- 客户已经说 Type B 吃紧后，仍继续强调理论可贷。
- 没有确认首付现金、紧急缓冲、职业稳定性和购房时间线。
- 历史利率、月供、折扣、售价、楼层和库存不得成为 Brain 的长期事实。
- 财务资料属于敏感资料；Brain 应先说明用途并取得同意，只收集必要信息。

## 9. Brain 应采用的安全话术演练

> 以下是根据案例整理的理想流程，不是原聊天逐字重建。演练新增的问题用于展示更完整的 FactFind，不代表客户在原聊天已经给过答案。

```text
CUSTOMER: 这个大户型很好，但我的净收入大约 RM4k，我觉得负担不起。Studio 也不是我想要的，我至少希望两房。

SALES: 明白，那我们先排除这个大户型，也不拿 Studio 来勉强配预算。你希望每个月供到什么范围仍然觉得生活舒服？地点是否可以从 Bangsar 放宽？

CUSTOMER: 最好控制在 RM2.5k 左右，地点可以灵活。

SALES: 好，我先记录两个硬条件：至少两房、月供舒适范围约 RM2.5k。为了做初步筛选，我可以再问你几个必要的财务问题吗？最终贷款仍要由银行正式评估。

CUSTOMER: 可以。

SALES: 目前有没有车贷、PTPTN、个人贷款或信用卡未清余额？另外，你准备给首付和相关费用的现金范围大概是多少？

CUSTOMER: 没有车贷或 PTPTN，信用卡每月清。首付现金我还要确认。

SALES: 明白。那我现在只能先按月供舒适度筛项目，不能先判断银行一定批准。地点放宽后，PJ South 的 The Verando 可以进入候选名单，因为有两房以上 Layout，价格方向也比原本的大户型接近你的范围。

CUSTOMER: 看起来不错。Type A、A1 和 B 有什么分别？

SALES: 我会分成三个层级给你看：最接近舒适月供的是主要选择；接近上限的是平衡选择；超过舒适范围的只作为空间比较。最新售价、库存和月供会重新确认。

CUSTOMER: Type B 感觉有一点吃紧。

SALES: 那 Type B 就不当首选。我们先比较较接近舒适范围的户型，再看客厅、阳台和实际生活空间是否够用。你主要是自己住，还是投资出租的比重更高？

CUSTOMER: 两个都有可能。

SALES: 好，那看房前我会准备两套比较：一套按自住空间和通勤，一套按出租对象和持有成本。你看完后再决定哪个目的优先，不需要先被某个大户型绑住。

CUSTOMER: 我会尝试安排时间。

SALES: 没问题。Weekday 还是 weekend 比较容易？你选一个方向后，我再确认具体日期和最新可售单位。
```

## 10. 下一轮最佳 FactFind

客户重新联系时，建议依次确认：

1. “现在自住和投资，哪一个是第一优先？”
2. “预计几个人住，至少两房之外还有什么空间不能少？”
3. “平常在哪里工作、开车还是公共交通？”
4. “RM2.5k 是理想值还是绝对不能超过的上限？”
5. “首付、费用和应急缓冲准备到什么范围？”
6. “希望什么时候买／入住？”
7. “是否同意由银行正式做资格评估？”

## 11. Marcus 审核

- [ ] 月供舒适度比最高贷款额度重要的判断正确
- [ ] 至少两房属于硬条件
- [ ] Type B 应属于 Stretch Option，而不是首选
- [ ] Outcome = Warm · Viewing Not Booked 正确
- [ ] 可以作为 FactFind Golden 写入 Brain
- [ ] 需要修改

修改备注：

---

# Candidate 03 · 外州自住客户的房型收窄与看房培育

## 1. 案例定位

| 字段 | 建议值 |
| --- | --- |
| Primary Project | Pantai Sentral Park / Enlace |
| Scenario | Outstation Own-Stay Buyer → Layout Qualification → Viewing Nurture |
| Customer Type | Direct Buyer · Outstation |
| Purpose | Own Stay |
| Outcome | Warm · Viewing Not Booked |
| Language | Mixed Chinese / English |
| Golden 类型 | **异地客户需求收窄与时机培育案例；不是已预约案例** |

## 2. 客户表面问题与真实任务

客户表面上询问：

- 项目是否已经建好、何时完工。
- 楼下是否有商业、有没有阳台。
- 797 / 979 / 1249 sqft 的 Layout、视频、楼层和价格。
- 发展商、Booking Fee、律师费与退款安排。

真正任务是：

> 一位对 KL 不熟悉、准备从外州来到 KL 的买家，希望寻找适合自住的两房单位；目前仍在了解地点、交付时间、房型与购买流程，还没有完成预算和贷款资格确认。

客户询问 Booking Fee 和看了多个户型，代表参与度较高，但不等于已经准备付款。现阶段更准确的判断是“认真研究中的 Warm Lead”。

## 3. FactFind 需求卡

| 项目 | 状态 | 从聊天得到的资料 |
| --- | --- | --- |
| 购买者／入住者 | 大致确认 | 客户本人从外州来 KL，自住 |
| KL 熟悉程度 | 已确认 | 不熟悉 Bangsar South 与 KL 地理 |
| 用途 | 已确认 | 自住 |
| 房间数 | 部分确认 | 明确问两房，也要求看三房视频；最终最低／理想房数仍需确认 |
| 阳台 | 有明显偏好 | 主动询问单位是否带阳台 |
| 地点评价 | 有兴趣 | 认可项目位于 PJ 与 KL 之间的连接性 |
| 完工／入住时间 | 关键但未完成 | 主动问是否建好、何时完工；Sales 问何时搬来但没有得到有效答案 |
| 预算 | 未确认 | Sales 问预算、也问能否提高至较大单位价位，客户没有给范围 |
| 贷款状态 | 未确认 | Sales 询问是否第几套房／贷款准备情况，客户没有回答 |
| Household | 未确认 | 几个人入住、是否需要第三房、未来家庭变化均未知 |
| 工作／日常区域 | 未确认 | 为什么搬来 KL、在哪里工作、通勤方式均未收集 |
| 现金准备 | 未确认 | 客户问 Booking Fee，但首付、费用及现金缓冲未确认 |
| 看房时间 | 部分确认 | 客户表示将从外州来 KL，Sales 计划之后联系；没有确定日期 |

## 4. FactFind 推进地图

| 阶段 | 客户信号 | Sales 的动作 | 背后目的／判断 | 对推荐产生的影响 |
| --- | --- | --- | --- | --- |
| 地点不熟 | 客户不知道 Bangsar South | 提供地图、视频和区域连接资料 | 先建立客户的地理认知 | 客户后来认可连接 PJ 与 KL 的位置 |
| 交付关注 | 客户问是否建好、何时完成 | 说明在建与历史预计年份 | 判断客户是否能等项目完成 | 但客户搬家时间没有真正确认 |
| 用途确认 | 客户说自住 | 问预计几时搬来、预算和房间数 | 从宣传进入生活需求 | 得到两房方向，但预算／时间仍缺失 |
| 空间偏好 | 客户问阳台、两房和室内视频 | 提供 797 sqft Layout 与 Virtual Tour | 测试具体房型兴趣 | 797 看起来是初步候选 |
| 产品扩展 | 客户要求三房视频 | 提供 979 与 1249 sqft 资料 | 让客户理解空间升级 | 但没有先确认为什么需要三房 |
| 信任／风险 | 客户问发展商与 Booking Fee | 提供发展商、退款和费用说明 | 处理交易安全感 | 这些条款必须从最新正式资料确认 |
| 预算测试 | Sales 问能否承担较大单位 | 列出不同两房设计与价格带 | 尝试识别承受范围 | 客户没有回答，不能假设预算足够 |
| 看房推进 | 多次给日期与时段 | 尝试把研究转为现场体验 | 异地客户需要提前规划 | 客户没有确认具体到 KL 日期 |
| 长线培育 | Sales 约定之后联系 | 继续分享区域和交通资料 | 保持项目记忆 | 跟进应以客户旅程时间为准，避免过密 |

## 5. 房型收窄逻辑

从已有资料看，不应该把三个房型放在同一个优先级：

| 房型方向 | 当前匹配判断 | 仍需确认 |
| --- | --- | --- |
| 797 sqft 两房 | 最接近客户已表达的“两房 + 阳台” | 总价／月供、实际空间、入住人数、交付时间 |
| 979 sqft 两房 | 空间升级候选，客户有看视频 | 为什么需要更大空间、预算能否舒服承担 |
| 1249 sqft 三房 | 客户主动要求资料，可保留作比较 | 是否真的需要第三房，还是只想理解项目完整产品 |

Brain 应先问“谁住、需要几间独立房、预算和入住时间”，再决定推荐哪个房型。客户要求看视频，不代表该房型已经符合财务和生活需求。

## 6. 上司值得学习的思路

1. **先补地点认知。** 对 KL 不熟的客户需要地图、主要区域和生活动线，而不只是项目宣传。
2. **从用途进入房型。** 确认自住后，再问房间和搬迁时间。
3. **用视频降低异地了解成本。** Virtual Tour 和 Showroom Video 能帮助客户先过滤不喜欢的空间。
4. **回应交易安全问题。** 发展商、Booking Fee 和退款条件是客户判断风险的重要资料。
5. **提供不同空间层级。** 让客户看见两房与三房的取舍，而不是只有一个单位。
6. **接受客户需要时间。** 外州客户的下一步应围绕实际来 KL 的行程。

## 7. 不能直接让 Brain 模仿的部分

- 客户问完工时间后，没有完成“客户最迟何时需要入住”的 FactFind。
- 客户没有给预算和贷款资料，却大量发送更高价格房型。
- “最后一间”“只剩几间”“优先给贷款准备好的 Buyer”等历史稀缺信息不可长期复用。
- 商户数量、完工年份、MRT、折扣、退款和律师费必须重新验证。
- 多次使用不同日期模板邀请看房，但客户尚未给明确 KL 行程；容易形成追问压力。
- “Facebook 广告都是还没建好”等笼统说法不专业，也不能解释项目阶段。
- 客户看三房视频可能只是探索，不应自动改成三房需求。

## 8. Brain 应采用的安全话术演练

> 以下是根据案例整理的理想流程，不是原聊天逐字重建；没有确认的预算、贷款和时间线必须继续提问。

```text
CUSTOMER: 我不太熟 KL。这个项目建好了吗？我主要想买来自住。

SALES: 目前项目阶段和预计交付时间，我会用最新官方资料确认给你。你是准备什么时候搬来 KL？如果交付时间晚于你的入住计划，我就不应该把它当首选。

CUSTOMER: 时间还没完全确定。我想先了解两房，有阳台会比较好。

SALES: 明白，先记录自住、两房和阳台三个方向。预计几个人入住？平时主要去 KL 哪一区工作或生活？

CUSTOMER: 这些我还要确认。

SALES: 没问题。797 sqft 可以先作为空间参考，因为它的历史 Layout 方向接近两房和阳台；但最新户型、价格和库存我会重新确认。你也想看较大的两房或三房，是因为需要更多房间，还是想比较空间感？

CUSTOMER: 主要想比较空间。

SALES: 那我会把较大户型列作比较，不先当成推荐。下一步最重要的是确认舒服预算和入住时间，这两个答案会决定较大的房型是否值得继续看。

CUSTOMER: 我之后会去 KL。

SALES: 好。你确认行程后告诉我日期，我再安排一次集中看房；看房前我先把符合两房、阳台和预算的单位缩到两三个，避免你从外州过来却看很多不适合的房源。
```

## 9. 下一轮最佳 FactFind

1. “你计划什么时候正式搬来 KL？最迟需要何时可以入住？”
2. “平时主要在哪里工作／生活，开车还是公共交通？”
3. “预计几个人入住，第三房是必须还是只作空间比较？”
4. “舒服的总价或月供范围大概是多少？”
5. “首付和其他费用准备在什么范围？”
6. “你确认哪一天到 KL 后，我再集中安排最匹配的单位。”

## 10. Marcus 审核

- [ ] 客户属于外州自住买家
- [ ] 797 sqft 只是初步候选，不是已确定房型
- [ ] 客户尚未提供预算、贷款和入住时间
- [ ] Outcome = Warm · Viewing Not Booked 正确
- [ ] 可以作为 FactFind Golden 写入 Brain
- [ ] 需要修改

修改备注：

---

# Candidate 04 · 数据型投资客户的证据核实与看房预约

## 1. 案例定位

| 字段 | 建议值 |
| --- | --- |
| Primary Project | Pantai Sentral Park / Enlace Suite 1 & 2 |
| Scenario | Investment Research → Unit Comparison → Viewing Scheduled |
| Customer Type | Direct Buyer · Analytical Investor |
| Purpose | Investment |
| Outcome | Viewing Scheduled · Attendance Not Yet Proven |
| Language | English Preferred / Mixed |
| Golden 类型 | **投资 FactFind、证据比较与预约处理案例；不是已到场或成交案例** |

## 2. 客户表面问题与真实任务

客户明确表示刚开始做市场调研、以投资为目的。她询问：

- 每平方尺售价与该区实际租金。
- 当前公共交通与未来 MRT 的分别。
- 474 sqft Studio 与 560 sqft 一房的投资差异。
- Suite 1 与 Suite 2 的价格差。
- 家具是否包含、楼层、景观、净价和月供差异。
- 与 Laurel 的距离，以及样板间是否展示真实材料。

真正任务是：

> 找到一个入场成本、租赁需求、交通兑现时间和持有风险都合理的小户型投资，同时用可核实数据比较 Suite、房型、楼层与景观的真实回报。

这是一个数据敏感型客户。她不是只需要更多宣传资料，而是需要证据质量清楚的 Investment Case。

## 3. FactFind 需求卡

| 项目 | 状态 | 从聊天得到的资料 |
| --- | --- | --- |
| 用途 | 已确认 | 投资 |
| 研究阶段 | 已确认 | 刚开始 Market Research |
| 语言偏好 | 已确认 | 英文沟通较舒服；Sales 有配合 |
| 房型 | 部分确认 | 主动比较 474 sqft Studio 与 560 sqft 一房 |
| 入场成本 | 明显关注 | 问 PSF、Suite 价差、净价和楼层差价 |
| 租赁回报 | 明显关注 | 主动问 Transacted Rental 与租金水平 |
| 交通 | 明显关注 | 能否步行到现有交通、未来 MRT 何时兑现 |
| 产品细节 | 明显关注 | 家具、材料、楼层、景观和 Layout |
| 竞争项目 | 有比较意识 | 主动问与 Laurel 的距离 |
| 投资目标 | 未确认 | 现金流、资本增值或两者，尚未排序 |
| 目标回报 | 未确认 | 没有确认最低 Gross／Net Yield 或 Cash-on-Cash 目标 |
| 财务能力 | 未确认 | 预算、首付、贷款能力和持有现金没有收集 |
| 持有期限 | 未确认 | 没有确认预计持有几年和退出计划 |
| 风险承受 | 未确认 | 对 2029 项目交付、2032 交通假设、空置和利率风险的接受度未知 |
| 目标租客 | 只有 Sales 推测 | Sales 提到 Bangsar South 公司与小户型需求，但客户没有确认投资策略 |
| 看房 | 已预约并改期 | 最后确认下周三 2 PM，并在前一晚再次确认；未证明实际到场 |

源文件包含客户车牌，这是停车登记用途的个人资料。Golden 与 Brain 必须完全删除，不得进入训练、SQLite、Obsidian 或日志摘要。

## 4. FactFind 推进地图

| 阶段 | 客户信号 | Sales 的动作 | 背后目的／判断 | 对推荐产生的影响 |
| --- | --- | --- | --- | --- |
| 目的识别 | 客户说刚开始投资研究 | 推荐较低入场的小单位和 Suite 1 | 用投资目的调整产品方向 | Studio／一房进入候选 |
| 语言适配 | 客户问能否用英文 | Sales 切换英文 | 降低沟通摩擦 | 客户持续提出详细问题 |
| 数据要求 | 问 PSF、Transacted Rental 和公共交通 | 提供售价、租金、竞争项目和交通资料 | 建立投资论点 | 但证据层级没有清楚标示 |
| 房型收窄 | 客户选 474 或 560 sqft | 比较 Studio 与一房 Layout | 判断小户型偏好 | 客户开始比较入场成本与租赁需求 |
| Suite 比较 | 客户问 Suite 1 vs 2 | 强调 Suite 1 入场较低、历史声称 ROI 较高 | 给投资方向 | 缺少完整净回报计算支持 |
| 库存／楼层 | 客户问可售楼层和净价 | 提供不同景观与楼层的历史价格 | 将兴趣落到具体单位 | 客户愿意安排 Showroom |
| 实体验证 | 客户问家具与材料是否同样板间 | 说明可到 Showroom 看实际样品 | 把线上资料转为现场核实 | 形成第一次预约 |
| 改期处理 | 客户临时有事 | Sales 接受改期并给新日期 | 保护客户体验，不制造压力 | 预约成功移到周三 2 PM |
| 预约确认 | 看房前一晚联系 | 确认时间与停车资料是否一致 | 降低 No-show 风险 | 状态是 Scheduled，不是 Attended |

## 5. 投资证据必须分层

这段案例最重要的 Brain 规则，是不能把不同质量的数字混成同一种事实：

| 证据层级 | 例子 | Brain 可否直接引用 |
| --- | --- | --- |
| Verified Transaction | 有来源、日期和同类单位的真实成交／租约 | 可以，必须标明来源与日期 |
| Current Official Data | 发展商最新价单、正式库存、书面配套 | 可以，但须显示有效日期 |
| Comparable Market Data | 附近项目类似面积、楼龄和配套的成交／租赁数据 | 可以作比较，必须说明差异 |
| Asking Price / Listing | Portal 上的出租叫价或业主期望 | 只能叫“挂牌／叫价”，不能叫成交租金 |
| Sales Projection | 预计租金、预计升值、未来租客需求 | 只能作情景假设，不能包装为事实 |

客户问的是 `transacted rental`。如果提供的是宣传图、挂牌价或预计租金，Brain 必须坦白数据类型，不能回答成已经发生的租赁成交。

## 6. 投资比较应计算什么

Brain 不应只说“入场低、ROI 高”。至少要建立：

```text
Gross Rental Yield
= 年租金 ÷ 最新净购价

Estimated Net Rental Yield
=（年租金
   - 预计空置
   - 管理费与 Sinking Fund
   - 门牌税／地税
   - 保险、维修与家具损耗
   - 代理／租赁成本）
  ÷ 总投资成本

Cash-on-Cash Return
= 年度税前现金流 ÷ 实际投入现金
```

所有输入都要标明：Verified、Comparable、Assumption 或 Unknown。缺少管理费、贷款、空置与现金投入时，不能下结论说哪一个单位 ROI 最高。

## 7. Unit / Suite 推荐逻辑

| 候选方向 | 可能优势 | 主要未知／风险 |
| --- | --- | --- |
| 474 sqft Studio | 较低总价方向、小户型租赁定位 | 实际租约证据、Studio 供应量、净租金、竞争项目与退出流动性 |
| 560 sqft 一房 | 独立睡房，可能覆盖更广租客 | 历史库存紧张说法需更新；价差是否带来足够租金差 |
| Suite 1 | 历史聊天认为入场较低 | 与 Suite 2 的交付、景观、配套和租金差需同口径比较 |
| Suite 2 | 较新推出、历史 PSF 较高 | 高价是否有足够租金或增值依据 |
| 高层森林景观 | 景观与楼层可能增加吸引力 | 历史溢价是否能通过租金／转售价收回 |
| 较低价 City View | 较低投入、月供压力可能较小 | 景观、噪音和出租差异需验证 |

Brain 应给客户一张同口径比较表，而不是把“剩最后两个单位”当作投资理由。

## 8. 上司值得学习的思路

1. **快速识别投资目的。** 没有继续用纯自住话术介绍大户型。
2. **适配客户语言。** 客户选择英文后，沟通自然度明显提高。
3. **回应客户的数据型问题。** 对 PSF、租金、交通、房型、景观和净价逐项回应。
4. **把候选缩到 Studio／一房。** 符合客户主动选择的小户型研究方向。
5. **使用实物验证推进看房。** 家具、材料、Layout 与景观适合在 Showroom 核实。
6. **正确处理改期。** 没有因客户临时变动施压，而是快速确认新时间。
7. **看房前重新确认。** 对降低 No-show 有帮助，但个人资料不进入 Brain。

## 9. 不能直接让 Brain 模仿的部分

- “Studio 可以租到某个数目”“Higher ROI”等结论没有展示真实租约与完整净回报计算。
- 将未来 MRT 与当前公共交通表达得太接近；必须清楚分开 `Current / Interim / Future`。
- “该区唯一有盖连桥”“附近 Studio 都能租到某范围”等绝对说法。
- 用未来租客、MNC、商户和交通兑现作为确定性结果。
- 没有先确认预算、现金、贷款、持有期限、目标回报和风险承受度。
- 用剩余单位和贷款被拒的 Released Unit 制造紧迫感；尤其不应拿其他买家的贷款结果开玩笑。
- 没有把 Asking Rent、Comparable Rent 和 Transacted Rent 分开。
- 车牌属于个人资料，只用于当次停车安排，必须从训练资料彻底删除。

## 10. Brain 应采用的安全话术演练

> 以下是根据案例整理的理想流程，不是原聊天逐字重建；所有租金、售价、库存与交通资料都必须由最新来源支持。

```text
CUSTOMER: I just started my market research and I'm looking mainly for investment. What is the PSF and transacted rental in this area?

SALES: Sure. Before comparing units, may I understand whether your priority is monthly cash flow, long-term appreciation, or a balance of both? I will also separate verified transactions from current asking rents and projections.

CUSTOMER: A balance of both. I'm comparing the 474 sqft Studio and 560 sqft one-bedroom.

SALES: Good, then we should compare them on the same basis: latest net price, verified or comparable rent, maintenance and holding cost, vacancy assumption, loan structure and exit demand. Do you already have a comfortable purchase budget or cash amount in mind?

CUSTOMER: I'm still working that out. How is the public transport now, before the future MRT is completed?

SALES: That's an important distinction. I will show you three separate layers: what is operating now, any interim shuttle arrangement, and the future MRT plan with its official status. The future line should not be treated as current convenience.

CUSTOMER: What is the difference between Suite 1 and Suite 2?

SALES: I will prepare a like-for-like comparison. A lower purchase price does not automatically mean higher ROI; we need to see whether the rent difference, maintenance, layout demand and completion risk justify the price difference.

CUSTOMER: Can I see the actual furnishing and materials?

SALES: Yes. The showroom is useful for verifying layout, material and practical space. Before the visit, I will prepare one comparison sheet and label every number as official data, comparable evidence or assumption, so you know what still needs verification.

CUSTOMER: I need to reschedule. Are weekdays possible?

SALES: No problem. Wednesday at 2 PM works. I will reconfirm before the appointment, and we can use the visit to compare only the two units that match your investment criteria.
```

## 11. 下一轮最佳 FactFind

1. “投资重点是现金流、升值还是两者平衡？”
2. “舒服的总价、首付现金和贷款范围是什么？”
3. “最低 Gross Yield／Net Yield 目标是多少？”
4. “预计持有几年，什么情况下会出售？”
5. “能接受多少个月空置和多大的利率变化？”
6. “目标租客是谁，为什么会选择这个 Layout？”
7. “需要我用 Verified Transaction、Comparable 和 Assumption 分开做比较吗？”

## 12. Marcus 审核

- [ ] 客户属于数据型投资买家
- [ ] 474 Studio 与 560 一房是主要比较方向
- [ ] Outcome = Viewing Scheduled，尚未证明到场
- [ ] 投资数据必须区分 Transaction / Asking / Projection
- [ ] 车牌等个人资料不得进入 Brain
- [ ] 可以作为 FactFind Golden 写入 Brain
- [ ] 需要修改

修改备注：

---

# 四个案例共同形成的 Brain Playbook

## 1. 推荐前的最小资料集

Brain 不需要问完十几条才回应，但至少要知道：

- 谁住／谁买／谁决定。
- 自住还是投资，哪一个优先。
- 2–3 个硬条件。
- 一个真实预算边界：总价、月供或现金能力。
- 工作／上学地点和交通方式。
- 房间与入住人数。
- 购买／入住时间线。

如果缺少其中会显著改变项目选择的资料，Brain 应先问，不应立即给“最适合”的结论。

## 2. 动态提问逻辑

```text
客户询问项目
  → 先识别用途和实际入住者
  → 找出硬条件
  → 如果原项目违反硬条件：坦白不匹配
  → 问一个能扩大候选池的弹性条件
  → 确认预算／月供舒适度
  → 只推荐 1–3 个候选
  → 每个候选说明 Match / Trade-off / Still Unknown
  → 客户有兴趣后，再进入 Layout、Verified Facts 和 Viewing
```

## 3. 推荐输出格式

以后 Brain 推荐房源时，建议固定输出：

```text
为什么进入候选：
- 对应客户哪几个已确认条件

需要接受的取舍：
- 地点、面积、价格、产权或交付时间有什么变化

仍需确认：
- 哪些项目事实要从 Verified Knowledge 更新
- 哪些客户资料还没问到

下一步：
- 只问一个最能推进判断的问题，或发送一份最相关资料
```

## 4. Golden 与 Project Knowledge 的边界

### Golden Conversation 保存

- 提问顺序和背后目的。
- 客户回答后如何改变筛选方向。
- 如何承认项目不匹配。
- 如何解释替代项目的推荐理由。
- 如何处理预算、时间与家庭状况。
- 哪一步推进成功、哪一步仍未完成。

### Verified Project Knowledge 保存

- 产权、价格、库存和促销。
- Layout、面积、停车位和设施。
- 完工时间、发展商资料和法律信息。
- 实际距离、交通路线和周边设施。

Golden 只能告诉 Brain **怎样使用事实**，不能成为事实本身。

## 5. 建议的本机 Golden 数据结构

当前 SQLite `golden_conversations` 只有 Scenario 与 Conversation Text，太难表达 FactFind。正式写入前，建议扩展为：

| 字段 | 作用 |
| --- | --- |
| `origin_project_code` | 客户原本询问的项目 |
| `recommended_project_code` | 经过 FactFind 后进入候选的项目 |
| `customer_role` | 本人、家长、配偶、投资者等 |
| `primary_goal` | 自住、投资、租房等 |
| `confirmed_facts_json` | 客户明确说过的资料 |
| `hard_constraints_json` | 不能违反的条件 |
| `flexible_preferences_json` | 可以交换或放宽的条件 |
| `missing_information_json` | 推荐前仍需确认的资料 |
| `factfind_steps_json` | 每个问题、目的、答案和判断变化 |
| `recommendation_reasoning` | 为什么从原项目转向候选项目 |
| `tradeoffs` | 推荐中仍存在的取舍 |
| `next_best_question` | 下一条最有价值的问题 |
| `outcome` | Warm、Viewing Booked、Booking 等真实结果 |
| `coaching_notes` | 值得学习与禁止模仿的部分 |
| `source_hash` | 防止重复导入同一案例 |

第一阶段也可以先把这些内容作为结构化区块存在 `conversation_text`，等 Marcus 审核后再决定是否升级 SQLite schema。

---

# 最终审核结论

四份案例都值得保留，但不应被包装成“完美销售对话”：

- Candidate 01 的价值是识别家庭角色、尊重 Freehold 硬条件、通过地点弹性找到替代候选，并在家庭状况出现时保护关系。
- Candidate 02 的价值是把“负担不起”转成房间数、月供舒适度和地点弹性，再寻找较合适项目。
- Candidate 03 的价值是为外州自住客户建立地点认知、收窄房型，并让看房安排跟随客户真实 KL 行程。
- Candidate 04 的价值是处理数据型投资客户、比较单位和预约改期，同时建立投资证据分层。
- 四份案例都有未完成的 FactFind，也有绝对项目说法、过量资料、贷款保证或未经验证的投资预测等风险。
- 最合适的 Brain 学习方式是：**学习判断路径 + 保存安全护栏 + 所有项目事实另行核实。**

Marcus 确认后才执行：

1. 决定是否采用扩展后的 Golden 数据结构。
2. 写入本机 SQLite。
3. 生成 Obsidian 可阅读版本。
4. 建立 Brain 本地索引。
5. Notion 保持关闭或只作可选镜像。
