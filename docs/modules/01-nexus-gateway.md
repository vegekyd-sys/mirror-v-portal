# 01 — Nexus Agent Gateway 系分

> 优先级: P0 | 部署: 客户 Pod 内 | 语言: TypeScript + Node.js

## 1. 职责边界

```
Bot webhook ──▶ [Gateway] ──▶ DealClaw Agent
                   │
                   ├── ① 身份鉴权 (验证 Bot 签名/Token → tenant_id)
                   ├── ② Key 配置注入 (从 K8s Secret 读取，注入 header)
                   ├── ③ Credits 校验 (余额 → 不足则 402)
                   ├── ④ 场景解锁 (套餐 tier → 能力开关)
                   ├── ⑤ 请求转发 (注入 context header → Agent)
                   └── ⑥ 审计记录 (每次请求写 audit_log)
```

**Gateway 不负责的事**: 支付订单创建、Key 生命周期管理、客户数据存储、Agent 业务逻辑。

## 2. API 契约

### 2.1 健康检查

```
GET /healthz
→ 200 { "ok": true, "service": "nexus-gateway", "tenantId": "cust-001" }
```

### 2.2 Agent 请求入口

```
POST /v1/agent/execute
Content-Type: application/json

Request Body:
{
  "platformMessageId": "om_xxx",       // IM 平台消息 ID
  "platformUserId": "ou_xxx",          // IM 用户 ID
  "intent": {
    "kind": "chat" | "command" | "query" | "action",
    "text": "查一下 ABC Corp 的公司信息", // chat 时必填
    "action": "lead_search",             // command/action 时必填
    "args": { "company": "ABC Corp" },   // 可选参数
    "resource": "company",               // query 时必填
    "filters": { "name": "ABC Corp" }    // query 可选
  },
  "scene": "lead"                       // 可选，不填则不检查场景权限
}

Response (Gateway 校验通过，转发 Agent):
→ Agent 响应透传（状态码 + body）

Response (Gateway 拦截):
→ 401 { "code": "UNAUTHORIZED", "message": "..." }
→ 402 { "code": "INSUFFICIENT_CREDITS", "message": "...", "detail": "Account: credits-cust-001" }
→ 403 { "code": "SCENE_LOCKED", "message": "Scene 'expo' not available on starter plan" }
→ 429 { "code": "RATE_LIMITED", "message": "..." }
→ 503 { "code": "TENANT_SUSPENDED", "message": "..." }
```

### 2.3 Gateway 注入的 Context Header（转发到 Agent）

```http
POST /execute HTTP/1.1
Host: dealclaw-agent:18789
Content-Type: application/json
X-DealClaw-Tenant-ID: cust-001
X-DealClaw-User-ID: ou_xxx
X-DealClaw-Key-Config-Ref: cust-001/api-key
X-DealClaw-Credits-Remaining: 3800000
X-DealClaw-Scene-Unlocked: lead,email,expo,research
X-DealClaw-Plan-Tier: pro
```

## 3. 时序图

### 3.1 正常请求流程

```
客户(Bot)    Nexus Agent Gateway       Credits Ledger      DealClaw Agent
  │                  │                      │                    │
  │ POST /v1/agent/  │                      │                    │
  │─────────────────▶│                      │                    │
  │                  │──① 验证 Bot 签名      │                    │
  │                  │──② 解析 tenant_id     │                    │
  │                  │──③ 检查场景权限        │                    │
  │                  │                      │                    │
  │                  │──④ GET /balance/{id}  │                    │
  │                  │─────────────────────▶│                    │
  │                  │◀──── 3800000 ────────│                    │
  │                  │                      │                    │
  │                  │──⑤ 余额 >= cost? ✅   │                    │
  │                  │                      │                    │
  │                  │ POST /execute        │                    │
  │                  │ (+ gateway headers)  │                    │
  │                  │─────────────────────────────────────────▶│
  │                  │                      │                    │
  │                  │◀──── Agent 响应 ─────────────────────────│
  │                  │                      │                    │
  │                  │──⑥ POST /debit       │                    │
  │                  │─────────────────────▶│                    │
  │                  │◀──── 3798000 ────────│                    │
  │                  │                      │                    │
  │                  │──⑦ 写 audit_log      │                    │
  │                  │                      │                    │
  │◀── Agent 响应 ───│                      │                    │
  │                  │                      │                    │
```

