# MAMBA UI BIBLE · 设计规范 v1.0

> 单一真相源:`campaign-app/assets/mamba.css`(基础层)。
> 规则:**页面不允许自造颜色/字号/间距**,只能用这里定义的 token。
> 页面自己的 `<style>` 是覆盖层,只写该页独有的东西。

---

## 0. 架构

```
mamba.css(tokens + 组件)  ←  所有页面 <link> 引入,排最前
page <style>               ←  只放页面独有样式,可覆盖基础层
```

新页面起步模板:

```html
<link rel="stylesheet" href="/assets/mamba.css" />
<style>/* 只写本页独有的 */</style>
```

---

## 1. 字体

| 用途 | 字体 |
|------|------|
| 界面(英文/数字) | **Inter Variable**(本地 woff2,`/assets/fonts/`) |
| 界面(中文) | **苹方 PingFang SC**(系统),Windows 回退微软雅黑 |
| 代码/日志/号码 | `ui-monospace / Menlo` |

统一走 `var(--font-sans)` / `var(--font-mono)`,禁止在页面里手写 font-family。

## 2. 字号(Type Scale)

| Token | 大小 | 用途 |
|-------|------|------|
| `--fs-h1` | 19px / 650 | 页面标题(每页只有一个) |
| `--fs-h2` | 13px / 700 大写 + .8px 字距 | 卡片标题 |
| `--fs-body` | 14px / 1.5 | 正文、按钮、输入框 |
| `--fs-sub` | 12.5px | 副标题、提示、chip |
| `--fs-tiny` | 11.5px | 表头、badge |

## 3. 间距 · 8px Grid

`--sp-1`(4) `--sp-2`(8) `--sp-3`(12) `--sp-4`(16) `--sp-5`(20) `--sp-6`(24) `--sp-8`(32) `--sp-10`(40) `--sp-12`(48)

规则:所有 margin/padding/gap 从这里取,4px 是唯一允许的半步。卡片间距 16,卡片内边距 16,页面左右 20。

## 4. Color Tokens

**背景四层**(由深到浅):`--bg` 页面底 → `--panel` 卡片 → `--panel-2` 控件底 → `--panel-3` hover。
**描边两级**:`--line` 默认 → `--line-2` hover。
**文字三级**:`--text` 主 → `--muted` 次 → `--faint` 占位。

**品牌与语义**:

| Token | 色 | 语义 |
|-------|----|----|
| `--green` #25d366 | 品牌绿 | 主 action、成功、OPEN、Active |
| `--blue` #4a9eff | 蓝 | 链接、进行中、信息 |
| `--amber` #f5b342 | 琥珀 | 警告、LIVE、Testing |
| `--red` #ff5d5d | 红 | 危险、失败、STOP |

**16% 规则**:语义色做底色时一律用 16-18% 透明度版(`--green-bg` 等),文字用实色。绿底/琥珀底上的文字用 `--on-green` / `--on-amber`(深色),不用白。

## 5. Dark Mode 规则

Mamba 是 dark-first,只有暗色模式。原则:

1. 永不用纯黑 #000,底是 `#0f1115`。
2. 层级靠**背景变浅**表达,不靠阴影(阴影只给 dialog/toast 这种浮层)。
3. 边框比背景亮一档;hover = 背景和边框各提一档。
4. 大面积高饱和色禁止;高饱和只出现在小元素(badge、按钮、dot)。

## 6. 组件

全部在 mamba.css 里,类名即 API:

| 组件 | 类名 | 要点 |
|------|------|------|
| Button | `.btn` + `.primary/.danger/.live/.sm` | 高 40,radius 9;主 action 每卡片最多一个 primary |
| Segmented | `.seg` | TEST/LIVE 这种二选一 |
| Input | `input/select/textarea` 自动生效 | focus 绿边;placeholder 用 `--faint` |
| Card | `.card` + `h2` | radius 12,标题大写 |
| Table | 原生 `table` 自动生效 | 行 hover 微亮;表头 tiny 大写 |
| Badge | `.badge` + `.b-queued/.b-go/.b-sent/.b-warm/.b-fail` | 状态标准五色 |
| Pill | `.pill` + `.dot.on/.off` | 页头 API 状态 |
| Chips | `.chips > .chip` | 统计数字 |
| Progress | `.progress > i` | 400ms 过渡;不叫 .bar,那是工具页的工具栏 |
| Log | `.log` | mono 字体,更深底 |
| Dialog | `.modal > .modal-box > .modal-head/.modal-content/.modal-actions` | 带进场动画 |
| Toast | `.toast(.show)(.err)` | 底部居中 |
| 步骤号 | `.step-no` | 绿圆圈数字 |

## 7. Sidebar(未来)

做成 SaaS 后左侧栏规格:宽 232px,背景 `--bg`,当前项 `--panel-2` 底 + 绿色 3px 左条;分组标题用 `--fs-tiny` 大写 `--faint`。导航项高 36px,radius 7。

## 8. AI Chat(未来 · Sales Brain 前端)

- 客户消息:左侧,`--panel` 气泡;我方/AI 消息:右侧,`--green-bg` 底 + `--text` 文字。
- AI 草稿状态:虚线边框 + amber「草稿」badge;人批准后变实线。
- 时间戳 `--fs-tiny` `--faint`;号码一律 `--font-mono`。
- 输入区固定底部,`--panel` 底,发送按钮 `.btn.primary`。

## 9. Motion

| Token | 时长 | 用途 |
|-------|------|------|
| `--t-fast` 120ms | hover、按下 |
| `--t-med` 200ms | dialog/toast 进出、展开折叠 |
| `--t-slow` 400ms | 进度条 |

统一缓动 `--ease`(easeOutQuad)。动画只做 opacity/transform,不动 layout 属性。`prefers-reduced-motion` 自动全关(已内置)。

## 10. 禁止事项

1. 页面里写死色值(#xxx)—— 用 token。
2. 自造字号/间距 —— 用 scale。
3. 一个卡片两个 primary 按钮。
4. 白底元素(除了二维码区,那是功能需要)。
5. emoji 当图标乱换 —— 每个功能的 emoji 在控制台和页面标题保持一致:
   ⓪🚀 一键启动 · ①📣 首轮群发 · ②☀️ 早间跟进 · ③⬆️ 上传补跑 · 💬 回复追踪 · 📱 号码连接 · 🗂 模板&Flow · 🔎 查找客户 · 🐳 Evolution · 🧠 Brain
6. 基础层新增组件前先 grep 五个页面,类名不许和页面局部类撞名(教训:.bar 进度条 vs 工具栏)。
