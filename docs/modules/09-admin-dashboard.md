# 09 — Admin Dashboard 系分

> 优先级: P1 | 部署: 中央控制平面 | 语言: TypeScript + Node.js + 纯 HTML
> 前置依赖: 各服务 /healthz, Tenant Registry, Credits Ledger

## 1. 职责边界

Admin Dashboard 是内部运维观测面板，仅运维/开发团队使用，不面客。聚合展示所有租户状态、服务健康、Credits 余额、审计日志。

**不负责**: 客户数据展示、用户登录鉴权（基础 Basic Auth / IP 白名单即可）、修改操作（只读面板）。

## 2. 功能清单

| 页面 | 路径 | 数据来源 | 刷新间隔 |
|------|------|---------|---------|
| 租户总览 | `/` | Tenant Registry | 30s |
| Credits 概览 | `/credits` | Credits Ledger | 30s |
| 服务健康 | `/health` | 各服务 /healthz | 10s |
| 审计日志 | `/audit` | audit_log 表 | 手动 |
| 支付订单 | `/orders` | payment_orders 表 | 手动 |
| Healthz API | `/api/health` | 聚合各服务状态 | — |

## 3. 页面设计

### 3.1 租户总览（首页）

```
┌──────────────────────────────────────────────────────────────┐
│  DealClaw Nexus Admin                          🔄 30s 刷新    │
│──────────────────────────────────────────────────────────────│
│  [总览] [Credits] [服务健康] [审计] [订单]                     │
│──────────────────────────────────────────────────────────────│
│                                                              │
│  ┌─ 统计卡片 ──────────────────────────────────────────┐     │
│  │  Active        Suspended     Grace       Total       │     │
│  │   ██ 42          ██ 3        ██ 1      ██ 46        │     │
│  └────────────────────────────────────────────────────┘     │
│                                                              │
│  ┌─ 租户列表 ──────────────────────────────────────────┐     │
│  │ Tenant ID   公司名        套餐    状态    到期日      │     │
│  │────────────────────────────────────────────────────│     │
│  │ cust-001    ABC Corp      Pro    ● active  2027-07  │     │
│  │ cust-002    XYZ Trading   Starter ● active  2027-06  │     │
│  │ cust-003    渤程生物       Pro    ● active  2026-12  │     │
│  │ cust-004    Test Inc       Growth ⬤ grace  2026-06  │     │
│  └────────────────────────────────────────────────────┘     │
│                                                              │
│  ┌─ 最近创建 ──────────────────────────────────────────┐     │
│  │ cust-046   海昌科技      Starter  pending   刚刚      │     │
│  │ cust-045   利达五金      Pro       active   2h ago    │     │
│  └────────────────────────────────────────────────────┘     │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 Credits 概览

```
┌──────────────────────────────────────────────────────────────┐
│  Credits 概览                                       🔄 30s    │
│──────────────────────────────────────────────────────────────│
│                                                              │
│  总余额: 186,500,000          本月总消耗: 12,340,000           │
│                                                              │
│  ┌─ 用量排行 (本月) ───────────────────────────────────┐     │
│  │ #   租户         套餐      已用/总额      使用率    │     │
│  │────────────────────────────────────────────────────│     │
│  │ 1   ABC Corp     Pro      4.2M / 5M     84%  ⚠️     │     │
│  │ 2   XYZ Trading  Starter   0.8M / 1M     80%  ⚠️     │     │
│  │ 3   渤程生物      Pro      1.5M / 5M     30%         │     │
│  └────────────────────────────────────────────────────┘     │
│                                                              │
│  余额告警 (< 10%): 2 个租户                                   │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 3.3 服务健康

