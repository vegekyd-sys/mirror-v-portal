---
name: "aochuang-review-report"
description: "奥创企业TikTok营销复盘报告：7章结构+分析框架+数据采集。设计遵循report-web。"
---

# 奥创企业 TikTok 营销复盘报告

> 完整流程：数据采集 → 分析 → 报告生成 → 页面构建部署
> 
> 设计系统遵循 `report-web` skill，本 skill 不重复定义排版/动效/响应式规范。

## 触发条件

当需要为奥创客户企业生成 TikTok 营销复盘报告时使用。典型场景：
- "给XX企业做一份复盘报告"
- "XX的review页面更新一下"
- 基于企业最新的 TK 账号数据生成分析报告

## Background task execution policy

This skill has background-worthy branches when it collects Feishu/FCloud data, computes account metrics, generates report pages, builds, deploys, or validates a live report. These branches can hold the Feishu/Lark lane and may include external API calls, build/deploy pipelines, and verification.

When invoked from an IM/group/chat surface for real report generation or update:

1. **Parent session is control-plane only**: validate company/date/version requirements, confirm whether deployment is authorized, submit a background task, and reply quickly.
2. **Do not run the full data collection/report build/deploy workflow in the parent session.**
3. **Use OpenClaw official background task primitives**: spawn a `sessions_spawn` subagent with `mode="run"`. The run is tracked by the official background task ledger (`openclaw tasks`) and can be inspected/cancelled/audited there.
4. Default to isolated child context; fork only when the child genuinely needs current transcript context.
5. Parent session must not poll-loop waiting for build/deploy/verification. Rely on OpenClaw task completion / heartbeat wake to notify the parent session, then the parent sends the final user-visible result.
6. Child worker must write durable artifacts: data object, changed file paths, build/deploy output, verification results, screenshots if useful, and blockers.
7. Child worker should not message the chat directly; it returns structured results/artifact paths for the parent session to deliver.
8. Explanation of report structure or small data lookups may run synchronously; real generation/build/deploy should be backgrounded.

Recommended parent submission shape:

```ts
sessions_spawn({
  taskName: "aochuang-review-<company>-<yyyymmdd-hhmm>",
  mode: "run",
  cleanup: "keep",
  task: `
You are an Aochuang review-report background worker.
Objective: <generate/update report for company>
Inputs: company=<...>, dateRange=<...>, deployAllowed=<yes/no>
Output contract:
- final status: completed/failed/blocked
- source data summary and calculations
- changed files and report URL if deployed
- build/HTTP/content verification evidence
- clear blocker and next step if failed
- do not send user-visible chat messages directly; return results for the parent session to deliver
`
})
```

## 数据来源

### 1. 飞书 TK 账号表（主要数据源）
- Base token：`IVlxbfPwqa9cjPsNzhucpS3rnPH`
- 主表：tblbmcjTL3aD1EUG（企业名/合同/CSM/视频数/播放量/线索/账号等）
- TK 账号表：tblFkptD0HRi4TvG（SourceID→fcloud映射、播放/粉丝/视频数）
- 交付权益：tblP0D9KkJTxkwUG（目标值）
- 查询方式：`lark-cli base +record-search --search-field "企业名称" --keyword "企业名" --as user`

### 2. FCloud 实时数据
- 提供账号级：作品数、粉丝数、播放量、点赞、评论、分享、status
- 匹配方式：`categoryName` 字段搜索企业全称（不是 `acctName`）
- 活跃号去重：只统计有作品(works>0)且 status=0 的账号
- 用于：账号健康度判级、互动转化漏斗计算

### 3. 合同/权益信息
- 交付目标：目标播放量、目标视频数、目标线索数
- 服务周期：起止日期、距到期天数
- CSM/运营/销售负责人

## 分析框架

### 账号健康度判级
| 级别 | 标识 | 判定标准 |
|------|------|----------|
| 高权重/正常 | ✅ | 播放>10万 或 粉丝>500，有增长趋势 |
| 待优化 | ⚠ | 播放1千-10万，策略需调整 |
| 需重点关注 | 🔴 | 播放<1千 或 粉丝<10，内容策略需重构 |
| 零作品闲置 | 🟣 | 作品=0，建议清理或启用 |

