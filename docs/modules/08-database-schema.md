# 08 — 数据库 Schema 总览

> 版本: v0.1 | 数据库: PostgreSQL (Supabase)

## 1. 数据库分布

```
dealclaw_nexus DB:
├── tenants              # 租户注册表 (Provisioning Service)
├── credits_accounts     # Credits 账户 (Credits Ledger)
├── credits_transactions # Credits 交易流水 (不可变)
├── credits_monthly_usage# 月度用量汇总
├── payment_orders       # 支付订单 (Payment Service)
└── audit_log            # 统一审计日志

每客户 DB (独立 Supabase project / schema):
├── customers            # 客户 CRM 数据
├── leads                # 线索
├── emails               # 邮件记录
├── meeting_notes        # 会议纪要
└── followups            # 跟进记录
```

## 2. 全量 Schema

### 2.1 tenants（租户注册表）

```sql
CREATE TABLE tenants (
    id              VARCHAR(64) PRIMARY KEY,            -- cust-001
    company_name    VARCHAR(50) NOT NULL,
    email           VARCHAR(255),
    phone           VARCHAR(20),
    plan_tier       VARCHAR(16) NOT NULL,               -- starter|growth|pro|team
    platform        VARCHAR(16) NOT NULL,               -- feishu|dingtalk|wecom
    runtime_namespace   VARCHAR(128),                   -- dealclaw-staging / dealclaw-prod
    agent_service       VARCHAR(128) UNIQUE,            -- dealclaw-agent-cust-001
    status          VARCHAR(16) NOT NULL DEFAULT 'pending',
                    -- pending|provisioning|active|low_credits|suspended|grace|destroyed
    
    -- Key & Creds refs (values in K8s Secret, not here)
    key_config_ref      VARCHAR(128),                   -- cust-001/api-key
    bot_cred_ref        VARCHAR(128),                   -- cust-001/bot-cred
    credits_account_id  VARCHAR(64),                    -- credits-cust-001
    
    -- 计费周期
    subscription_start  TIMESTAMPTZ,
    subscription_end    TIMESTAMPTZ,
    
    -- 生命周期时间戳
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    provisioned_at      TIMESTAMPTZ,
    suspended_at        TIMESTAMPTZ,
    grace_until         TIMESTAMPTZ,
    destroyed_at        TIMESTAMPTZ,
    data_retain_until   TIMESTAMPTZ,
    
    metadata            JSONB DEFAULT '{}'
);

CREATE INDEX idx_tenants_status ON tenants(status);
CREATE INDEX idx_tenants_platform ON tenants(platform);
CREATE INDEX idx_tenants_subscription_end ON tenants(subscription_end);
```

### 2.2 credits_accounts（Credits 账户）

```sql
CREATE TABLE credits_accounts (
    id                  VARCHAR(64) PRIMARY KEY,        -- credits-cust-001
    tenant_id           VARCHAR(64) NOT NULL UNIQUE REFERENCES tenants(id),
    plan_tier           VARCHAR(16) NOT NULL,
    balance             BIGINT NOT NULL DEFAULT 0,
    monthly_allowance   BIGINT NOT NULL DEFAULT 0,
    monthly_used        BIGINT NOT NULL DEFAULT 0,
    month_reset_at      TIMESTAMPTZ NOT NULL,
    lifetime_credited   BIGINT NOT NULL DEFAULT 0,      -- 累计充值
    lifetime_consumed   BIGINT NOT NULL DEFAULT 0,      -- 累计消耗
    status              VARCHAR(16) NOT NULL DEFAULT 'active',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_credits_accounts_tenant ON credits_accounts(tenant_id);
CREATE INDEX idx_credits_accounts_status ON credits_accounts(status);
```

### 2.3 credits_transactions（交易流水 — 不可变）

```sql
CREATE TABLE credits_transactions (
    id                  VARCHAR(64) PRIMARY KEY,        -- txn_<UUIDv7>
    account_id          VARCHAR(64) NOT NULL REFERENCES credits_accounts(id),
    type                VARCHAR(16) NOT NULL,           -- debit|credit|refund|monthly_reset
    amount              BIGINT NOT NULL,                -- 正=入账, 负=出账
    balance_before      BIGINT NOT NULL,
    balance_after       BIGINT NOT NULL,
    reference           VARCHAR(128) NOT NULL,
    description         TEXT,
    category            VARCHAR(32),                    -- lead_search|email_send|...
    idempotency_key     VARCHAR(128) NOT NULL,
    metadata            JSONB DEFAULT '{}',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_credits_txn_idempotent ON credits_transactions(idempotency_key);
CREATE INDEX idx_credits_txn_account ON credits_transactions(account_id, created_at DESC);
CREATE INDEX idx_credits_txn_reference ON credits_transactions(reference);
CREATE INDEX idx_credits_txn_category ON credits_transactions(account_id, category, created_at DESC);
```

