---
name: "sop-service-perception-card"
description: "服务感知卡出图：先查Base成品图→有则直接下发→无则按规范生成。严禁image_generate出hero。"
package: miao-b2b
aliases:
  - sop-service-perception-card
---

# 服务感知卡出图规则

## 🚨 第一优先级：查Base任务表成品图（所有出卡请求第一步）

无论CSM在哪个群/私聊索要服务感知卡，**第一个动作永远是查Base任务表**，不是生成。

Base: `GN6ibmtp9ad72asdZ9fc8CVnnGc`，任务表: `tblvV9ssvid8HDIZ`

```
查询命令:
lark-cli base +record-list --base-token GN6ibmtp9ad72asdZ9fc8CVnnGc --table-id tblvV9ssvid8HDIZ --page-size 50 | grep "企业名"

成品图字段: fldPr2VFdE (attachment类型)
下载附件: lark-cli drive +download --file-token <token> --output <本地路径>
```

### 查表后的两条分支

**✅ 表里有成品图（file_token不为空）：**
1. 用 `lark-cli drive +download --file-token <token>` 下载成品图到本地
2. 直接发送成品图到群，不重新生成
3. 不再走下面的"出图流程"——结束

**❌ 表里无成品图（file_token为空或无记录）：**
1. 确认企业名称、服务节点、卡片类型、CSM
2. 文案从 copywriting-templates.md 取
3. 走标准出图流程（见下方）
4. 生成后将成品图上传回任务表（`lark-cli base +record-upload-attachment --field-id fldPr2VFdE`）

## 先读规范
出图前先读取项目规范：
- `memory/projects/service-perception-cards/main.md`
- `memory/projects/service-perception-cards/design-rules.md`
- `memory/projects/service-perception-cards/copywriting-templates.md`

## Base 表结构
Base 名称：服务感知卡任务表。

保留两张表：
- `任务表`：实际待办、企业、CSM、当前动作、成品图。成品图字段只保留最终版。
- `服务节点表`：节点规则、触发条件、是否主动触发、模板状态。

表ID：
- 任务表 Base: `GN6ibmtp9ad72asdZ9fc8CVnnGc` 表: `tblvV9ssvid8HDIZ`
- 拍摄服务表 Base: `IVlxbfPwqa9cjPsNzhucpS3rnPH` 表: `tblN3js6sTuCxuXj`
- 交付权益表 Base: `IVlxbfPwqa9cjPsNzhucpS3rnPH` 表: `tblP0D9KkJTxkwUG`

## 节点规则（仅标准卡）
- 「账号开通」和「账号搭建完成」是两个独立服务节点。
- 「账号开通」触发条件：拍摄服务完成后 T+8 天，投放地区来自交付权益表。
- 「账号搭建完成」触发条件：查看「AI视频营销运营服务进度」下「提供账号搭建信息」，从「未完成」变为「已完成」。
- 「拍摄服务」不主动触发；只有 CSM 询问或明确需要拍摄服务卡时才生成。
- **月度服务同步卡已独立为 `monthly-service-review-card` skill，CSM 提到月度复盘时由该 skill 处理。**

## 设计风格
蓝紫主调 + 少量暖金点缀，整图自然融合。

## 主图规则
- 主图全幅背景，上下羽化过渡自然，无硬边/贴片/断层
- hero 画面必须同时融合三层元素：**企业主营业务 + 服务节点主题 + 蓝紫科技感**
  - 企业业务元素以全息/数字/线框方式融入，不是写实照片
  - 节点主题（如素材收集=数据流+文件库、视频出海=全球网络+传播）
  - 科技风格：蓝紫主调 + 暖金点缀 + 粒子/光轨/数字网格
- 禁止纯抽象科技风（看不出行业），也禁止写实产品照（像宣传册）
- **hero 必须与策划案/企业真实主营业务一致**。不知道主营业务时先查策划案或交付权益表「客户行业-按交付」字段，不要猜。
- logo + 企业名区域不被主体遮挡，避开手机灵动岛安全区
- **服务卡统一 804×1748px**
- **hero 必须为 9:16 竖版（makaron edit 生成，生成后检查尺寸，非竖版则重生成）**

## 标题区遮罩
标题区必须有暗色遮罩衬底：
- top=880px, height=470px, 渐变 0→40→80
- 底部补一块纯黑：top=1350px 到底, background=#02040b, z-index=4（在蒙版下方，保证文字区永远黑底）

## 卡片类型

### 文字型
- 大字: .metric-text, 104px, font-weight:900
- 小字: .sub-text, 30px, font-weight:400
- 底部文案标题: 38px · 描述: 26px
- 文案来源：copywriting-templates.md 预定义

### 数字型
- 大字: .metric, 182px, @font-face 加载本地 fonts/DIN-Pro.ttf, font-weight:900
- 小字: .sub-title, 42px, font-weight:900, margin-top: 4px
- 底部文案标题: 40px · 描述: 24px
- 文案来源：copywriting-templates.md 预定义

## 版本标识（Badge）

