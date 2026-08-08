# DealClaw Nexus 代码审查报告

**审查日期**: 2026-07-26
**审查范围**: `packages/credits-ledger`、`packages/nexus-gateway` 全部 TS 源文件
**审查重点**: 性能瓶颈与潜在 Bug

---

## 总览

| 严重程度 | 数量 | 说明 |
|----------|------|------|
| 🔴 Blocker | 8 | 必须在上线前修复，涉及数据安全、竞态条件、认证绕过 |
| 🟡 Suggestion | 9 | 建议在当前迭代内处理，涉及性能、输入验证、健壮性 |
| 💭 Nit | 5 | 改进建议，涉及代码质量与可维护性 |

---

## 🔴 Blocker（必须修复）

### B1. debit/credit 操作存在 TOCTOU 竞态条件

**文件**: `packages/credits-ledger/src/services/account.ts` 第 90-134 行（debit）、第 155-186 行（credit）

**问题**: `debit` 函数分三步执行，且不在同一个数据库事务中：

1. 查询 idempotency_key 是否已存在（第 90-96 行）
2. 执行 `UPDATE ... WHERE balance >= amount RETURNING`（第 99-108 行）
3. 插入 transaction 记录（第 129-134 行）

两个并发请求携带相同的 `idempotencyKey` 时，可能同时通过第 1 步的幂等检查，然后都执行第 2 步扣款。虽然第 3 步的唯一约束会阻止重复插入，但余额已被扣除两次，且第二个请求会抛出未捕获的 unique constraint 异常。

`credit` 函数存在完全相同的问题。

**影响**: 重复扣款/充值、数据不一致、未处理的异常导致 500 错误。

**建议**: 将整个操作包裹在 `BEGIN ... COMMIT` 事务中，并使用 `SELECT ... FOR UPDATE` 锁定账户行：

```typescript
const client = await getPool().connect();
try {
  await client.query('BEGIN');
  // 使用 SELECT FOR UPDATE 锁定行
  const account = await client.query(
    'SELECT balance FROM credits_accounts WHERE id = $1 FOR UPDATE',
    [accountId]
  );
  if (account.rows.length === 0) {
    await client.query('ROLLBACK');
    return { ok: false, code: 'ACCOUNT_NOT_FOUND' };
  }
  // 幂等检查
  const existing = await client.query(
    'SELECT id FROM credits_transactions WHERE idempotency_key = $1',
    [idempotencyKey]
  );
  if (existing.rows.length > 0) {
    await client.query('ROLLBACK');
    return { ok: true, idempotent: true, transactionId: existing.rows[0].id };
  }
  // 执行扣款
  // ... UPDATE + INSERT ...
  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  client.release();
}
```

---

### B2. credit 端点认证逻辑反转 — 未配置 Token 时任意 Token 均可通过

**文件**: `packages/credits-ledger/src/routes/accounts.ts` 第 69-75 行

**问题**:

```typescript
const expectedToken = process.env.PAYMENT_SERVICE_TOKEN;
if (!token || (expectedToken && token !== expectedToken)) {
  res.status(401).json({ code: 'UNAUTHORIZED', message: 'Invalid token' });
  return;
}
```

当 `PAYMENT_SERVICE_TOKEN` 环境变量未设置时，`expectedToken` 为 `undefined`，表达式 `(expectedToken && token !== expectedToken)` 短路为 `false`。此时只要请求携带任意非空 `Authorization` 头，就能通过认证。

注释写的是"Require auth when no explicit token configured for testing"，但实际行为恰恰相反 — 未配置时反而放行。

**影响**: 生产环境如果忘记配置 `PAYMENT_SERVICE_TOKEN`，任何人都可以调用 `/credit` 端点给任意账户充值。

**建议**: 未配置 Token 时应直接拒绝所有请求，而非放行：

```typescript
const expectedToken = process.env.PAYMENT_SERVICE_TOKEN;
if (!expectedToken) {
  console.error('PAYMENT_SERVICE_TOKEN is not configured');
  res.status(503).json({ code: 'SERVICE_UNAVAILABLE', message: 'Payment service not configured' });
  return;
}
if (!token || token !== expectedToken) {
  res.status(401).json({ code: 'UNAUTHORIZED', message: 'Invalid token' });
  return;
}
```

---

### B3. nexus-gateway 余额存储在进程内存中 — 重启即丢失

