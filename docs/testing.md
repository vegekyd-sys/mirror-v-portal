# 测试设计

> 版本: v0.1 | 2026-07-26 | Author: V
> 工具选型: TypeScript → Vitest · Python → pytest · K8s → kind

## 1. 测试策略总览

| 层级 | 工具 | 范围 | 目标覆盖率 |
|------|------|------|-----------|
| 单元测试 | Vitest (TS), pytest (Python) | 纯函数、校验逻辑、状态机、幂等 | ≥ 80% P0 模块 |
| 集成测试 | Supertest + Testcontainers | 每模块 HTTP API + DB | 全模块 |
| K8s 集成 | kind (Kubernetes in Docker) | Provisioning 创建/销毁 Namespace+Pod | API 调用链 |
| 支付链路 | 支付宝沙箱 | 下单→支付→回调→入账 全链路 | 100% 关键路径 |
| E2E (未来) | 飞书沙箱 Bot | 扫码→开通→对话→充值 全流程 | M1+ |

### 不做的事

- ❌ UI 端到端测试（无前端 UI）
- ❌ 性能/压测（M0 阶段不需要）
- ❌ 安全渗透测试（基础设施层由 K8s 保证，业务层 M0 后单独做）
- ❌ 支付宝 mock（mock 支付链路无意义，直接用沙箱）

## 2. 工具选型理由

| 工具 | 选型理由 |
|------|---------|
| **Vitest** | 与 TypeScript ESM + tsx 开发栈一致，启动快，watch 模式体验好。Jest 的 ESM 配置繁琐且启动慢 |
| **Testcontainers** | 每个测试跑临时 PostgreSQL，不依赖远程数据库。并行安全，用完即弃 |
| **Supertest** | Express 集成测试标准工具，断言 HTTP 状态码 + body |
| **pytest** | Python 生态标准，支付宝 SDK 原生 Python |
| **kind** | 本地单节点 K8s，Provisioning Service 创建 Namespace/Pod 的真实验证 |
| **GitLab CI** | repo 在 git.versa-ai.com，天然集成 |

## 3. 各模块测试设计

### 3.1 Nexus Agent Gateway (Vitest + Supertest)

```
packages/nexus-gateway/
└── src/
    └── __tests__/
        ├── unit/
        │   ├── identity.test.ts          # 身份解析逻辑
        │   ├── credits.test.ts           # 余额检查 + 扣减
        │   ├── scene.test.ts             # 套餐场景权限
        │   ├── config.test.ts            # 环境变量加载
        │   └── types.test.ts             # 类型守卫函数
        │
        └── integration/
            ├── pipeline.test.ts          # 完整管道 (identity→credits→scene→fw)
            ├── healthz.test.ts           # 健康检查端点
            ├── credits-insufficient.test.ts  # 402 场景
            ├── scene-locked.test.ts      # 403 场景
            └── agent-forward.test.ts     # Agent 转发 mock
```

**关键测试用例**:

```typescript
// credits.test.ts — 核心业务逻辑
describe('Credits Middleware', () => {
  it('should allow request when balance >= cost', async () => {
    initCreditsAccount('acc-1', 10000);
    const res = await request(app)
      .post('/v1/agent/execute')
      .send({ intent: { kind: 'query', resource: 'company' } });
    expect(res.status).toBe(200);  // 2000 <= 10000 → OK
  });

  it('should return 402 when balance < cost', async () => {
    initCreditsAccount('acc-1', 500);
    const res = await request(app)
      .post('/v1/agent/execute')
      .send({ intent: { kind: 'query', resource: 'company' } });
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('INSUFFICIENT_CREDITS');
  });

  it('should not charge for chat intent', async () => {
    initCreditsAccount('acc-1', 100);
    const res = await request(app)
      .post('/v1/agent/execute')
      .send({ intent: { kind: 'chat', text: 'hello' } });
    expect(res.status).toBe(200);  // chat = 0 credits
  });

  it('should debit correctly after successful agent response', () => {
    const result = debitCredits('acc-1', 2000);
    expect(result.remaining).toBe(8000);  // 10000 - 2000
  });
});

// scene.test.ts — 套餐权限
describe('Scene Middleware', () => {
  it('should allow starter scene on starter plan', async () => {
    setPlanConfig(initPlanConfig('starter'));
    const res = await request(app)
      .post('/v1/agent/execute')
      .send({ scene: 'lead', intent: { kind: 'chat', text: 'hi' } });
    expect(res.status).toBe(200);
  });

  it('should deny expo scene on starter plan', async () => {
    setPlanConfig(initPlanConfig('starter'));
    const res = await request(app)
      .post('/v1/agent/execute')
      .send({ scene: 'expo', intent: { kind: 'chat', text: 'hi' } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SCENE_LOCKED');
  });
});
```

