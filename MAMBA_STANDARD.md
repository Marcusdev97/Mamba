# MAMBA STANDARD — 命名与结构铁律 v1.0

> 这份文件是 Mamba 的宪法。所有新内容（模板、图片、database、字段、fact）必须符合本标准。
> 放进 repo 根目录，团队 onboard 第一天读它，AI 的 system prompt 引用它。
> 改这份文件需要 bump 版本号（v1.0 → v1.1）并在文末 Changelog 记一行。

---

## 0. 三条总原则

1. **机器可读优先**：所有 code / ID 用小写 + 下划线，固定位数，能被一条 regex 验证。
2. **一处真相（Single Source of Truth）**：每种数据只有一个权威存放地，其他地方都是 cache。
3. **命名即归因**：看到任何一个 code，不查表就能知道它属于哪个盘、哪一轮、哪个语言、第几版 — 因为钱最后要按这些维度算回来。

---

## 1. Project Code 注册表

**规则**：小写、2–4 个字母、注册后永不改。新项目先在这张表登记，再产生任何内容。

| Code | 项目全名 | Notion Select 显示名 | 状态 |
|------|---------|---------------------|------|
| `mv` | Mid Valley | Mid Valley | Active |
| `gs` | Gen Starz (Old Klang Road) | Gen Starz | Active |
| `enl` | Enlace Suites (Pantai Sentral Park) | Enlace | Active |
| `bin` | Binastra Cochrane | Binastra | Active |
| `ra` | Radium Arena (Old Klang Road) | Radium Arena | Active |

- 新项目命名：取项目名最有辨识度的 2–4 字母，不与现有冲突。
- 一个 code 永远只指一个盘。项目下架 → 状态改 Retired，code 不回收、不复用。

## 2. Flow Number 注册表

**规则**：Flow 号码的含义全局固定，所有项目通用，永不重新分配。

| Flow | 主题 | Flow Topic (Notion) | 序列位置 |
|------|------|--------------------|---------| 
| 01 | 项目介绍 | Project Template | Day 0（首发） |
| 02 | 户型 | Layout | Day 2 |
| 03 | 地点 | Location | Day 4 |
| 04 | 配套 | Package | Day 6 |
| 05 | 家私清单 | Furnished List | 条件触发 |
| 06 | 价格 | Price | Day 9 |
| 07 | 设施 | Facilities | Day 12 |
| 08 | 邀约 | Invitation | Day 15（收尾） |
| 09 | 出租/投资 | Rental | 条件触发 |
| 10 | 周边环境 | Surrounding | 条件触发 |
| 11–19 | 预留：房产扩展 | — | — |
| 20+ | 预留：非房产产品线（如 CICI 回访序列） | — | — |

## 3. Template Code 语法（最重要的一条铁律）

```
{project}_{lang}_f{NN}_p{N}_v{N}
```

| 段 | 规则 | 例 |
|----|------|-----|
| project | 注册表里的 code | `gs` |
| lang | `en` / `zh` / `bm`（小写） | `zh` |
| f{NN} | Flow 号，**固定两位** | `f06` |
| p{N} | Part 号（1/2/3；Follow Up = `pf`） | `p2` |
| v{N} | 版本号，从 1 起 | `v1` |

**正确**：`gs_zh_f06_p2_v1`、`bin_en_f01_p1_v3`、`enl_bm_f01_p1_v1`
**错误**（现存旧格式，逐步迁移）：`binastra_flow01_project_template_en_part1_v1`、`enl_en_flow1_investment_p1`

**验证 regex**（进 validator 和 sync script）：
```
^(mv|gs|enl|bin|ra)_(en|zh|bm)_f\d{2}_p(\d|f)_v\d+$
```

## 4. Template Name（Notion 显示名）

给人看的名字，和 code 一一对应：

```
[{Project 显示名}][F{NN} {Topic}][{LANG}][P{N}][v{N}] {可选: Angle 备注}
```

例：`[Gen Starz][F06 Price][ZH][P2][v1]`、`[Binastra][F01 Project][EN][P1][v3] Investment hook`

## 5. Asset / 图片命名

```
{project}_f{NN}_{slug}_{lang}_v{N}.{ext}
```

例：`gs_f03_mrt_link_en_v1.jpeg`、`bin_f01_hero_en_v1.jpg`

- slug：2–3 个英文单词描述内容，下划线连接。
- **进 `campaign-assets/images/` 前必须改名**。禁止 `ChatGPT Image Jul 1, 2026...png` 这类原始文件名入库。
- 视频同规则：`gs_f08_showroom_invite_en_v1.mp4`。

## 6. Notion Database 注册表

**规则**：全部以 `Mamba | ` 开头。建新库先登记。

| Database | 职责（一处真相） | 状态 |
|----------|-----------------|------|
| Mamba \| Campaign Templates | 出站话术唯一编辑地 | ✅ 已有 |
| Mamba \| Blast Leads | Blast 客户 + flow 状态 | ✅ 已有 |
| Mamba \| Ads Leads | 广告进线客户 | ✅ 已有 |
| Mamba \| Recycle Leads | 旧名单 / call list | ✅ 已有 |
| Mamba \| Campaign Runs | 每次群发一行 | ✅ 已有 |
| Mamba \| Images | 图片资产登记 | ✅ 已有 |
| Mamba \| Project Knowledge | **AI 唯一事实来源** | 🔨 要建 |
| Mamba \| Golden Conversations | AI 的范例（真实成功对话） | 🔨 要建 |
| Mamba \| Objection Bank | 问题解码表 | 🔨 要建 |
| Mamba \| AI Reply Log | AI 每条回复的记录（飞轮） | 🔨 要建 |

