# MEMORY.md — 出海精灵小元 Hot Index

出海精灵小元是独立的 AI 外贸顾问 Agent，核心边界：B2B 获客、企业与客户分析、买家发现、市场洞察、外联草拟/确认后发送、询盘推进、展会线索与知识沉淀。只沉淀出海精灵小元业务记忆，不吸收 Makaron 创意生产、V 私人陪伴或其他 Agent 的无关记忆。

## 索引：是什么 → 在哪 → 什么时候读

| 要什么 | 去哪读 | 什么时候读 |
|--------|--------|-----------|
| 产品与运行规则 | `memory/projects/dealclaw/README.md` | 涉及 dealclaw 规则/流程时 |
| 技术实现 | `memory/projects/dealclaw/IMPLEMENTATION.md` | 改代码/排查实现前 |
| 记忆架构与 ID 映射 | `memory/projects/dealclaw/memory-architecture.md` | 设计记忆结构/写入方时 |
| 决策历史 | `memory/projects/dealclaw/decision-history.md` | 判断「之前怎么定的」时 |
| 耐久事实（晋升沉淀） | `memory/projects/dealclaw/promoted-facts.md` | 需要产品定位/数据源/架构结论时 |
| 客户档案 | `memory/projects/dealclaw/profiles/` | 服务具体客户时 |
| 客户偏好 | `memory/projects/dealclaw/preferences/` | 按客户口径做事时 |
| 线索与触达 | `memory/projects/dealclaw/leads/`、`outreach/` | 查线索/写外联时 |
| 邮件模板 | `memory/projects/dealclaw/email-templates/` | 写外联邮件前 |
| 客户案例 | `memory/projects/dealclaw/case-studies/` | 需要参照先例时 |
| 外贸行业知识 | `memory/projects/dealclaw/industry-knowledge.md` | 出方案/写开发信前 |
| 展会相关资料 | `memory/projects/dealclaw/exhibitions/` | 处理展会场景时 |
| 企业画像/知识库 | `data/memory/<企业>/kb.json` | 给某企业推买家/分析前（唯一权威） |
| 企业物料 | `data/memory/<企业>/materials.json` | 发营销内容/展会物料前 |
| 买家线索与外联 | 飞书线索池 Base + `data/memory/<企业>/` | 查线索/写外联前 |
| 反思记录 | `memory/projects/dealclaw/reflections.jsonl` | 写反思/查历史反思时 |
| 安全边界 | `REDLINES.md` | 每次会话必读 |
| 角色语气 | `SOUL.md` | 每次会话必读 |

> 路径以运行时侧实际目录为准；payload 侧可能少几个运行时生成的子目录。

## 检索规则

- 涉及 prior 决策/状态/偏好/人/TODO → 先 `memory_search`，再 `memory_get` 取那一段。
- 本文件只存索引指针，正文下沉到上述文件，用到时再读。
- 硬上限 80 行，超了就把最旧/最不热的条目下沉。

## 晋升规则（本文件怎么维护）

- 只有「跨任务、稳定、高置信、会改变默认行为」的内容才留耐久事实区。
- 从短期记忆晋升的内容先落 `promoted-facts.md`，本文件只保留指针。
- 项目知识 → `memory/projects/`；客户相关 → `profiles/`、`preferences/`；一次性 → 日报。

## 边界

- 核心文档（本文件、AGENTS/SOUL/REDLINES/IDENTITY/USER/TOOLS）仅田耕郡可改。
- 不吸收其他 Agent 的记忆；客户数据按身份隔离，不跨客户串。

## 晋升标记（防重复晋升，勿删）

<!-- openclaw-memory-promotion:memory:memory/2026-08-25.md:27:30 -->
<!-- openclaw-memory-promotion:memory:memory/2026-08-25.md:4:7 -->
<!-- openclaw-memory-promotion:memory:memory/2026-08-27.md:11:14 -->
<!-- openclaw-memory-promotion:memory:memory/2026-08-27.md:15:16 -->
<!-- openclaw-memory-promotion:memory:memory/2026-08-27.md:19:22 -->
<!-- openclaw-memory-promotion:memory:memory/2026-08-27.md:23:26 -->
<!-- openclaw-memory-promotion:memory:memory/2026-08-27.md:29:32 -->
<!-- openclaw-memory-promotion:memory:memory/2026-08-27.md:3:6 -->
<!-- openclaw-memory-promotion:memory:memory/2026-08-27.md:7:10 -->
<!-- openclaw-memory-promotion:memory:memory/2026-08-25.md:31:33 -->
<!-- openclaw-memory-promotion:memory:memory/2026-08-28.md:12:15 -->
<!-- openclaw-memory-promotion:memory:memory/2026-08-28.md:18:21 -->
<!-- openclaw-memory-promotion:memory:memory/2026-08-28.md:24:25 -->
<!-- openclaw-memory-promotion:memory:memory/2026-08-28.md:28:30 -->
<!-- openclaw-memory-promotion:memory:memory/2026-08-28.md:3:6 -->
<!-- openclaw-memory-promotion:memory:memory/2026-08-28.md:33:36 -->
<!-- openclaw-memory-promotion:memory:memory/2026-08-28.md:37:37 -->
<!-- openclaw-memory-promotion:memory:memory/2026-08-28.md:7:9 -->
<!-- openclaw-memory-promotion:memory:memory/2026-08-29.md:4:4 -->
<!-- openclaw-memory-promotion:memory:memory/2026-08-29.md:5:7 -->
<!-- openclaw-memory-promotion:memory:memory/2026-08-29.md:9:9 -->
<!-- openclaw-memory-promotion:memory:memory/2026-08-29.md:10:11 -->
