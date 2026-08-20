---
name: "buyer-match-query"
description: "买家匹配定时推送：每天 11:00 读取企业买家画像的产品 + 展会国，调用 agent.datathink.com 异步接口匹配买家并推送到群。无关键词即时触发。"
---

# Buyer Match 定时推送

> 定时任务：每天上午 11:00，读企业「买家画像的产品线」+「展会国」，调展商-买家匹配服务，把匹配的潜在买家推送到群。

## 触发机制（定时任务，无关键词触发）

- **每天 11:00（Asia/Shanghai）由 host scheduler 触发**，每群独立执行。
- **已删除关键词即时触发**：用户说「找买家 / 匹配买家」等不再走本 skill，走 find-buyers 三步链。
- 输入来源（不再从用户当句消息取）：
  - `coreProduct`（产品词）：从企业买家画像的产品线读取（每条产品线一个任务）
  - `targetCountry`（目标国家）：**展会国**（用户交互时确认，存于企业绑定 / 参展订单）

## 输入读取

- **产品**：从企业买家画像读取产品线（buyer-profile 分组后的产品线，或知识库 profile.products）。
- **国家**：展会国（用户交互时告知并确认的国家；多场展会则按展会逐个国家）。
- 每个「产品 × 展会国」组合提交一个 match-buyers 任务，按 matchScore 合并去重后推送。

## 接口信息（只读，已实测）

| 项 | 值 |
|----|----|
| 域名 | http://agent.datathink.com（禁止 SSH 22，已封） |
| 鉴权 | Header `Authorization: APPCODE ${SELECTION_APPCODE}` |
| 提交 | POST /api/agent/supplier/match-buyers（coreProduct + targetCountry + 可选 maxResults 1-50 默认20、preRegistYear） |
| 查状态 | GET /api/agent/supplier/match-tasks/{taskId}（PENDING → PROCESSING → COMPLETED/FAILED） |
| 查结果 | GET /api/agent/supplier/match-tasks/{taskId}/results |

## Workflow

1. 读企业绑定：产品线（买家画像）+ 展会国。
2. 每个「产品 × 国家」提交 match-buyers → 取 taskId。
3. 轮询：每 30 秒一次，直到 COMPLETED/FAILED；超 2 分钟记 taskId，10 分钟后再查，不无限等待。
4. 查结果，按 matchScore 降序合并去重。
5. **打分阈值过滤**：只保留 matchScore ≥ 60 的买家；< 60 的丢弃。
6. **落库**：过滤后的买家先 `sync_leads_to_pool` 落企业线索池（来源=买家推荐，company_id=企业键），基础信息全落，联系人字段初始不写（解锁才写，同 find-buyers）。
7. 全部 < 60 → 不落库、不推送（静默记录，不打扰）。
8. 推送到该企业绑定的群（群 ID 由绑定配置；每轮推 ≤5 条，按 matchScore 取 top）。
9. 固定 6 字段：公司名、国家、公司简介（空标「（空）」）、官网（空标「暂无」）、匹配理由、匹配分数；外层附 taskId/status/totalMatched。

## 关键规则

- **打分阈值 60**：只推 matchScore ≥ 60 的买家，< 60 一律不推。
- **落库规则同 find-buyers**：基础信息全落（公司名/官网/公司简介/国家/买家类型/匹配产品/推荐理由），联系人字段初始不写（解锁才写）。落库用共享 `sync_leads_to_pool`，不重复写落库代码。
- totalMatched=0 或全部 < 60 → 不落库、不推送，静默记录。
- FAILED → 记录 errorMsg，不编造结果。
- 只读，不改任何数据；失败如实报告。
- 每个「产品 × 国家」任务隔离，不跨企业、不跨群。
