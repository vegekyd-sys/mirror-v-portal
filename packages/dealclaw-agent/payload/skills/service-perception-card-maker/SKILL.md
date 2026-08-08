---
name: "service-perception-card-maker"
description: "服务感知卡出图：9:16竖版+hero+双模式+节点文案+QC+渲染"
---

# 服务感知卡出图 Skill

## 触发条件
在服务感知卡项目中，需要为用户生成/渲染服务感知卡时触发。

## 前置条件
- 已确定节点、卡片类型（文字型/数字型）、企业名称、hero 图
- 英雄图已通过 Makaron 生成并通过 5 项 QC

## 卡片类型规则（重要）

### 7 个 Pro 节点类型
| 节点 | 卡片类型 | 大字 | 小字 |
|------|---------|------|------|
| 需求推进会 | 文字型 | 需求共创 | 方案启航 |
| 拍摄服务 | 数字型 | {次数} | 拍摄服务(次) |
| 素材收集 | 数字型 | 100% | 素材全量入库 |
| DEMO进度 | 数字型 | 70% | DEMO视频进度 |
| 账号开通 | 文字型 | 账号开通 | {投放地区}相关 |
| 视频出海 | 文字型 | 澎湃出海 | 跨越国界 赋能全球 |
| 感恩卡 | 文字型 | 感恩同行 | 共赴全球增长新旅程 |

### Pro+/Max 扩展节点
- 第二次拍摄服务 → 数字型，大字:2
- 第三次拍摄服务 → 数字型，大字:3
- 素材收集(复用) → 数字型，大字:100%
- 感恩卡(复用) → 文字型，大字/小字同 Pro

## HTML 渲染规则（不允许手动临时修正）

### 文字型卡片
```
<div class="metric-text">大字</div><div class="sub-text">小字</div>
```
- metric-text: 104px font-weight:900
- sub-text: 30px font-weight:400
- ⚠️ 严禁使用 .metric 或 .sub-title（那是数字型专用）

### 数字型卡片
```
<div class="metric">大字</div><div class="sub-title">小字</div>
```
- metric: 182px DIN Pro
- sub-title: 42px font-weight:900

### 渲染脚本必须同时支持两种模式
不能只处理数字型再手动修文字型。必须检测 mode 参数切换。

## ⛔ 第一硬规则：群里只出现成品卡，不出现 hero 裸图

**感知卡出图时，不允许使用 Makaron 服务卡工作流（visible-parent-flow.cjs / restart-task-worker.cjs）。**

原因：Makaron 卡跑器会自动把所有中间产物（含 hero 图）发到群里，导致裸图泄漏。

**正确做法：**
- hero 图用 `makaron edit` CLI 命令生成（会直接输出到本地文件，不会自动出现在群里）
- ⚠️ 不能用 `image_generate` 工具——它会在会话中自动显示生成的图片
- hero 路径存到 `work/service-card-demo/makaron-assets/`
- hero **绝不**通过 message.send 发到群，也不能让 image_generate 自动挂到回复里
- 只有 Playwright 截图合成的成品卡才发到群

## 出图流程
1. 用 `image_generate` 或 `makaron edit` 生成 hero → QC 5 项（蓝紫调/主视觉位置/上下渐变/无文字无数字/无硬边）
2. 下载 hero 到 `work/service-card-demo/makaron-assets/`（hero 留在本地，不发送）
3. 渲染 HTML：根据节点类型选择 metric-text (文字型) 或 metric (数字型)
4. Playwright 截图 → **输出到 work/service-card-demo/ 目录**
5. 发群前验证：检查文件大小 > 500KB（hero 已加载）、检查 HTML class 正确

## 发图到群
- **只发最终合成后的成品卡**，用 message.send + attachments 直接发
- 同时上传到触发表的成品图字段
- **不发 hero 裸图、不发中间产物、不单独发 Makaron 原图**

## 严禁事项
- ❌ 不要在渲染后再手动改 HTML class
- ❌ 不要用数字型的 182px 字号渲染文字型内容
- ❌ 不要把截图输出到 workspace 根目录
- ❌ 不要在发群前不检查文件大小
- ❌ **不要用 Makaron 服务卡工作流（visible-parent-flow/restart-task-worker）来生成感知卡的 hero**
- ❌ **不要把 hero 裸图发到群里**
