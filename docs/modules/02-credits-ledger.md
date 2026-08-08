# 02 — Credits Ledger 系分

> 优先级: P0 | 部署: 中央共享服务 | 语言: TypeScript + Node.js
> 存储: Supabase PostgreSQL

## 1. 职责边界

Credits Ledger 是 DealClaw 的计费核心，负责账户余额管理和消费记账。不负责支付——支付订单由 Payment Service 独立处理。

```
Nexus Agent Gateway ──▶ GET  /v1/accounts/:id/balance   (查询余额)
                      ──▶ POST /v1/accounts/:id/debit    (扣减)
                      
Payment Service      ──▶ POST /v1/accounts/:id/credit    (充值入账)
                      
Ops Agent            ──▶ GET  /v1/accounts/:id/history   (对账查询)
```

## 2. API 契约

### 2.1 查询余额

```
GET /v1/accounts/{accountId}/balance

Response 200:
{
  "accountId": "credits-cust-001",
  "balance": 3800000,
  "planTier": "pro",
  "monthlyAllowance": 5000000,
  "monthlyUsed": 1200000,
  "updatedAt": "2026-07-26T12:00:00Z"
}
```

### 2.2 扣减 Credits

```
POST /v1/accounts/{accountId}/debit
Content-Type: application/json

{
  "amount": 2000,
  "reference": "req_abc123",        // Gateway request ID
  "description": "lead_search: ABC Corp",
  "idempotencyKey": "idem_xyz789"   // 幂等键，防重复扣减
}

Response 200:
{
  "ok": true,
  "balanceBefore": 3800000,
  "balanceAfter": 3798000,
  "transactionId": "txn_001"
}

Response 402:
{
  "ok": false,
  "code": "INSUFFICIENT_CREDITS",
  "balance": 500,
  "required": 2000
}
```

### 2.3 充值入账（仅 Payment Service 调用）

```
POST /v1/accounts/{accountId}/credit
Authorization: Bearer <payment-service-internal-token>
Content-Type: application/json

{
  "amount": 100000,
  "reference": "order_po_20260726_001",
  "description": "支付宝充值 100K Credits",
  "idempotencyKey": "pay_cb_xyz789"
}

Response 200:
{
  "ok": true,
  "balanceBefore": 500,
  "balanceAfter": 100500,
  "transactionId": "txn_002"
}
```

### 2.4 交易历史

```
GET /v1/accounts/{accountId}/history?from=2026-07-01&to=2026-07-31&limit=50

Response 200:
{
  "accountId": "credits-cust-001",
  "transactions": [
    {
      "id": "txn_001",
      "type": "debit",
      "amount": 2000,
      "balanceBefore": 3800000,
      "balanceAfter": 3798000,
      "reference": "req_abc123",
      "description": "lead_search: ABC Corp",
      "timestamp": "2026-07-26T12:00:00Z"
    }
  ],
  "total": 1
}
```

### 2.5 月度用量

```
GET /v1/accounts/{accountId}/usage?month=2026-07

Response 200:
{
  "accountId": "credits-cust-001",
  "month": "2026-07",
  "monthlyAllowance": 5000000,
  "totalUsed": 1200000,
  "breakdown": {
    "lead_search": 400000,
    "email_send": 300000,
    "company_intel": 500000
  }
}
```

## 3. 数据库 Schema

