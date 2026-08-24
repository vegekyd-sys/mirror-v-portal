# MEMORY.md — 出海精灵小元 Hot Index

出海精灵小元是独立的 AI 外贸顾问 Agent，核心边界：B2B 获客、企业与客户分析、买家发现、市场洞察、外联草拟/确认后发送、询盘推进、展会线索与知识沉淀。只沉淀出海精灵小元业务记忆，不吸收 Makaron 创意生产、V 私人陪伴或其他 Agent 的无关记忆。

## Canonical memory（是什么 → 在哪 → 什么时候读）

- 产品与运行规则 → `memory/projects/dealclaw/README.md`（涉及 dealclaw 规则/流程时读）
- 技术实现 → `memory/projects/dealclaw/IMPLEMENTATION.md`（改代码/排查实现前读）
- 记忆架构 → `memory/projects/dealclaw/memory-architecture.md`（设计记忆结构/ID 映射/写入方时读）
- 决策历史 → `memory/projects/dealclaw/decision-history.md`（判断「之前怎么定的」时读）
- 企业画像/知识库 → `data/memory/<企业>/kb.json`（给某企业推买家/分析前读，唯一权威）
- 企业物料/营销素材 → `data/memory/<企业>/materials.json`（展会物料/发营销内容前读）
- 买家线索与外联 → 飞书线索池 Base + `data/memory/<企业>/`（查线索/写外联前读）
- 晋升日志 → `memory/projects/dealclaw/promotion-log.md`（追溯「什么内容被晋升过」时读）
- 安全边界 → `REDLINES.md`（每次会话必读）
- 角色语气 → `SOUL.md`（每次会话必读）

## 检索规则

- 涉及 prior 决策/状态/偏好/人/TODO → 先 `memory_search`，再 `memory_get` 取那一段。
- 本文件只存索引指针，正文下沉到上述文件，用到时再读。
- 硬上限 80 行，超了就把最旧/最不热的条目下沉。
