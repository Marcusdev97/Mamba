# MAMBA 发送模式(Send Modes)设计说明

> 状态:草案(设计,未实现) · 日期:2026-07-17
> 目的:在**不分叉发送引擎**的前提下,给 Blast 增加三档"速度 vs 安全"模式,并让新号/风险名单自动走安全档。
> 相关:`docs/MAMBA_ARCHITECTURE_ADR.md`、`campaign-app/lib/campaign-schedule.mjs`(现有 pacing 字段)。

---

## 0. 一条核心原则(先记住)

**三个 mode = 同一套引擎 + 三组参数(preset),绝不写成三段发送逻辑。**

引擎照旧只认 `partGap / contactGap / dailyCap / typingSim …` 这些值;一个 mode 只是"把这些值打包成一个命名预设"。这样以后改发送 bug 只改一处。**参数化=便宜;分叉代码=昂贵。**

Blast 仍是基础:极速档 ≈ 你现在的行为,拟人档只是高风险时才切的选项。

---

## 1. 三个模式的定位

| Mode | 代号 | 一句话 | 典型场景 |
|---|---|---|---|
| ⚡ 极速 | `turbo` | 最快,不装打字,量大 | 暖号 + 低风险/已互动名单,要冲量,愿担风险 |
| ⚖️ 标准 | `standard` | 抖动 + 中等间隔(默认) | 日常主力 |
| 🕊 拟人 | `human` | 打字模拟 + 长歇 + 作息,量小 | 新号、cold 陌生名单、暖机期 |

---

## 2. 参数字段(放哪、叫什么)

所有模式共用同一批字段,只是取值不同。字段分三层存放:

### 2.1 项目发送配置 `delivery`(每个项目 JSON;沿用现有 + 少量新增)

| 字段 | 现有/新增 | 含义 |
|---|---|---|
| `partGapSeconds` / `partGapMaxSeconds` | 现有 | 段间隔的 min/max(建议都设,做抖动) |
| `contactGapSeconds.min` / `.max` | 现有 | 人间隔的 min/max |
| `minBlastGapSeconds` | 现有 | AUTO 排程"每人预留"地板 |
| `typingSim.enabled` | 新增 | 是否显示"正在输入…" |
| `typingSim.msPerChar` | 新增 | 每字打字毫秒(拟人时长模型用) |
| `typingSim.baseMs` / `typingSim.maxMs` | 新增 | 打字基础耗时 / 封顶 |
| `workingHours.enabled` `.start` `.end` `.days` `.tz` | 新增 | 只在作息时间发 |
| `longBreak.everyN` `.minMinutes` `.maxMinutes` | 新增 | 每发 N 人后随机长歇 |

### 2.2 号码状态 `whatsapp_connections`(每个号码一行,新增几列)

| 字段 | 含义 |
|---|---|
| `warmth` | `NEW` / `WARMING` / `ESTABLISHED` |
| `warmup_day` | 暖机第几天(NEW/WARMING 用) |
| `allowed_max_mode` | 这个号当前**最高**能用到哪档(由 warmth/health 决定) |
| `daily_cap` | 今日发送上限(按 warmth 给) |
| `sent_today` | 今日已发人数(每日 0 点归零) |
| `block_rate_24h` | 近 24h 被 block/举报比例(健康信号) |
| `fail_rate_1h` | 近 1h 发送失败率 |
| `health` | `OK` / `THROTTLED` / `PAUSED` |

### 2.3 单次群发覆盖(发送台选择)

| 字段 | 含义 |
|---|---|
| `campaign_runs.mode` | 这次 blast 选的档(受号码 `allowed_max_mode` 封顶) |

---

## 3. 每档取值(默认值,均可调)

> ⚠️ 数字是**起点**,不是 WhatsApp 官方限额(官方不公开)。cold 名单请偏保守,按实际 block 率调。

| 参数 | ⚡ turbo | ⚖️ standard | 🕊 human |
|---|---|---|---|
| `typingSim.enabled` | false | 轻(短固定) | true(随字数) |
| 段间隔 part(s) | 3–10 | 20–40 | 30–70 |
| 人间隔 contact(s) | 15–35 | 45–75 | 60–120 |
| `longBreak` | 关 | 每 40 人歇 2–5 分 | 每 20 人歇 3–10 分 |
| `workingHours` | 关(或宽) | 09:00–21:00 | 10:00–20:00 严格 |
| 暖号日上限/号 | ~120–150 | ~80–100 | ~30–50 |

