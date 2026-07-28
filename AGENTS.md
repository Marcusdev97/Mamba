# Mamba Engineering Instructions

> 适用范围：整个 Mamba repository。
> Codex 在修改代码前，必须同时阅读
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) 与
> [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md)。
> 如果文档与实际代码不一致，先报告差异；不要默默把错误假设写进代码。

## 1. 核心目标

Mamba 必须保持：

- 容易理解
- 容易测试
- 容易替换外部服务
- 不会因为修改一个 integration 而破坏 Campaign
- 不会因为 TEST 配置错误而发送给真实客户
- 所有发送、同步和重试行为都可以追踪
- 业务规则只有一个来源，不在多个文件重复实现

修改代码时，优先保持结构清晰和资料安全，不要为了快速完成而增加隐藏 fallback、重复逻辑或写死资料。

---

## 2. 标准系统结构

```text
campaign-app/
├── server.mjs              # 启动与组装，不放业务逻辑
├── routes/                 # HTTP 输入、验证和输出
├── services/               # 完整业务流程与 use cases
├── domain/                 # 纯业务规则，不接触网络或文件
├── integrations/           # Notion、Telegram、Evolution、AI Provider
├── repositories/           # SQLite、JSON、缓存的数据读写
├── jobs/                   # Scheduler、Sync、Retry、Maintenance
├── config/                 # env 读取、验证和默认设置
├── assets/                 # 前端静态资源
├── test/                   # 自动化测试
└── scripts/                # 人工维护工具
```

现有文件不需要一次全部搬迁。修改旧功能时才逐步迁移，避免为了整理目录而进行大型无功能重构。

---

## 3. Dependency Direction

依赖方向必须保持：

```text
Routes
  ↓
Services
  ↓
Domain

Services
  ↓
Repositories / Integrations
```

规则：

- `routes/` 只处理 request、validation、status code 和 response。
- `routes/` 不直接调用 Notion、Telegram、Evolution 或数据库。
- `services/` 负责编排完整流程。
- `domain/` 保存 Campaign、Flow、Suppression、Resend Guard 等纯业务规则。
- `domain/` 不得读取 `.env`、HTTP、filesystem 或数据库。
- `integrations/` 只负责和外部系统沟通，不决定业务规则。
- `repositories/` 只负责数据存取，不决定什么时候发送或同步。
- UI 不得成为业务规则的唯一实现位置。
- 同一个规则不得分别在 UI、route 和 service 内各写一套。

---

## 4. Server 规则

`server.mjs` 只可以负责：

- 载入与验证配置
- 创建 service、repository 和 integration
- 注册 routes
- 启动 scheduled jobs
- graceful shutdown
- health check

`server.mjs` 不可以包含：

- Campaign 发送判断
- TEST／LIVE 名单选择逻辑
- Notion field mapping
- Telegram message formatting
- AI Provider fallback 规则
- 大段数据库查询
- 客户状态推进规则

如果 `server.mjs` 出现超过约 30 行的完整业务流程，应提取成 service。

---

## 5. Integration 规则

每一个外部系统使用独立 adapter：

```text
integrations/
├── evolution/
├── notion/
├── telegram/
├── openai/
├── anthropic/
└── gemini/
```

每个 adapter 必须处理：

- request timeout
- 可理解的错误类型
- response normalization
- retry classification
- idempotency key
- rate limit
- 安全日志
- 外部字段与内部字段的转换

禁止：

- 在 route 内直接 `fetch()` 外部系统
- 在多个文件重复写 Notion property mapping
- 把第三方 response 原封不动传遍整个系统
- 在日志中输出 API Key、Token、完整客户资料
- integration 失败后静默跳过
- 无限重试
- Campaign 尚未完成就启动最终 Notion Sync

Notion Sync 原则：

- SQLite 是发送过程中的即时记录来源。
- 每个客户发送结果先安全写入本地。
- Campaign 全部完成后才执行最终 Notion Sync。
- Sync 必须可以重复执行而不会产生重复资料。
- 字段冲突必须进入明确的 `RETRY` 或 `CONFLICT` 状态。
- 不得为了让任务显示成功而覆盖语义冲突。

---

## 6. Configuration 与 `.env`

所有配置必须通过一个中央 config module 读取。

规则：

- 业务代码不得到处直接读取 `process.env`。
- 启动时验证必填配置。
- Settings 保存的配置必须经过相同验证。
- Secret 只能显示 masked value。
- `.env.example` 只保留空值或明显无效的示例。
- 不得在源码中加入真实电话号码、Token、Chat ID 或 API Key。
- TEST 名单只有一个来源：`TEST_LEADS`。
- 没有 TEST 名单时必须 fail closed。
- 不得提供任何内建真人测试号码。
- 删除 Provider 时，同时删除 UI、route、service、config、fallback、测试和文档引用。

---

## 7. TEST 与 LIVE 安全规则

TEST 和 LIVE 必须共用业务引擎，但使用不同的 recipient source。

### TEST

- 只允许使用 Settings 保存的 `TEST_LEADS`。
- TEST 名单为空时拒绝启动。
- 不允许 request body 临时覆盖 TEST 名单。
- 预览必须显示最终收件人数。
- 日志必须明确标记 `TEST`。

### LIVE

- 必须确认 opt-in。
- 必须经过 suppression 和 resend guard。
- 必须绑定明确的 Project、Lead Group 和 Sender。
- 正在运行时，不得由维护操作重启 Server。
- 对运行中 Campaign 的补发、重试或状态修改必须取得用户明确确认。

---

## 8. Function 与文件设计