```
┌──────────────────────────────────────────────────────────────┐
│  服务健康                                            🔄 10s   │
│──────────────────────────────────────────────────────────────│
│                                                              │
│  ┌─ 中央服务 ──────────────────────────────────────────┐     │
│  │ nexus-central-gateway   ● healthy   200ms             │     │
│  │ onboarding-agent        ● healthy   150ms             │     │
│  │ provisioning-service    ● healthy   180ms             │     │
│  │ credits-ledger          ● healthy   120ms             │     │
│  │ payment-service         ● healthy   300ms             │     │
│  │ ops-agent               ● healthy    50ms             │     │
│  └────────────────────────────────────────────────────┘     │
│                                                              │
│  ┌─ 客户 Pod (最近 20) ────────────────────────────────┐     │
│  │ cust-001  gateway ● healthy  agent ● healthy          │     │
│  │ cust-002  gateway ● healthy  agent ● healthy          │     │
│  │ cust-003  gateway ● healthy  agent ⬤ unhealthy  ⚠️    │     │
│  └────────────────────────────────────────────────────┘     │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 3.4 审计日志

```
┌──────────────────────────────────────────────────────────────┐
│  审计日志                              [搜索] [筛选]          │
│──────────────────────────────────────────────────────────────│
│                                                              │
│  筛选: [tenant: all ▼] [action: all ▼] [result: all ▼]       │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ 时间          租户      操作              结果   详情  │  │
│  │────────────────────────────────────────────────────────│  │
│  │ 12:05:23    cust-001  gateway.request   success  ...  │  │
│  │ 12:05:22    cust-003  credits.debit     success  ...  │  │
│  │ 12:05:20    cust-007  gateway.request   denied   402  │  │
│  │ 12:05:18    cust-001  credits.debit     success  ...  │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  今日统计: 成功 12,340  |  拒绝 23  |  错误 0                  │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

## 4. API 契约

### 4.1 租户列表

```
GET /api/tenants?status=active&limit=50&offset=0

Response 200:
{
  "tenants": [
    {
      "id": "cust-001",
      "companyName": "ABC Corp",
      "planTier": "pro",
      "platform": "feishu",
      "status": "active",
      "subscriptionEnd": "2027-07-01T00:00:00Z",
      "createdAt": "2026-07-01T12:00:00Z"
    }
  ],
  "stats": {
    "active": 42,
    "suspended": 3,
    "grace": 1,
    "total": 46
  },
  "total": 46
}
```

### 4.2 Credits 汇总

```
GET /api/credits/summary

Response 200:
{
  "totalBalance": 186500000,
  "totalMonthlyConsumed": 12340000,
  "lowBalanceTenants": 2,       // < 10% 月额度
  "topConsumers": [
    {
      "tenantId": "cust-001",
      "companyName": "ABC Corp",
      "planTier": "pro",
      "balance": 4200000,
      "monthlyAllowance": 5000000,
      "monthlyUsed": 4200000,
      "usagePercent": 84
    }
  ]
}
```

### 4.3 服务健康聚合

```
GET /api/health

Response 200:
{
  "central": {
    "central-gateway": { "healthy": true, "latencyMs": 200 },
    "onboarding-agent": { "healthy": true, "latencyMs": 150 },
    "provisioning": { "healthy": true, "latencyMs": 180 },
    "credits-ledger": { "healthy": true, "latencyMs": 120 },
    "payment-service": { "healthy": true, "latencyMs": 300 },
    "ops-agent": { "healthy": true, "latencyMs": 50 }
  },
  "tenants": [
    {
      "tenantId": "cust-001",
      "gateway": { "healthy": true },
      "agent": { "healthy": true }
    }
  ],
  "updatedAt": "2026-07-26T14:00:00Z"
}
```

### 4.4 审计日志查询

```
GET /api/audit?tenantId=cust-001&action=credits.debit&result=denied&limit=50

Response 200:
{
  "entries": [...],
  "stats": { "success": 12340, "denied": 23, "error": 0 },
  "total": 12363
}
```

### 4.5 支付订单

```
GET /api/orders?status=paid&limit=50

Response 200:
{
  "orders": [
    {
      "id": "order_po_20260726_001",
      "tenantId": "cust-001",
      "productCode": "credits_pack_100k",
      "amountYuan": 10.00,
      "status": "paid",
      "paidAt": "2026-07-26T12:35:00Z"
    }
  ],
  "total": 156
}
```

