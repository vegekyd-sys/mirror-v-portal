# DealClaw Nexus 开发任务列表

> 版本: v0.2 | 2026-07-29 | 按系分文档 9 模块拆解
> 标记: ⬜ 待开始 | 🔵 进行中 | ✅ 已完成 | ⏸️ 阻塞 | ❌ 取消

## 里程碑概览

| 里程碑 | 目标 | 预计模块 | 状态 |
|--------|------|---------|------|
| **M0** | 单租户跑通 | Gateway, Credits, Agent | ✅ |
| **M1** | 多租户开通 | Provisioning, Ops, Admin | ✅ |
| **M2** | 正式上线 | Central, Onboarding, Payment | 🔵 |

> M2 关键变更 (2026-07-29): 入驻流程从表单页改为飞书 registerApp() 一键扫码。旧版 HTML 表单相关代码已废弃。

---

## Phase 0: 基础设施 (需王建配合)

| # | 任务 | 优先级 | 状态 | 备注 |
|---|------|--------|------|------|
| 0.1 | 阿里云 ACR 命名空间创建 + 推送账号 | P0 | ✅ | 王建 — dealclaw namespace 已创建 |
| 0.2 | Jenkins agent 配置 (dealclaw-builder label) | P0 | ✅ | 王建 — 构建可用 |
| 0.3 | Jenkins credentials 配置 (6个) | P0 | ✅ | 王建 |
| 0.4 | K8s 集群就绪 + imagePullSecret 配置 | P0 | ✅ | 王建 — dealclaw-test 已部署 |
| 0.5 | Staging Namespace + 独立 PostgreSQL | P1 | ✅ | 王建 — 阿里云 RDS 已配置 |
| 0.6 | 支付宝商户号注册 (APPID + 密钥) | P4 | 🔵 | 王建 — 沙箱已就绪，生产待办 |
| 0.7 | Git repo CI webhook → Jenkins | P0 | ⬜ | 王建 |

---

## Phase 1: P0 模块 (M0 核心)

### 1.1 Nexus Agent Gateway

| # | 任务 | 状态 | 文件 |
|---|------|------|------|
| 1.1.1 | 项目骨架 + TypeScript 类型定义 | ✅ | `packages/nexus-gateway/src/types/index.ts` |
| 1.1.2 | 环境变量加载 + 配置模块 | ✅ | `packages/nexus-gateway/src/config.ts` |
| 1.1.3 | Express app 组装 + /healthz | ✅ | `packages/nexus-gateway/src/app.ts`, `index.ts` |
| 1.1.4 | Identity 中间件 (Bot 签名验证 + tenant 解析) | ✅ | `packages/nexus-gateway/src/middleware/identity.ts` |
| 1.1.5 | Credits 中间件 (余额检查 + 扣减) | ✅ | `packages/nexus-gateway/src/middleware/credits.ts` |
| 1.1.6 | Scene 中间件 (套餐场景权限) | ✅ | `packages/nexus-gateway/src/middleware/scene.ts` |
| 1.1.7 | Dockerfile | ✅ | `packages/nexus-gateway/Dockerfile` |
| 1.1.8 | Rate Limit 中间件 | ✅ | `packages/nexus-gateway/src/middleware/ratelimit.ts` |
| 1.1.9 | Credits 远程调用（替换 mock，对接 Credits Ledger API） | ✅ | `packages/nexus-gateway/src/app.ts` |
| 1.1.10 | 审计日志写入 | ✅ | `packages/nexus-gateway/src/middleware/audit.ts` |
| 1.1.11 | 单元测试 (identity + credits + scene + config) | ✅ | `src/__tests__/unit/services.test.ts` (8 tests) |
| 1.1.12 | 集成测试 (pipeline + healthz + 402/403/502/chat-free) | ✅ | `src/__tests__/integration/pipeline.test.ts` (6 tests) |
| 1.1.13 | K8s deployment.yaml + service.yaml | ✅ | `k8s/base/nexus-gateway/` |

### 1.2 Credits Ledger

