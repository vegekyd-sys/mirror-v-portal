# Nexus — DealClaw 多租户运行平台

> Created: 2026-08-07 | Status: 🟢 Active | Priority: 🔥 高
> 
> Nexus 是 DealClaw AI 外贸销售 Agent 的多租户运行平台。
> 客户飞书一键扫码开通 → 10 秒拥有自己的 AI 外贸助手。

## 项目定位

Nexus 不是 DealClaw 的"后台"——它是承载 DealClaw Agent 运行的基础设施层。

```
Nexus（平台层）              DealClaw（应用层）
     │                           │
     │ 租户管理·隔离·计费·运维      │ AI 外贸 Agent·Skill 编排·米奥 API
     │                           │
     └──────── 支撑 ──────────────┘
```

- **Nexus 做的**：客户开通、租户隔离、credential 管理、用量计费、生命周期运维
- **Nexus 不做的**：外贸业务逻辑、客户沟通、邮件发送、CRM 操作

## 架构

```
┌─────────────────────────────────────────────────────────┐
│                    中央调度层                              │
│  Central Gateway  (二维码 + 一键入驻编排)                   │
│  ┌───────────────┐     ┌────────────────────┐            │
│  │ 扫码入口        │────▶│ registerApp SDK     │            │
│  │ GET /onboard   │     │ (飞书一键创建应用)    │            │
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
│                 租户专用运行时 (per-tenant)                  │
│  dealclaw-agent-<tenantId> (Deployment+Service)          │
│      └─ Skill 编排：查客户·写邮件·圈线索·跟进…                │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│                    后台运维层                              │
│  Ops Agent · Credits Ledger · Payment Service            │
└─────────────────────────────────────────────────────────┘
```

## 模块清单

| # | 模块 | 部署 | 状态 | 说明 |
|---|------|------|------|------|
| 1 | **Nexus Central Gateway** | 中央 | ✅ | 飞书 registerApp 扫码入驻 + 渠道识别 + 编排引擎 |
| 2 | **Provisioning Service** | 中央 | ✅ | 租户 CRUD + K8s provision/deprovision（安全代理） |
| 3 | **Nexus Agent Gateway** | 中央(共享) | ✅ | Identity/Credits/Scene/RateLimit/Audit 中间件 |
| 4 | **Credits Ledger** | 中央 | ✅ | 账本 CRUD + 超扣保护 + 幂等 + 月度重置 |
| 5 | **DealClaw Agent** | per-tenant Pod | 🔵 | Mirror V 骨架 + DealClaw 身份 + 131 skill；docker build 进行中 |
| 6 | **Ops Agent** | 中央 | ✅ | 租户状态机 + 巡检调度 + 余额检查 + 通知链 |
| 7 | **Payment Service** | 中央 | ⏸️ | 支付宝沙箱就绪，王建延后 |
| 8 | **Admin Dashboard** | 中央 | ✅ | 租户/credits/审计/健康/支付 6 面板 |

## 测试环境

| 资源 | 值 |
|------|-----|
| K8s | 阿里云 ACK，namespace `dealclaw-test` |
| 镜像仓库 | `ultronx-acr-registry-vpc.cn-shanghai.cr.aliyuncs.com/dealclaw/` |
| CI | Jenkins `https://devops-tools.ultronx.tech:8443/jenkins/job/dealclaw/` |
| CD | ArgoCD `dealclaw-test` Application |
| 测试域名 | `dealclaw-test.ultronx.tech` |

## 关键设计决策

### ADR-001: 集中式 Gateway + per-tenant Agent
Nexus Agent Gateway 集中部署，按 tenant_id 路由；DealClaw Agent 每租户独立 Pod。
→ 故障隔离、bot 凭证天然隔离。

### ADR-003: Onboarding 不直接操作 K8s
Onboarding Agent 只能通过 Provisioning Service HTTP API 操作基础设施。
→ 攻击面最小化。

### ADR-004: 飞书 registerApp 一键扫码入驻
客户入驻不使用 HTML 表单。registerApp() SDK → 扫码 → 飞书 App 内确认 → 后台异步创建租户。
→ 10 秒完成，零表单流失。

## 当前痛点：Credential 管理

### 问题
所有租户共享同一把 `MAKARON_API_KEY`（写在 Docker 镜像里），无法按租户隔离外部 API key。
无法做到：大客户专用 key、key 用量告警、key rotation 运行时切换。

### 计划方案
新增 **Nexus Credential Manager**：
- 中央 credential 注册表（key type + value + scope）
- tenant ↔ key 动态绑定
- Gateway Header 注入 → Agent 运行时读取，不再读镜像 ENV

详见 `dealclaw/docs/progress/2026-08-07-status-and-nexus-credential.md`

## 关联项目

- **DealClaw（应用层）**：`memory/projects/mio/dealclaw/` — AI 外贸 Agent 业务逻辑、Skill、客户画像、PRD
- **DealClaw Platform（平台层）**：`memory/projects/dealclaw-platform/` — 多租户 SaaS 平台总览（已归档）
- **Mirror V Payload**：`config/mirror-v/profiles/dealclaw.json` — DealClaw 专用 payload profile，独立于 v001-full
- **代码仓库**：`dealclaw/` workspace — 所有模块源码
- **设计文档**：`dealclaw/docs/` — 系分、任务列表、CI/CD、部署方案

## 团队

- **管理员**：产品决策 + 架构方向
- **王建**：K8s/ACR/Jenkins/网络/支付宝商户
- **方达**：DealClaw Agent + Tiance landing 开发
- **V**：Agent 开发、文档、测试、CI/CD、进度追踪

## 历史

| 日期 | 事件 |
|------|------|
| 2026-07-26 | DealClaw Nexus 系统设计文档 v0.1 |
| 2026-07-28 | M0 测试环境部署（王建），4 核心服务跑通 |
| 2026-07-29 | 入驻流程改为飞书 registerApp 一键扫码 |
| 2026-07-30 | dealclaw-platform 项目建档 |
| 2026-08-05 | 6/6 服务 ArgoCD Healthy+Synced；98/98 测试通过 |
| 2026-08-07 | DealClaw Agent payload 重构：Mirror V 骨架 + 131 skill + DealClaw 身份；CI docker build 调通 |
| 2026-08-07 | Nexus 项目正式建档；credential 管理缺口分析完成 |