**文件**: `packages/nexus-gateway/src/middleware/credits.ts` 第 24 行、第 47 行、第 75-77 行

**问题**: 余额使用 `const MOCK_BALANCES: Map<string, number>` 存储。代码注释说"In production: reads from the credits ledger service"，但这就是实际运行的代码。进程重启后余额归零，多 Pod 部署时各 Pod 余额不一致。

`debitCredits` 使用 `Math.max(0, current - amount)` 防止负数，但这意味着用户可以通过并发请求超额消费 — 多个请求同时通过余额检查，然后各自扣减，实际消耗远超余额。

**影响**: 余额数据丢失、多 Pod 数据不一致、用户可通过并发请求免费使用 Agent。

**建议**: Gateway 应调用 credits-ledger 服务的 API 进行余额检查和扣款，而非使用内存 Map。至少在扣款时使用原子操作：

```typescript
// 调用 credits-ledger 的 debit API
const response = await fetch(`${CREDITS_LEDGER_URL}/v1/accounts/${accountId}/debit`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${INTERNAL_TOKEN}` },
  body: JSON.stringify({ amount: cost, reference, idempotencyKey }),
});
```

---

### B4. 身份认证中间件未验证平台签名 — 可伪造任意用户身份

**文件**: `packages/nexus-gateway/src/middleware/identity.ts` 第 35-44 行、第 61-71 行

**问题**: 注释写"Verify platform signature / token"，但 `extractPlatformUserId` 只是直接从 HTTP 头 `x-feishu-user-id` 或请求体 `body.senderId` 读取用户 ID，没有任何签名验证或 Token 校验。攻击者只需设置 `x-feishu-user-id: any_user_id` 即可冒充任意用户。

此外，`allowedAppIds` 在 `app.ts` 第 14 行初始化为空数组 `[]`，且从未在中间件中被检查。

**影响**: 完全的认证绕过，任何人可以冒充任意租户用户调用 Agent。

**建议**:
- 对飞书请求验证 webhook 签名（使用 `X-Lark-Signature` 头 + app secret 计算 HMAC）
- 对钉钉请求验证 `X-DingTalk-Signature` 头
- 校验 `allowedAppIds` 是否包含请求来源的 App ID

---

### B5. Agent 请求无超时 — 可能无限挂起

**文件**: `packages/nexus-gateway/src/app.ts` 第 39-51 行

**问题**: `fetch` 调用 DealClaw Agent 时没有设置超时。如果 Agent 响应缓慢或挂起，Gateway 的请求线程会一直等待，最终耗尽连接池。

```typescript
const response = await fetch(`${config.agentUrl.replace(/\/$/, '')}/execute`, {
  method: 'POST',
  // 没有 signal / timeout
  ...
});
```

**影响**: Agent 故障可引发 Gateway 雪崩，所有请求挂起。

**建议**: 使用 `AbortSignal.timeout()` 设置超时：

```typescript
const response = await fetch(url, {
  method: 'POST',
  signal: AbortSignal.timeout(30000), // 30 秒超时
  ...
});
```

---

### B6. 月度额度重置逻辑完全缺失

**文件**: `packages/credits-ledger/src/services/account.ts`、`packages/credits-ledger/src/db/migrate.ts`

**问题**: 数据库 schema 中有 `month_reset_at` 字段，`debit` 操作会递增 `monthly_used`，但代码中没有任何逻辑检查 `month_reset_at` 是否已过期、也没有重置 `monthly_used` 的逻辑。`createAccount` 设置 `month_reset_at` 为下月第一天，但此后永远不会更新。

**影响**: 用户的月度使用量会无限增长，永远不会被重置。`monthly_allowance` 形同虚设。

**建议**:
- 在 `debit` 操作中检查 `month_reset_at < NOW()`，如果是则先重置 `monthly_used = 0` 并更新 `month_reset_at`
- 或添加定时任务（cron）在每月初执行重置

```sql
UPDATE credits_accounts
SET monthly_used = 0,
    month_reset_at = date_trunc('month', NOW()) + INTERVAL '1 month'
WHERE month_reset_at < NOW()
```

---

### B7. debit 未校验月度额度上限

**文件**: `packages/credits-ledger/src/services/account.ts` 第 99-108 行

**问题**: `debit` 的 SQL 只检查 `balance >= amount`，没有检查 `monthly_used + amount <= monthly_allowance`。用户可以在一个月内消耗远超月度额度的 Credits，只要总余额够。

```sql
UPDATE credits_accounts
SET balance = balance - $2,
    monthly_used = monthly_used + $2,
    lifetime_consumed = lifetime_consumed + $2,
    updated_at = NOW()