### 互动转化漏斗
```
播放量(100%) → 互动量(X%) → 粉丝转化(Y%) → 买家线索(Z%)
```
- 计算每层转化率和绝对值
- 定位漏斗断裂点

### 问题分类
1. **流量问题**：长尾号占比高、播放量不达标
2. **转化问题**：有流量无询盘、CTA缺失、漏斗断裂
3. **运营问题**：内容产能不足、素材重复、复盘机制缺失
4. **合同风险**：服务过期、闲置号未清理、目标缺口大

### 目标达成率
- 每项指标计算：实际值/目标值 = 达成率
- 超额标记绿色，不达标标记红色

## 报告结构（7章）

### 01 项目概况
- 合同编号、产品版本、项目周期
- 矩阵规模（活跃号+闲置号）、覆盖市场、语言
- CSM/运营/销售、拍摄/复盘次数
- 交付权益目标、项目里程碑时间线

### 02 核心指标与目标达成
- 4项核心KPI：播放量、互动率、视频发布、买家线索
- 每项显示：实际值 / 目标值 / 达成率
- 核心结论段落（2-3句话总结）

### 03 账号维度表现分析
- 矩阵表格：账号名、定位、作品数、粉丝、播放、互动、国家、状态
- 按播放量降序排列
- 健康度分类汇总卡片

### 04 内容与互动效能
- 爆款内容策略总结（3-4条）
- 互动转化漏斗（进度条可视化）
- 关键发现（如：线索转化断裂预警）

### 05 问题与挑战
- 2-4个核心问题卡片（图标 + 标题 + 描述）
- 从数据自动识别：低播放占比/互动率缺口/账号异常

### 06 下一步策略路线图
- 短期（1-2月）：紧急修复项
- 中期（3-6月）：能力建设项
- 长期（商业化）：目标达成项

### 07 亮点与总结
- 亮点卡片（正向发现）
- 3条总结：核心达成 + 最大瓶颈 + 下一步方向

## 页面构建与部署

遵循 `report-web` skill 的完整设计系统和工作流。关键信息：

- 页面路径：`/aochuang/review/YYYY-MM-DD-企业名-review`
- 导航页：`/aochuang/review/page.tsx`
- 参考实现：`report/app/aochuang/review/2026-07-09-junye-review/page.tsx`
- 参考实现：`report/app/aochuang/review/2026-07-09-tyc-review/page.tsx`
- 暗色主题，`useScrollReveal()` + `forwardRef` + anime.js onload 分离 hero 动画
- 部署：`npm run build` → `npx vercel deploy --prod`

## 数据模板

```ts
const data = {
  company: '企业全称',
  contract: '合同编号',
  version: '产品版本',
  period: '服务周期',
  csm: 'CSM', ops: '运营', sales: '销售',
  industry: '行业', region: '目标市场', lang: '语言',
  accounts: 账号数, videos: 视频总数, plays: 总播放, fans: 总粉丝,
  interactions: 总互动, engagementRate: '互动率%',
  leads: { delivered: 线索数, target: 目标线索 },
  targets: { plays: 目标播放, videos: 目标视频, leads: 目标线索 },
  accountList: [{ name, label, works, fans, views, likes, comments, shares, country, status }],
  issues: [{ title, desc, icon }],
  highlights: [{ title, desc, icon }],
  milestones: [{ date, text }],  // 可选
  dormantAccounts: ['账号名 (区域)'],  // 可选
};
```

## 工作流程

1. **数据采集**：查飞书 TK 账号表 + FCloud
2. **分析计算**：健康度判级、漏斗计算、目标达成率
3. **生成数据对象**：按数据模板整理
4. **创建页面**：参考实现 + 数据对象 → `page.tsx`（遵循 report-web 设计系统）
5. **更新导航**：追加 `/aochuang/review` 列表
6. **构建部署**：build → Vercel deploy（参考 report-web 流程）
7. **验证**：HTTP 200 + 关键内容检查
