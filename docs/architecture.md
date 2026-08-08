# DealClaw Nexus 系统设计文档

> 版本：v0.2 | 2026-07-29 | Author: V
> 变更：入驻流程改为飞书一键扫码（registerApp SDK），移除表单页
> 参考：[DealClaw Nexus 技术方案 v3.0](https://versa-ai.feishu.cn/docx/EPGvdMIb6onOdIxdRKScpj6tnxI)

## 1. 系统总览

DealClaw Nexus 是承载 DealClaw AI 外贸销售 Agent 的多租户运行平台。客户飞书扫码一键开通，无需表单、无需手动配置——10 秒拥有自己的 AI 外贸助手。

```
┌─────────────────────────────────────────────────────────┐
│                    中央调度层                              │
│  Central Gateway  (融合二维码 + 一键入驻编排)               │
│  ┌───────────────┐     ┌────────────────────┐            │
│  │ 扫码入口        │────▶│ registerApp SDK     │            │
│  │ GET /onboard   │     │ (飞书一键创建应用)    │            │
│  │ 生成二维码       │     │ 用户扫码→确认→App完成 │            │
│  └───────────────┘     └────────┬───────────┘            │
│                                 │ App ID + Secret          │
│                                 ▼                         │
│  ┌──────────────────────────────────────────┐            │
│  │      Onboarding 编排引擎                   │            │
│  │      创建租户 · 分配虚拟机 · 绑定 webhook    │            │
│  └──────────────────┬───────────────────────┘            │
│                     │ HTTP API                             │
│                     ▼                                      │
│  ┌──────────────────────────────────────┐                │
│  │      Provisioning Service             │                │
│  │      (K8s 资源安全代理)               │                │
│  └──────────────────────────────────────┘                │
└─────────────────────────────────────────────────────────┘
                     │ K8s API
                     ▼
┌─────────────────────────────────────────────────────────┐
│                 租户专用 Agent 运行层 (per-tenant)           │
│  K8s Namespace: dealclaw-staging / dealclaw-prod (共享)      │
│                                                         │
│  dealclaw-agent-<tenantId> (Deployment+Service, per-tenant)  │
│      └─ Skill 编排：查客户·写邮件·圈线索·跟进…                │
│                                                         │
│  隔离手段：Secret/Quota/NetworkPolicy(按 label)/Audit        │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│                    后台运维层                              │
│  Ops Agent · Credits Ledger · Payment Service            │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ Ops      │  │ Credits      │  │ Payment          │   │
│  │ Agent    │  │ Ledger       │  │ Service          │   │
│  │ 生命周期  │  │ 计费·账本    │  │ 支付宝·嘉联      │   │
│  └──────────┘  └──────────────┘  └──────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

## 2. 模块清单与依赖

| # | 模块 | 部署位置 | 运行时依赖 | 数据依赖 |
|---|------|---------|-----------|---------|
| — | **Admin Dashboard** | 中央 | Tenant Registry, Credits Ledger | PostgreSQL (只读) |
| 1 | **Nexus Central Gateway** | 中央 | — | — |
| 2 | **Onboarding Agent** | 中央 | Central Gateway, Provisioning | — |
| 3 | **Provisioning Service** | 中央安全 Pod | K8s API | tenant registry |
| 4 | **Nexus Agent Gateway** | 中央（共享） | DealClaw Agent | Credits Ledger (R/O) |
| 5 | **DealClaw Agent** | 中央（同环境 namespace，per-tenant 专用） | Nexus Agent Gateway | 米奥 API, 客户数据 |
| 6 | **Credits Ledger** | 中央 | — | Supabase/PostgreSQL |
| 7 | **Payment Service** | 中央 | Credits Ledger | 支付宝/嘉联 |
| 8 | **Ops Agent** | 中央 | K8s API, Credits | tenant registry |
| — | **Support Agent** (未来) | 中央 | K8s API | — |

### 依赖关系图

```
用户飞书扫码
     │
     ▼
Central Gateway ──▶ lark.registerApp() ──▶ 飞书一键创建应用
     │                      │
     │                App ID + Secret
     │                      │
     ▼                      ▼
 Onboarding 编排 ──▶ Provisioning Service ──▶ K8s
                        │
                        ▼
                Tenant Registry (DB)

Nexus Agent Gateway ──▶ DealClaw Agent ──▶ 米奥 API
       │
       ▼
  Credits Ledger ◀── Payment Service ──▶ 支付宝/嘉联
       ▲
       │
  Ops Agent ──▶ K8s API
```

## 3. 开发优先级

| 阶段 | 模块 | 理由 |
|------|------|------|
| **P0 (当前)** | #4 Nexus Agent Gateway + #6 Credits Ledger | 消息入口 + 计费基础，独立性强，不需 K8s |
| **P1** | #3 Provisioning Service + #8 Ops Agent | 客户开通 + 生命周期，需要 K8s 集群 |
| **P2** | #1 Central Gateway + #2 Onboarding Agent | 融合二维码调度，依赖 P0+P1 |
| **P3** | #5 DealClaw Agent | 8 个 Skill 编排，依赖 Gateway 就绪 |
| **P4** | #7 Payment Service | 支付接入，需支付宝商户号（王建提供） |

## 4. 技术栈决策

| 模块 | 语言/运行时 | 理由 |
|------|-----------|------|
| Nexus Agent Gateway | TypeScript + Node.js | 与 OpenClaw 生态一致，轻量 HTTP 服务 |
| Provisioning Service | TypeScript + Node.js | K8s client 支持好，输入校验逻辑清晰 |
| Credits Ledger | TypeScript + Node.js | 与 Gateway 同栈，Supabase/PostgreSQL |
| Payment Service | Python | 支付宝 SDK 原生 Python 支持最好 |
| Ops Agent | TypeScript + Node.js | 定时任务 + K8s client |
| DealClaw Agent | OpenClaw runtime | 现有 8 个米奥 Skill 直接复用 |

## 5. 各模块详细设计

详见模块文档：

- [Nexus Agent Gateway](./modules/01-nexus-gateway.md) ← P0
- [Credits Ledger](./modules/02-credits-ledger.md) ← P0
- [Provisioning Service](./modules/03-provisioning.md) ← P1
- [Ops Agent](./modules/04-ops-agent.md) ← P1
- [Central Gateway + Onboarding](./modules/05-central-gateway-onboarding.md) ← P2
- [DealClaw Agent](./modules/06-dealclaw-agent.md) ← P3
- [Payment Service](./modules/07-payment-service.md) ← P4
- [Admin Dashboard](./modules/09-admin-dashboard.md) ← P1 (运维观测)
- [数据库 Schema 总览](./modules/08-database-schema.md)
- [测试设计](./testing.md) — Vitest/pytest/kind/支付宝沙箱，各模块测试用例
- [任务列表](./tasks.md) — 101 项开发任务，按 Phase 0-7 排列，实时追踪进度
- [CI/CD 方案](./cicd.md) — GitLab CI + Container Registry + GitOps (ArgoCD) + 灰度升级
- [部署方案](./deployment.md) — 全部国内部署 + CDN 策略 + 域名规划 + 海外扩展预留

## 6. 关键设计决策记录 (ADR)

### ADR-001: Gateway 在 Pod 内 vs 集中式

**决策**: Nexus Agent Gateway 采用集中式（共享）部署，按 `tenant_id` 路由到对应租户的专用 DealClaw Agent（每租户 1 Pod/Service）。

**理由**:
- 生产消息不经过 Central Gateway，减少中央瓶颈
- 每个租户独立 Gateway 实例，故障隔离
- Bot 凭证天然隔离，无需集中存储客户 App Secret

**代价**: 升级 Gateway 需逐 Pod 灰度，运维复杂度略增 → Ops Agent 自动化处理

### ADR-002: 支付与对话解耦

**决策**: Agent 不内嵌支付二维码，改为返回统一支付链接跳转第三方收银台。

**理由**:
- 不同 IM 对图片消息支持不一
- 二维码在聊天中可被截图转发，安全隐患
- Payment Service 独立部署，未来切换支付服务商只需改适配器

### ADR-003: Onboarding Agent 不直接操作 K8s

**决策**: Onboarding Agent 只能通过 Provisioning Service HTTP API 操作基础设施。

**理由**:
- Onboarding Agent 是唯一跨租户边界的组件，安全风险最高
- Provisioning Service 有严格输入校验 + 极有限 RBAC
- 攻击面最小化：即使 Onboarding Agent 被注入，也无法直接调 K8s API

### ADR-004: 入驻零表单——飞书 registerApp SDK 一键扫码

**决策**: 客户入驻不使用 HTML 表单页。改用飞书开放平台 `registerApp()` SDK，生成二维码 → 用户扫码 → 飞书 App 内一键确认创建 → 后台异步创建租户和虚拟机。

**理由**:
- PRD 要求：参考 Hermes 体验，扫码后直接进入飞书智能体创建流程
- 表单页停留时间过长 → 用户高流失率
- `registerApp()` 自动预配置权限、事件订阅，无需用户手动操作
- 用户侧操作：扫码 → 点确认，10 秒完成
- 客户信息（公司名等）由 DealClaw Agent 在对话中收集，不中断入驻体验

**代价**: 
- 依赖飞书 SDK 的 device authorization flow
- 入驻无中间表单意味着租户初始元数据有限（仅 tenant_id + App ID/Secret），后续需 Agent 收集补充
