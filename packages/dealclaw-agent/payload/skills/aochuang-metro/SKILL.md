---
name: "aochuang-metro"
description: "奥创服务进度地铁图：企业服务阶段跟踪+关键节点触达。列表页+企业详情页。设计遵循report-web。"
---

# 奥创服务进度地铁图

> 企业服务进度可视化，按阶段跟踪，关键节点触达。
> 
> 页面设计/构建/部署遵循 `report-web` skill 的设计系统和工作流，本 skill 只定义地铁图独有的数据模型和页面结构。

## 触发条件

- "地铁图 / 服务进度 / XX企业到哪个阶段了"
- "更新地铁图 / 加一家企业"
- "生成XX的地铁图详情页"

## 后台任务执行策略（必须）

本 skill 属于 heavy skill。涉及飞书多维表/FCloud 数据采集、页面构建、浏览器/部署验证，可能拖慢 IM 入口。

当从飞书/Lark/群聊/IM 等交互入口触发，且任务预计超过 10 秒、需要构建/部署/浏览器验证、或需要批量查询数据时：

1. **父会话只做控制面**：确认需求、检查必要输入、创建后台任务、快速回复用户。
2. **不要在父会话直接执行完整地铁图生成/构建/部署**，避免占住 Feishu Lane。
3. **使用 OpenClaw 官方后台任务方案**：优先通过 `sessions_spawn` 启动 `mode="run"` 的 subagent worker。该 subagent run 会进入官方 background task ledger，可通过 `openclaw tasks` 追踪/取消/审计。
4. `sessions_spawn` 默认使用隔离上下文；只有子任务确实需要当前完整聊天记录时才使用 fork context。
5. 父会话提交后台任务后应立即结束当前重任务链路，并回复：已提交后台任务、任务名/范围、预计耗时、完成后由父会话收到 completion wake 后整理回写。
6. 父会话不得用轮询循环等待后台任务完成；依赖 OpenClaw task completion / heartbeat wake 唤醒父会话，再由父会话发送最终用户可见结果。
7. 子 worker 不应直接向群里发送半成品或最终消息；它负责输出结构化结果、artifact 路径、验证证据和 blocker，父会话负责最终交付。

建议提交形态：

```ts
sessions_spawn({
  taskName: "aochuang-metro-<company-or-batch>-<yyyymmdd-hhmm>",
  mode: "run",
  cleanup: "keep",
  task: `
你是奥创地铁图后台 worker。请在隔离后台任务中完成：
- 目标：<生成/更新哪些企业或列表页>
- 数据来源：飞书客户运营服务表 + FCloud
- 输出：改动摘要、页面/部署链接、验证结果、失败原因（如有）
- 约束：不要泄露凭证；不要直接向用户发送消息；失败要明确报告 blocker
- 验证：至少完成构建/页面检查/关键数据抽查后再报告成功
`
})
```

如果用户只是询问地铁图规则、字段含义、阶段定义，允许同步回答；只要进入数据采集/构建/部署/浏览器验证，就必须后台化。

## 数据来源

### 飞书客户运营服务表
- Base token：`IVlxbfPwqa9cjPsNzhucpS3rnPH`
- 主表 tblbmcjTL3aD1EUG：企业名、合同、CSM、阶段、视频数、播放量、线索、账号、月度同步等
- TK账号 tblFkptD0HRi4TvG：播放/粉丝/视频数
- 交付权益 tblP0D9KkJTxkwUG：目标值

### FCloud
- 活跃号计数、播放量汇总

## 服务阶段体系

| 阶段 | 名称 | 颜色 | 说明 |
|------|------|------|------|
| 1 | 启动期 | #7C3AED | 合同签署→素材收集→首次拍摄 |
| 2 | 蓄势期 | #8B5CF6 | 账号搭建→内容常规发布→数据积累 |
| 3 | 冲刺期 | #EC4899 | 优化投放→线索转化→目标达成 |
| 4 | 价值期 | #F97316 | 续约评估→案例沉淀→更深合作 |

## 页面结构

### 列表页 (`/aochuang/metro/page.tsx`)
- Hero：标题 + 企业数/临期数/冲刺期数统计
- 企业卡片列表，每张卡片包含：
  - 企业名 + 到期天数（红色过期/黄色临期/灰色正常）
  - 版本标签 + 阶段标签 + CSM
  - 服务进度条（doneNodes/totalNodes）
  - 关键指标（视频数/播放量/账号数等）

### 企业详情页 (`/aochuang/metro/[company]/page.tsx`)
- 服务阶段时间轴（各阶段节点+完成状态）
- 关键指标卡片
- 待办/风险项

## 数据模型

```ts
interface MetroCompany {
  slug: string;
  name: string;
  version: string;
  stage: number;        // 1-4
  stageLabel: string;   // 启动期/蓄势期/冲刺期/价值期
  startDate: string;
  endDate: string;
  daysLeft: number;
  doneNodes: number;
  totalNodes: number;
  keyMetrics: { label: string; current: number; total: number; unit: string }[];
  csm: string;
}
```

## 页面构建

遵循 `report-web` skill 的设计系统。关键信息：
- 页面路径：`/aochuang/metro/`（列表）、`/aochuang/metro/[slub]`（详情）
- 参考实现：`report/app/aochuang/metro/page.tsx`
- 暗色主题 `#10102B`，紫色系高亮
- 响应式适配（列表卡片在移动端全宽堆叠）

## 工作流程

1. **数据采集**：查飞书客户运营服务表 + FCloud
2. **阶段判级**：根据合同周期/节点完成情况判断服务阶段
3. **更新列表页**：追加/修改 `metro/page.tsx` 中的数据
4. **创建详情页**（可选）：`metro/[slub]/page.tsx`
5. **构建部署**：参考 report-web 流程
