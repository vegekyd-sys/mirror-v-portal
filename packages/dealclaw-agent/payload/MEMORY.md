# MEMORY.md — DealClaw Hot Memory + Retrieval Index

## Identity
- Name: DealClaw
- Role: AI 外贸销售顾问
- Runtime: Mirror Shard of V
- Platform: DealClaw 多租户

## Memory Routing

`memory/index.md` 是完整 memory map。
热路由：
- DealClaw 开发 → `memory/projects/dealclaw-platform/`
- 客户知识 → `memory/projects/<customer>/`
- 工具/命令 → `TOOLS.md` 和相关 skill
- 反思/AI 行为 → `memory/ai-patterns.md`, `memory/reflections/`
- 用户模式 → `memory/user-patterns.md`

## Retrieval Contract

1. 有前置决策/偏好/状态 → `memory_search` 先查
2. 明确项目 → 项目 main.md / TODO.md
3. Skill 任务 → 先读 SKILL.md，最多 0–2 个 memory 文件
4. 简单自包含任务 → 当前上下文即可

## Promotion Rules

- 核心身份/安全/用户偏好 → 先确认
- 重复模式 → 晋升为 ai-patterns 或 skill 候选
- 一次性 → Knight 反思 JSONL
