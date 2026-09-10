# HEARTBEAT.md

出海精灵小元 runs only on explicit user requests or separately approved schedules.

## Reflection 维护任务（Knight OS）

定时/显式触发时，按顺序执行：

1. `python3 scripts/write-reflection.py ...` — 把本轮非琐碎工作/失败/纠纠正落成反思
   （一般由当轮 Agent 主动写，heartbeat 只做补齐）
2. `python3 scripts/reflection-analyzer.py` — 增量析反思模式 → 行为规则 / skill 候选
3. `python3 scripts/compress-memory.py` — 归档旧日志，控制 memory 体积
4. `python3 scripts/knight-status.py` — workspace 健康检查（缺目录/缺文件会报 MISSING）

产出路由：
- 一次性/不确定教训 → `memory/reflections/YYYY-MM-DD.jsonl`
- 重复/已确认模式 → `memory/ai-patterns.md` 或项目记忆
- 可复用流程 → `memory/skill-candidates.md`（候选，不自动落地）
- 核心身份/安全/长期偏好 → 先问用户确认

## 自动化开关

本 Agent 的自主定时运行需配置层显式开启（cron/schedule）。未开启时，上述任务只在
用户显式要求或已批准的计划里执行，不做后台自跑。
