---
name: "presales-planning-doc"
description: "v5.3·修正📸格式+callout结构：对齐杰尔古格基准文档"
updated: "2026-07-21"
changelog: |
  v5.3 (2026-07-21) - 用户要求沉淀：
    - 📸 截图建议：不用callout包裹，直接放表格，内容固定为4标准项（诊断核心痛点/市场洞察/同行情况/账号布局）
    - callout格式：`<callout emoji="💬">` + 内部 `>` blockquote（不用 `<blockquote>` 标签）
    - 强制读取基准文档 JfondEgKvovrl2xlXicc6bfInXb 作为唯一模板
---

# 售前策划案 Skill — v5.3

> **基准文档**：https://versa-ai.feishu.cn/docx/JfondEgKvovrl2xlXicc6bfInXb（杰尔古格标准版）
> **每次生成方案前，必须先读取基准文档确认最新格式**：`lark-cli docs +fetch --doc JfondEgKvovrl2xlXicc6bfInXb --doc-format markdown --as bot`
> 用途：基于客户调研表生成7章+5气泡TikTok品牌战略合作方案

## 7章结构

| 章 | 标题 | 核心内容 |
|----|------|----------|
| §1 | 客户前沿诊断&达成目标 | 能力底座表 / 核心痛点 / 五种语言框架 / 期望目标 |
| §2 | 市场洞察 | 目标市场客户画像 / 平台机会&用户数据 / 4层竞品分析 |
| §3 | 趋势分析 | 三大不可逆趋势 / 4种获客方式对比 / 社媒+展会O2O联动 |
| §4 | 为什么选奥创 | 奥创6好 / 已验证案例 / 自建vs外包vs奥创对比 |
| §5 | 客户交付后具体解决方案 | 账号布局 / 内容输出(6类×目标条数) / 推广投流(P0/P1/P2) / 线索承接(七步漏斗+S/A/B/C) |
| §6 | 具体陪跑计划&验收保障 | 三阶段路线图 / 交付清单 / 首月KPI / 服务边界矩阵 / 兜底机制 |
| §7 | 为什么现在报名 | "三个不等"叙事 / 三列对比表 / 方案选择(Pro 6月/9月) |

## 📸 1. 4张截图建议（⚠️ 不用callout包裹）

**这是普通表格，不是callout气泡**。内容永远固定为以下4行，不随客户变化：

```markdown
📸 1. 4张截图建议

微信发给客户时按以下4张截图：

| 序号 | 截图内容 | 截取位置 |
|------|----------|----------|
| ① | 诊断核心痛点 | §1 能力底座表 + 核心痛点4条 |
| ② | 市场洞察 | §2 目标市场客户画像 + 平台机会 |
| ③ | 同行情况 | §2④ 4层竞品分析表 |
| ④ | 账号布局 | §5① 6账号矩阵表 |
```

## 5个销售工具模块（callout气泡格式）

以下每个模块都使用：`## emoji 序号. 标题` + `<callout emoji="...">` + 内部 `>` blockquote。

### 💬 2. 配套邀约话术

```markdown
## 💬 2. 配套邀约话术

<callout emoji="💬">
> （邀约话术内容，根据客户定制）
</callout>
```

### 💰 3. 给老板的三句话

```markdown
## 💰 3. 给老板的三句话

<callout emoji="💬">
> 1. **（第一句）**
>
> 2. **（第二句）**
>
> 3. **（第三句）**
</callout>
```

### 📋 4. 给外贸经理的三句话

```markdown
## 📋 4. 给外贸经理的三句话

<callout emoji="💬">
> 1. **（第一句）**
>
> 2. **（第二句）**
>
> 3. **（第三句）**
</callout>
```

### ✅ 5. 方案讲完后小结

```markdown
## ✅ 5. 方案讲完后小结

<callout emoji="💬">
> （小结内容，根据客户定制）
</callout>
```

### ❓ 6. FAQ应对话术

```markdown
## ❓ 6. FAQ应对话术

<callout emoji="💬">
> **Q: （问题1）**
> A: （回答1）
>
> **Q: （问题2）**
> A: （回答2）
>
> **Q: （问题3）**
> A: （回答3）
>
> **Q: （问题4）**
> A: （回答4）
</callout>
```

## 执行规则

1. **必须先读基准文档**：每次生成前执行 `lark-cli docs +fetch --doc JfondEgKvovrl2xlXicc6bfInXb --doc-format markdown --as bot`
2. **📸截图建议**：不包callout，直接放表格，4行内容永远固定
3. **5个callout**：`## emoji 序号. 标题` + `<callout emoji="...">` + 内部 `>` blockquote
4. 主推Pro 6月/9月双版本
5. 标注"不构成交付承诺"
6. h1/h2/h3 + table + ul/ol