WHERE id = $1 AND balance >= $2
```

**影响**: 月度额度限制形同虚设，无法防止用户在某个月内异常大量消耗。

**建议**: 如果 `monthly_allowance` 是硬限制，应在 WHERE 条件中加上月度检查：

```sql
WHERE id = $1 AND balance >= $2
  AND monthly_used + $2 <= monthly_allowance
```

或根据产品设计决定是否为软限制（仅告警不阻止）。

---

### B8. credits-ledger 全局错误处理缺失 — 未捕获的异步异常会导致进程崩溃

**文件**: `packages/credits-ledger/src/app.ts`

**问题**: Express app 没有注册全局错误处理中间件。虽然每个路由都有 try/catch，但如果中间件链中抛出未捕获的异步异常（例如 `express.json()` 解析异常、或未来新增中间件的 bug），Express 4.x 不会自动捕获，会导致进程崩溃。

此外，`index.ts` 没有注册 `process.on('uncaughtException')` 和 `process.on('unhandledRejection')` 处理器。

**影响**: 单个异常请求可能导致整个服务崩溃。

**建议**:

```typescript
// app.ts — 在所有路由之后注册错误处理中间件
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ code: 'INTERNAL', message: 'Internal server error' });
});

// index.ts — 进程级错误处理
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});
```

---

## 🟡 Suggestion（建议修复）

### S1. getHistory 的 limit 参数未校验 — 可拖垮数据库

**文件**: `packages/credits-ledger/src/routes/accounts.ts` 第 106 行

**问题**: `Number(req.query.limit)` 可能是 `NaN`（如 `?limit=abc`）或极大值（如 `?limit=999999999`）。`NaN` 会导致 pg 报错，极大值会导致查询返回过多数据。

**建议**: 校验并限制范围：

```typescript
const rawLimit = req.query.limit ? Number(req.query.limit) : 50;
const limit = Number.isNaN(rawLimit) ? 50 : Math.min(Math.max(1, rawLimit), 200);
```

---

### S2. getHistory 执行两次独立查询 — 可合并

**文件**: `packages/credits-ledger/src/services/account.ts` 第 210-237 行

**问题**: 先查询分页数据，再执行 `COUNT(*)` 查询总数。两次查询之间数据可能已变化，且多一次数据库往返。

**建议**: 使用窗口函数合并为一次查询：

```sql
SELECT *, COUNT(*) OVER() AS total_count
FROM credits_transactions
WHERE ...
ORDER BY created_at DESC
LIMIT $n
```

---

### S3. getUsage 执行两次独立查询 — 可合并

**文件**: `packages/credits-ledger/src/services/account.ts` 第 241-261 行

**问题**: 先查询 `credits_monthly_usage` 表，再查询 `credits_accounts` 表。两次查询可合并为一次 JOIN。

**建议**:

```sql
SELECT a.monthly_allowance, a.monthly_used,
       u.category, u.total_used, u.call_count
FROM credits_accounts a
LEFT JOIN credits_monthly_usage u
  ON u.account_id = a.id AND u.month = $2
