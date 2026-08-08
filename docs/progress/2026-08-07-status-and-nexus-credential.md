# DealClaw Nexus — 当前进度与 Credential 管理缺口

> 2026-08-07 | Author: V | 供下周团队同步使用

## 一、整体进度

### ✅ 已完成（M0 + M1）

| 模块 | 状态 | 说明 |
|------|------|------|
| **Nexus Agent Gateway** | ✅ | Identity/Credits/Scene/RateLimit/Audit 中间件全通；11+6 测试 pass；K8s manifests 就绪 |
| **Credits Ledger** | ✅ | 账本 CRUD + 超扣保护 + 幂等 + 月度重置；11 tests pass；已部署 dealclaw-test |
| **Provisioning Service** | ✅ | 租户 CRUD + K8s provision/deprovision；14+HTTP API tests pass；DB 事务安全 |
| **Ops Agent** | ✅ | 租户状态机 + 巡检调度 + 余额检查 + 通知链；29 tests pass；已部署 dealclaw-test |
| **Admin Dashboard** | ✅ | 租户/credits/审计/健康/支付 6 面板 + Basic Auth；已部署 |
| **Central Gateway + Onboarding** | ✅ | 飞书 registerApp 一键扫码入驻；渠道识别 + 编排引擎 + 状态轮询；15 e2e + 24 unit tests pass |
| **CI/CD** | ✅ | Jenkins pipeline (lint→test→build→deploy staging)；6/6 服务 ArgoCD Healthy+Synced |
| **DealClaw Agent（M0）** | ✅ | Skill 路由 + 3 核心 Skill stub + 输出标准化；测试通过 |

### 🔵 当前进行中

- **DealClaw Agent 镜像构建**：CI build #111 正在跑，修了 3 个 build blocker（CI Dockerfile 时序、customer-overlay 测试依赖已删数据、全量 Mirror V skill 已搬入）
- **支付服务**：支付宝沙箱已就绪，但王建决定延后实现，优先其它服务

### ⬜ 待推进

| 模块 | 优先级 | 阻塞项 |
|------|--------|--------|
| DealClaw Agent M1（5 个剩余 Skill） | P3 | 需要真实 CRM 数据验证 |
| Payment Service | P4 | 王建延后 |
| 钉钉/企微 OAuth 对接 | P2 | 飞书主力渠道上线后补 |
| Pod 健康检查 + 自动重启 | P1 | K8s 集群内测试 |

---

## 二、Nexus 对 ENV/Key/Credential 管理不满意的具体问题

Tianyi 的核心判断：

> "后续对 ENV 各种 key credential 的管理，现在每个镜像都只能用一样的 key，最后无法形成通过 key 来控制服务的结果。"

### 现状分析

当前 credential 流是 **镜像内静态 ENV + K8s Secret 注入**：

```
Docker 镜像（所有租户相同）
  │
  │  内置 ENV: MAKARON_API_KEY, SUPABASE_URL, ...
  │
  ▼
Provisioning Service ──创建──▶ K8s Secrets（per-tenant）
  │                              │
  │  dealclaw-bot-<id>          │ DEALCLAW_BOT_SECRET
  │  dealclaw-agent-config-<id> │ DEALCLAW_AGENT_URL, ...
  │  dealclaw-credits-<id>      │ DEALCLAW_CREDITS_ACCOUNT_ID
  │                              │
  ▼                              ▼
Nexus Gateway Pod              DealClaw Agent Pod
（per-tenant Secret 注入）      （per-tenant Secret 注入）
```

**问题所在**：

1. **镜像级 key 无法区分租户**：`MAKARON_API_KEY`、`SUPABASE_URL` 等写在 Dockerfile 里的 ENV，所有租户用同一把 key。即使 Nexus Gateway 做了 per-tenant route，Agent 内部调 Makaron/米奥 API 时用的还是共享 key。

