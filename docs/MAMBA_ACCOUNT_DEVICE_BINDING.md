# MAMBA 账号 / 设备绑定与号码转移设计 — Rev 3(安全实现基础)

> 状态:Phase 1 v4 候选库/核心服务已实现,尚未 Cutover · 日期:2026-07-17
> 目的:同一 WhatsApp 号码从 PC A 转到 PC B 后,**暖机、Daily Cap、客户、STOP、回复历史、未完成 Campaign 全部连续**;旧 PC 失去发送权;已成功发送的客户绝不重发。
> 相关:`MAMBA_ARCHITECTURE_ADR.md`、`MAMBA_SCHEMA.md`、`MAMBA_SEND_MODES.md`、`lib/device-identity.mjs`。

## P0 修订摘要(相对 Rev 1)

1. **不用 Notion 当心跳/租约 Arbiter**。Notion 无原子 CAS/抢锁,断线会卡发送,违反"Notion 不进关键路径"。**Phase 1 只开放 cooperative handoff**;emergency takeover 等有原子 Arbiter(Postgres/Supabase/Redis)后再做。Notion 仅镜像 + 审计。
2. 靠 `UNIQUE(idem_key) WHERE status='SENT'` 挡不住"两个进程都写 UNKNOWN 再发送"。改用 **`send_claims` 原子占位锁**(抢占成功者才可调 WhatsApp API)+ append-only **`send_events`** 存历史。
3. **不允许**仅凭 Notion `last_flow_sent` 给所有 Part 补 SENT。证据优先级:Campaign Run JSON → part timestamp → provider message id;证据不足只能标 `LEGACY_UNVERIFIED` 进人工检查。
4. Daily Cap 用 **COUNT(DISTINCT contact_key / 收件号码)**,不用 `project_lead_key`。
5. **STOP 留在 contact / 全局策略**,不移进 `whatsapp_accounts`。
6. Bundle 存 `source_generation`;`new_generation` 由原子 claim 返回。Bundle 用 **AES-GCM 认证加密**,含 `bundle_id / nonce / created_at / expires_at / schema_version / snapshot_hash`。
7. 明确 `whatsapp_connections` 与 `device_bindings` 的**唯一数据来源**;迁移**新增 `assigned_account_key`**,不改 `assigned_sender_key` 旧语义。

---

## 0. 三层身份

| 层 | 键 | 代表 | 跨电脑 | 唯一数据来源 |
|---|---|---|---|---|
| **WhatsApp Account** | `account_key = 归一化号码` | 真账号(暖机/Cap/健康/统计) | 不变 | `whatsapp_accounts` |
| **Device Binding** | `binding_key = device_key::号码` | 号码"现在在哪台跑" + 绑定生命周期 | 每次转移换代 | `device_bindings` |
| **Evolution 连接** | `connection_key = device_key::号码` | **仅本机** Evolution instance 运行时健康 | 本机、临时 | `whatsapp_connections` |

> **明确边界(修订 7)**:绑定归属/生命周期只认 `device_bindings`;`whatsapp_connections` 降级为"本机 Evolution instance ↔ 号码 ↔ OPEN/CLOSED/last_seen"的**纯运行时健康**,不含任何 warmth/cap/ownership 语义。两表各有唯一职责,不重叠。
> STOP 不在这三层,它是 **contact 全局策略**(修订 5)。

---

## 1. 数据表结构(修订版)

在当前 v3 的**新副本**上新增 6 张表(`handoff_transfers` 是可恢复交接状态机);绝不原地覆盖 v3。

### 1.1 `whatsapp_accounts`(账号 = 真相,跨电脑)

```
account_key            TEXT PK      -- 601133698121
label                  TEXT
warmth                 TEXT         -- NEW / WARMING / ESTABLISHED
warmup_started_at      TEXT         -- warmup_day = MYT今天 - 此日期(不每天递增)
allowed_max_mode       TEXT         -- conservative / standard(暂不含 turbo)
daily_cap_contacts     INTEGER      -- 每日"独立收件人"上限(见 1.5 Cap 口径)
daily_cap_messages     INTEGER      -- 每日"消息条"上限
health                 TEXT         -- OK / THROTTLED / PAUSED
account_risk_note      TEXT         -- 账号级风险(⚠️ 不含 STOP;STOP 在 contacts)
current_generation     INTEGER NOT NULL DEFAULT 1  -- 绑定代号(见第 2 节)
active_binding_key     TEXT         -- 当前 ACTIVE binding(镜像,便于查询)
lifetime_sent_messages INTEGER DEFAULT 0
lifetime_failed        INTEGER DEFAULT 0
created_at, updated_at TEXT
```
> ❌ Rev 1 里的 `lease_heartbeat_at` 已删除(修订 1,Phase 1 无实时租约)。