| # | 任务 | 状态 | 文件 |
|---|------|------|------|
| 1.2.1 | 项目初始化 (package.json + tsconfig + Dockerfile) | ✅ | `packages/credits-ledger/` |
| 1.2.2 | 数据库 migration (accounts + transactions + monthly_usage) | ✅ | `packages/credits-ledger/src/db/migrate.ts` |
| 1.2.3 | GET /v1/accounts/:id/balance API | ✅ | `src/routes/accounts.ts` |
| 1.2.4 | POST /v1/accounts/:id/debit API (含超扣保护 + 幂等) | ✅ | `src/services/account.ts` |
| 1.2.5 | POST /v1/accounts/:id/credit API (Payment Service 内部调用) | ✅ | `src/services/account.ts` |
| 1.2.6 | GET /v1/accounts/:id/history API | ✅ | `src/routes/accounts.ts` |
| 1.2.7 | GET /v1/accounts/:id/usage API (月度用量) | ✅ | `src/routes/accounts.ts` |
| 1.2.8 | 月度额度重置逻辑 | ✅ | `packages/credits-ledger/src/services/monthly-reset.ts` |
| 1.2.9 | 单元测试 + 集成测试 (11 tests, balance/debit/credit/idempotency) | ✅ | `src/__tests__/api.test.ts` |
| 1.2.10 | 集成测试 (Testcontainers PG) | ✅ | 合并到 1.2.9，11 tests pass |
| 1.2.11 | K8s deployment.yaml + service.yaml | ✅ | `ultronx/cd/k8s/dealclaw/applications/credits-ledger/` |

### 1.3 Admin Dashboard

| # | 任务 | 状态 | 文件 |
|---|------|------|------|
| 1.3.1 | 项目初始化 | ✅ | `packages/admin-dashboard/` |
| 1.3.2 | 租户总览 API + 页面 | ✅ | `src/routes/api.ts` + `public/index.html` |
| 1.3.3 | Credits 概览 API + 页面 | ✅ | `src/routes/api.ts` + `public/index.html` |
| 1.3.4 | 服务健康聚合 API + 页面 | ✅ | `src/routes/api.ts` + `public/index.html` |
| 1.3.5 | 审计日志查询 API + 页面 | ✅ | `src/routes/api.ts` + `public/index.html` |
| 1.3.6 | 支付订单 API + 页面 | ✅ | `src/routes/api.ts` + `public/index.html` |
| 1.3.7 | Basic Auth 登录页 | ✅ | `packages/admin-dashboard/public/login.html` |
| 1.3.7.1 | IP 白名单 | ⬜ | 可通过 K8s NetworkPolicy 限制 |
| 1.3.8 | K8s deployment.yaml | ✅ | `ultronx/cd/k8s/dealclaw/applications/admin-dashboard/` |

---

## Phase 2: P1 模块 (M1 多租户)

### 2.1 Provisioning Service

| # | 任务 | 状态 | 备注 |
|---|------|------|------|
| 2.1.1 | 项目初始化 | ✅ | `packages/provisioning-service/` |
| 2.1.2 | 输入校验模块 (公司名/邮箱/套餐/手机号/SQL清洗) | ✅ | XSS sanitize + plan clamp + quota bounds |
| 2.1.3 | POST /v1/tenants API (创建租户) | ✅ | 含 K8s provisioning |
| 2.1.4 | GET /v1/tenants/:id API (查询状态) | ✅ | 含 status log |
| 2.1.5 | DELETE /v1/tenants/:id API (销毁) | ✅ | 含 K8s deprovisioning |
| 2.1.6 | K8s Namespace 创建逻辑 | ✅ | dry-run 模式 → 生产模式切换 |
| 2.1.7 | K8s Secret + NetworkPolicy + Pod 创建逻辑 | ✅ | 3 secrets per tenant |
| 2.1.8 | Tenant Registry DB migration | ✅ | `src/db/migrate.ts` |
| 2.1.9 | K8s RBAC 配置 | ✅ | RBAC manifests 已提交 |
| 2.1.10 | 单元测试 (validation + sanitize + quota) | ✅ | 14 tests pass |
| 2.1.11 | 集成测试 (ACK test env) | ✅ | HTTP API: create/read/delete tenant lifecycle |
| 2.1.12 | RUNTIME_NAMESPACE 统一 — 单一默认值 `DEFAULT_RUNTIME_NAMESPACE`（原 config 默认 `dealclaw-staging` 与 provisioning 内联 `dealclaw-test` 不一致）+ provisionTenant 改走 config 注入 + deployment.yaml 用 downward API (`fieldRef: metadata.namespace`) 注入 | ✅ | 保证跨 namespace FQDN（credits-ledger.\<ns\> / provisioning-service.\<ns\>）在任何控制面 namespace 下都拼对 |

