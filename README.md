# Mamba — WhatsApp Blast 自动化系统

Mamba 是一套房产销售用的 WhatsApp 批量群发 + 多轮自动跟进系统。核心思路:把一个项目(楼盘)的话术拆成多个 **Flow**(第 1 轮、第 2 轮……),按天数一轮一轮发给客户;客户一旦回复就自动退出序列、转人工;整个过程用网页面板点按钮操作,发送记录和客户状态都同步到 Notion。

> ⚠️ **仓库里不含任何机密和客户名单**(Notion token、`.env`、Excel 名单、缓存都被 `.gitignore` 挡掉了)。新电脑拉下来后需要自己配 token,见下方「首次安装」。

---

## 一、核心概念:Flow 序列

一个客户从进名单到成交,会依次收到若干轮消息。每一轮叫一个 **Flow**,按天数间隔发出:

| Flow | 主题 | 发送时机 |
|------|------|----------|
| Flow 1 | Project Template(项目介绍) | Day 0(初始群发) |
| Flow 2 | Layout(户型) | Day 2 |
| Flow 3 | Location(地点) | Day 4 |
| Flow 4 | Package(配套) | Day 6 |
| Flow 6 | Price(价格) | Day 9 |
| Flow 7 | Facilities(设施) | Day 12 |
| Flow 8 | Invitation(邀约) | Day 15 |
| Flow 5 / Flow 9 | Furnished / Rental | 条件触发(如投资客) |

序列链默认 `1 → 2 → 3 → 4 → 6 → 7 → 8`(**跳过 Flow 5**,除非条件触发)。

规则:
- **没回复** → 按天数继续下一轮。
- **客户回复** → 自动退出序列、转人工;根据回复内容自动分类(见「回复分类」)。
- **STOP / 退订** → 打红旗(Stop Flag),永不再发。

判断"谁该发下一轮"靠 Notion 里三个字段:`Follow Up Due`(到期日)+ `Next Flow`(下一轮是哪个)+ `Sequence Status`(序列是否还在跑)。**没有实时 webhook**,每轮发送前手动在网页上勾人。

---

## 二、系统架构

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────┐
│  Control Center │────▶│  Campaign Console │────▶│ Evolution   │
│  (按钮总面板)    │     │  (发送 + 网页)     │     │ API (WA引擎) │
│  :8810          │     │  :8787            │     │ :8080       │
└─────────────────┘     └────────┬─────────┘     └─────────────┘
                                 │
                                 ▼
                          ┌─────────────┐
                          │   Notion    │  名单 / 模板 / 发送记录
                          └─────────────┘
