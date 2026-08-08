# DealClaw Nexus 代码审查报告 V2

**审查日期**: 2026-07-29
**审查范围**: 全部 7 个包（`credits-ledger`、`nexus-gateway`、`provisioning-service`、`ops-agent`、`central-gateway`、`dealclaw-agent`、`admin-dashboard`）
**上次审查**: 2026-07-26（V1，覆盖 2 个包，22 项发现）

---

## 总览

本次审查覆盖从 2 个包扩展到 7 个包的全部源码。上次发现的 8 个 Blocker 中，**6 个已修复、1 个部分修复、1 个未修复**。同时新增代码中发现了 **8 个新 Blocker**。

| 严重程度 | V1 数量 | V2 已修复 | V2 新增 | V2 总计 |
|----------|---------|-----------|---------|---------|
| 🔴 Blocker | 8 | 6 | 8 | 10 |
| 🟡 Suggestion | 9 | 4 | 9 | 14 |
| 💭 Nit | 5 | 2 | 0 | 3 |

---

## V1 Blocker 修复状态

| 编号 | 问题 | 状态 | 说明 |
|------|------|------|------|
| B1 | debit/credit TOCTOU 竞态条件 | ✅ 已修复 | 使用 `BEGIN` + `SELECT FOR UPDATE` + `COMMIT` 事务 |
| B2 | credit 端点认证反转 | ✅ 已修复 | 先检查 `!token`，再检查 `!expectedToken` 返回 503 |
| B3 | Gateway 余额存内存 Map | ✅ 已修复 | 改为 HTTP 调用 credits-ledger API |
| B4 | 身份认证无签名验证 | ⚠️ 部分修复 | 飞书签名已实现，但 `botSecret` 未配置时仍放行 |
| B5 | Agent fetch 无超时 | ✅ 已修复 | 使用 `AbortSignal.timeout(30_000)` |
| B6 | 月度重置逻辑缺失 | ✅ 已修复 | debit 内自动重置 + 独立 `monthly-reset.ts` 服务 |
| B7 | debit 未校验月度额度 | ✅ 已修复 | 新增 `monthly_used + amount > monthly_allowance` 检查 |
| B8 | 全局错误处理缺失 | ✅ 已修复 | 添加 Express 错误中间件 |

---

## 🔴 Blocker（必须修复）

### 来自 V1 未完全修复的问题

---

### B4-续. 身份认证在 botSecret 未配置时完全放行

**文件**: `packages/nexus-gateway/src/middleware/identity.ts` 第 77 行

**问题**: `verifyFeishuSignature` 第一行：

```typescript
if (!TENANT_CONFIG?.botSecret) return true;
```

生产环境如果忘记配置 `DEALCLAW_BOT_SECRET`，网关接受所有请求，无需签名验证。这与 V1 的 B2 是同一反模式——"未配置 = 放行"。

此外，第 40 行注释 `// TODO: DingTalk / WeCom signature verification` 意味着钉钉和企业微信平台**完全没有签名验证**。

**影响**: 忘记配置环境变量 = 认证完全绕过。

**建议**: 未配置 `botSecret` 时应拒绝请求（类似 B2 的修复方式），或至少在生产环境强制要求配置。DingTalk/WeCom 也需实现各自的签名验证。

---

### NB1. admin monthly-reset 端点认证绕过（与 B2 同一模式）

**文件**: `packages/credits-ledger/src/app.ts` 第 31 行

**问题**:

```typescript
if (expectedToken && token !== expectedToken) {
  res.status(401).json({ code: 'UNAUTHORIZED', message: 'Invalid admin token' });
  return;
}
```

当 `ADMIN_API_TOKEN` 未配置时，`expectedToken` 为 `undefined`，整个条件短路为 `false`，任何人都可以触发月度重置。

**影响**: 任何人可以触发所有租户的月度额度重置，导致 `monthly_used` 被清零。

**建议**: 与 B2 修复方式一致——未配置时返回 503。

---

### NB2. provisioning-service 全部端点无认证

**文件**: `packages/provisioning-service/src/app.ts`、`routes/tenants.ts`

**问题**: 所有端点（创建/列表/查看/删除租户、更新状态）完全没有认证。配合 `app.use(cors())`（开放所有源），任何能访问该服务的人都可以：
- 创建任意数量租户
- 删除租户并销毁 K8s 资源
- 修改租户状态

**影响**: 完全的未授权访问，可创建/删除租户、操作 K8s 资源。

**建议**: 添加认证中间件（Bearer Token 或 mTLS），限制 CORS 来源。

---

### NB3. admin-dashboard 全部 API 无认证

**文件**: `packages/admin-dashboard/src/routes/api.ts`

**问题**: 所有 API 端点（租户列表、Credits 汇总、审计日志、订单列表）完全无认证。管理员后台的数据对任何人都开放。

**影响**: 租户信息、余额数据、审计日志泄露。

**建议**: 至少添加基础认证（Basic Auth）或 session-based 认证。

---

### NB4. ops-agent 破坏性端点无认证

**文件**: `packages/ops-agent/src/app.ts`

