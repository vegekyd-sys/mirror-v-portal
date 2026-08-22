# DealClaw Nexus 测试质量分析报告

> 审查日期：2026-07-29
> 覆盖范围：全部 8 个包的 9 个测试文件

---

## 一、测试架构概览

### 技术栈
- **测试框架**：Vitest 1.6
- **HTTP 测试**：Supertest 7.0
- **运行时**：Node 22 + TypeScript 5.5
- **包管理**：pnpm 9 + Turborepo

### 测试文件分布

| 包 | 文件 | 测试数 | 类型 | DB |
|---|---|---|---|---|
| credits-ledger | `api.test.ts` | 11 | 集成 | 真实 PG |
| nexus-gateway | `integration/pipeline.test.ts` | 6 | 集成 | 无（mock） |
| nexus-gateway | `unit/services.test.ts` | 8 | 单元 | 无（内存 Map） |
| admin-dashboard | `api.test.ts` | 6 | 集成 | 真实 PG |
| central-gateway | `api.test.ts` | 14 | 集成 + 单元 | 无 |
| dealclaw-agent | `api.test.ts` | 10 | 集成 | 无（硬编码） |
| ops-agent | `api.test.ts` | 17 | 集成 + 单元 | 真实 PG |
| provisioning-service | `api.test.ts` | 10 | 集成 | 真实 PG |
| mock-agent | `api.test.ts` | 5 | 集成 | 无 |
| **合计** | **9 文件** | **~87** | — | — |

### 测试金字塔

```
            ┌─────────────────────────┐
            │   E2E 跨服务测试 (0)     │  ← 完全缺失
            ├─────────────────────────┤
            │  服务级集成测试 (~55)    │  ← 主体
            ├─────────────────────────┤
            │     单元测试 (~32)      │  ← 仅 ops-agent + gateway
            └─────────────────────────┘
```

项目处于"倒金字塔"状态——集成测试为主，单元测试薄弱，E2E 完全缺失。

---

## 二、做得好的地方

### 1. ops-agent 状态机测试（15 个用例）— 最佳实践

**文件**：`packages/ops-agent/src/__tests__/api.test.ts`

覆盖了全部状态转换路径：

```
active → low_credits（余额为 0 / 低于 10%）
low_credits → active（充值恢复）
low_credits → suspended（7 天未付款）
suspended → active（收到付款）
suspended → grace（7 天后）
grace → destroyed（30 天后）
grace → active（收到付款）
grace → 15 天删除警告
destroyed / pending → 无转换（终态）
active → suspended（订阅过期）
7 天 / 3 天到期提醒
```

每个用例都构造了完整的 `TenantState` 对象，验证 `computeTransition` 的返回值，包括 `to` 状态和 `actions` 列表。这是教科书级别的状态机测试。

### 2. credits-ledger 幂等性测试

**文件**：`packages/credits-ledger/src/__tests__/api.test.ts`

```typescript
it('handles idempotency — same key returns same result', async () => {
  const r1 = await request(app).post(`/v1/accounts/${TEST_ACCOUNT}/debit`)
    .send({ amount: 2000, reference: 'req-001', idempotencyKey: key });
  const r2 = await request(app).post(`/v1/accounts/${TEST_ACCOUNT}/debit`)
    .send({ amount: 2000, reference: 'req-001', idempotencyKey: key });
  expect(r2.body.idempotent).toBe(true);
  const bal = await request(app).get(`/v1/accounts/${TEST_ACCOUNT}/balance`);
  expect(bal.body.balance).toBe(8000); // 只扣了一次
});
```

- 使用 `beforeEach` 重置余额和交易记录，保证测试隔离
- 验证了余额只扣减一次
- 使用真实 PostgreSQL，包括 `SELECT FOR UPDATE` 事务
- 测试了月度重置的幂等性（第二次运行不会重复重置）

### 3. provisioning-service 安全测试

**文件**：`packages/provisioning-service/src/__tests__/api.test.ts`

- XSS 注入测试：`<script>alert("xss")</script>上海有限公司` → 验证 script 标签被清除
- 配额限制测试：`quotaAgents: 999` → 验证被 clamp 到 ≤ 100
- 无效套餐降级：`super_premium` → 降级为 `starter`
- 无效邮箱拒绝、字段缺失拒绝
- K8s 使用 `dryRun: true` 模式，不产生真实副作用