## 5. 技术实现

### 5.1 架构

```
Admin Dashboard (Express, port 8090)
    │
    ├── GET / (static HTML + JS)
    ├── GET /api/* (JSON API, 聚合后端服务)
    │       │
    │       ├── Tenant Registry ──▶ PostgreSQL
    │       ├── Credits Ledger ───▶ PostgreSQL
    │       ├── Payment Orders ───▶ PostgreSQL
    │       └── curl /healthz ────▶ 各服务
    │
    └── Basic Auth / IP 白名单（仅运维访问）
```

### 5.2 前端：单页 HTML

不引入 React/Vue/构建工具。一个 `index.html` + 原生 JS fetch + 简单的 CSS Grid 表格。

```html
<!-- 核心结构 -->
<div id="app">
  <nav class="tabs">
    <a href="#" data-page="tenants" class="active">租户总览</a>
    <a href="#" data-page="credits">Credits</a>
    <a href="#" data-page="health">服务健康</a>
    <a href="#" data-page="audit">审计</a>
    <a href="#" data-page="orders">订单</a>
  </nav>
  <main id="content"></main>
</div>
```

- 页面切换：纯 JS DOM 渲染（不路由，同页切换 tab）
- 自动刷新：`setInterval(fetchData, 30000)`（租户/Credits/健康页）
- 样式：~200 行内嵌 CSS（深色主题，运维风格）
- 总大小：< 15KB gzipped

### 5.3 后端：Express

```typescript
// packages/admin-dashboard/src/app.ts
import express from 'express';

const app = express();

// Static frontend
app.use(express.static('public'));

// API routes
app.get('/api/tenants', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM tenants ORDER BY created_at DESC');
  res.json({ tenants: rows, stats: computeStats(rows) });
});

app.get('/api/health', async (req, res) => {
  const central = await Promise.all(
    SERVICES.map(async ([name, url]) => {
      const start = Date.now();
      try {
        await fetch(`${url}/healthz`);
        return [name, { healthy: true, latencyMs: Date.now() - start }];
      } catch {
        return [name, { healthy: false }];
      }
    })
  );
  res.json({ central: Object.fromEntries(central), tenants: await getTenantHealth() });
});

app.get('/api/audit', async (req, res) => {
  const { tenantId, action, result, limit = 50 } = req.query;
  const entries = await db.query(
    'SELECT * FROM audit_log WHERE ($1::text IS NULL OR tenant_id = $1) ...',
    [tenantId || null]
  );
  res.json({ entries: entries.rows });
});
```

## 6. 部署规格

```yaml
cpu: 100m
memory: 128Mi
replicas: 1
port: 8090
namespace: dealclaw-system

环境变量:
  DATABASE_URL: postgresql://.../dealclaw
  CENTRAL_GATEWAY_URL: http://central-gateway:8080
  PROVISIONING_URL: http://provisioning:8082
  CREDITS_LEDGER_URL: http://credits-ledger:8081
  BASIC_AUTH_USER: admin
  BASIC_AUTH_PASS: <运维密码>
  ALLOWED_IPS: 10.0.0.0/8   # 仅内网访问
```

## 7. 安全设计

| 防护点 | 措施 |
|--------|------|
| 访问控制 | Basic Auth + IP 白名单（仅内网） |
| 只读操作 | Admin Dashboard 不暴露任何写 API |
| 敏感数据 | 不展示客户 Bot 凭证、API Key |
| SQL 注入 | 全部参数化查询 |
| 暴露面 | 不暴露到公网，仅 K8s 集群内部 Service |

## 8. 后续扩展（不纳入 M0）

- WebSocket 实时推送（Pod 状态变化）
- 图表（Credits 消耗趋势折线图）
- 告警规则配置 UI（Ops Agent 触发阈值）
- 客户 Pod 资源使用（CPU/Mem 实时曲线）