**问题**: `POST /v1/ops/cron` 可触发完整的 cron 循环（包括 pod 挂起/销毁操作），`POST /v1/ops/scan` 和 `POST /v1/ops/check` 也无认证。

**影响**: 任何人可触发租户 pod 挂起/销毁。

**建议**: 添加内部服务间认证。

---

### NB5. MONTHLY_LIMIT_EXCEEDED 未在路由处理中处理

**文件**: `packages/credits-ledger/src/routes/accounts.ts` 第 47-58 行

**问题**: `debit` 函数新增了 `MONTHLY_LIMIT_EXCEEDED` 返回类型，但路由处理器只检查 `ACCOUNT_NOT_FOUND` 和 `INSUFFICIENT_CREDITS`。当月度额度超限时，错误对象会以 **HTTP 200** 返回：

```typescript
// 缺少这个分支：
if ('code' in result && result.code === 'MONTHLY_LIMIT_EXCEEDED') {
  res.status(402).json({ ... });
  return;
}
```

**影响**: 客户端收到 200 状态码但实际是错误，导致逻辑混乱。

**建议**: 添加 `MONTHLY_LIMIT_EXCEEDED` 的处理分支，返回 402 或 429。

---

### NB6. 飞书签名验证因 body 重新序列化而失效

**文件**: `packages/nexus-gateway/src/middleware/identity.ts` 第 90 行

**问题**:

```typescript
const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
```

Express 的 `express.json()` 中间件会将请求体解析为 JS 对象。`JSON.stringify(req.body)` 重新序列化后的字符串可能与原始请求体不同（键顺序、空格、Unicode 转义等差异）。飞书签名的是**原始请求体**，因此签名验证会失败。

**影响**: 合法的飞书请求可能被拒绝（签名不匹配），导致网关无法正常工作。

**建议**: 使用 `express.json({ verify: (req, buf) => { req.rawBody = buf; } })` 保留原始请求体，用于签名验证。

---

### NB7. Credits 检查 fail-open — 用户可绕过付费

**文件**: `packages/nexus-gateway/src/app.ts` 第 137-141 行、第 157-162 行

**问题**: `creditsCheckMiddleware` 在 credits-ledger 不可达时 fail-open：

```typescript
// Fail open with warning in M0
(req as any).creditsCheck = { remaining: -1, required: cost, ... };
next();
```

同时，Agent 执行成功后的扣款（第 85-88 行）是 fire-and-forget，如果扣款失败只记录日志不阻止响应。两个环节都 fail-open 意味着：ledger 宕机 = 用户免费使用 Agent。

**影响**: credits-ledger 故障期间，所有用户可免费使用 Agent，产生收入损失。

**建议**: 至少在 M1 阶段改为 fail-close（ledger 不可达时拒绝请求）。如果必须 fail-open，应记录未扣款的请求以便后续补扣。

---

### NB8. central-gateway 无认证、无限流

**文件**: `packages/central-gateway/src/app.ts`

**问题**: `POST /onboard/start` 端点无认证、无限流。攻击者可以自动化创建大量租户，每个租户都会触发 K8s 资源开通。

**影响**: 资源耗尽攻击——创建大量无意义租户消耗 K8s 集群资源。

**建议**: 添加速率限制和认证（如验证码、API Key）。

---

## 🟡 Suggestion（建议修复）

### 来自 V1 未修复的问题

---

### S1. getHistory 的 limit 参数仍未校验

**文件**: `packages/credits-ledger/src/routes/accounts.ts` 第 115 行

**状态**: ❌ 未修复。`Number(req.query.limit)` 仍可能是 NaN 或极大值。

---

### S2. getHistory 仍执行两次独立查询

**文件**: `packages/credits-ledger/src/services/account.ts` 第 261-272 行

**状态**: ❌ 未修复。仍先查数据再 COUNT。

---

### S6. Gateway 请求体未校验

**文件**: `packages/nexus-gateway/src/app.ts` 第 35-42 行

**状态**: ❌ 未修复。任意 JSON 直接转发给 Agent。

---

### S9. 连接池大小仍硬编码

**文件**: `packages/credits-ledger/src/db/pool.ts` 第 11 行

**状态**: ❌ 未修复。`max: 10` 仍硬编码。

---

### 新发现的 Suggestion

---

### NS1. 死代码 — 旧 credits.ts 中间件仍存在

**文件**: `packages/nexus-gateway/src/middleware/credits.ts`

`app.ts` 已不再 import 此文件，但 `MOCK_BALANCES` Map 和 `creditsMiddleware`/`debitCredits` 函数仍存在。应删除以避免混淆。

---

### NS2. 租户 ID 仅 8 位十六进制（32 位熵）

**文件**: `packages/provisioning-service/src/routes/tenants.ts` 第 32 行

```typescript
const tenantId = uuidv4().slice(0, 8);
```

32 位熵意味着约 65,000 次尝试有 50% 概率命中有效 ID。应使用完整 UUID。

---

### NS3. provisioning-service 创建/删除租户无事务

**文件**: `packages/provisioning-service/src/routes/tenants.ts` 第 37-56 行、第 186-196 行