WHERE a.id = $1
```

---

### S4. getBalance 通过 SELECT * 获取全部字段 — 查询了不必要的列

**文件**: `packages/credits-ledger/src/services/account.ts` 第 46 行、第 58 行

**问题**: `getAccount` 使用 `SELECT *`，但 `getBalance` 只需要 `id, balance, plan_tier, monthly_allowance, monthly_used, updated_at` 几个字段。查询了 `lifetime_credited`、`lifetime_consumed`、`tenant_id` 等不必要的列。

**建议**: 为 `getBalance` 编写专用查询，只 SELECT 需要的列。

---

### S5. Transaction ID 生成方式熵不足 — 高并发下可能碰撞

**文件**: `packages/credits-ledger/src/services/account.ts` 第 128 行、第 180 行

**问题**: `txn_${Date.now()}_${Math.random().toString(36).slice(2, 9)}` — `Date.now()` 是毫秒精度，`Math.random().toString(36).slice(2, 9)` 只有约 36 位熵（约 7 字符）。在高并发场景下，同一毫秒内的碰撞概率不可忽略。

**建议**: 使用 `crypto.randomUUID()`（Node.js 19+ 内置）或 ULID。

---

### S6. nexus-gateway 无请求体校验 — 任意 JSON 直接转发给 Agent

**文件**: `packages/nexus-gateway/src/app.ts` 第 29-51 行

**问题**: `/v1/agent/execute` 端点接受任意 JSON body 并直接转发给 Agent。没有 schema 验证，恶意请求可以注入任意字段。

**建议**: 定义请求体 schema 并使用 zod 或类似库验证：

```typescript
const ExecuteSchema = z.object({
  intent: z.object({
    kind: z.enum(['chat', 'command', 'query', 'action']),
    // ... 根据 kind 验证不同字段
  }),
  scene: z.string().optional(),
});
```

---

### S7. nexus-gateway 扣款在 Agent 执行后 — 失败时无错误处理

**文件**: `packages/nexus-gateway/src/app.ts` 第 54-55 行

**问题**: `debitCredits` 是同步函数，但如果未来改为调用 credits-ledger API（异步），当前的代码没有 await 也没有 try/catch。即使 Agent 返回成功但扣款失败，用户得不到任何错误提示，且 Agent 已经执行了。

**建议**: 扣款失败时应记录日志并返回错误，或在 Agent 执行前预扣款（两阶段提交模式）。

---

### S8. 健康检查不验证数据库连通性

**文件**: `packages/credits-ledger/src/app.ts` 第 13-15 行

**问题**: `/healthz` 始终返回 `{ ok: true }`，不检查数据库是否可达。K8s readiness probe 会认为服务健康，但实际上数据库连接已断开。

**建议**:

```typescript
app.get('/healthz', async (_req, res) => {
  try {
    await query('SELECT 1');
    res.json({ ok: true, service: 'credits-ledger' });
  } catch {
    res.status(503).json({ ok: false, message: 'Database unavailable' });
  }
});
```

---

### S9. 数据库连接池大小固定为 10 — 多租户场景下可能不足

**文件**: `packages/credits-ledger/src/db/pool.ts` 第 11 行

**问题**: `max: 10` 是硬编码值。作为多租户平台的共享账本服务，10 个连接在高并发下可能成为瓶颈。

**建议**: 通过环境变量配置：

```typescript
max: Number(process.env.DB_POOL_MAX ?? 10),
```

---

## 💭 Nit（改进建议）

### N1. sceneMiddleware 中的 plan 配置用全局变量传递

**文件**: `packages/nexus-gateway/src/middleware/scene.ts` 第 29 行

`DEFAULT_PLAN` 是模块级可变变量，通过 `setPlanConfig` 设置。这种模式不利于测试隔离，建议改用依赖注入或 Express app locals。

### N2. app.ts 中 initPlanConfig 被重复调用

**文件**: `packages/nexus-gateway/src/app.ts` 第 17 行、第 47 行

`initPlanConfig(config.planTier)` 在初始化时调用一次（第 17 行），又在每个请求中调用一次来获取 scenes（第 47 行）。应在初始化时缓存结果。

### N3. credits-ledger 无请求限流

API 端点没有 rate limiting，建议添加 `express-rate-limit` 中间件，至少对 `/debit` 和 `/credit` 端点限流。

### N4. 测试依赖真实数据库

**文件**: `packages/credits-ledger/src/__tests__/api.test.ts`

测试直接连接真实 PostgreSQL，未使用 mock 或 testcontainer。CI 环境中需要预装数据库，且测试间可能相互影响。

### N5. pool.ts 连接字符串中硬编码了密码

**文件**: `packages/credits-ledger/src/db/pool.ts` 第 10 行

默认连接字符串 `'postgresql://postgres:***@localhost:5432/dealclaw_test'` 包含密码（虽然已脱敏）。建议移除默认值，强制通过环境变量提供。

---

## 修复优先级建议

| 优先级 | 问题编号 | 修复内容 |
|--------|----------|----------|
| P0 — 立即 | B1, B2, B4 | 竞态条件、认证绕过、身份伪造 |
| P0 — 立即 | B3, B5 | 内存余额、请求超时 |
| P1 — 本周 | B6, B7, B8 | 月度重置、额度校验、错误处理 |
| P2 — 本迭代 | S1-S5 | 输入验证、查询优化、ID 生成 |
| P3 — 下迭代 | S6-S9, N1-N5 | 请求校验、健康检查、限流等 |