### 2.2 Ops Agent

| # | 任务 | 状态 | 备注 |
|---|------|------|------|
| 2.2.1 | 项目初始化 | ✅ | `packages/ops-agent/` |
| 2.2.2 | 状态机引擎 (pending→active→suspended→grace→destroyed) | ✅ | `src/services/state-machine.ts` — 16 state tests |
| 2.2.3 | 巡检调度器 (每小时 cron) | ✅ | `src/services/cron.ts` — setInterval loop + 启动后首轮 |
| 2.2.4 | Credits 余额检查 + low_credits 推进 | ✅ | `src/services/credits-check.ts` — 并发查询 credits-ledger |
| 2.2.5 | 到期通知链 (7d/3d/1d 提醒) | ✅ | 内置 transition actions + notify action |
| 2.2.6 | suspended → grace 推进 (7天超时) | ✅ | State machine daysInCurrentStatus logic |
| 2.2.7 | grace → destroyed 推进 (30天超时) | ✅ | 含 15 天 final warning |
| 2.2.8 | 月度 Credits 重置 (每月1日 00:00) | ✅ | `shouldResetMonthly()` + credits-ledger 已有 proactive reset |
| 2.2.9 | Pod 健康检查 + 自动重启 | ⬜ | 需 K8s 集群内 |
| 2.2.10 | 对话式续费流程 | ⬜ | M2 补，由 dealclaw-agent 处理 |
| 2.2.11 | 单元测试 (状态机 + 通知规则) | ✅ | 29 tests pass |
| 2.2.12 | 集成测试 (ACK test env) | ✅ | HTTP API: cron scan 14 tenants, 0 errors |
| 2.2.13 | 通知真实触达 — central-gateway 代发 relay (`POST /internal/v1/notify`，Bearer INTERNAL_API_TOKEN) | ✅ | `central-gateway/src/services/notify-relay.ts` — 租户 Pod 被缩 0 时仍可送达；email 渠道显式 skip |
| 2.2.14 | 幂等去重 — `tenant_notifications` 表 + UNIQUE dedup_key | ✅ | dedupKey 按周期标记（月份/订阅周期/suspendedAt）；`ops-agent/src/services/notifier.ts` |
| 2.2.15 | im_open_id 捕获回写 — nexus-gateway 首条消息上报 + `PATCH /v1/tenants/:id/contact` | ✅ | `nexus-gateway/src/ws-client.ts` + tenants 表新增 platform/im_open_id 列 |
| 2.2.16 | 窗口判断修复 — 到期提醒 7d/3d/1d 改窗口制、grace 15 天警告 `===15`→`>=15&&<30`、subscription_end NULL 不再默认明年 1/1、daysInCurrentStatus 改取 status_log | ✅ | `state-machine.ts` + `db/query.ts`；通知文案中文化 |

---

## Phase 3: P2 模块 (M2 上线)

### 3.1 Central Gateway + Onboarding（飞书一键扫码入驻）

> 2026-07-29 重构：旧版 HTML 表单方案已废弃，改为 lark.registerApp() 一键扫码。