### 3.2 Credits Ledger (Vitest + Testcontainers)

```
packages/credits-ledger/
└── src/
    └── __tests__/
        ├── unit/
        │   ├── debit.test.ts             # 扣减逻辑（含超扣保护）
        │   ├── credit.test.ts            # 入账逻辑
        │   └── idempotency.test.ts       # 幂等去重
        │
        └── integration/
            ├── balance.test.ts           # 余额查询 API
            ├── debit-debit-duplicate.test.ts  # 重复扣减幂等
            ├── credit-idempotent.test.ts # 重复入账幂等
            ├── concurrency.test.ts       # 并发扣减 (行锁)
            └── history.test.ts           # 交易历史查询
```

**关键测试用例**:

```typescript
// idempotency.test.ts — 幂等性（核心）
describe('Idempotency', () => {
  it('should reject duplicate debit with same idempotency key', async () => {
    // 第一次扣减 2000
    const r1 = await request(app)
      .post('/v1/accounts/acc-1/debit')
      .send({ amount: 2000, idempotencyKey: 'key-001', reference: 'req-1' });
    expect(r1.status).toBe(200);
    expect(r1.body.balanceAfter).toBe(3800000);

    // 相同幂等键第二次扣减
    const r2 = await request(app)
      .post('/v1/accounts/acc-1/debit')
      .send({ amount: 2000, idempotencyKey: 'key-001', reference: 'req-1' });
    expect(r2.status).toBe(200);           // 幂等成功
    expect(r2.body.balanceAfter).toBe(3800000);  // 余额不变
    expect(r2.body.idempotent).toBe(true);
  });

  it('should allow different idempotency keys', async () => {
    const r1 = await request(app)
      .post('/v1/accounts/acc-1/debit')
      .send({ amount: 2000, idempotencyKey: 'key-A', reference: 'req-A' });
    expect(r1.body.balanceAfter).toBe(3800000);

    const r2 = await request(app)
      .post('/v1/accounts/acc-1/debit')
      .send({ amount: 2000, idempotencyKey: 'key-B', reference: 'req-B' });
    expect(r2.body.balanceAfter).toBe(3798000);  // 实际扣减
  });
});

// concurrency.test.ts — 并发安全
describe('Concurrency Safety', () => {
  it('should not overspend under concurrent debits', async () => {
    // 账户余额 5000
    // 10 个并发请求各扣 2000
    const requests = Array.from({ length: 10 }, (_, i) =>
      request(app)
        .post('/v1/accounts/acc-1/debit')
        .send({ amount: 2000, idempotencyKey: `concurrent-${i}`, reference: `req-${i}` })
    );
    const results = await Promise.all(requests);
    
    // 最多 2 个成功（5000/2000 = 2.5，只能扣 2 次）
    const successes = results.filter(r => r.status === 200);
    const failures = results.filter(r => r.status === 402);
    
    expect(successes.length).toBeLessThanOrEqual(2);
    // 余额不能为负
    const finalBalance = (await request(app).get('/v1/accounts/acc-1/balance')).body.balance;
    expect(finalBalance).toBeGreaterThanOrEqual(0);
  });
});
```

### 3.3 Provisioning Service (Vitest + kind)