### 4. central-gateway 渠道检测

**文件**：`packages/central-gateway/src/__tests__/api.test.ts`

- 覆盖飞书、钉钉、企业微信、个人微信、未知浏览器 5 种场景
- 中英文 User-Agent 都测了
- 验证了重定向 URL 的正确性
- 测试了 onboarding 编排失败场景

### 5. mock-agent 设计

**文件**：`packages/mock-agent/src/app.ts`

mock-agent 不是一个简单的 stub，而是一个可配置的模拟服务：
- `failWithStatus`：可模拟任意 HTTP 错误码
- `delayMs`：可模拟延迟
- `/admin/config` 端点动态配置
- 支持 5 种 intent 响应

这为后续的集成测试提供了良好的基础设施——只要有人用它。

---

## 三、关键问题

### 🔴 T1 — 无真实 E2E 测试

**严重程度**：Blocker

项目有 7 个微服务，但没有任何测试验证"用户请求 → gateway → agent → ledger"的完整链路。

**现状**：
- nexus-gateway 的 `pipeline.test.ts` 名为 "integration"，但实际只测了 gateway 单个服务，下游 agent 和 ledger 都是 mock 或不可达
- mock-agent 存在且有完整实现，但没有任何测试把它和 nexus-gateway 连起来跑

**影响**：
- 接口契约不匹配（如 gateway 发给 agent 的 header 名 vs agent 读取的 header 名）无法被测试发现
- credits 扣款链路（gateway → ledger debit）从未被端到端验证
- 任何服务间的序列化/反序列化不兼容都不会被测试捕获

**建议**：
```
packages/e2e-tests/
  ├── docker-compose.test.yml    # 启动 PG + 所有服务
  ├── e2e/credit-flow.test.ts     # 用户请求 → gateway → agent → ledger debit
  ├── e2e/onboarding.test.ts      # central-gateway → provisioning → k8s (dry-run)
  └── e2e/state-machine.test.ts   # ops-agent cron → DB → 状态转换
```

---

### 🔴 T2 — 无 CI/CD 流水线

**严重程度**：Blocker

**现状**：
- 没有 `.github/workflows/` 目录
- 根 `package.json` 的 scripts 只有 `dev`、`build`、`lint`，**没有 `test`**
- 没有任何自动化测试执行的机制

**影响**：
- 测试只能本地手动运行
- PR 合并前不会自动运行测试
- 测试是否通过完全依赖开发者自觉

**建议**：
1. 根 package.json 添加 `"test": "turbo test"`
2. 添加 `.github/workflows/ci.yml`：
```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env: { POSTGRES_DB: dealclaw_test, POSTGRES_PASSWORD: postgres }
        ports: ['5432:5432']
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - run: pnpm install --frozen-lockfile
      - run: pnpm test
```

---

### 🔴 T3 — 单元测试测的是过时代码

**严重程度**：Blocker

**文件**：`packages/nexus-gateway/src/__tests__/unit/services.test.ts`

**问题**：

单元测试导入并测试了 `middleware/credits.ts` 中的 `initCreditsAccount` 和 `debitCredits`：

```typescript
import { initCreditsAccount, debitCredits, creditsMiddleware } from '../../middleware/credits.js';

it('debites and returns remaining balance', () => {
  const result = debitCredits('credits-test', 2000);
  expect(result.remaining).toBe(8000);
});
```

但实际应用流程中，`app.ts` 已经用内联的 `creditsCheckMiddleware` 替代了这个中间件（B3 修复），通过 HTTP 调用 credits-ledger API 检查和扣减余额。`middleware/credits.ts` 中的 `MOCK_BALANCES` Map 和 `debitCredits` 函数是**死代码**，不再被 app.ts 使用。

**影响**：
- 8 个测试用例全部通过，但测的东西在生产环境根本不走这条路
- 给人一种"credits 逻辑已被测试覆盖"的虚假安全感
- 如果有人修改 `app.ts` 中的 `creditsCheckMiddleware`，这些测试不会失败

**建议**：
- 删除 `middleware/credits.ts` 中的死代码
- 为 `app.ts` 中的 `creditsCheckMiddleware` 写新的单元测试
- 或将 `creditsCheckMiddleware` 提取为独立模块再测试

---

### 🟡 T4 — 测试验证 fail-open 为"正确行为"

**严重程度**：Suggestion