- 一个文件只负责一个清楚的主题。
- 一个 function 只做一件可以描述清楚的事。
- 优先使用小型纯函数处理判断、转换和验证。
- 避免超过三层的 nested condition。
- 避免神秘 boolean 参数，例如 `run(true, false)`。
- 使用 object parameter 表达多个参数。
- 重复两次以上的业务判断应提取成共同函数。
- 不创建只有一行转发、没有实际价值的 abstraction。
- 不建立 `utils.mjs` 垃圾桶；使用明确名称，例如：
  - `phone-normalizer.mjs`
  - `campaign-safety.mjs`
  - `notion-property-mapper.mjs`

---

## 9. Naming

命名必须表达业务意思。

推荐：

```js
selectEligibleCampaignLeads()
archiveExpiredBrainApprovals()
syncCompletedCampaignToNotion()
assertTestRecipientsConfigured()
```

避免：

```js
handleData()
doStuff()
processItems()
helper()
temp()
finalData()
newLogic()
```

Boolean 使用：

```js
isCampaignComplete
hasOptIn
shouldRetry
canSend
```

不要使用意义不明确的：

```js
flag
check
status2
isOk2
```

---

## 10. Comment 规则

Comment 应解释“为什么”，不要重复代码正在做什么。

### 应该写 Comment

- 安全规则背后的原因
- 不明显的业务 invariant
- 外部 API 的特殊限制
- 暂时 workaround 的原因
- 为什么这里必须等 Campaign 完成
- 为什么某个错误不能自动重试
- 为什么 TEST 必须 fail closed

示例：

```js
// Notion is the final mirror, not the live send ledger.
// Waiting until every recipient finishes prevents partial campaign state
// from being treated as a completed sync.
```

```js
// Never fall back to built-in recipients. A missing TEST_LEADS value must
// stop the run because a fallback number could belong to a real customer.
```

### 不应该写 Comment

```js
// Set name
user.name = name;

// Loop through items
for (const item of items) {
```

不要使用：

- `temporary fix`，但没有原因或移除条件
- `old logic`
- `new logic`
- `magic happens here`
- 大段已经过期的历史说明
- 被注释掉但不再使用的代码

Workaround comment 必须包含：

```text
原因
影响范围
移除条件
相关 issue／日期（如果有）
```

---

## 11. Error Handling

- 不允许空的 `catch {}`，除非该错误确实不影响流程，并写明原因。
- 错误必须包含 operation、target 和可采取的下一步。
- 对外部系统错误进行分类：
  - retryable
  - permanent
  - conflict
  - authentication
  - rate_limit
- 用户界面显示可理解的信息。
- 系统日志保留技术详情，但不得包含 secret。
- 不要把所有错误都转换成 HTTP 500。
- Retry 必须有次数上限和 backoff。
- WhatsApp 发送状态不明确时，不得自动重发。

---

## 12. Database 与状态

- SQLite 是运行期间的主要事实来源。
- Notion 是业务可见的同步层，不承担实时事务。
- 每个发送动作必须有稳定的 idempotency key。
- 状态名称集中定义，不允许不同文件创造相似名称。
- Schema 修改必须有 migration。
- 不得在启动时偷偷修改大量生产资料。
- Maintenance script 默认必须是 dry-run。
- 真正修改资料必须显式使用 `--apply`。
- 清理操作优先归档，不直接永久删除。

---

## 13. 修改现有功能时的工作流程

Codex 每次修改前必须：

1. 找出当前功能的入口、资料来源和下游影响。
2. 检查是否有正在运行的 LIVE Campaign。
3. 阅读相关测试和结构文件。
4. 列出准备修改的文件。
5. 判断是否涉及发送、删除、同步、重试或 secret。
6. 只修改当前任务需要的范围。

修改完成后必须：

1. 运行相关测试。
2. 运行完整测试套件。
3. 检查 syntax。
4. 检查 Git diff。
5. 搜索旧实现是否仍然残留。
6. 更新相关文档和 `.env.example`。
7. 报告没有处理的风险。
8. 不自动 restart、commit、push 或发送真实消息，除非用户明确要求。

---

## 14. Definition of Done

功能只有满足以下条件才算完成：

- [ ] 代码放在正确层级
- [ ] 没有重复业务规则
- [ ] 没有真实号码或 secret 写死
- [ ] TEST 缺少配置时 fail closed
- [ ] 外部调用有 timeout 和错误分类
- [ ] 写入操作具有 idempotency
- [ ] 新行为有测试
- [ ] 旧行为的 regression test 仍通过
- [ ] UI 与后端 validation 一致
- [ ] `.env.example` 和文档已更新
- [ ] 没有遗留 dead code
- [ ] 没有不明用途文件
- [ ] `git diff --check` 通过
- [ ] 完整测试通过
- [ ] 不会影响正在运行的 LIVE Campaign
- [ ] 用户知道是否需要 restart 或 migration

---

## 15. Codex 回报格式

完成任务后，使用以下格式汇报：

```text
结果：
完成了什么。

结构：
代码分别放在哪一层，为什么。

安全：
是否影响 LIVE、客户资料、发送或同步。

验证：
运行了哪些测试，结果是什么。

尚未处理：
仍需要等待或需要用户决定的事项。

Git：
当前 branch、commit 状态、是否 push。
```

---

## 16. 单次任务输入模板

用户不需要每次重复整份工程规则。一个清楚的任务应尽量包含：

```text
目标：
我要解决什么问题。

允许修改：
哪些功能或文件可以动。

不要修改：
哪些行为必须保持不变。

运行状态：
现在是否有 LIVE Campaign、Sync 或其他任务运行中。

验收条件：
完成后我如何判断它是对的。

Git：
是否需要 commit、branch 或 push。
```