### 1.2 `device_bindings`(号码目前在哪台电脑 + 绑定生命周期)

```
binding_key          TEXT PK       -- device_key::号码
account_key          TEXT NOT NULL -> whatsapp_accounts
device_key           TEXT NOT NULL -> devices
instance_name        TEXT          -- 本机 wa_01(仅本机路由,可重复)
status               TEXT          -- PENDING_CLAIM / ACTIVE / TRANSFERRING / RELEASED / REVOKED
generation           INTEGER       -- 本绑定成为 ACTIVE 的代号
bound_at, released_at TEXT
CREATE UNIQUE INDEX ... ON device_bindings(account_key) WHERE status='ACTIVE'
```

### 1.3 `send_claims`(**原子占位锁** —— 抢到才可调 API,修订 2)

```
idem_key           TEXT PRIMARY KEY   -- run:lead:flow:part(唯一;INSERT 即抢锁)
account_key        TEXT NOT NULL
contact_key        TEXT NOT NULL      -- 收件人(算 Cap 用,修订 4)
device_key         TEXT NOT NULL
binding_generation INTEGER NOT NULL
state              TEXT NOT NULL      -- CLAIMED / SENT / FAILED_RETRYABLE / FAILED_FINAL / UNKNOWN / LEGACY_UNVERIFIED
claim_token        TEXT NOT NULL      -- 只有本次抢锁者可结算
provider_msg_id    TEXT
attempt_count      INTEGER DEFAULT 0
claimed_at, updated_at TEXT
```
**抢锁语义**:发某段前 `INSERT INTO send_claims(idem_key, state='CLAIMED', …)`。
- **UNIQUE 冲突** → 别人已占 → **不得调用 WhatsApp API**(交给占用者/跳过)。
- **插入成功** → 我持锁 → 才可调 API。
- 这一条 INSERT 是原子的,天然挡住"两个进程都写 UNKNOWN 再发送"的竞态(单库内)。
- `CLAIMED` 必须先 **COMMIT** 才调用 Evolution;启动时过期 `CLAIMED` 一律转 `UNKNOWN` 人工检查。
- 只有 Provider 明确确认"请求没有被接受"才可进入 `FAILED_RETRYABLE`;TIMEOUT 永不自动重试。

### 1.4 `send_events`(append-only 历史 —— Cap 与审计的唯一真相,修订 2/4)

```
id                 INTEGER PK AUTOINCREMENT
idem_key           TEXT NOT NULL
account_key        TEXT NOT NULL
contact_key        TEXT NOT NULL
device_key         TEXT NOT NULL
binding_generation INTEGER NOT NULL
event_type         TEXT NOT NULL  -- CLAIMED/SENT/FAILED/TIMEOUT/UNKNOWN/SKIPPED/LEGACY_UNVERIFIED/MANUAL_REVIEW
provider_msg_id    TEXT
at_utc             TEXT NOT NULL
myt_date           TEXT NOT NULL  -- Asia/Kuala_Lumpur 当天
error_code         TEXT
detail             TEXT
```
`SENT` 另有 partial unique index:`UNIQUE(idem_key) WHERE event_type='SENT'`,避免重复事件把消息 Cap 算大。

### 1.5 Daily Cap 口径(修订 4)

- `contacts_sent_today` = `COUNT(DISTINCT contact_key)` FROM `send_events` WHERE `event_type='SENT' AND myt_date=今天(MYT)` ——**按独立收件号码,不按 project_lead_key**(同一人在两个盘当天只算 1)。
- `messages_sent_today` = `COUNT(*)` 同条件。
- 永远按 `myt_date` 实时算,**不午夜归零**。

### 1.6 `handoff_transfers` + `handoff_log`

交接主状态:`PREPARING → EXPORTED → IMPORTED → COMPLETED`;导出前失败可 `ABORTED` 并安全恢复来源 Binding。Bundle 一旦成功导出,来源电脑保持失权,不可直接撤销。

### 1.7 现有表调整(修订 7)

- `whatsapp_connections`:**只保留本机 Evolution 运行时**字段;移除任何 warmth/cap/ownership。
- `project_leads`:**新增列 `assigned_account_key`**(→ `whatsapp_accounts`),表示"该 lead 钉在哪个号码"。**`assigned_sender_key` / `last_sender_key` 旧语义保持不变**(不改动、不复用),迁移期两者并存,后续代码逐步改读 `assigned_account_key`。

