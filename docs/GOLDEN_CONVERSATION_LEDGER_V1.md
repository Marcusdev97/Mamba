# Mamba Golden Conversation Ledger v1

更新日期：2026-07-18  
依据：`GC-实作规格-v1.md`

## 现在完成了什么

Golden Conversation 已从旧的“Notion 对话收藏”整理成一套本机 SQLite 对话账本：

- 一行代表一个匿名客户的完整对话，不是一句一行。
- 成功标准固定为 `Viewing Booked`；Booking／成交不作为 Mamba 指标。
- `Viewing Booked` 进入 Brain runtime cache；失败案例保留给诊断报表。
- Project Knowledge 继续负责价格、库存、发展商、距离等事实。
- Golden Ledger 只教 Brain 如何读取客户信号、如何 FactFind、为什么选择某个推进动作。
- 对话内的历史价格、租金、库存与交通说法不会成为 Brain 的事实来源。

入口：`http://127.0.0.1:8787/golden-ledger`

## 安全升级方式

当前 Mamba SQLite 仍保持全局 `user_version = 3`，不会因为 GC 子系统而强迫整个数据库升级。

如果检测到旧版 `golden_conversations`：

1. 保留原表为 `golden_conversations_legacy_v3`。
2. 建立新的 Conversation Ledger。
3. 把旧记录逐行搬入，并使用 `LEGACYxxxx` 匿名代号。
4. 记录 `metadata.gc_schema_version = 1`。
5. 建立 `followup_log` 与三个分析索引。

升级不会删除旧表，也不会修改 Notion。

## 导入流程

1. 操作者填写 Project、客户类型、用途、结果与完整 M/C 对话。
2. 写入前自动移除姓名、马来西亚手机号、车牌、电邮、网页链接和常见地址格式。
3. Parser 检查 M1/C1 连续编号、相对时间、结束标记及至少一次客户回复。
4. `decision_trace` 必须由人填写 `signal / read / move / why / effect`。
5. 先跑“安全预检”，通过后才允许确认写入 SQLite。
6. `source_hash` 与 `lead_code` 同时防止重复导入。

`trigger_message` 必须逐字存在于一则 M 讯息中，避免事后创造一个没有说过的成功理由。

## Outcome 规则

- `Viewing Booked`：必须有 trigger message 和客户下一步。
- `Active`：仍在 30 天互动窗口内。
- `Dormant`：超过 30 天无回复，但仍在跟进名单。
- `Dead`：只可人工标记，必须有明确理由。

自动任务只会执行 `Active → Dormant`。它使用 `last_customer_reply_at` 判断，并自动反查最后一则没有得到客户回复的 M 回合。系统没有任何自动转 Dead 的逻辑。

## Runtime 规则

本机 runtime cache 位于：

`campaign-data/brain/golden-ledger.json`

Cache 只包含 `Viewing Booked`，Brain 应检索 `decision_trace.signal / read / move`。完整历史对话不作为楼盘知识，价格与库存只能从最新 Project Knowledge 取得。

## 已安装的四组验收报表

1. 哪一类最后讯息最容易成为 Dormant／Dead 的死亡点。
2. 哪个 Blast Version 带来最多 `specific_question` 型首次回复。
3. 哪一种 Follow-up 最能让沉默客户回复。
4. 沉默间隔进入哪个区间后，Follow-up 复活率明显下降。

## Seed L001

唯一自动 Seed 是规格指定的 ENLACE 投资客户案例：

- 客户处于市场研究早期并主动表达投资目的。
- Sales 配合语言偏好，从项目比较推进到单位比较。
- 稀缺性只在客户已经缩小户型后出现。
- 低压力邀请让客户主动提出看房时段。
- 通过净价差、月供差、Waze、车位与 Virtual Tour 降低到场摩擦。
- 客户改期时没有施压，随后重新预约并 reconfirm。
- 车牌与其他 PII 不进入 SQLite、Cache 或日志摘要。

## 验收

自动测试覆盖：

- 新库建表与 Seed。
- 旧 v3 表无损迁移和备份表保留。
- 电话、电邮、车牌、姓名清洗，同时保留 M1/C1 与 RM 价格文字。
- 严格对话 Parser、结束状态和 death turn。
- 重复导入拦截。
- 四组查询。
- Active 30 天后转 Dormant，Dead 自动转换次数恒为 0。
- Runtime cache 只包含 Viewing Booked。

测试命令：

```bash
node campaign-app/test_golden_conversation_ledger.mjs
```