### 2.4 credits_monthly_usage（月度用量）

```sql
CREATE TABLE credits_monthly_usage (
    account_id      VARCHAR(64) NOT NULL,
    month           VARCHAR(7) NOT NULL,                -- 2026-07
    category        VARCHAR(32) NOT NULL,
    total_used      BIGINT NOT NULL DEFAULT 0,
    call_count      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, month, category)
);
```

### 2.5 payment_orders（支付订单）

```sql
CREATE TABLE payment_orders (
    id                  VARCHAR(64) PRIMARY KEY,        -- order_po_20260726_001
    tenant_id           VARCHAR(64) NOT NULL REFERENCES tenants(id),
    account_id          VARCHAR(64) NOT NULL REFERENCES credits_accounts(id),
    product_code        VARCHAR(32) NOT NULL,
    amount_yuan         DECIMAL(10, 2) NOT NULL,
    credits_amount      BIGINT NOT NULL,
    status              VARCHAR(16) NOT NULL DEFAULT 'created',
                        -- created|paid|expired|refunded
    pay_url             TEXT,
    pay_url_token       VARCHAR(128) UNIQUE,
    pay_url_expires     TIMESTAMPTZ,
    
    -- 渠道信息
    payment_channel     VARCHAR(16),                    -- alipay|wechat|jialian|stripe
    channel_trade_no    VARCHAR(64),                    -- 支付宝 trade_no
    channel_callback    JSONB,                          -- 回调原始数据（审计）
    
    credits_updated     BOOLEAN DEFAULT FALSE,
    paid_at             TIMESTAMPTZ,
    
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_payment_orders_tenant ON payment_orders(tenant_id);
CREATE INDEX idx_payment_orders_status ON payment_orders(status);
CREATE UNIQUE INDEX idx_payment_orders_token ON payment_orders(pay_url_token);
CREATE UNIQUE INDEX idx_payment_orders_channel ON payment_orders(channel_trade_no);
```

### 2.6 audit_log（统一审计日志 — 不可变）

```sql
CREATE TABLE audit_log (
    id              VARCHAR(64) PRIMARY KEY,
    tenant_id       VARCHAR(64) NOT NULL,
    user_id         VARCHAR(128),
    action          VARCHAR(64) NOT NULL,               -- gateway.request|credits.debit|...
    resource        VARCHAR(128) NOT NULL,              -- account:credits-cust-001
    detail          TEXT,
    source_ip       INET,
    user_agent      TEXT,
    result          VARCHAR(16) NOT NULL,               -- success|denied|error
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_tenant ON audit_log(tenant_id, created_at DESC);
CREATE INDEX idx_audit_action ON audit_log(action, created_at DESC);
-- 注意: audit_log 无 DELETE 权限，仅 INSERT + SELECT
```

## 3. 表关系图

```
tenants (1) ──────< (1) credits_accounts
   │                      │
   │                      ├──< credits_transactions (∞)
   │                      ├──< credits_monthly_usage (∞)
   │                      │
   │                      └──< payment_orders (∞)
   │
   └──< audit_log (∞)
```

## 4. 索引策略

| 表 | 索引类型 | 用途 |
|---|---------|------|
| tenants.status | B-tree | Ops Agent 巡检（WHERE status IN (...)） |
| tenants.subscription_end | B-tree | 到期扫描 |
| credits_transactions.idempotency_key | UNIQUE | 幂等去重 |
| credits_transactions (account_id, created_at DESC) | B-tree | 交易历史查询 |
| credits_transactions (account_id, category, created_at) | B-tree | 按类别统计用量 |
| payment_orders.channel_trade_no | UNIQUE | 支付宝回调去重 |
| audit_log (tenant_id, created_at DESC) | B-tree | 审计查询 |

## 5. 数据保留策略

| 数据 | 保留期 | 过期处理 |
|------|--------|---------|
| credits_transactions | 永久 | — |
| audit_log | 永久（压缩归档） | 超 1 年转冷存储 |
| payment_orders | 永久 | — |
| 客户业务数据 | 销毁后 90 天 | Ops Agent 定时清理 |
| credits_monthly_usage | 3 年 | 按年归档 |

## 6. 迁移策略

```sql
-- 初始迁移
-- 按依赖顺序: tenants → credits_accounts → (credits_transactions, payment_orders, audit_log)

-- MVP 阶段 (P0-P1): tenants, credits_accounts, credits_transactions
-- P2 加入: payment_orders, credits_monthly_usage
-- P3+ 加入: audit_log

-- 所有迁移文件放在: /migrations/ 目录
-- 使用 Supabase CLI 管理: supabase migration new <name>
```