```
packages/provisioning/
└── src/
    └── __tests__/
        ├── unit/
        │   ├── validation.test.ts        # 输入校验 (公司名/邮箱/套餐)
        │   ├── sanitize.test.ts          # SQL 注入清洗
        │   └── quota.test.ts             # 开通配额检查
        │
        └── integration/
            ├── create-tenant.test.ts     # 创建租户 API + Kind 集群
            ├── k8s-namespace.test.ts     # Namespace 实际创建验证
            ├── security-boundary.test.ts # Onboarding Agent 不允许删租户
            └── teardown.test.ts          # 销毁租户 + 资源清理验证
```

**关键测试用例**:

```typescript
// validation.test.ts — 输入校验（安全关键）
describe('Input Validation', () => {
  it('should reject SQL injection in company name', async () => {
    const res = await request(app)
      .post('/v1/tenants')
      .send({ companyName: "'; DROP TABLE tenants; --", email: 'a@b.com', planTier: 'pro' });
    expect(res.status).toBe(400);
    expect(res.body.errors[0].field).toBe('companyName');
  });

  it('should reject invalid email', async () => {
    const res = await request(app)
      .post('/v1/tenants')
      .send({ companyName: 'Test Corp', email: 'not-an-email', planTier: 'pro' });
    expect(res.status).toBe(400);
  });

  it('should reject unknown plan tier', async () => {
    const res = await request(app)
      .post('/v1/tenants')
      .send({ companyName: 'Test Corp', email: 'a@b.com', planTier: 'enterprise' });
    expect(res.status).toBe(400);
  });

  it('should reject unknown fields (whitelist mode)', async () => {
    const res = await request(app)
      .post('/v1/tenants')
      .send({ companyName: 'Test', email: 'a@b.com', planTier: 'pro', isAdmin: true });
    expect(res.status).toBe(400);
  });
});

// create-tenant.test.ts — K8s 集成 (Needs kind cluster)
describe('Tenant Creation (K8s)', () => {
  beforeAll(async () => {
    // Ensure kind cluster is running
    await exec('kind get clusters').then(r => {
      if (!r.stdout.includes('dealclaw-test')) {
        throw new Error('kind cluster "dealclaw-test" not found');
      }
    });
  });

  it('should create namespace and pod via K8s API', async () => {
    const res = await request(app)
      .post('/v1/tenants')
      .send({
        companyName: 'Test Corp',
        email: 'test@corp.com',
        planTier: 'starter',
        platform: 'feishu',
      });
    expect(res.status).toBe(202);
    expect(res.body.tenantId).toMatch(/^cust-/);

    // Verify namespace exists in K8s
    const ns = await kubectl(`get namespace tenant-${res.body.tenantId} -o json`);
    expect(JSON.parse(ns.stdout).status.phase).toBe('Active');

    // Cleanup
    await request(app).delete(`/v1/tenants/${res.body.tenantId}`);
  }, 30000);  // 30s timeout for K8s operations
});
```

### 3.4 Payment Service (pytest + 支付宝沙箱)

```
packages/payment-service/
└── tests/
    ├── unit/
    │   ├── test_products.py          # 产品配置校验
    │   └── test_validation.py        # 订单创建参数校验
    │
    └── integration/
        ├── test_create_order.py      # 创建订单 (沙箱)
        ├── test_callback_verify.py   # 回调验签
        ├── test_idempotent.py        # 重复回调幂等
        └── test_refund.py            # 退款 (沙箱)
```

**关键测试用例**:

```python
# test_callback_verify.py
def test_verify_alipay_signature():
    """验证支付宝异步通知签名"""
    # 使用支付宝沙箱密钥
    # 构造签名后的回调参数 → 验签通过 → 更新 Credits
    pass

def test_reject_invalid_signature():
    """拒绝伪造签名"""
    pass

def test_amount_mismatch_rejected():
    """回调金额与订单不符 → 拒绝"""
    pass

def test_duplicate_callback_idempotent():
    """重复回调 → 幂等处理，不会重复入账"""
    pass
```

### 3.5 Ops Agent (Vitest)