### 3.2 Credits 不足 → 充值 → 重试

```
客户(Bot)    Nexus Agent Gateway      Credits Ledger   DealClaw Agent   Payment Service
  │                  │                      │                │                │
  │ POST /v1/agent/  │                      │                │                │
  │─────────────────▶│                      │                │                │
  │                  │──GET /balance         │                │                │
  │                  │─────────────────────▶│                │                │
  │                  │◀──── 500 (不足) ─────│                │                │
  │                  │                      │                │                │
  │◀── 402 Insufficient ──│                 │                │                │
  │   (need 2000, have 500)                 │                │                │
  │                  │                      │                │                │
  │ Agent 调用充值CLI │                      │                │                │
  │─────────────────────────────────────────────────────────▶│                │
  │                  │                      │                │ POST /order    │
  │                  │                      │                │───────────────▶│
  │                  │                      │                │◀── pay_url ───│
  │◀── "请点击链接支付" ─────────────────────────────────────│                │
  │                  │                      │                │                │
  │ 客户在第三方支付台付款...                                                     │
  │                  │                      │                │                │
  │                  │                      │◀── 支付宝回调 ─────────────────────│
  │                  │                      │ POST /callback                   │
  │                  │                      │ balance += 100000                │
  │                  │                      │                │                │
  │ 客户重试原请求     │                      │                │                │
  │ POST /v1/agent/  │                      │                │                │
  │─────────────────▶│                      │                │                │
  │                  │──GET /balance         │                │                │
  │                  │─────────────────────▶│                │                │
  │                  │◀──── 100500 ✅ ──────│                │                │
  │                  │──────────────────────────────────────▶│                │
  │                  │◀──── Agent 响应 ──────────────────────│                │
  │◀── 结果 ────────│                      │                │                │
```

## 4. Gateway 处理管道（代码级）

```typescript
// 请求管道: 中间件链式执行，任一失败即返回错误
const pipeline = [
  identityMiddleware,      // ① 验证身份 → tenantContext
  keyConfigMiddleware,     // ② 读取 Key 配置
  sceneMiddleware,         // ③ 检查场景权限
  rateLimitMiddleware,     // ④ 频率限制
  creditsMiddleware,       // ⑤ Credits 检查
  agentForwardHandler,     // ⑥ 转发 Agent + 扣减 + 审计
];
```

### Credits 成本映射

| Intent Kind | Credits 消耗 | 说明 |
|-------------|-------------|------|
| chat | 0 | 自然对话免费 |
| command | 5000 | 结构化命令 |
| query/lead_search | 2000 | 数据查询 |
| action/email_send | 8000 | 邮件发送 |
| action/lead_generation | 16000 | 线索生成 |
| action/expo_followup | 30000 | 展后跟进 |

## 5. 部署规格

```yaml
# 单实例资源
cpu: 100m
memory: 128Mi
replicas: 1 (per tenant)

# 环境变量（K8s Secret 注入）
DEALCLAW_TENANT_ID: cust-001
DEALCLAW_PLATFORM: feishu
DEALCLAW_PLAN_TIER: pro
DEALCLAW_AGENT_URL: http://dealclaw-agent.cust-001:18789
DEALCLAW_CUSTOMER_KEY_REF: cust-001/api-key
DEALCLAW_BOT_CREDENTIAL_REF: cust-001/bot-cred
DEALCLAW_CREDITS_ACCOUNT_ID: credits-cust-001
DEALCLAW_INITIAL_CREDITS: 5000000
```

## 6. 已实现文件（Git: packages/nexus-gateway/）

| 文件 | 职责 |
|------|------|
| `src/types/index.ts` | 核心类型定义 (TenantContext, CreditsCheckResult, GatewayError 等) |
| `src/middleware/identity.ts` | 身份鉴权中间件 |
| `src/middleware/credits.ts` | Credits 检查 + 扣减 |
| `src/middleware/scene.ts` | 场景/套餐权限 |
| `src/config.ts` | 环境变量加载 |
| `src/app.ts` | Express 应用组装 |
| `src/index.ts` | 入口 |
| `Dockerfile` | 容器化 |

**待实现**: rateLimitMiddleware, audit log 写入, Credits Ledger 远程调用（当前 mock），单元测试。