| # | 任务 | 状态 | 备注 |
|---|------|------|------|
| 3.1.1 | 项目初始化 (Central Gateway) | ✅ | `packages/central-gateway/` |
| 3.1.2 | User-Agent 渠道识别 | ✅ | `src/services/channel.ts` — 5 platforms |
| 3.1.3 | ~~GET /onboard HTML 表单页~~ | ❌ | 废弃 — 改为飞书一键扫码 |
| 3.1.4 | 飞书 registerApp() 集成 | ✅ | `src/services/feishu-register.ts` — lark.registerApp() 封装 |
| 3.1.5 | 入驻编排引擎 | ✅ | `src/services/onboarding-orchestrator.ts` — App凭证→租户→webhook→欢迎语 |
| 3.1.6 | 入驻状态轮询 API | ✅ | `GET /onboard/status?deviceCode=xxx` — 6阶段进度 |
| 3.1.7 | 多平台二维码调度 | ✅ | UA detect → feishu registerApp / dingtalk-wecom guidance |
| 3.1.8 | Bot webhook 绑定 → 客户 Pod Gateway | ✅ | onboarding-orchestrator 已处理 |
| 3.1.9 | 客户 Bot 欢迎语 + Agent 引导 | ✅ | onboarding-orchestrator 已处理 |
| 3.1.10 | 钉钉 OAuth 集成 | ⬜ | 辅线，飞书主力渠道上线后补 |
| 3.1.11 | 企业微信 OAuth 集成 | ⬜ | 辅线 |
| 3.1.12 | E2E 全链路测试 (registerApp mock + unit) | ✅ | 15 e2e tests pass + 24 unit tests pass |

---

## Phase 4: P3 模块

### 4.1 DealClaw Agent

| # | 任务 | 状态 | 备注 |
|---|------|------|------|
| 4.1.1 | Skill 路由表 (意图→Skill 选择) | ✅ | `packages/dealclaw-agent/src/intent.ts` |
| 4.1.2 | Gateway Context Header 中间件 | ✅ | M0 stub, Gateway handles credits |
| 4.1.3 | CRM 查询 Skill 集成 | ✅ | M0 stub with sample data |
| 4.1.4 | 妙记分析 Skill 集成 | ✅ | M0 stub with sample insights |
| 4.1.5 | 下一步跟进 Skill 集成 (M0 核心) | ✅ | M0 stub with actions + draft email |
| 4.1.6 | 其余 5 个 Skill 集成 | ⬜ | M1+ |
| 4.1.7 | Agent 输出标准化 | ✅ | `packages/dealclaw-agent/src/app.ts` |
| 4.1.8 | M0 3 样本验证 | ⬜ | 需要真实 CRM 数据 |

---

## Phase 5: P4 模块

### 5.1 Payment Service

| # | 任务 | 状态 | 备注 |
|---|------|------|------|
> ⚠️ Payment Service 延后实现（2026-08-05 王建决定），优先其它服务。
> 支付宝沙箱 APPID + 密钥 + 账号已于 2026-08-04 就绪，解除此前阻塞。

| 5.1.1 | 项目初始化 (Python + requirements) | ⏸️ | 延后 |
| 5.1.2 | 产品列表配置 | ⏸️ | 延后 |
| 5.1.3 | POST /v1/orders API (创建订单) | ⏸️ | 延后 |
| 5.1.4 | 支付宝 alipay.trade.wap.pay 集成 | ⏸️ | 延后 |
| 5.1.5 | 支付宝异步回调验签 + 入账 | ⏸️ | 延后 |
| 5.1.6 | 支付订单幂等 + 安全设计 | ⏸️ | 延后 |
| 5.1.7 | GET /v1/orders/:id API | ⏸️ | 延后 |
| 5.1.8 | 定时对账 (招联支付台账单 vs credits_ledger) | ⏸️ | 延后 |
| 5.1.9 | 支付宝沙箱全链路测试 | ⏸️ | 延后 |

---

## Phase 6: CI/CD & 部署

| # | 任务 | 状态 | 备注 |
|---|------|------|------|
| 6.1 | Jenkinsfile 提交到 repo | ✅ | `ultronx/ci/pipelines/dealclaw.groovy` |
| 6.2 | K8s base manifests (所有中央服务) | ✅ | `ultronx/cd/k8s/dealclaw/applications/` |
| 6.3 | K8s staging overlay | ✅ | `ultronx/cd/k8s/dealclaw/test/` |
| 6.4 | K8s production overlay | ✅ | `k8s/overlays/production/` |
| 6.5 | 租户 Pod 模板 | ✅ | `k8s/tenants/tenant-template/` |
| 6.6 | Jenkins pipeline 调通 (lint→test→build→deploy staging) | ✅ | tsc + vitest stage 已插入，任意失败阻止构建 |
| 6.7 | Staging 环境冒烟测试 | ✅ | 6/6 服务全通，ArgoCD Healthy+Synced | |

