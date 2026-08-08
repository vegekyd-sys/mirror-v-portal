# 03 — Provisioning Service 系分

> 优先级: P1 | 部署: 中央安全 Pod | 语言: TypeScript + Node.js
> 前置依赖: K8s 集群（王建提供服务器后配置）

## 1. 职责边界

Provisioning Service 是 Onboarding Agent 与 K8s 之间的安全代理。**Onboarding Agent 不能直接调 K8s API**——所有基础设施操作必须通过 Provisioning Service 的严格校验。

```
Onboarding Agent ──▶ POST /v1/tenants          (创建租户)
                   ──▶ GET  /v1/tenants/:id      (查询状态)
                   ──▶ DELETE /v1/tenants/:id    (销毁租户)

Ops Agent         ──▶ GET  /v1/tenants           (列出所有)

内部:
  Provisioning Service ──▶ K8s API (仅 create/read per-tenant agent workload)
                         ──▶ Tenant Registry (PostgreSQL)
```

## 2. API 契约

### 2.1 创建租户运行时

```
POST /v1/tenants
Authorization: Bearer <onboarding-internal-token>
Content-Type: application/json

{
  "companyName": "渤程生物",
  "email": "admin@sh-biochem.com",
  "planTier": "pro",
  "platform": "feishu",
  "botAppId": "cli_xxx",
  "botAppSecret": "<encrypted>",
  "initialCredits": 5000000
}

Response 202:
{
  "ok": true,
  "tenantId": "cust-003",
  "status": "provisioning",
  "runtimeNamespace": "dealclaw-staging",
  "agentService": "dealclaw-agent-cust-003",
  "credentials": {
    "customerKeyRef": "cust-003/api-key",
    "botCredentialRef": "cust-003/bot-cred",
    "creditsAccountId": "credits-cust-003"
  },
  "estimatedReadyAt": "2026-07-26T12:05:00Z"
}

Response 400 (校验失败):
{
  "ok": false,
  "code": "VALIDATION_ERROR",
  "errors": [
    { "field": "companyName", "message": "仅允许中英文+数字+括号，最长50字符" }
  ]
}
```

### 2.2 查询租户状态

```
GET /v1/tenants/{tenantId}

Response 200:
{
  "tenantId": "cust-003",
  "status": "active",             // pending|provisioning|active|suspended|grace|destroyed
  "runtimeNamespace": "dealclaw-staging",
  "agentService": "dealclaw-agent-cust-003",
  "planTier": "pro",
  "platform": "feishu",
  "createdAt": "2026-07-26T12:00:00Z",
  "resources": {
    "cpu": "6",
    "memory": "12Gi",
    "storage": "100Gi",
    "agentReplicas": 3
  },
  "gatewayStatus": "healthy"
}
```

### 2.3 销毁租户

```
DELETE /v1/tenants/{tenantId}
Authorization: Bearer <ops-internal-token>

Response 202:
{
  "ok": true,
  "tenantId": "cust-003",
  "status": "destroying",
  "dataRetentionDays": 90
}
```

## 3. 输入校验规则

```typescript
const VALIDATION_RULES = {
  companyName: {
    pattern: /^[\u4e00-\u9fa5a-zA-Z0-9()（）]{1,50}$/,
    sanitize: (v: string) => v.trim(),
  },
  email: {
    pattern: /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/,
    verifyMx: true,    // DNS MX 记录验证
  },
  planTier: {
    enum: ['starter', 'growth', 'pro', 'team'],
  },
  phone: {
    pattern: /^[+\d][\d]{6,20}$/,
  },
  platform: {
    enum: ['feishu', 'dingtalk', 'wecom'],
  },
  // 白名单模式：拒绝任何不认识的字段
  additionalFields: 'DENY',
};
```

## 4. K8s 操作清单

