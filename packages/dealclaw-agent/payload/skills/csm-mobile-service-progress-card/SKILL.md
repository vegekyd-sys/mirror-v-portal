---
name: "csm-mobile-service-progress-card"
description: "地铁图:当前阶段置顶高亮+历史沉底+飞书数据,Playwright截图,客户可读文案"
---

# CSM Mobile Service Progress Card（地铁图）

## 定位

375px 客户可见竖屏服务进展图。**客户打开第一屏必须看到当前阶段的核心进展，不需要往下翻。图片交付客户，不能有任何内部标注或技术字段。**

## 信息架构（v3）

卡片排序规则：**当前阶段 → 已完成阶段 → 未来阶段**。不再按五分类平铺，改为按阶段组织。

### 1. 当前阶段 · 高亮置顶

- 区域标题：`阶段名 · 进行中`（粉紫色系，带发光圆点）
- 主体：核心指标卡片——不是"做了几个节点"，而是 **"这个阶段创造了什么价值"**
  - 大号数字 + 单位（视频条数、播放量、账号数等）
  - 一行价值描述文案
  - 横向排列的 2-3 个关键子指标
- 子节点：当前阶段内归属于标准 SKU 的其他节点，以紧凑 ✓ 行形式跟在核心卡片下方

样式：
```
border: 1px solid rgba(236,72,153,.25);  /* 阶段色系 */
border-left: 4px solid 阶段色;           /* 左侧加粗色条 */
background: rgba(阶段色,.08);           /* 微透底色 */
```

### 2. 已完成阶段 · 沉底低调

- 分隔线 `------ 已完成 ------` 将当前阶段与历史阶段隔开
- 每个已完成阶段：
  - 标题白色但透明度降低（opacity: 0.45-0.6）
  - 节点用紧凑行样式，smaller font
  - 背景极淡 rgba(色, .04)，border 极细
  - 不展示大号数字，只展示节点名 + ✓ 标记

### 3. 未来阶段 · 极淡提示

- 最低透明度（opacity: 0.2-0.25）
- 单行简述该阶段会做什么（如"10%小批量投放、90%大批量投放"）
- 无勾选标记、无数字

## 禁止在客户图上出现的内部标注

| 禁止 | 原因 |
|------|------|
| "20%混剪→30%混剪" | 内部交付节点名，客户不理解 |
| "待fcloud确认" | 内部技术标注 |
| "飞书无对应字段" | 内部调试信息 |
| "数据来源：xxx" | 并非客户需要的信息 |
| 内部技术术语（pubTime、query-works等） | 客户不可见 |

## 节点体系

节点的 source of truth 是标准 SKU 节点定义（来自合同/交付标准文档），而非飞书字段名。每个版本的 SKU 有不同节点集合。

**当前版本对应的标准 SKU 节点以飞书多维表格中该企业的「产品版本」字段 + 交付权益表为准。**

节点命名规则：
- 用客户能理解的业务语言，不用飞书原始字段名
- 每组节点数量遵循 SKU 定义，不凭飞书有字段就全列

## 出图时机

| 触发条件 | 检测方式 |
|----------|----------|
| 客户阶段变化（筹备→蓄势→冲刺→价值） | 飞书表比对当前阶段 vs 上次记录 |
| 关键节点中任一 status 从 false → true | 标准 SKU 节点差异比对 |
| 核心指标跨档变化 | 播放量跨百万/千万档位、视频数跨百档 |

**不触发：** 仅数字微调、仅日期推进无其他变化、无新数据的重复查询。

## 变更检测

每次拉取数据后，与基准快照 diff。无变化 → 跳过出图。有变化 → 出图 + 更新快照。

快照格式：`{phase, nodes[{id, done}], metrics{key: value}}`

## Layout 结构（HTML 模板）

```
[标题] 服务进度
[企业信息] 名称 + 版本 + 期限 + CSM
[四阶段 Pill]
[当前阶段区域] ← 客户第一屏
  ├ 核心指标卡片（大号数字 + 价值文案）
  └ 子节点 ✓ 行
[分隔线] ── 已完成 ──
[历史阶段 · 低调]
  ├ 阶段小标题
  └ 节点 ✓ 行（紧凑）
[分隔]
[未来阶段 · 极淡]
  ├ 阶段小标题（opacity .25）
  └ 单行简述
```

## 数据来源

1. 飞书多维表格 `IVlxbfPwqa9cjPsNzhucpS3rnPH` → 企业基础信息、阶段、视频数、播放量、账号数等
2. fcloud API → 视频投放状态（pubTime 判断）
3. 标准 SKU 节点定义 → 决定哪些节点展示、节点命名

## 截图

```python
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={"width": 375, "height": 800}, device_scale_factor=3)
    page.goto("file:///path.html", wait_until="networkidle")
    page.evaluate("document.fonts.ready")
    page.wait_for_timeout(2000)
    h = page.evaluate("document.body.scrollHeight")
    page.set_viewport_size({"width": 375, "height": h + 20})
    page.screenshot(path="/output.png", full_page=True)
    browser.close()
```

## 工作流程

1. 拉飞书数据 → 获取企业基础信息 + 阶段 + 关键指标
2. 对照标准 SKU 节点确定当前阶段有哪些节点
3. 调 fcloud → 判断投放状态
4. 按 v3 架构生成 HTML（当前置顶 → 历史沉底 → 未来极淡）
5. Playwright 截图
6. 变更检测：与快照 diff → 有变化才发图