企业名后紧跟版本标，色块+白字，与企业名同行同高。

| 版本 | CSS class | 色值 |
|------|-----------|------|
| Pro | `.badge-pro` | 浅蓝 `rgba(88,180,255,.85)` |
| Pro+ | `.badge-proplus` | 深蓝 `rgba(40,80,180,.90)` |
| Max | `.badge-max` | 金色 `rgba(212,175,55,.85)` |

CSS 规范：
```css
.badge{display:inline;vertical-align:middle;margin-left:10px;padding:3px 10px;border-radius:5px;font-size:20px;font-weight:700;color:#fff;letter-spacing:1px}
```

HTML 示例：`<div class="company">企业名称<span class="badge badge-pro">Pro</span></div>`

## 文案分层规则

每个节点有三套文案（Pro / Pro+ / Max），体现递进的服务价值：
- **Pro**：做完基本功 — 标准化流程完成
- **Pro+**：做得更聪明 — 更深度加工、对标分析、定向多版本
- **Max**：做到战略级 — 独占策略团队、全域布局、年度规划

文案约束：
- 每段正文 ≤2 行（26px 字号下约 28 字/行，即 ≤56 字）
- 文案来源：`copywriting-templates.md`，按节点+版本取用

## 通用位置
- logo: top=148px, 居中, width=126px
- 企业名: top=216px, 居中, 36px
- 标题区: top=930px, 居中
- 分割线: top=1202px, 左右各留100px
- 文案区: top=1244px, 左右各留74px

## ⛔ hero 生成铁律

- **只允许 `makaron edit` CLI 命令生成 hero**，生成后直接输出本地文件，不会自动出现在群/对话里
- **严禁使用 `image_generate` 工具生成 hero**——它会自动把裸图发到群，违反"群内只出现成品卡"规则
- hero 生成后必须检查尺寸是否为 9:16 竖版，非竖版则重生成
- hero 只存在本地，不得作为独立消息发到飞书群

## ⛔ 群内只出现成品卡，不出现 hero 裸图

- hero 图生成后只能用于 HTML 合成，**不得**作为独立消息发到飞书群
- 不得使用 Makaron 服务卡工作流（visible-parent-flow.cjs / restart-task-worker.cjs）来生成感知卡的 hero
- 原因：Makaron 卡跑器会自动把中间产物发到群，导致裸图泄漏
- 最终只发 Playwright 截图合成的成品卡

## ⛔ 模板 ≠ 规范：渲染前必须逐项交叉校验

**模板文件（如 `material_collected-template-v1.html`）是历史快照，`design-rules.md` 是唯一权威源。两者可能存在偏差。**

渲染前，必须打开 `design-rules.md` 逐项对照合成后的 HTML：

| 检查项 | 规范值 | 检查方法 |
|--------|--------|---------|
| logo 位置 | top=148px, width=126px | 对照 HTML |
| 企业名位置 | top=216px, font-size=36px | 对照 HTML |
| 标题区遮罩 | top=880px, height=470px, 渐变 0→40→100 | **必须显式 `.mask` div** |
| 底部纯黑块 | top=1350px, background=#02040b, z-index=4 | 对照 HTML |
| 大字字号 | 文字型 104px / 数字型 182px DIN Pro | 对照 HTML |
| 小字字号 | 文字型 30px / 数字型 42px | 对照 HTML |
| 底部标题/正文 | 文字型 38px+26px / 数字型 40px+24px | 对照 HTML |
| 分割线 | top=1202px / 数字型 top=1190px（兼容） | 对照 HTML |
| hero 尺寸 | 9:16 竖版 | 检查生成结果 |

**不匹配规范的项目必须修正后重渲染。不依赖"模板看起来应该是对的"。**

## 完整出图流程（当表里无成品图时）

1. 先查 `任务表` —— **这是第一步，见顶部🚨规则**
2. 如果表里已有成品图 → 下载直接发，结束
3. 如果无 → 查 `服务节点表` 确认节点规则和触发条件
4. 查策划案或交付权益表确认企业主营业务
5. 文案从 copywriting-templates.md 取，按节点+版本选用
6. 文字型用 `.metric-text`；数字型用 `.metric` + @font-face DIN Pro
7. 用 `makaron edit` CLI 生成 hero（严禁 `image_generate`）。检查尺寸 9:16 竖版
8. 套版式合成成品卡（132% auto + .mask 0→40→100 + 黑块 1350px + hero:after 渐变）
9. 对照 design-rules.md 校验表逐项检查，不通过修正后重来
10. Playwright 截图 → 发成品图到群
11. 上传成品图到任务表（`lark-cli base +record-upload-attachment`）
12. 发前终检：群里只有 1 张成品图？有 logo？有企业名？文字字号正确？遮罩到位？

## ⛔ 不对无关企业生成卡片

- 只生成 CSM 明确索要的企业卡片
- 不要用 sed/替换企业名的方式给无关企业批量生成卡片
- 每个企业需要独立的 hero 和文案，不能用另一个企业的模板直接改名