---

## 2. Account 与 Binding 状态机(Phase 1:无实时 Arbiter)

### 2.1 跨机互斥怎么保证(诚实说明,修订 1)

Phase 1 **没有实时 Arbiter / 心跳 / 租约**。跨机"同一账号只有一台在发"靠:
1. **流程纪律**:cooperative handoff —— PC B 认领前 PC A 必须**完全停机**(单向交接)。
2. **代号 generation**:交接后 PC B = `source_generation + 1`;旧代号一律无发送权。
3. **单库原子锁**:`send_claims` 保证**同一段**不会被并发发两次(单库内竞态)。
4. **检测(非强制)**:Notion 作镜像,若出现两个 generation 同时活动 → 标记冲突 → 人工核对(仅告警,不进发送路径)。

> ⚠️ **残余风险(已知、可接受)**:若用户违规——没停 A 就在 B 认领——Phase 1 **无法用技术手段硬性阻止双活**,只能事后检测。硬性阻止需要 Phase 2 的**原子 Arbiter**。因此 **emergency takeover 在 Phase 1 关闭**。

### 2.2 warmth(成熟度)/ health(运行)—— 两轴分开
```
warmth:  NEW ──(暖机满 X 天 + 量达标 + health=OK)──▶ WARMING ──▶ ESTABLISHED  (只升,换机不重置)
health:  OK ──(可验证信号超软阈值)──▶ THROTTLED ──(超硬阈值)──▶ PAUSED ──(次日+人工)──▶ 降一档恢复
```

### 2.3 Binding 状态机
```
(无) ──claim(cooperative;generation = source+1)──▶ PENDING_CLAIM ──成功──▶ ACTIVE
ACTIVE ──cooperative release──▶ RELEASED
ACTIVE ──被更高 generation 顶替──▶ REVOKED
```
**发送许可(Phase 1,本机判定)**:`binding.status==ACTIVE 且 generation==account.current_generation`。
> Phase 2 会在此之上叠加原子 Arbiter 的 lease 校验(见第 9 节)。

---

## 3. PC A → PC B 转移(Cooperative Handoff,Phase 1 唯一支持)

```
PC A:
1. 进入 PREPARING:冻结该账号 Scheduler;确认无 CLAIMED 未结算的段(没有 in-flight)
2. 建立一致性快照;Notion 待同步项一起放进 Bundle,Notion 断线不阻塞交接
3. 生成并重新验证加密 Handoff Bundle(见下)
4. 只有 Bundle 验证成功后才进入 EXPORTED,本地 binding → RELEASED

PC B:
5. 连接相同真实号码(normalizeSenderPhone 一致)
6. 导入 Bundle:AES-GCM 解密 + 验证 tag、snapshot_hash、expires_at、schema_version
7. claim:new_generation = source_generation + 1;写本地 binding=ACTIVE(new_generation);
   account.current_generation = new_generation;active_binding_key = PC B
8. 续跑未完成 Campaign(第 5 节,靠 send_events/claims 去重)

结果:PC A binding 是旧 generation → 无发送权;PC A 若重开,发送许可判定失败 → 拒发,
      未同步数据转人工合并,绝不自动发送。
```

**Handoff Bundle(修订 6:AES-GCM 认证加密)**
```
外层(密文头,明文可读用于校验):
  bundle_id, nonce, created_at, expires_at, schema_version, auth_tag
  KDF=scrypt 参数 + salt(不含密码/密钥)
加密载荷:
  account_key
  source_generation          -- 交接前代号;new_generation 由认领方 claim 后得到(= +1)
  未完成 campaign(run 状态 + 队列)
  全部相关 send_claims(包含 UNKNOWN / LEGACY_UNVERIFIED)和 send_events
  未完成 run 必须保留原 campaign_run_id,续跑不可生成新 ID
  当日 send_events(用于 Cap 连续)
  STOP List —— 作为 contact 全局策略快照(修订 5,非"账号 STOP")
  客户归属(project_leads 关键字段,含 assigned_account_key)
  最后同步时间
  snapshot_hash              -- 明文快照哈希,导入端复核
```
> Bundle 是"旧程序完全停止后的一次单向导出/导入",**SQLite 文件本身不跨机同步、不双写**。
> 交接密码至少 12 字符,用 scrypt 派生 AES-256-GCM key;Bundle 不保存解密 key。Phase 1 只能在 UI/本机记录 consumed,跨电脑硬防重放要等 Phase 2 Arbiter。

