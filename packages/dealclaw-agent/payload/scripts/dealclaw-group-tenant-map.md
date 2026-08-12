# 小元内测群 → Credit 租户映射表

# 用于 shadow 计费记录：agent skill 执行完成后，
# 根据当前群名查找对应的 tenantId，调用 dealclaw-billing-record.sh。

# 群名（飞书群名/标识）            → tenantId          → accountId
# ──────────────────────────────────────────────────────────
小元01                               xiaoyuan_01          acct_xiaoyuan_01
小元03                               xiaoyuan_03          acct_xiaoyuan_03
小元04                               xiaoyuan_04          acct_xiaoyuan_04
小元07                               xiaoyuan_07          acct_xiaoyuan_07
内测群                               xiaoyuan_neice       acct_xiaoyuan_neice
Agent测试                            xiaoyuan_agent_test  acct_xiaoyuan_agent_test

# 规则：
# 1. 根据群名模糊匹配 → 对应 tenantId
# 2. 无法匹配的群 → 使用 xiaoyuan_unknown（作为未分类兜底，需要手动补建账户）
# 3. 新增群 → 先在 credits-ledger 创建账户，再加到此表
#
# 使用方法：
#   bash scripts/dealclaw-billing-record.sh <tenantId> dealclaw.<skill_id> 1
