# 代码审查概述

## 任务
对 DealClaw Nexus 项目的 `credits-ledger` 和 `nexus-gateway` 两个核心包进行代码审查，识别性能瓶颈和潜在 Bug。

## 审查范围
- `packages/credits-ledger` — 7 个 TS 源文件（app.ts, db/pool.ts, db/migrate.ts, routes/accounts.ts, services/account.ts, index.ts, __tests__/api.test.ts）
- `packages/nexus-gateway` — 7 个 TS 源文件（app.ts, config.ts, index.ts, middleware/credits.ts, middleware/identity.ts, middleware/scene.ts, types/index.ts）

## 关键发现
共发现 22 项问题：8 项 Blocker、9 项 Suggestion、5 项 Nit。

### 最严重的 3 个问题
1. **debit/credit 竞态条件（B1）** — 幂等检查与扣款操作不在同一事务中，并发请求可导致重复扣款
2. **credit 端点认证反转（B2）** — 未配置 PAYMENT_SERVICE_TOKEN 时任意 Token 均可充值
3. **Gateway 身份伪造（B4）** — 未验证平台签名，攻击者可冒充任意用户

## 产出文件
- `code-review-report.md` — 完整代码审查报告，包含每项问题的文件位置、代码行号、影响分析和修复建议