```
packages/ops-agent/
└── src/
    └── __tests__/
        ├── unit/
        │   ├── state-machine.test.ts     # 状态机流转逻辑
        │   ├── notification.test.ts      # 通知规则计算
        │   └── scheduler.test.ts         # 巡检调度
        │
        └── integration/
            ├── scan-active.test.ts       # 扫描 active → low_credits 推进
            ├── scan-suspended.test.ts    # suspended → grace 推进
            ├── monthly-reset.test.ts     # 月度额度重置
            └── health-check.test.ts      # Pod 健康检查触发重启
```

**关键测试用例**:

```typescript
// state-machine.test.ts
describe('Tenant State Machine', () => {
  it('active with low credits → low_credits', () => {
    const result = transitionState('active', { credits: 0, monthlyAllowance: 5000000 });
    expect(result).toBe('low_credits');
  });

  it('low_credits with 7 days unpaid → suspended', () => {
    const result = transitionState('low_credits', {
      daysInState: 7,
      hasPaid: false,
    });
    expect(result).toBe('suspended');
  });

  it('suspended with payment → active', () => {
    const result = transitionState('suspended', { hasPaid: true });
    expect(result).toBe('active');
  });

  it('suspended > 7 days → grace', () => {
    const result = transitionState('suspended', { daysInState: 8 });
    expect(result).toBe('grace');
  });

  it('grace > 30 days → destroyed', () => {
    const result = transitionState('grace', { daysInState: 31 });
    expect(result).toBe('destroyed');
  });

  it('should never transition from destroyed', () => {
    const result = transitionState('destroyed', { hasPaid: true });
    expect(result).toBe('destroyed');  // 不可逆
  });
});
```

## 4. CI 流水线

```yaml
# .gitlab-ci.yml (待创建)
stages:
  - install
  - test
  - build

variables:
  PNPM_CACHE_FOLDER: .pnpm-store

cache:
  key: $CI_COMMIT_REF_SLUG
  paths:
    - .pnpm-store
    - node_modules/

install:
  stage: install
  script:
    - corepack enable
    - pnpm install --frozen-lockfile

test:gateway:
  stage: test
  script:
    - pnpm --filter @dealclaw/nexus-gateway test
  coverage: '/All files[^|]*\|[^|]*\s+([\d\.]+)/'

test:credits:
  stage: test
  services:
    - postgres:16-alpine
  variables:
    DATABASE_URL: postgresql://postgres:postgres@postgres:5432/dealclaw_test
  script:
    - pnpm --filter @dealclaw/credits-ledger test

test:provisioning:
  stage: test
  before_script:
    - kind create cluster --name dealclaw-test --wait 60s
  script:
    - pnpm --filter @dealclaw/provisioning test
  after_script:
    - kind delete cluster --name dealclaw-test

test:payment:
  stage: test
  image: python:3.12
  variables:
    ALIPAY_SANDBOX: "true"
    ALIPAY_APP_ID: $ALIPAY_SANDBOX_APP_ID       # GitLab CI 变量
    ALIPAY_PRIVATE_KEY: $ALIPAY_SANDBOX_PRIVATE_KEY
    ALIPAY_PUBLIC_KEY: $ALIPAY_SANDBOX_PUBLIC_KEY
  script:
    - cd packages/payment-service && pip install -r requirements-dev.txt && pytest

build:
  stage: build
  script:
    - pnpm build
  artifacts:
    paths:
      - packages/*/dist/
```

## 5. 本地开发测试

```bash
# 跑全部单元测试
pnpm test

# 单模块 watch 模式
pnpm --filter @dealclaw/nexus-gateway test --watch

# Credits Ledger 集成测试 (需要本地 PG)
docker run -d --name dealclaw-test-pg -e POSTGRES_PASSWORD=test -p 5433:5432 postgres:16-alpine
DATABASE_URL=postgresql://postgres:test@localhost:5433/dealclaw_test \
  pnpm --filter @dealclaw/credits-ledger test

# Provisioning K8s 集成测试
kind create cluster --name dealclaw-test
pnpm --filter @dealclaw/provisioning test
kind delete cluster --name dealclaw-test

# Payment 沙箱测试
cd packages/payment-service
ALIPAY_SANDBOX=true pytest
```