**文件**：`packages/nexus-gateway/src/__tests__/integration/pipeline.test.ts:93-104`

```typescript
it('passes credits check even when credits-ledger is down (M0 fail-open)', async () => {
  const res = await request(app)
    .post('/v1/agent/execute')
    .send(feishuBody({ scene: 'lead', intent: { kind: 'query', resource: 'company' } }));
  expect(res.status).toBe(502); // 不是 402，说明 credits 检查放行了
});
```

测试明确断言 credits-ledger 不可达时请求继续转发（fail-open），然后因为 agent 也不可达返回 502。这个测试"通过"了，但它验证的是一个**安全风险**——ledger 宕机期间用户可以免费使用 Agent。

**建议**：
- 在测试中明确标注 `// TODO: M1 should fail-closed`
- 当 fail-open 策略切换为 fail-closed 时，同步更新测试

---

### 🟡 T5 — 无并发测试验证竞态修复

**严重程度**：Suggestion

V1 审查发现的 B1（debit/credit 竞态条件）已通过 `SELECT FOR UPDATE` 事务修复，但没有任何测试验证这个修复。

**现状**：所有 debit 测试都是串行的，一个请求完成后再发下一个。

**建议**：
```typescript
it('handles concurrent debits with same idempotencyKey', async () => {
  const key = 'concurrent-test';
  const promises = Array.from({ length: 10 }, () =>
    request(app).post(`/v1/accounts/${TEST_ACCOUNT}/debit`)
      .send({ amount: 1000, idempotencyKey: key })
  );
  const results = await Promise.all(promises);
  const okCount = results.filter(r => r.status === 200).length;
  const idemCount = results.filter(r => r.body.idempotent).length;
  // 只应有一次成功扣款，其余应返回幂等结果
  expect(okCount + idemCount).toBe(10);
  // 余额只扣了一次
  const bal = await request(app).get(`/v1/accounts/${TEST_ACCOUNT}/balance`);
  expect(bal.body.balance).toBe(9000);
});
```

---

### 🟡 T6 — 无覆盖率门禁

**严重程度**：Suggestion

只有 `credits-ledger` 配置了 coverage，但没有设置阈值（thresholds）：

```typescript
// credits-ledger/vitest.config.ts
coverage: {
  provider: 'v8',
  include: ['src/**/*.ts'],
  exclude: ['src/__tests__/**', 'src/db/migrate.ts'],
  // 没有 thresholds!
}
```

其他 6 个包连 coverage 配置都没有。

**建议**：
```typescript
coverage: {
  provider: 'v8',
  include: ['src/**/*.ts'],
  exclude: ['src/__tests__/**', 'src/db/migrate.ts', 'src/index.ts'],
  thresholds: {
    lines: 70,
    functions: 70,
    branches: 60,
    statements: 70,
  },
},
```

---

### 🟡 T7 — 测试数据污染

**严重程度**：Suggestion

**文件**：`packages/provisioning-service/src/__tests__/api.test.ts`

`beforeAll` 创建了测试租户但没有全局 `afterAll` 清理：

```typescript
beforeAll(async () => {
  // 创建了租户但没有在 afterAll 中删除
  await migrate(pool);
});

describe('POST /v1/tenants', () => {
  it('creates a tenant', async () => {
    // 每次运行测试都会创建新租户
    // 没有清理逻辑
  });
});
```

`GET /v1/tenants — list` 测试断言 `tenants.length >= 1`，这意味着每次运行测试，列表都会增长。

**影响**：
- 重复运行测试会累积数据
- `GET /v1/tenants` 的结果依赖之前的测试是否运行过
- 测试不幂等

**建议**：添加 `afterAll` 清理，或使用事务回滚。

---

### 🟡 T8 — 硬编码数据库连接字符串

**严重程度**：Suggestion

多个测试文件硬编码了数据库连接：

```typescript
// admin-dashboard
const app = createApp('postgresql://postgres:***@localhost:5432/dealclaw_test');

// provisioning-service
const TEST_DB = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
  ?? 'postgresql://postgres:postgres@localhost:5432/dealclaw_test';
```

- admin-dashboard 的密码用了 `***`（显然不是真实密码，测试只能在特定环境跑）
- provisioning-service 的 fallback 密码是明文 `postgres`
- 没有统一的环境变量管理

