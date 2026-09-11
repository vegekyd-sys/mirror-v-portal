# DealClaw Memory Index

> 小元的完整记忆地图。`MEMORY.md` 是热索引（每次加载），本文件是完整地图（按需检索）。

## 顶层

- `MEMORY.md` — 热索引 + 检索规则 + 晋升规则
- `memory/ai-patterns.md` — AI 行为规则（跨任务）
- `memory/user-patterns.md` — 已确认的用户偏好
- `memory/index.md` — 本文件

## 项目

- **DealClaw 业务** → `memory/projects/dealclaw/`
  - 规则/流程：`README.md`
  - 技术实现：`IMPLEMENTATION.md`
  - 记忆架构：`memory-architecture.md`
  - 决策历史：`decision-history.md`
  - 耐久事实：`promoted-facts.md`
  - 行业知识：`industry-knowledge.md`
  - 邮件打法：`email-playbook.md`
  - PRD：`PRD-v2.md`
  - 安全要求：`security-requirements.md`
  - 线索池字段：`lead-pool-fields.md`
  - CDP 接口契约：`cdp-api-contract.md`
  - 客户档案 Schema：`customer-dossier-schema.md`
  - 飞书格式：`feishu-standard-format.md`
  - 客户旅程：`user-journey.md`
  - 定价：`pricing.md`
  - 展后复盘接口图：`after-exhibition-review-interface-map.md`
  - 单租户推送重构：`single-tenant-push-redesign.md`
  - 初始数据映射：`init-data-mapping.md`
  - 子目录：`profiles/`、`preferences/`、`leads/`、`outreach/`、`email-templates/`、`case-studies/`、`exhibitions/`、`workflows/`、`cards/`、`channel-rules/`、`insights/`、`skill-acceptance/`
- **Nexus 平台** → `memory/projects/nexus/`

## 反思

- `memory/projects/dealclaw/reflections.jsonl` — 反思记录

## 企业数据（按企业隔离）

- 画像/知识库：`data/memory/<企业>/kb.json`
- 物料：`data/memory/<企业>/materials.json`
- 线索池：飞书 Base（+ `data/memory/<企业>/` 本地镜像）

## 检索规则

1. prior 决策/客户画像 → `memory_search` 先查
2. 明确客户 → 该客户 profile
3. Skill 任务 → 读具体 `SKILL.md`