2. **Credential 没有中央注册表**：当前没有"这个租户用哪把 Makaron key、那个租户用哪把米奥 key"的统一管理。Provisioning Service 创建的 3 个 K8s Secret 只是 bot/app/credits 相关，不覆盖 Agent 内部需要的外部 API key。

3. **无法通过 key 控制服务**：Tianyi 想要的场景——
   - 给大客户分配专用 Makaron API key，跟小客户隔离
   - 某个客户的 key 用量超标 → 自动限流/降级
   - 新客户试用 → 分配临时 key，到期自动回收
   - 运维视角：一眼看到每个 key 被哪些租户使用、用量如何
   
   当前架构做不到，因为所有租户共享同一把镜像级 key。

4. **Key rotation 无机制**：如果要换一把 Makaron key，需要重新构建所有镜像 + 滚动更新所有 Pod，不是运行时切换。

### 理想态

```
┌─────────────────────────────────────────────┐
│         Nexus Credential Manager            │
│  (新模块 or Central Gateway 扩展)            │
│                                             │
│  Credential Registry:                       │
│  ┌─────────────────────────────────────┐    │
│  │ key_id │ type    │ value  │ scope   │    │
│  │ k001   │ makaron │ sk-xxx │ tenant: │    │
│  │ k002   │ makaron │ sk-yyy │ shared  │    │
│  │ k003   │ mio     │ mi-zzz │ tenant: │    │
│  └─────────────────────────────────────┘    │
│                                             │
│  Binding:                                   │
│  ┌──────────────────────────────────────┐   │
│  │ tenant_01 → makaron: k001, mio: k003 │   │
│  │ tenant_02 → makaron: k002, mio: k003 │   │
│  └──────────────────────────────────────┘   │
│                                             │
│  API: GET /v1/credentials/:tenantId/:type   │
│       → Nexus Gateway 调用，注入到 Agent     │
└─────────────────────────────────────────────┘
```

Agent 不再从镜像 ENV 读 key，而是从 Gateway Header 中获取运行时 credential。

---

## 三、建议的推进路径

### Phase A：Credential 管理模块（新 P0）

| # | 任务 | 预估 |
|---|------|------|
| A.1 | Credential Registry DB schema + migration | 0.5d |
| A.2 | POST/GET/DELETE /v1/credentials API（key CRUD） | 1d |
| A.3 | POST /v1/bindings API（tenant ↔ key 绑定） | 0.5d |
| A.4 | Nexus Gateway 集成：请求时查询 credential → 注入 Header | 0.5d |
| A.5 | DealClaw Agent 改造：从 Gateway Header 读 key，不再读镜像 ENV | 1d |
| A.6 | Provisioning Service 集成：创建租户时自动创建 credential binding | 0.5d |
| A.7 | Admin Dashboard 面板：credential 总览 + 用量 | 1d |
| A.8 | Key rotation + 用量告警 | 1d |

### Phase B：DealClaw Agent 真实验证（M0→M1）

| # | 任务 |
|---|------|
| B.1 | 用真实米奥 API key + 真实 CRM 数据替换 M0 stub |
| B.2 | 3 样本端到端验证（查客户→读妙记→出跟进方案） |
| B.3 | 补齐 5 个剩余 Skill（数据圈选/话术拆解/方案生成/拜访评分/客户历程） |

### Phase C：上线准备

| # | 任务 |
|---|------|
| C.1 | Production namespace + RDS 就绪 |
| C.2 | 飞书应用市场审核 |
| C.3 | 首批客户 onboarding（米奥内部销售团队 + 1-2 个外部客户） |

---

## 四、下周会议建议议题

1. **Credential 管理优先级**：是否同意 Phase A 为当前 P0？与支付、钉钉/企微的优先级对比？
2. **米奥 API 对接**：什么时间可以拿到真实的米奥测试 key + CRM 数据？
3. **运维分工**：王建负责基础设施（K8s/ACR/Jenkins/网络），方达负责 DealClaw Agent 开发——credential 模块谁主力？
4. **时间线**：M2 上线（飞书一键扫码 + 多租户 + credential 隔离）的目标日期？