**建议**：
- 统一使用 `process.env.TEST_DATABASE_URL`，无 fallback
- 在 `.env.test` 中配置
- CI 中通过 secrets 注入

---

### 🟡 T9 — 缺少关键负路径测试

**严重程度**：Suggestion

多个已知的 Bug（来自 V1/V2 审查）没有被测试覆盖：

| Bug | 描述 | 测试状态 |
|-----|------|----------|
| S1 | `getHistory` 的 `limit` 参数未校验 | 未测试 |
| NB5 | `MONTHLY_LIMIT_EXCEEDED` 返回 200 | 未测试 |
| NB1 | admin monthly-reset 认证绕过 | 部分测试（测了 401，但没测 token 未配置时的行为） |
| NB6 | 飞书签名验证不工作 | 未测试（测了"botSecret 未配置时接受所有"，但没测签名实际匹配） |

**建议**：为每个已知 Bug 添加回归测试。

---

### 💭 T10 — 无 docker-compose 测试基础设施

**严重程度**：Nit

没有 `docker-compose.test.yml`，开发者需要手动搭建 PostgreSQL 测试数据库。

**建议**：
```yaml
# docker-compose.test.yml
services:
  postgres-test:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: dealclaw_test
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
    ports: ['5432:5432']
    tmpfs: /var/lib/postgresql/data  # 内存模式，快速启动
```

---

### 💭 T11 — dealclaw-agent 测试使用硬编码数据

**严重程度**：Nit

**文件**：`packages/dealclaw-agent/src/__tests__/api.test.ts`

```typescript
it('returns company info', async () => {
  const res = await request(app).post('/execute')
    .send({ intent: { kind: 'command', text: '查一下 ABC Corp...', action: 'company_lookup' } });
  expect(res.body.result.summary).toContain('ABC Corp');
});
```

所有测试都依赖硬编码的 mock 数据（ABC Corp、渤程生物）。数据写死在 skill 实现里，测试实际上在验证"mock 返回了 mock"。

---

## 四、改进路线图

| 优先级 | 任务 | 工作量 | 影响 |
|--------|------|--------|------|
| **P0** | 根 package.json 添加 `test` 脚本 | 1 行 | 立即可用 |
| **P0** | 添加 GitHub Actions CI | 半天 | 每次 PR 自动跑测试 |
| **P0** | 删除 nexus-gateway 过时单元测试或重写 | 1 天 | 消除虚假安全感 |
| **P1** | 添加并发 debit 测试 | 2 小时 | 验证 B1 修复 |
| **P1** | 添加 MONTHLY_LIMIT_EXCEEDED 返回码测试 | 1 小时 | 验证 NB5 |
| **P1** | 添加 docker-compose.test.yml | 1 小时 | 降低本地测试门槛 |
| **P1** | provisioning-service 添加 afterAll 清理 | 1 小时 | 消除数据污染 |
| **P2** | 编写 E2E 测试套件（gateway + mock-agent + ledger） | 2-3 天 | 验证跨服务契约 |
| **P2** | 为所有包添加 coverage 配置和阈值 | 半天 | 量化覆盖率 |
| **P2** | 统一 TEST_DATABASE_URL 环境变量 | 1 小时 | 消除硬编码 |
| **P3** | 契约测试（Pact 或类似方案） | 1 周 | 服务间兼容性保障 |

---

## 五、总结评分

| 维度 | 评分 | 说明 |
|------|------|------|
| **覆盖广度** | 7/10 | 8 个包都有测试，mock-agent 基础设施齐全 |
| **覆盖深度** | 5/10 | ops-agent 状态机出色，其余多为 happy path |
| **测试隔离** | 5/10 | credits-ledger 好（beforeEach），provisioning 差（无清理） |
| **CI/自动化** | 0/10 | 完全缺失 |
| **E2E 覆盖** | 0/10 | 完全缺失 |
| **代码时效性** | 4/10 | nexus-gateway 单元测试测的是死代码 |
| **负路径覆盖** | 4/10 | 缺少 limit 滥用、认证绕过、签名验证等关键负路径 |
| **综合** | **4.5/10** | 有基础但关键环节缺失，需要系统化补齐 |

**一句话总结**：测试数量尚可（~87 个），质量参差不齐——ops-agent 状态机测试是亮点，但缺少 CI、E2E、并发测试和覆盖率门禁，且有单元测试测死代码的问题，给人虚假的安全感。