```

- **Evolution API**(`:8080`)—— WhatsApp 引擎,跑在 Docker / Colima 里,号码扫码上线后才能发。
- **Campaign Console**(`:8787`,`campaign-app/server.mjs`)—— 系统核心。负责发送 + 提供 4 个网页界面。
- **Control Center**(`:8810`,`campaign-app/control_center.mjs`)—— 把 `launchers/` 里的 `.command` 启动器列成按钮的总面板。
- **Notion** —— 数据后端:客户名单、话术模板、发送记录都在这。

---

## 三、目录结构

```
Mamba/
├── campaign-app/            # 所有代码
│   ├── server.mjs           # Campaign Console(发送核心 + 网页 + 所有 API)
│   ├── campaign_core.mjs    # 发送引擎(节流、多段、重试、回复取消)
│   ├── control_center.mjs   # 按钮总面板
│   ├── flow_sequence.mjs    # Flow 序列定义 + 回复分类器
│   ├── morning_followup.mjs # 早间跟进:结算回复、分类、退订
│   ├── notion_upload.mjs    # 把发送记录写进 Notion
│   ├── console.html         # 主控制台网页
│   ├── next-flow.html       # 「选人发下一轮」网页
│   ├── templates.html       # 「模板 & Flow 面板」网页
│   ├── lookup.html          # 「查找客户」网页
│   └── node_modules/        # 依赖(不进 git,自己 npm install)
├── campaign-assets/         # 配置 + 图片
│   ├── projects.json        # 项目列表
│   ├── <项目>.json          # 每个项目的话术配置(如 binastra.json)
│   ├── image_aliases.json   # 模板图片名 → 本地文件名 映射
│   └── images/              # 群发用的图片
├── assets/                  # Cloudflare R2 云端图片入口
│   ├── inbox/               # 新图临时丢这里
│   ├── templates/           # 可复用模板图
│   ├── raw/                 # 原始素材
│   └── manifest.json        # 同步后自动生成:本地文件 → 云端 URL
├── campaign-data/           # 运行时数据(大多不进 git)
│   ├── notion_config.json   # Notion 数据库 ID(进 git,无 token)
│   └── ...                  # 名单缓存、发送记录等(不进 git)
├── evolution-pilot/         # WhatsApp 引擎(Docker)
│   ├── .env                 # 🔑 机密:Notion token + Evolution 配置(不进 git)
│   └── docker-compose.yml
├── launchers/               # 双击启动器(macOS)
│   ├── Mamba Control Center.command
│   ├── Campaign Console.command
│   └── ...
└── docs/                    # 标准、任务板、蓝图等内部文档
```

---

## 四、首次安装(新电脑)

拉下仓库后要做这几步,因为机密和依赖**故意不进仓库**:

1. **装依赖**
   ```bash
   cd Mamba/campaign-app
   npm install
   ```

2. **配 `.env`**(机密)——在 `evolution-pilot/` 下建 `.env`,照 `.env.example` 的结构填,至少要有:
   ```
   NOTION_API_KEY=<你的 Notion integration token>
   ```
   还有 Evolution / 数据库相关配置(照 example)。
   > 也可以双击 **🔑 设置 Notion Token** 按钮来填 token。

3. **启动 WhatsApp 引擎**——打开 `launchers/`,双击 **Start Evolution.command**(会拉起 Docker / Colima + Evolution 容器),然后在主控制台「+ 添加号码(扫码)」扫码上线。

4. **开面板**——双击 **Mamba.app**,所有按钮就出来了。`launchers/` 只是备用入口。

5.(可选)客户名单/缓存不在仓库里。打开「查找客户」页点一次「同步 Notion 到本地」,本地快照就有了。

---

## 五、日常工作流

### A. 发第一轮(Flow 1,新客户群发)
1. **🐳 启动 Evolution** → 确认号码 OPEN。
2. **① 发送 Blast(主控制台)** → 选项目(如 Binastra)→ 导入名单 Excel(要 `Name` / `Phone` 两列)。
   - 导入时会**自动跳过已 blast 过的客户**(对比 Notion 里本项目已存在的号码),避免重复轰炸。
3. 先 **TEST**(发给自己)看排版 → 没问题切 **LIVE** 正式发。
4. 发完 → **④ 上传 Blast 名单到 Notion** → 这批人进入序列。

### B. 发后续轮次(Flow 2 及以后)
1. **③ 选人发下一轮** → 网页列出今天到期该发下一轮的人。
2. 选项目 + 勾人(或整组)→ 系统**自动按 flow 从 Notion 取话术**、带对应图发送。
3. 发完**自动**把 Notion 的 flow 状态往前推进(下一轮到期日、Next Flow)。
4. 发送过程中如果客户当场回复,会实时给那一行标色(🔴 STOP / 🟢 WARM)并停止后续段。

### C. 每天早上
- **② 早间跟进检查** → 结算昨天的回复、自动给退订的人打红旗、列出今天要人工跟进的人。

### D. 安全同步
- **同步全局 STOP 名单** → 从 Notion 汇总所有项目 / lead 数据库的 Stop Flag,写到本地 `campaign-data/suppressed.json`;导入、选人、正式发送前都会用它拦截退订号码。
- **同步 AI Brain Cache** → 从 Notion 同步 Project Knowledge / Golden Conversations / Objection Bank 到本地 `campaign-data/brain/`;后续 AI 回复服务会优先读这个缓存。

---

## 六、四个网页界面(都由 Console 提供,`:8787`)

| 网页 | 地址 | 作用 |
|------|------|------|
| 主控制台 | `/` | 导入名单、设时间、TEST/LIVE 群发、看发送进度 |
| 选人发下一轮 | `/next-flow` | 列出该发下一轮的人,勾选直接发 + 自动推进 + 实时回复上色 |
| 模板 & Flow 面板 | `/templates` | 看整个序列、拉 Notion 模板、增删改话术、上传/移除图、WhatsApp 预览 |
| 查找客户 | `/lookup` | 同步 Notion 到本地快照;拖 Excel 批量对比(谁已 blast/谁是新客户);单个查号码/名字 |

---

## 七、模板、多段与轮换

### 多段发送(动态)
一个 Flow 可以拆成多条消息:Part 1、Part 2、Part 3……发送时按段间隔(默认 45 秒)一条条发,**每段发之前都会查客户有没有回复,回了就停**。
- 主控制台(配置驱动):在项目 JSON 里用 `part1` / `part2` / `extraParts`(Part 3+)。
- 选人页(Notion 驱动):在模板库给同一个 Flow 建 Part 1 / Part 2 / Part 3 模板(设 Active)即可,系统自动按段号发。

### 变体轮换(防 spam)
同一段可以有多个版本(变体)。发送时**每个客户随机抽一条**,避免所有人收到一模一样的消息被 WhatsApp 判成 spam。
- 主控制台:同一段的 `variants` 放多条。
- 选人页:给同一个 Flow / 同一段建多个 Active 模板(文案不同)。

### 图片
模板的「Image Name」字段 → 通过 `image_aliases.json` 映射到 `campaign-assets/images/` 里的本地文件。发送时从本地读图(base64)。某段不想带图,在面板点「🗑 移除图(改纯文字)」。

### Cloudflare 云端图片
新素材可以放进根目录的 `assets/`。双击 **同步 Cloudflare 图片** 后,系统会把 `assets/` 和现有 `campaign-assets/images/` 上传到 Cloudflare R2,并生成 `assets/manifest.json`。之后 AI 或另一台电脑可以直接读这个 manifest 拿图片 URL。

当前 Cloudflare R2 设置:
- Bucket: `mamba-assets`
- Prefix: `mamba-assets`
- Public manifest: `https://pub-3e0df885be9c4a2db26f1cfb0fcf8f3e.r2.dev/mamba-assets/manifest.json`
- 默认同步来源: `assets/` + `campaign-assets/images/`