---

## 4. Emergency Takeover —— **Phase 1 关闭,延后至 Phase 2**(修订 1)

强制接管一台"没配合停机"的电脑,必须有**原子仲裁**才能安全做(否则会顶掉一台还活着、可能正在发的机器 → split-brain)。Phase 1 无原子 Arbiter,故:

- **Phase 1**:emergency takeover **不提供**。PC A 损坏时,人工确认其确实停止后,走 cooperative handoff 的"无 Bundle 降级路径":PC B 用最后一次 Notion 镜像重建,凡"无法确认是否已发送"的段一律 `LEGACY_UNVERIFIED` / `UNKNOWN` → 人工检查,不自动补发。
- **Phase 2(有原子 Arbiter 后)**:Arbiter 提供 `claim(account, expected_generation) → new_generation` 的原子 CAS + lease/heartbeat;仅当租约过期才允许接管,`new_generation` 由 Arbiter 原子分配。届时 `transfer_generation` 递增让旧 binding 永久失效。

---

## 5. 未完成 Campaign 无重复续跑(修订 2/3)

**幂等单元**:`idem_key = campaign_run_id : project_lead_key : flow_topic : part_no`。

发每段的判定顺序:
| 依据 | 动作 |
|---|---|
| `send_events` 有该 idem_key 的 `SENT` | **跳过**(绝不重发) |
| `send_claims` 该 idem_key 已被占(CLAIMED/其它) | 不重复调 API |
| `LEGACY_UNVERIFIED` / `UNKNOWN` / `TIMEOUT` | **人工检查**,不自动补发 |
| 无任何记录 | 抢锁:`INSERT send_claims` 成功 → **先写 CLAIMED → 发 → 拿到 provider_msg_id 再 SENT**;抢锁失败(UNIQUE)→ 跳过 |

- **续跑**:恢复/接管后按队列逐段问 `send_events`,SENT 跳过 → 天然从断点续。Part1=SENT、Part2 未发 → 从 Part2 续。
- **先占锁后发**:claim 的 INSERT 是原子门,任何"已发但没记 SENT"的模糊态都停在 `UNKNOWN` → 人工,绝不猜测重发。

---

## 6. Send Modes 字段归属(修订 4/5)

| 字段 | 属于 | 备注 |
|---|---|---|
| warmth / warmup_started_at / allowed_max_mode / health / daily_cap_* | **whatsapp_accounts** | 换机不重置 |
| 当日已发量 | **send_events 实时算** | contacts=DISTINCT contact_key;messages=COUNT(*) |
| 本次 mode | `campaign_runs.mode` | 受 account.allowed_max_mode 封顶 |
| 节奏预设(gaps/typingSim/workingHours/longBreak) | 项目 `delivery` preset | 行为参数 |
| ACTIVE/REVOKED / generation / instance_name | `device_bindings` | 只管在哪台跑 |
| **STOP** | **contacts(全局)** | 修订 5:不进 account |

**本阶段约束(不变)**:只做 Conservative + Standard(**Turbo 不开**);Typing Simulation **仅体验功能、非防封机制**;健康只用可验证信号(失败率/连续失败/Evolution 状态/STOP/回复率/API timeout),**`block_rate` 不用**;**连续失败 3 停不放宽**;自动降档**只告警**。

---

## 7. 从当前 v3 迁到 v4 的步骤(全部新库、additive、先 dry-run)

1. 建 5 张新表:`whatsapp_accounts / device_bindings / send_claims / send_events / handoff_log`。
2. **账号去重**:`whatsapp_connections` 按 `normalizeSenderPhone` 归并成 `whatsapp_accounts`(同号多机 → 1 account)。
3. **迁状态**:warmth/cap/health 迁进 account;`warmup_started_at` 取该号最早 `first_blast_at`(缺失→迁移当天 + warmth=NEW 保守)。**STOP 不动,留 contacts。**
4. **建绑定**:当前在用设备 → `ACTIVE` `generation=1`;历史设备 → `REVOKED`。
5. **加列不改旧义(修订 7)**:`project_leads` **新增** `assigned_account_key`(= 该号 account_key);`assigned_sender_key` 原样保留。
6. **播种 send_events(修订 3,证据优先)**:
   - 有 **Campaign Run JSON + part timestamp + provider_msg_id** → 写 `SENT`。
   - 只有 run 记录但缺 part 级证据 → 保守:该 part 记 `LEGACY_UNVERIFIED`。
   - **仅有 Notion `last_flow_sent`、无 part 级证据** → 一律 `LEGACY_UNVERIFIED` → 人工检查。**绝不把所有 Part 补成 SENT。**
