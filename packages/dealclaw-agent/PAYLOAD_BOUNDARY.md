# Payload 目录边界（v1）

> 目标模型：**分发前「测试母体」学习；分发后独立分身本地学习。**
> 这不是一个持续多租户学习平台——母体在发布前积累改进，分身后各自本地学习、互不相通。
> 状态：2026-09-11 定稿（田耕郡修正目标后落地）。

## 一、与当前情况的 diff

| 维度 | 之前（我上一版理解） | 现在（修正后） |
|---|---|---|
| 模型 | 持续**多租户学习平台**，租户数据跨租户聚合晋升 | **分发前测试母体学习 + 分发后独立分身本地学习** |
| 晋升门槛 | 跨租户复现 ≥2 或人工批准 | 只在**测试母体**审阅：`review-reflections.py` 出候选，人工落位 |
| 自动改系统 | 讨论过自动/半自动晋升 | **只生成审核候选，绝不自动改系统** |
| payload 边界 | 口头上"排除 memory" | **机器可读清单 + 打包测试**强制（见 `payload-boundary.json` / `tests/test_payload_boundary.py`） |

不变项：保留 `write-reflection.py`（agent 层）与 `write-business-reflection.py`（业务层）；通用知识落 `industry-knowledge.md`。

## 二、两类 reflection（分发前改进输入）

- **agent 层**：`memory/reflections/*.jsonl` —— 工程方法论（开发/部署/踩坑）。写入口 `scripts/write-reflection.py`。
- **业务层**：`memory/projects/dealclaw/reflections.jsonl` —— 行业知识与使用记忆。写入口 `scripts/write-business-reflection.py`。

两者都在**测试母体**里作为「分发前改进输入」，由 `scripts/review-reflections.py` 分类成候选。

## 三、review-reflections 固定 5 分类与去向

| 分类 | 去向 | 谁落 |
|---|---|---|
| `bug` | 代码 + 回归测试 | 人（改代码/补测试） |
| `skill_improvement` | Skill / 规则 | 人 |
| `industry_knowledge` | 脱敏后落通用知识（`industry-knowledge.md`） | 人（脱敏复核） |
| `tenant_only` | 仅本地分身，**不进 payload** | — |
| `ignore` | 忽略（噪声/一次性） | — |

脚本只写候选到 `memory/reflection-review/candidates-<date>.{md,json}`，**不改代码/Skill/知识库**。

## 四、目录边界（进 / 不进 payload）

**进 payload（制品）**
- `scripts/`（含 `write-reflection.py` / `write-business-reflection.py` / `review-reflections.py`）
- `skills/`、`payload/AGENTS.md` 等 identity 文档
- 通用知识文档：`memory/projects/dealclaw/industry-knowledge.md`、`promoted-facts.md`、各 schema/口径 `.md`
- 占位：`memory/reflections/.gitkeep`（空目录，保证运行时目录存在）

**不进 payload（运行时 / 企业数据 / 每日流水）**
- `memory/reflections/**`（reflection 数据）
- `memory/projects/dealclaw/reflections.jsonl`
- `memory/reflection-review/**`（审核候选）
- `memory/<YYYY-MM-DD>.md`（每日流水）、`memory/logs/**`、`memory/sends/**`、`memory/daily-session-review/**`
- 企业数据：`memory/projects/dealclaw/{preferences,leads,profiles,insights,outreach,case-studies}/**`
- `.env` / `.env.*`、`data/**`、`work/mio-api/data/**`

> 机器可读清单：`packages/dealclaw-agent/payload-boundary.json`；打包校验：`packages/dealclaw-agent/tests/test_payload_boundary.py`。

## 五、使用

```bash
# 生成审核候选（测试母体）
python3 scripts/review-reflections.py --json
# 打包边界校验
python3 tests/test_payload_boundary.py
```