给 AI 的规则:
- 新图先放 `assets/inbox/` 或 `assets/templates/`。
- 群发已经在用的旧图继续留在 `campaign-assets/images/`,不需要搬。
- 运行 `npm run sync:cloudflare-assets` 会上传新增/修改过的图片。
- 运行 `npm run check:cloudflare-assets` 只检查会同步什么,不会上传。
- `assets/manifest.json` 是本地生成物,不要提交到 GitHub。
- Cloudflare secret 只放 `evolution-pilot/.env`,不要提交到 GitHub。

第一次使用前,在 `evolution-pilot/.env` 加上:

```bash
CF_ACCOUNT_ID=你的 Cloudflare Account ID
CF_R2_BUCKET=mamba-assets
CF_R2_ACCESS_KEY_ID=你的 R2 access key
CF_R2_SECRET_ACCESS_KEY=你的 R2 secret key
CF_R2_PUBLIC_URL=https://pub-3e0df885be9c4a2db26f1cfb0fcf8f3e.r2.dev
CF_R2_PREFIX=mamba-assets
```

---

## 八、Notion 数据库

`campaign-data/notion_config.json` 里存各库的 ID(不含 token):

- **Blast Leads** —— 客户名单 + 每人的 flow 状态。关键字段:`Phone`、`Name`、`Project`、`Sequence Status`、`Next Flow`、`Last Flow Sent`、`Cohort Day`、`Follow Up Due`、`First/Last Blast At`、`Stop Flag`、`Reply Count`、`AI Category`、`Last Reply Text` 等。
- **Templates** —— 话术模板。字段:`Template Name`、`Project`、`Flow Topic`、`Part`、`Language`、`Status`(Active/Testing)、`Message Text`、`Image Name`、以及分析计数(`Sent/Response/Warm/Stop Count`)。
- **Campaign Runs** —— 每次群发一行(cohort)。
- 另有 Images / Ads Leads / Recycle Leads。

模板匹配靠 **Flow Topic**(不是天数)+ 项目别名(`projectAlias`,例:名单项目「Gen Starz」→ 模板项目「Gen Starz」)。

---

## 九、回复分类

`flow_sequence.mjs` 里的分类器把客户回复分成 12 类(按优先级),给每类定 `signal`:
- 🔴 **RED** = STOP / 退订 / 投诉 → 打红旗,退出序列。
- 🟢 **GREEN** = WARM,想看户型/价格/地点等 → 转人工跟进。
- ⚪️ **GREY** = 看不懂 / 疑似诈骗 / 打错 → 转人工判断。

分类结果写回 Notion 的 `AI Category` / `AI Summary`,并给对应模板累计 Response / Warm / Stop 计数。

---

## 十、两台电脑同步(Git)

这是**私有**仓库,机密和客户数据都不进仓库。

改完东西推上去:
```bash
cd ~/Desktop/Mamba
git add -A
git commit -m "说明改了什么"
git push
```

另一台电脑拉更新:
```bash
cd ~/Desktop/Mamba
git pull
```

> 第一次在新电脑上要先做「首次安装」(npm install + 配 .env)。名单/缓存不同步,各机自己「同步 Notion 到本地」。

---

## 十一、常见问题

- **号码发不出去** → 先 **🐳 启动 Evolution**,确认主控制台里号码状态是 OPEN。
- **选人页说「没人该发」** → 该批还没到期(`Follow Up Due` 未到),或都已回复退出序列。
- **模板面板报「本地没图」** → 图片名对应的文件不在 `campaign-assets/images/`,在面板里上传即可。
- **改了代码/模板没生效** → 重启一次 Campaign Console(很多改动开机时才加载)。
- **Notion 429 / 超时** → 已内建自动重试,稍等即可。
- **git push 报 "Repository not found"** → GitHub 上还没建那个 **Private** 仓库,或没登录(`gh auth login`)。

---

## 端口速查

| 服务 | 地址 |
|------|------|
| Campaign Console | http://127.0.0.1:8787 |
| Control Center | http://127.0.0.1:8810 |
| Evolution API | http://127.0.0.1:8080 |