派生节奏参考(3 段的人):turbo ≈ 40–60s/人;standard ≈ 2.5 分/人;human ≈ 4 分/人。

---

## 4. 拟人打字时长模型(human 档)

发每一段前:**上线 → 显示"正在输入…" T 秒 → 发出 → 短暂"暂停"**。

```
T = clamp(baseMs + 字数 × msPerChar + 随机抖动, 下限, maxMs)
```

- 建议:`baseMs` ≈ 800–1500(愣一下想一下),`msPerChar` ≈ 200–300,`maxMs` ≈ 12000(没人真打 3 分钟)。
- 关键:T 必须**随这条消息字数变化 + 抖动**;固定 3.0s 仍是机器指纹。
- 带图:图有天然"上传中"延迟,再加 caption 的打字时间。

---

## 5. 号码状态联动(不用每次纠结)

**mode 不是随便选,受号码状态封顶。** 号码越"生",能用的档越安全。

### 5.1 暖机爬坡(新号)

| 阶段 | 天 | `allowed_max_mode` | 日上限/号 |
|---|---|---|---|
| NEW | 第 1–3 天 | 只能 `human` | 10–20 |
| WARMING | 第 4–7 天 | 只能 `human` | ~30 |
| WARMING | 第 2 周 | 解锁 `standard` | ~50 |
| WARMING | 第 3 周 | `standard` | ~80 |
| ESTABLISHED | 之后 | 解锁 `turbo` | ~100–150 |

### 5.2 生效档解析(优先级)

```
生效 mode = min( 本次群发选的档, 号码 allowed_max_mode )
再被 health 压制:THROTTLED → 强制降一档;PAUSED → 不发
再被 daily_cap 压制:sent_today ≥ daily_cap → 今日停发该号
```

即:用户可以"手动升档冲量",但升不过号码当前允许的上限,也升不过健康刹车。

---

## 6. 自动降档 / 熔断规则(健康刹车)

系统按滚动窗口盯几个信号,超阈值自动降档或暂停该号(阈值均可调):

| 信号 | 软阈值 → 动作 | 硬阈值 → 动作 |
|---|---|---|
| `block_rate_24h`(被 block/举报比) | > 3% → 降一档 + 告警(`THROTTLED`) | > 6% → 暂停该号(`PAUSED`) |
| `fail_rate_1h`(发送失败率) | > 10% → 降一档 | > 20% → 暂停该号 |
| 连续发送失败 | ≥ 5 条 → 降一档 | ≥ 10 条 → 暂停该号 |
| Evolution 连接掉线 | — | 立即暂停,恢复后从 human 起 |

- **降档**:`turbo→standard→human`,并把 `daily_cap` 打折(如 ×0.5)。
- **暂停**:`health=PAUSED`,当天不再发;次日以更低档 + 更低上限恢复(不直接回 turbo)。
- 所有降档/暂停写 `system_logs`(带信号值 + 原因),Control Center 显示每号当前 mode / health / 今日已发。

---

## 7. UI 呈现(发送台)

- 一个**三选一档位**(turbo / standard / human),默认取项目配置。
- 档位旁显示所选号码的 **当前允许最高档 + health + 今日 x/上限**;选了超过 `allowed_max_mode` 的档时禁用并提示原因(如"新号暖机中,仅限拟人")。
- 进度卡(见多段进度 mockup)顶部标出本次运行的 mode,方便回看当时用的是哪档。

---

## 8. 落地清单(实现时,不改引擎主逻辑)

1. `delivery` 配置补:`typingSim` / `workingHours` / `longBreak` / `partGapMaxSeconds`。
2. `whatsapp_connections` 补:`warmth / warmup_day / allowed_max_mode / daily_cap / sent_today / block_rate_24h / fail_rate_1h / health`。
3. 定义 `turbo / standard / human` 三段 preset(一份共享 JSON)。
4. 发送前:按第 5.2 节解析生效 mode → 把该 preset 的值喂给**现有** pacing 函数(引擎不变)。
5. human 档:在"发每段前"插入 presence=composing + 第 4 节时长(其余流程照旧)。
6. 后台健康采集 + 第 6 节熔断(可先只做告警,不自动降档,观察一段再打开自动)。
7. 每日 0 点重置 `sent_today`;暖机天数推进。

> 建议顺序:先做 **1–4(参数化 + 三档预设)**,让"选档就能改节奏"跑通;再做 **5(打字模拟)**;最后做 **6(自动熔断)**,且先"只告警"观察两周再开自动降档。