创建租户时：INSERT tenant → INSERT status_log → provisionTenant。如果 provisionTenant 失败，DB 中已有租户记录但 K8s 资源未创建。删除时同理：deprovision → UPDATE → INSERT 无事务。

**建议**: 将 DB 操作包裹在事务中，K8s 操作失败时回滚。

---

### NS4. ops-agent cron 逐个查询 credits 余额

**文件**: `packages/ops-agent/src/services/credits-check.ts` 第 54-60 行

`enrichWithCredits` 对每个租户发起一个独立的 HTTP 请求。虽然使用 `Promise.allSettled` 并行，但租户数量多时会压垮 credits-ledger。

**建议**: 实现 credits-ledger 批量查询端点（如 `POST /v1/accounts/batch-balance`）。

---

### NS5. sceneHeaders 缓存未按 tier 区分

**文件**: `packages/nexus-gateway/src/middleware/scene.ts` 第 35-40 行

```typescript
let _cachedScenes: string | null = null;
export function sceneHeaders(tier: PlanTier): string {
  if (!_cachedScenes) {
    _cachedScenes = PLAN_SCENES[tier].join(',');
  }
  return _cachedScenes;
}
```

首次调用后缓存永不更新。如果 tier 参数变化（虽然当前每 Pod 单 tier 不会发生），会返回错误结果。函数签名有 `tier` 参数但实际忽略它，API 设计有误导性。

---

### NS6. 状态机提醒使用精确天数匹配

**文件**: `packages/ops-agent/src/services/state-machine.ts` 第 89-95 行

```typescript
if (daysUntilExpiry === 7) { ... }
else if (daysUntilExpiry === 3) { ... }
else if (daysUntilExpiry === 1) { ... }
```

如果 cron 当天未运行（宕机、维护），提醒永远不会发送。应改为 `<=` 并记录已发送的提醒。

---

### NS7. admin-dashboard 和 credits-ledger 的 db.ts 仍有硬编码密码

**文件**: `packages/admin-dashboard/src/routes/db.ts` 第 10 行、`packages/credits-ledger/src/db/pool.ts` 第 10 行

```typescript
connectionString: process.env.DATABASE_URL || 'postgresql://postgres:***@localhost:5432/dealclaw_test'
```

**建议**: 移除默认值，强制通过环境变量提供。

---

### NS8. 租户列表端点无分页

**文件**: `packages/provisioning-service/src/routes/tenants.ts` 第 139-163 行、`packages/admin-dashboard/src/routes/api.ts` 第 7-30 行

两个端点都 `LIMIT 100` 无 offset/分页参数。租户超过 100 个后无法查看旧数据。

---

### NS9. admin-dashboard credits summary 使用 SELECT *

**文件**: `packages/admin-dashboard/src/routes/api.ts` 第 35-36 行

```typescript
const { rows: accts } = await query('SELECT * FROM credits_accounts ORDER BY balance DESC');
```

查询所有账户的所有字段，但只用了一部分。租户数量多时会拉取大量不必要数据。

---

## 💭 Nit

### N1. plan 配置仍用全局变量

**文件**: `packages/nexus-gateway/src/middleware/scene.ts` 第 29 行

`DEFAULT_PLAN` 仍是模块级可变变量。

### N4. 测试仍依赖真实数据库

V1 标记的问题未变化。

### N5. pool.ts 硬编码密码

V1 标记的问题未变化（与 NS7 重复）。

---

## 修复优先级建议

| 优先级 | 问题编号 | 修复内容 |
|--------|----------|----------|
| **P0 立即** | NB2, NB3, NB4, NB8 | 4 个新服务全部缺少认证 — 任何人可操作 |
| **P0 立即** | NB1, B4-续 | admin monthly-reset 认证绕过 + botSecret 未配置时放行 |
| **P0 立即** | NB5 | MONTHLY_LIMIT_EXCEEDED 返回 200 而非错误码 |
| **P1 本周** | NB6 | 签名验证因 body 重序列化失效 |
| **P1 本周** | NB7 | Credits fail-open 导致免费使用 |
| **P1 本周** | NS1, NS2, NS3 | 清理死代码、加长 ID、加事务 |
| **P2 本迭代** | S1, S2, S6, S9 | V1 遗留未修复项 |
| **P2 本迭代** | NS4-NS9 | 性能优化与分页 |
| **P3 下迭代** | N1, N4, N5 | 代码质量改进 |

---

## 值得表扬的改进

- **debit/credit 事务化**：`SELECT FOR UPDATE` + `BEGIN/COMMIT` + `ROLLBACK` on error，是教科书级别的修复
- **monthly-reset 服务**：`FOR UPDATE SKIP LOCKED` 避免死锁、double-check under lock、审计日志记录，设计很专业
- **飞书签名验证**：使用了 `timingSafeEqual` 防时序攻击、5 分钟时间窗防重放
- **Agent 请求超时**：正确使用 `AbortSignal.timeout`
- **限流中间件**：globalLimiter + agentLimiter 分层限流
- **输入清理**：provisioning-service 对公司名做了 HTML 字符过滤、长度限制