## 7. 四个 AI Database 的 Schema（建库照抄）

**Mamba | Project Knowledge**
| 字段 | 类型 | 说明 |
|------|------|------|
| Fact | Title | 一行一个事实，短句 |
| Project | Select | 注册表显示名 |
| Category | Select | Price / Layout / Package / Location / Facilities / Rental / Legal / Developer / Promo |
| Verified | Checkbox | **AI 只准引用 = true** |
| Source | Text | 出处（sales kit 页码 / developer 确认 + 日期） |
| Valid Until | Date | 过期自动失效（promo/price 必填） |
| Updated At | Last edited time | 自动 |

**Mamba | Golden Conversations**
| 字段 | 类型 |
|------|------|
| Scenario | Select：Price Objection / Hesitation / Comparing / Loan Question / Viewing Push / Cold Reopen / Angry / Other |
| Project | Select |
| Customer Type | Select：Own Stay / Investor / First Timer / Unknown |
| Outcome | Select：Viewing Booked / Booking / Warm / Lost |
| Conversation Text | Text（整段真实对话，双方） |
| Why It Worked | Text（你的一两句注解） |
| Language | Select：EN / ZH / BM / Mixed |

**Mamba | Objection Bank**
| 字段 | 类型 |
|------|------|
| Customer Says | Title（表面问题） |
| Real Intent | Text（真实意图） |
| Response Direction | Text（应对方向，不是逐字稿） |
| Handoff Required | Checkbox（true = 必须转人工） |
| Scenario | Select（同 Golden 的选项） |

**Mamba | AI Reply Log**
| 字段 | 类型 |
|------|------|
| Lead Phone | Phone |
| Project / Route / Language | Select |
| AI Draft | Text |
| Final Sent | Text |
| Action | Select：Sent As-Is / Edited / Rejected / Takeover |
| Timestamp | Date |

## 8. Status 生命周期（Templates）

```
Testing ──(Sent ≥ 50 且 response rate 达标)──▶ Active ──▶ Paused ──▶ Retired
```

- **Testing**：可小量发送，收集数据。
- **Active**：主力轮换池。**文案一经 Active 即冻结** — 要改字 = 开新版本（v2），旧版转 Retired。原因：计数按版本归因，改了字数据就脏了。
- **Retired**：永不删除（历史归因要用），永不复活（要复活 = 复制成新版本）。

## 9. 版本规则

- 任何文案改动（哪怕一个 emoji）= bump v。
- 同一位置（同 project/flow/part/lang）同时 Active 的版本数：2–4 个（防 spam 轮换 + A/B），超过 4 个先杀弱的。
- Fact 变了（价格、package 到期）：**不改旧模板** — 旧版 Retired，新版引用新 fact。

## 10. 「跟上时代」的四个时钟 ⏰

这就是你要的「一直实时跟上时代」— 不靠感觉，靠四个固定节拍：

| 时钟 | 频率 | 动作 |
|------|------|------|
| **Fact 时钟** | 每次 developer 更新 + Valid Until 到期自动 | Knowledge 库改字段，AI 下一秒生效，不碰 code 不碰模板 |
| **话术时钟** | 每周 15 分钟 | Response/Viewing rate 排序 → 砍输家、复制赢家开新版 |
| **分类器时钟** | 每两周 | 从 replies.jsonl 捞新样本进 test file，客户新说法进 regex |
| **AI 飞轮时钟** | 每两周 | 回顾 Reply Log 里「被你改过的」→ 好改法进 Golden，错事实修 Knowledge |

四个时钟一直转，系统就一直是「今天的系统」。

## 11. 新项目 Onboarding SOP（照单执行，约 2–3 小时）

- [ ] 1. Project Code 注册（第 1 节的表加一行）
- [ ] 2. Notion 各库的 Project select 加选项（显示名统一）
- [ ] 3. `campaign-assets/projects.json` 登记 + 建 `{code}.json`
- [ ] 4. Knowledge 库灌 30–50 条 fact，全部 Verified + Source（**先于写任何话术**）
- [ ] 5. 写 F01 P1 × 2–3 变体 + P2 + P3（EN/ZH 起步）
- [ ] 6. 写 F06 Price + F08 Invitation（最短可跑序列 = F01→F06→F08）
- [ ] 7. 图片按第 5 节命名入库 + `image_aliases.json` 登记
- [ ] 8. Validator 跑一遍全部新 code
- [ ] 9. TEST 模式发自己，检查排版 + 图片配对
- [ ] 10. 小 cohort（100–200 人）LIVE 试跑 → 看数据 → 再放量

---

## Changelog
- v1.0 (2026-07-04)：初版。Project/Flow/Template/Asset/Database 命名 + AI 四库 schema + 四时钟 + Onboarding SOP。
