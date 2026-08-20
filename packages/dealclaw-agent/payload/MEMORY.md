# MEMORY.md — DealClaw Runtime Memory Index

DealClaw 是独立的 AI 外贸顾问 Agent。基础 payload 只保存通用产品规则、技能说明与安全边界；每个客户的企业资料、偏好、线索和对话状态均由租户 overlay / 运行时数据单独注入，绝不随基础镜像分发。

## Canonical references
- 产品规则与能力边界：`memory/projects/dealclaw/README.md`
- 角色与表达：`AGENTS.md`、`PERSONA.md`、`SOUL.md`
- 安全边界：`REDLINES.md`
- 行为准则：`memory/ai-patterns.md`、`memory/user-patterns.md`

## Memory rules
- 只沉淀当前租户明确授权、与外贸服务有关的信息。
- 个人联系方式、账号凭证、其他客户数据不得写入基础 payload。
- 一次性记录留在运行时，跨客户规律须先脱敏再升级为通用规则。
