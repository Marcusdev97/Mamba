# MAMBA TASKS — 双轨作战板

> 更新: 2026-07-04。规则: 每完成一项打勾 + 写日期。改 regex 必先跑 `node test_classifier.mjs`。

---

## ✅ 已完成（本次 session 验证）

- [x] 分类器 bug 修复:「麻烦」误判 COMPLAINT → 已修（只匹配明确抱怨词组）
- [x] 分类器 bug 修复: `stop` 无 word boundary → 已修（明确词组 + 短消息裸词双规则）
- [x] 真实号码移出 source → `TEST_LEADS` env var
- [x] `test_classifier.mjs` 回归测试 — **35/35 通过**
- [x] MAMBA_STANDARD.md（命名铁律 v1.0）
- [x] 修复清单 + 优化路线图（MAMBA_FIXES_AND_ROADMAP.md）

## 🔴 你现在就做（15 分钟内）

- [x] **T1. 把三个文件放进 repo 并 commit**（2026-07-05 完成, 回归测试 35/35 通过）:
  ```bash
  # 覆盖 campaign-app/ 下的两个旧文件, 加入一个新测试文件
  cp flow_sequence.mjs campaign_core.mjs test_classifier.mjs <你的repo>/campaign-app/
  cd <你的repo> && node campaign-app/test_classifier.mjs   # 确认 35/35
  git add -A && git commit -m "P0: classifier fixes + TEST_LEADS env + regression tests" && git push
  ```
- [x] **T2. `.env` 加一行**（evolution-pilot/.env, 2026-07-05 完成; 真实号码只存在 .env, 已 gitignore）:
  ```
  TEST_LEADS=<Name>:<phone>:en:<templateId>,<Name>:<phone>:en:<templateId>
  ```
- [ ] **T3. Repo 转回 Private**（GitHub → Settings → Change visibility）— 你自己做
- [x] **T4. MAMBA_STANDARD.md 和本文件也放进 repo 的 `docs/` 一起 commit**（2026-07-05 完成）

## 🅰️ Track A — 出站赚钱（不等 AI, 本周起持续跑）

- [ ] A1. 全局 Suppression（code, 我来写）: 跨 Project 扫 Stop Flag, import + 发送前双闸门 — **下一个 code 任务**
- [ ] A2. Notion Templates 删掉 Cohort Day / Delay Days 冗余字段（你, 5 分钟）
- [ ] A3. 所有 Part 1 模板统一加 opt-out 尾行（你, Notion 里改）
- [ ] A4. 继续 blast + drip, 每周攒 replies.jsonl 真实样本
- [ ] A5. 每周话术 review（15 分钟）: response rate 排序 → 砍/留/开新版
- [ ] A6. Templates 加 Viewing Count 字段 + 分类器命中 VIEWING_REQUEST 时累加（code, 我来写）

## 🅱️ Track B — 入站 AI 大脑（并行搭建）

- [ ] B1. 建四个 Notion 库（我来建, **卡在授权 — 你按允许即通**）
- [ ] B2. ChatGPT 的 Product Knowledge 搬进 Mamba | Project Knowledge（你, 逐条打 Verified + Source）
- [ ] B3. Golden Conversations 灌 20 段真实成功对话（你）
- [ ] B4. Objection Bank 写 20 条解码（你 + 我一起整理）
- [ ] B5. Cache sync 脚本: Notion 四库 → 本地 JSON, 每 30 min（code, 我来写）
- [ ] B6. Brain service Phase 1: webhook → 分类器 → AI 草稿 → Telegram 三按钮审批（code, 我来写, 前置 = A1 + B1 + B5）
- [ ] B7. Phase 1 → 2 升级判定: 某 route 照发率连续两周 ≥ 90% → 自动放行（数据说话）

## 🏗️ 基础设施（Track A/B 共用）

- [ ] I1. Webhook (blaster_tracker) 升级为主通道, morning_followup 降级为对账
- [ ] I2. Mamba + Evolution 迁移 Mac Mini, launchd 常驻
- [ ] I3. Repo 重构为 /core /outbound /inbound 三模块（B6 动工前做）

## 📏 纪律（贴墙）

1. 地基先于大楼 — A1 没完成, B6 不动工。
2. 一次只改一个变量。
3. 升级看数据不看日历。
4. 改 regex 必跑 test；新样本每两周进 test file。