```sql
-- 账户表
CREATE TABLE credits_accounts (
    id              VARCHAR(64) PRIMARY KEY,        -- credits-cust-001
    tenant_id       VARCHAR(64) NOT NULL UNIQUE,    -- cust-001
    plan_tier       VARCHAR(16) NOT NULL,           -- starter|growth|pro|team
    balance         BIGINT NOT NULL DEFAULT 0,      -- 当前余额 (credits)
    monthly_allowance BIGINT NOT NULL DEFAULT 0,    -- 月赠额度
    monthly_used    BIGINT NOT NULL DEFAULT 0,      -- 本月已用
    month_reset_at  TIMESTAMPTZ NOT NULL,           -- 下月额度重置时间
    status          VARCHAR(16) NOT NULL DEFAULT 'active', -- active|suspended|closed
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_credits_accounts_tenant ON credits_accounts(tenant_id);
CREATE INDEX idx_credits_accounts_status ON credits_accounts(status);

-- 交易流水表（不可变日志）
CREATE TABLE credits_transactions (
    id              VARCHAR(64) PRIMARY KEY,        -- txn_001 (UUID v7)
    account_id      VARCHAR(64) NOT NULL REFERENCES credits_accounts(id),
    type            VARCHAR(16) NOT NULL,           -- debit|credit|refund|monthly_reset
    amount          BIGINT NOT NULL,                -- 变动额 (正=入账, 负=出账)
    balance_before  BIGINT NOT NULL,
    balance_after   BIGINT NOT NULL,
    reference       VARCHAR(128) NOT NULL,          -- 关联业务 ID
    description     TEXT,
    idempotency_key VARCHAR(128) NOT NULL,          -- 幂等去重键
    metadata        JSONB DEFAULT '{}',             -- 扩展信息
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_credits_txn_idempotent ON credits_transactions(idempotency_key);
CREATE INDEX idx_credits_txn_account ON credits_transactions(account_id, created_at DESC);
CREATE INDEX idx_credits_txn_reference ON credits_transactions(reference);

-- 月度用量汇总表（物化视图或定期更新）
CREATE TABLE credits_monthly_usage (
    account_id      VARCHAR(64) NOT NULL,
    month           VARCHAR(7) NOT NULL,            -- 2026-07
    category        VARCHAR(32) NOT NULL,           -- lead_search|email_send|...
    total_used      BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, month, category)
);
```

## 4. 幂等性设计

```
┌──────────────────────────────────────────────────────────────┐
│  幂等键格式: {source}:{request_id}:{nonce}                      │
│  例: gateway:req_abc123:a1b2c3                                │
│                                                              │
│  流程:                                                        │
│  1. Gateway 生成 idempotencyKey                               │
│  2. INSERT ... ON CONFLICT (idempotency_key) DO NOTHING       │
│  3. 如果 affected_rows = 0 → 幂等命中，返回已有 txn 结果      │
│  4. 如果 affected_rows = 1 → 新交易，正常返回                  │
└──────────────────────────────────────────────────────────────┘
```

## 5. 月度额度重置

Ops Agent 每月 1 日 00:00 触发：

```sql
-- 月度重置事务
BEGIN;
  -- 1. 记录上月剩余（如果需要结转，当前策略：不结转）
  -- 2. 重置 monthly_used = 0
  UPDATE credits_accounts
  SET monthly_used = 0,
      month_reset_at = month_reset_at + INTERVAL '1 month',
      updated_at = NOW();
  -- 3. 写入交易记录 (monthly_reset)
  INSERT INTO credits_transactions (...)
  SELECT ... FROM credits_accounts;
COMMIT;
```

## 6. 安全设计

| 防护点 | 措施 |
|--------|------|
| 超扣防护 | debit 使用 `UPDATE ... WHERE balance >= amount RETURNING balance`，原子判断 |
| 重复扣款 | idempotency_key UNIQUE 约束 |
| 充值伪造 | credit 端点需要 Payment Service 内部 Token，外部不可达 |
| 账户隔离 | 所有查询强制带 account_id 过滤，API 层校验 tenant 归属 |
| 审计 | transactions 表不可物理删除，仅逻辑标记 |

## 7. 部署规格

```yaml
cpu: 200m
memory: 256Mi
replicas: 1 (单实例，通过 PostgreSQL 行锁保证一致性)
port: 8081

环境变量:
  DATABASE_URL: postgresql://.../dealclaw_credits
  PAYMENT_SERVICE_TOKEN: <internal-shared-secret>
```
