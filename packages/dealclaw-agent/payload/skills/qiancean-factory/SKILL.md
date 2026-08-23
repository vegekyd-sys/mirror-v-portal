---
name: "qiancean-factory"
description: "快速生成制造业客户的前策案报告（线上资产审计+竞品对标+TikTok出海案例），输出Word文档。"
---

# 前策案制作 Skill

## Background task execution policy

This skill is background-worthy for real front-planning report production because it performs parallel web research, competitor/TikTok case discovery, document generation, and file delivery. These branches can hold the Feishu/Lark lane and depend on many external searches.

When invoked from an IM/group/chat surface for a real customer report:

1. **Parent session is control-plane only**: validate customer name, product/category, authorization, desired output format, submit a background task, and reply quickly.
2. **Do not run the full research/report-generation workflow in the parent session.**
3. **Use OpenClaw official background task primitives**: spawn a `sessions_spawn` subagent with `mode="run"`. The run is tracked by the official background task ledger (`openclaw tasks`) and can be inspected/cancelled/audited there.
4. Default to isolated child context; fork only when the child genuinely needs current transcript context.
5. Parent session must not poll-loop waiting for searches or document generation. Rely on OpenClaw task completion / heartbeat wake to notify the parent session, then the parent sends the final user-visible result/file.
6. Child worker must write durable artifacts: research notes with source URLs, competitor/case list, generated doc path, logs, and blockers.
7. Child worker should not message the chat directly; it returns structured results/artifact paths for the parent session to deliver.
8. A quick feasibility question or outline can run synchronously; real multi-source report production should be backgrounded.

Recommended parent submission shape:

```ts
sessions_spawn({
  taskName: "qiancean-factory-<customer>-<yyyymmdd-hhmm>",
  mode: "run",
  cleanup: "keep",
  task: `
You are a manufacturing front-planning report background worker.
Objective: <generate report for customer>
Inputs: customer=<...>, category=<...>, output=<docx/link>
Output contract:
- final status: completed/failed/blocked
- source-backed research summary
- artifact paths: notes, source list, generated document
- clear blocker and next step if failed
- do not send user-visible chat messages directly; return results for the parent session to deliver
`
})
```

## 触发条件
当国琳（<OPEN_ID>）或其他授权用户在飞书群中发送以"我们现在正在为XXX进行前策案的任务"开头的消息时，自动按此skill执行。

## 核心流程

### 1. 信息收集（并行搜索）
收到客户名称后，同时执行以下搜索：

**工商信息搜索：**
- 搜索 `"客户名称" 英文名 企查查 工商 主营`（获取工商英文名+注册资本+法人+成立时间）
- 搜索 `客户英文名的品牌关键词 + Alibaba social media manufacturer`（获取线上平台和社媒账号）

**竞品和TK案例搜索：**
- 搜索 `[品类关键词] + TikTok B2B factory manufacturer followers China`
- 搜索 `[品类关键词] + competitor + social media`

### 2. 平台匹配度检查
对以下平台逐一确认是否匹配：
- Google收录
- 独立官网/品牌站
- Alibaba国际站
- Made-in-China
- LinkedIn公司页
- Facebook主页
- Instagram账号
- YouTube频道
- TikTok账号

每个平台标注匹配状态：✅/⚠️/❌

### 3. 平台数据分析（针对已匹配平台）
- 平台优势：为什么该平台适合该客户的品类
- 流量喜好：该平台上什么内容获得自然推流
- 建设性建议：3-5条可执行的具体操作
- 仅对客户已匹配的平台做深度分析

### 4. 同行竞品对标
- 选取4-7家竞品（国际品牌+国内龙头+中小工厂三个层级）
- 每个竞品包含：名称/定位/线上布局/核心链接/分析与客户可学之处
- 结尾给出竞品对标总结+客户差异化机会

### 5. TikTok出海案例参考
- 选取2-5个同品类TK案例账号
- 每个案例：账号名/定位/粉丝量和表现/内容分析/对客户的参考价值
- 结尾给客户专属TK内容策略建议（内容方向/发布频率/转化链路/标签策略）

### 6. 生成Word文档
使用python-docx生成结构化文档，五个章节：
1. 客户基础信息
2. 各平台搜索结果+平台数据分析与建设性建议
3. 同行竞品对标
4. TikTok工厂出海案例参考
5. 前策案总结与行动建议（含线上资产评分卡+三阶段行动路线图）

### 7. 发送文件
用 `message + action=send + filePath` 发送Word文档到当前飞书群。

## 效率优化规则
- 批量场景下每个客户回复格式精简："X份。"+"NO_REPLY"
- 每个文档生成后附带简短摘要消息发送
- 对于公网信息极少的客户，标注⚠️并在文档中说明，仍然输出基础框架
- 对于非制造型/非出口型企业（如本地服务类），调整数字化建议方向