---

## Phase 7: 文档

| # | 任务 | 状态 | 备注 |
|---|------|------|------|
| 7.1 | 总体架构文档 | ✅ | `docs/architecture.md` |
| 7.2 | 模块 01-09 系分文档 | ✅ | `docs/modules/01-09` |
| 7.3 | 数据库 Schema 总览 | ✅ | `docs/modules/08-database-schema.md` |
| 7.4 | 测试设计 | ✅ | `docs/testing.md` |
| 7.5 | CI/CD 方案 | ✅ | `docs/cicd.md` |
| 7.6 | 任务列表 (本文档) | ✅ | `docs/tasks.md` |

---

## 进度统计

| 阶段 | 总任务 | 已完成 | 进行中 | 待开始 | 阻塞 |
|------|--------|--------|--------|--------|------|
| Phase 0: 基础设施 | 7 | 5 | 1 | 1 | 0 |
| Phase 1: P0 模块 | 32 | 31 | 0 | 1 | 0 |
| Phase 2: P1 模块 | 23 | 23 | 0 | 0 | 0 |
| Phase 3: P2 模块 | 12 | 11 | 0 | 1 | 2 ⏸️ (3.1.10 钉钉OAuth需凭证, 3.1.11 企微OAuth需上架) |
| Phase 4: P3 模块 | 8 | 7 | 0 | 1 | 0 |
| Phase 5: P4 模块 | 9 | 0 | 0 | 0 | 9 ⏸️ (延后 — 优先其它服务) |
| Phase 6: CI/CD & 部署 | 7 | 9 | 0 | 0 | 0 |
| Phase 7: 文档 | 6 | 6 | 0 | 0 | 0 |
| **合计** | **104** | **93** | **0** | **2** | **11 ⏸️** |

---

### 本轮新增完成（2026-07-31 12:53→17:26，8 commits）
- P0 安全修复 6 项（NB1/NB2/NB3/NB4/NB5/NB8 + B4-续/NB6/NB7）
- NS1/NS2/NS3 代码质量 3 项
- 3.1.10 钉钉入驻引导页（5 步向导，企业内部应用，无需应用市场）
- 4.1.6 5 个 Agent Skill 集成（lead_search/email_send/proposal/smart_reply/market_insight）
- 1.3.7 Admin Dashboard 登录页
- 6.4 K8s production overlay
- 6.5 租户 Pod 模板
- 融合二维码 E2E 测试（11 tests）
- 2.1.9 K8s RBAC manifests
- 3.1.8 Bot webhook 绑定（onboarding-orchestrator 已处理）
- 3.1.9 客户 Bot 欢迎语（onboarding-orchestrator 已处理）

### 剩余 15 项明细（2026-08-05 更新）
- **延后（9 项）**：Phase 5 Payment Service 全部 9 项（支付宝沙箱配置已就绪，王建决定延后实现）
- **阻塞（3 项）**：3.1.11 企微 OAuth（需上架）+ 0.7 Git CI webhook（需王建）+ 6.6 Jenkins 全链路（需 Build 权限）
- **非阻塞但需协作（4 项）**：2.1.11/2.2.12 kind 集成测试（需集群）、3.1.10 钉钉 OAuth（需凭证）、4.1.8 M0 样本验证（需 CRM 数据）
- **非阻塞可独立完成（2 项）**：1.3.7.1 IP 白名单、6.7 冒烟测试（需 Jenkins 部署先行）

### 本轮更新（2026-08-05 11:53）
- 支付宝沙箱配置已于 2026-08-04 全部就绪（APPID/密钥/账号），0.6 标记 🔵
- Phase 5 Payment Service 标记为延后 ⏸️（王建决定最后实现）
- 同步「本轮新增完成」中已完成的 6 项到主表（1.3.7 登录页/2.1.9/3.1.8/3.1.9/6.4/6.5）
- 进度更新：89/104 已完成，15 项剩余