```yaml
# Provisioning Service 的 K8s RBAC（极有限权限）
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: provisioner-role
  namespace: dealclaw-system
rules:
  # 只允许创建/删除租户级工作负载（同环境 namespace 内）
  - apiGroups: [""]
    resources: ["pods", "services", "secrets", "configmaps"]
    verbs: ["create", "delete", "get", "list"]
  - apiGroups: ["apps"]
    resources: ["deployments", "replicasets"]
    verbs: ["create", "delete", "get", "list", "patch", "update"]
  - apiGroups: ["networking.k8s.io"]
    resources: ["networkpolicies"]
    verbs: ["create", "delete", "get", "list"]
```

## 5. 创建租户流程（时序图）

```
Onboarding Agent    Provisioning Service    Tenant Registry    K8s API
      │                      │                    │               │
      │ POST /v1/tenants     │                    │               │
      │─────────────────────▶│                    │               │
      │                      │──① 参数校验         │               │
      │                      │──② SQL注入清洗      │               │
      │                      │──③ MX验证(可选)     │               │
      │                      │                    │               │
      │                      │──④ INSERT tenant    │               │
      │                      │  (status=pending)  │               │
      │                      │───────────────────▶│               │
      │                      │◀── tenantId ───────│               │
      │                      │                    │               │
      │                      │ UPDATE status=     │               │
      │                      │ provisioning       │               │
      │                      │───────────────────▶│               │
      │                      │                    │               │
      │                      │ CREATE Secret      │               │
      │                      │ (bot cred, api key)│               │
      │                      │──────────────────────────────────▶│
      │                      │◀── ok ────────────────────────────│
      │                      │                    │               │
      │                      │ CREATE NetworkPolicy│              │
      │                      │──────────────────────────────────▶│
      │                      │◀── ok ────────────────────────────│
      │                      │                    │               │
      │                      │ CREATE Gateway Pod │               │
      │                      │ + Agent Pod        │               │
      │                      │──────────────────────────────────▶│
      │                      │◀── ok ────────────────────────────│
      │                      │                    │               │
      │                      │ UPDATE status=     │               │
      │                      │ active             │               │
      │                      │───────────────────▶│               │
      │                      │                    │               │
      │◀── 202 { tenantId } ─│                    │               │
```

## 6. 安全设计

| 风险 | 防护 |
|------|------|
| SQL 注入 | companyName/email 等全部走参数化查询 + 正则清洗 |
| 命令注入 | 拒绝含 `;` `|` `` ` `` `$()` 等字符的输入 |
| K8s API 滥用 | RBAC 仅允许 create namespace+pod，不能 read/modify/delete 其他租户 |
| 超额开通 | 配额检查：总数上限、单日上限、IP 频控 |
| 凭证泄漏 | Bot Secret 写入 K8s Secret，不返回给 Onboarding Agent |
| Onboarding Agent 被注入 | 所有输入白名单校验，无效字段直接拒绝 |

## 7. Tenant Registry Schema

```sql
CREATE TABLE tenants (
    id              VARCHAR(64) PRIMARY KEY,        -- cust-001
    company_name    VARCHAR(50) NOT NULL,
    email           VARCHAR(255),
    plan_tier       VARCHAR(16) NOT NULL,
    platform        VARCHAR(16) NOT NULL,
    runtime_namespace   VARCHAR(128),
    agent_service       VARCHAR(128) UNIQUE,
    status          VARCHAR(16) NOT NULL DEFAULT 'pending',
                    -- pending|provisioning|active|suspended|grace|destroyed
    key_config_ref  VARCHAR(128),
    bot_cred_ref    VARCHAR(128),
    credits_account_id VARCHAR(64),
    
    -- 生命周期时间
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    provisioned_at  TIMESTAMPTZ,
    suspended_at    TIMESTAMPTZ,
    grace_until     TIMESTAMPTZ,
    destroyed_at    TIMESTAMPTZ,
    data_retain_until TIMESTAMPTZ,
    
    metadata        JSONB DEFAULT '{}'
);

CREATE INDEX idx_tenants_status ON tenants(status);
CREATE INDEX idx_tenants_platform ON tenants(platform);
```
