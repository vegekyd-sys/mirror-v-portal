# tools/reflection-review — 分发前测试母体工具（不进 payload）

> 目标：**分发前测试母体学习 + 分发后独立分身本地学习**。原则：**少规则、强边界**。
> 现有调度真实运行一周，只收集候选质量与人工采纳率；不继续扩张基础设施。

## 硬规则（只有 4 条，不可让步）
1. **租户隔离**：跨分身/跨租户不串数据。
2. **payload 不含运行数据**：reflection/企业数据/每日流水不进 payload（`.dockerignore` + `payload-boundary.json` + 打包测试）。
3. **事实有证据**：候选必须带 `evidence_refs`；无证据不生成。
4. **未经确认不自动修改系统**：只产候选；改代码/Skill/知识必须人工确认。

## 分类只是「建议」（不强制）
`bug / skill_improvement / industry_knowledge / tenant_only / ignore` 仅作 `suggested`；
Agent 可结合上下文**重分类**或把一条经验**拆分**成多条。

## 每日输出（每天只挑最值得的 3-5 条）
每条字段：`summary / agent_judgment / suggested_destination / suggested_change / evidence_refs / confidence`。

## 人工闭环（简单，不搞状态机）
人确认 → 直接改并测试 → 在候选上记 `handled: <说明>` 与 `commit_id: <sha>`。
（`handled` 由人填写；工具不自动改系统、不自动 commit/push/构建。）

## 文件
- `review-reflections.py`：读两类 reflection → 出候选（6 字段，已脱敏）。
- `reflection_scheduler.py`：仅测试母体；业务时区 21:30 窗口；单实例锁；hash/cursor 增量；
  同类合并；只出 pending 候选；无新增静默；失败不影响主流程；只写 `data/reflection-review`。
- `reflection_e2e.py`：端到端验收（构建/A-B 分身/隔离/优先级/可复现）。
- `scan_git_secrets.py`：Git 敏感信息掩码扫描。

```bash
python3 tools/reflection-review/review-reflections.py --workspace <runtime> --json
python3 tools/reflection-review/reflection_scheduler.py --workspace <runtime> [--dry-run|--force]
```
