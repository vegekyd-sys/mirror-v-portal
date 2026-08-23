---
name: "aochuang-leads"
description: "奥创线索客户画像报告：线索质量分析+API公司匹配+CSM行动建议。设计遵循report-web。"
---

# 奥创线索客户画像报告

> 客户线索质量分析 + API 公司匹配 + CSM 行动建议。
>
> 页面设计/构建/部署遵循 `report-web` skill 的设计系统和工作流，本 skill 只定义线索报告独有的分析逻辑和数据结构。

## 触发条件

- "XX企业的线索报告 / 线索画像"
- "分析一下XX的线索质量"
- "天易成最近有哪些线索"

## 数据来源

### 飞书线索表
- Base token：`IVlxbfPwqa9cjPsNzhucpS3rnPH`
- 线索表 tblpHmAKnXfNSRjJ：姓名、公司名、国家、来源campaign、创建时间
- 查询方式：`lark-cli base +record-search --search-field "辅助-公司名称" --keyword "企业名" --as user`

### 米奥贸易 API（公司匹配）
- 对线索填写的公司名做模糊匹配
- 匹配结果：命中公司名 / 未命中 / 行业不相关

## 分析框架

### 线索质量评级
| 评级 | 条件 |
|------|------|
| 🟢 高 | 公司名真实 + API匹配命中 + 行业相关 |
| 🟡 中 | 公司名真实 或 API模糊匹配 + 可能相关 |
| 🔴 低 | 乱填/无效 + API未命中 + 行业不符 |

### 逐条分析维度
- 姓名、表单公司名、API匹配结果
- 国家、行业相关性判断
- 每条给出 CSM 跟进建议

### 总量统计
- 线索总数
- API命中/未命中比例
- 高质量/中/低分布
- 值得跟进的数量

## 报告结构

### 线索质量总览（4格统计卡）
- 线索总数 / API模糊匹配 / API未命中 / 高质量线索

### 逐条分析表
| # | 姓名 | 表单公司名 | API匹配 | 国家 | 评级 | 建议 |
|---|------|-----------|---------|------|------|------|

### CSM 建议
- 哪些线索值得跟进（具体名字+理由）
- 哪些不建议联系（原因）
- 根源问题（如表单缺少校验）
- 改进建议

## 数据模型

```ts
interface Lead {
  name: string;
  company: string;       // 表单原始填写的公司名
  api: string;           // API匹配结果
  country: string;
  quality: '高' | '中' | '低';
  note: string;          // 跟进建议
}
```

## 页面构建

遵循 `report-web` skill 的设计系统。关键信息：
- 页面路径：`/aochuang/YYYY-MM-DD-企业名-leads` 或 `/aochuang/YYYY-MM-DD-leads-demo`
- 参考实现：`report/app/aochuang/2026-07-09-tyc-leads/page.tsx`
- 暗色主题 #0f172a，紫色高亮 #818cf8
- 数据通常较少（5-20条线索），适合表格+卡片混合布局

## 工作流程

1. **查询线索表**：`lark-cli base +record-search` 按企业名搜索
2. **API匹配**：对每条线索公司名调用米奥贸易API
3. **逐条评级**：按质量评级标准判断
4. **生成报告**：创建 `page.tsx`，遵循 report-web 设计系统
5. **构建部署**：参考 report-web 流程
