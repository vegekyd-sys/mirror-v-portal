---
name: "monthly-service-review-card"
description: "月度服务复盘卡出图：CSM提到月度复盘即触发，聊天提供内容后生成看板型卡片"
---

# 月度服务复盘卡出图规则

## 触发时机
CSM 在聊天中提及"月度复盘""月度服务同步""这个月做了哪些事"等关键词时，V 主动响应并引导 CSM 提供卡片内容。

## 先读规范
出图前先读取：
- `memory/projects/service-perception-cards/design-rules.md`（看板型部分）
- `memory/projects/service-perception-cards/copywriting-templates.md`（第 9 节）

## Base 表对应
- 服务节点：`月度服务同步`
- 卡片类型：`看板型`
- 触发方式：不主动触发，CSM 询问时生成
- 对应表：`服务节点表` 第 9 行

## 设计规范
- 卡片尺寸: 804×1748px
- hero: 3:5 比例（makaron edit 生成），贴顶展示，`background: top center/100% auto`，下半纯黑底 #02040b
- 蒙版: top=880px, height=470px, 渐变 rgba(2,4,11,0) 0% → rgba(2,4,11,.40) 40% → rgba(2,4,11,1) 100%
- 页面标题: 64px, font-weight:900, top=930px
- 分割线: top=1050px, 左右各留100px
- 双栏: top=1090px, left=80px, right=56px, gap=44px
- 列标题: 36px, font-weight:900, 不加下划线
- 时间线日期+正文: 22px
- 计划条目: 24px, ▸ 前缀

## 内容获取流程
1. CSM 提出月度复盘需求
2. V 询问：企业名称、本阶段主要进展（日期+事件 对）、下一阶段计划（条目列表）
3. CSM 在聊天窗口直接提供内容（不填表）
4. V 确认内容无误后出卡
5. 成品图发给 CSM，同时回填任务表

## 出图流程
1. 向 CSM 确认企业名称、日期事件列表、计划条目
2. 用 makaron edit 生成 hero（蓝紫主调、3:5 竖版、主题贴合月度进展回顾）
3. 套看板型版式（页面标题 + 双栏 + 遮罩 0→40→100）
4. 在 Chrome + Playwright 渲染成品卡
5. QC：hero 是否 3:5 竖版？遮罩是否 0→40→100？文字是否来自 CSM 确认内容？
