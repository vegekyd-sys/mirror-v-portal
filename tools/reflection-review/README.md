# tools/reflection-review — 分发前测试母体工具（不进 payload）

目标模型：**分发前「测试母体」学习；分发后独立分身本地学习**（非多租户学习平台）。

- `review-reflections.py`：读测试母体两类 reflection（agent 层 + 业务层）→ 固定 5 分类
  （`bug / skill_improvement / industry_knowledge / tenant_only / ignore`）→ **只生成审核候选，不改系统**。
  所有类别统一脱敏；`tenant_only` 只给脱敏摘要。输出到 `<workspace>/data/reflection-review/candidates/`（默认不进 Git）。
- `scan_git_secrets.py`：扫描 git 跟踪文件的敏感信息（api_key/token/邮箱/电话/域名/长ID/open_id/企业名），输出**掩码报告**。

```bash
python3 tools/reflection-review/review-reflections.py --workspace /path/to/runtime --json
python3 tools/reflection-review/scan_git_secrets.py --repo . --json
```

payload 只保留两个 writer（`write-reflection.py` / `write-business-reflection.py`）与空 memory 目录。
