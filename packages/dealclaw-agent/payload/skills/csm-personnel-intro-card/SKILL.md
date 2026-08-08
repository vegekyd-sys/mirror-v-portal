---
name: "csm-personnel-intro-card"
description: "飞书表格→CSM人员简介卡(402px),HTML+chrome截图,钻石/铂金/黄金三级,精确颜色对齐视觉稿"
---

# CSM Personnel Intro Card

从飞书多维表格「服务人员简介-模板」生成 CSM 服务人员简介竖屏卡（402px 宽 PNG）。

## 数据源

**Base:** `EI26bg9n3aRph9sWvqBcZmN8nNe` | **表:** `tblavzBavnktkoyh`（人员信息）

### 字段映射

| 字段 | 格式 | 渲染规则 |
|------|------|----------|
| 人员 | text | 姓名 |
| 人员级别 | select | 钻石→"我是您的星擎战略增长专家"，其他→"我是您的海外社媒运营专家" |
| 一句话介绍 | text | 放在服务卡上方 |
| 职业照 | attachment | 下载→正方形裁剪→288×288圆形PNG |
| 技能1/2/3 | `标题\n描述` | \n分割，段落一=4字标题，其余=描述 |
| 服务1/2/3 | 短标题 或 `标题\n\n描述` | \n\n分割；无分隔符则整段为标题 |

## 设计规范

### 颜色表（来自视觉稿精确值）

| 区域 | 颜色 |
|------|------|
| 暗色顶栏渐变 | #2A2522 → #1F1B1A |
| V watermark | #C4A68F @30% |
| 技能标签 | #8F6641 |
| 技能描述 | rgba(92,70,51,0.65) |
| 竖线分隔 | #D4C8B1, 1px |
| 浅色内容区 | #F9F3EB 实色 |
| 服务卡编号 | #D9C9B4 @75% |
| 金色标题渐变 | #D4B88C → #F2DFC8 → #E5CA9E |

### 卡片结构（上→下）

1. **暗色顶栏**（~344px）：V watermark + badge logo + 圆形头像居中 + 金色标题 + 人员标签 + 姓名
2. **技能三列**（#F9F3EB底）：icon图片 + 4字标签 + 描述，竖线分隔
3. **分割线** 1px #D4C8B1
4. **浅色内容区**（#F9F3EB）：一句话介绍 + 3张服务卡

### 不允许

- ❌ 手机状态栏（时间/信号/电池）
- ❌ 联系CSM按钮
- ❌ 底部多余空白
- ❌ 技能描述加粗
- ❌ 头像变形

## 截图

```bash
google-chrome-stable --headless --disable-gpu --no-sandbox \
  --force-device-scale-factor=3 \
  --window-size=402,830 --screenshot=output.png \
  "http://localhost:PORT/card.html"
```

3x scale 保证清晰度；viewport 高度 830px 紧贴内容。

## 工作流

1. 解析人员名→查飞书表记录
2. 下载职业照→正方形裁剪→288×288圆形PNG
3. 解析技能字段（\n分割）
4. 解析服务字段（\n\n分割；无分隔符时整段为标题）
5. 填充模板→生成HTML
6. chrome-headless 3x截图→PNG
7. 发送截图给用户确认