7. `quick_check` + `foreign_key_check` + 对账报告;人工抽查后再进影子。

---

## 8. 每步风险 / 回滚 / 测试

| 步骤 | 风险 | 回滚 | 测试 |
|---|---|---|---|
| 建表 | 无(additive) | 删新库 | 空库跑 schema,quick_check=ok、FK 干净 |
| 账号去重 | 误并/漏并同号 | 新库,重跑 | 造"同号多设备"样本 → 断言 1 account |
| 迁状态 | Cap 迁错致放量 | 保守默认兜底 | 断言迁后 Cap ≤ 迁前;缺失走 NEW |
| 建绑定 | 选错 ACTIVE | generation=1 + 人工确认 | 断言仅 1 个 ACTIVE,余 REVOKED |
| 加 assigned_account_key | 归属错 | 新列,可重算;旧列不动 | 抽查 lead 的 account_key 正确 |
| 播种 events | 误补 SENT 致漏发 / 漏补致重发 | 只写占位、可整批清空重播 | **断言:无 part 级证据者=LEGACY_UNVERIFIED,非 SENT** |
| send_claims 竞态 | 双发 | — | **并发压测:同 idem_key 多线程抢锁,仅 1 次调用 API** |
| Cap 口径 | 多项目重复计数 | — | 同人两盘当天:contacts_today 只 +1 |
| Handoff | Bundle 篡改/过期/双活 | AES-GCM tag/hash/expires 校验失败即拒;generation 挡旧机 | 模拟 A→B:A 失权、B 续跑、无重发;过期 Bundle 被拒 |

**端到端验收场景**:A 发 Flow1 Part1–2 → cooperative handoff → B 续 Part3 → 断言:暖机/Cap/STOP/历史连续、A 无法再发、Part1–2 不重发、模糊段进人工。

---

## 9. 现在能做 vs 必须等待

**Phase 1 · 现在能做(不需要原子 Arbiter)**
- 建 5 张表 + v3→v4 迁移(dry-run、新库)。
- `send_events` **影子写入**(旁路记录,不决策)。
- 从 `send_events` **只读展示** warmth / 当日 contacts&messages / Cap 余量。
- **Cooperative handoff** 导出/导入工具(AES-GCM Bundle + generation +1)。
- 健康**只告警**(可验证信号)。
- Notion 仅镜像/审计 + 双 generation **冲突检测**(告警)。

**Phase 1.5 · SQLite 进入发送热路径后(硬保证)**
- 每段发送前 `send_claims` **原子抢锁**(真正"绝不重发"的技术保证)。
- 发送前 binding + generation **本机硬校验**(挡住旧代号)。
- Daily Cap(DISTINCT contact)**实际拦截**发送。

**Phase 2 · 有原子 Arbiter(Postgres/Supabase/Redis)后**
- **Emergency takeover** + 实时 lease/heartbeat + 原子 `claim() → new_generation`。
- 跨机"同账号单活"**硬性**保证(不再只靠流程纪律)。

> 诚实结论:Phase 1 给你"**数据连续 + cooperative 交接 + 单库原子去重 + 完整对账 + 冲突检测**"。Phase 1.5 只保证**成功完成 cooperative release 后**旧 PC 本机失权;"违规双活也硬拦住"必须等 Phase 2 原子 Arbiter。

---

## 10. 验收条件对照

| 验收要求 | 机制 | 阶段 |
|---|---|---|
| 换机后暖机连续 | account.warmup_started_at + Bundle | Phase 1 存/显示 |
| Daily Cap 连续 | account.cap + send_events(DISTINCT contact, MYT) | Phase 1 显示 / 1.5 拦截 |
| 客户 / STOP / 回复历史连续 | contacts(STOP 全局)+ Notion 镜像 + Bundle | Phase 1 |
| 未完成 Campaign 续跑 | send_events 去重 + 断点续 | Phase 1.5 |
| 正常交接后旧 PC 无法继续发送 | RELEASED + generation + 发送前硬校验 | Phase 1.5 |
| 未停旧 PC 就违规双开也能拦截 | 原子 Arbiter + lease | Phase 2 |
| 已成功发送绝不重发 | send_claims 原子锁 + 先占后发 + SENT 跳过 | Phase 1.5 |
| 无法确认是否发送 → 人工 | UNKNOWN / LEGACY_UNVERIFIED 不自动补发 | Phase 1 起 |
