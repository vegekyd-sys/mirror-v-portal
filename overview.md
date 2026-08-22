# 代码审查概述 V2

## 任务
对 DealClaw Nexus 项目全部 7 个包进行第二轮代码审查，对比上次审查结果识别已修复/未修复/新增问题。

## 审查范围
- `packages/credits-ledger`（已更新）
- `packages/nexus-gateway`（已更新）
- `packages/provisioning-service`（新增）
- `packages/ops-agent`（新增）
- `packages/central-gateway`（新增）
- `packages/dealclaw-agent`（新增）
- `packages/admin-dashboard`（新增）

## 关键发现

### V1 Blocker 修复情况
上次发现的 8 个 Blocker 中：**6 个已修复、1 个部分修复、1 个未修复**。

### V2 新增 Blocker（8 项）
1. **NB1** — admin monthly-reset 端点认证绕过（与 V1 B2 同一模式）
2. **NB2** — provisioning-service 全部端点无认证
3. **NB3** — admin-dashboard 全部 API 无认证
4. **NB4** — ops-agent 破坏性端点无认证
5. **NB5** — MONTHLY_LIMIT_EXCEEDED 未在路由中处理，返回 200
6. **NB6** — 飞书签名验证因 body 重新序列化而失效
7. **NB7** — Credits 检查 fail-open，用户可绕过付费
8. **NB8** — central-gateway 无认证、无限流

### 最严重的 3 个问题
1. **4 个新服务全部缺少认证**（NB2-NB4, NB8）— 任何人可创建/删除租户、查看数据
2. **飞书签名验证实际不工作**（NB6）— body 重序列化导致签名不匹配
3. **Credits fail-open**（NB7）— ledger 宕机时用户免费使用 Agent

## 产出文件
- `docs/code-review/code-review-report-v2.md` — 完整审查报告，含 V1 对比和修复优先级
