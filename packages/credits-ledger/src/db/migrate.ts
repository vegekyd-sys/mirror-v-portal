import { query } from './pool.js';

export async function migrate() {
  // ── v1 tables ──
  await query(`
    CREATE TABLE IF NOT EXISTS credits_accounts (
      id                VARCHAR(64) PRIMARY KEY,
      tenant_id         VARCHAR(64) NOT NULL UNIQUE,
      plan_tier         VARCHAR(16) NOT NULL,
      balance           BIGINT NOT NULL DEFAULT 0,
      monthly_allowance BIGINT NOT NULL DEFAULT 0,
      monthly_used      BIGINT NOT NULL DEFAULT 0,
      month_reset_at    TIMESTAMPTZ NOT NULL,
      lifetime_credited BIGINT NOT NULL DEFAULT 0,
      lifetime_consumed BIGINT NOT NULL DEFAULT 0,
      status            VARCHAR(16) NOT NULL DEFAULT 'active',
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await query(`CREATE INDEX IF NOT EXISTS idx_credits_accounts_tenant ON credits_accounts(tenant_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_credits_accounts_status ON credits_accounts(status)`);

  await query(`
    CREATE TABLE IF NOT EXISTS credits_transactions (
      id              VARCHAR(64) PRIMARY KEY,
      account_id      VARCHAR(64) NOT NULL REFERENCES credits_accounts(id),
      type            VARCHAR(16) NOT NULL,
      amount          BIGINT NOT NULL,
      balance_before  BIGINT NOT NULL,
      balance_after   BIGINT NOT NULL,
      reference       VARCHAR(128) NOT NULL,
      description     TEXT,
      category        VARCHAR(32),
      idempotency_key VARCHAR(128) NOT NULL,
      metadata        JSONB DEFAULT '{}',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_credits_txn_idempotent ON credits_transactions(idempotency_key)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_credits_txn_account ON credits_transactions(account_id, created_at DESC)`);

  await query(`
    CREATE TABLE IF NOT EXISTS credits_monthly_usage (
      account_id  VARCHAR(64) NOT NULL,
      month       VARCHAR(7) NOT NULL,
      category    VARCHAR(32) NOT NULL,
      total_used  BIGINT NOT NULL DEFAULT 0,
      call_count  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (account_id, month, category)
    )
  `);

  // ── v1.5: Plan Templates ──
  await query(`
    CREATE TABLE IF NOT EXISTS plan_templates (
      plan_id         VARCHAR(32) PRIMARY KEY,
      plan_name       VARCHAR(64) NOT NULL,
      tier            VARCHAR(16) NOT NULL,
      annual_fee_yuan INTEGER NOT NULL,
      initial_credit  BIGINT NOT NULL,
      seats_min       INTEGER NOT NULL DEFAULT 1,
      seats_max       INTEGER NOT NULL DEFAULT 3,
      renewal_discount DECIMAL(3,2) NOT NULL DEFAULT 1.00,
      renewal_price_per_100k INTEGER NOT NULL,
      monthly_allowance BIGINT NOT NULL DEFAULT 0,
      features        TEXT,
      sort_order      INTEGER NOT NULL DEFAULT 0,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // v2.3: Plan management — status tracking + updated_at
  await query(`ALTER TABLE plan_templates ADD COLUMN IF NOT EXISTS status VARCHAR(16) DEFAULT 'active'`);
  await query(`ALTER TABLE plan_templates ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);

  // Seed plan templates if empty
  const { rows: plans } = await query('SELECT COUNT(*) as cnt FROM plan_templates');
  if (Number(plans[0].cnt) === 0) {
    await query(`
      INSERT INTO plan_templates (plan_id, plan_name, tier, annual_fee_yuan, initial_credit, seats_min, seats_max, renewal_discount, renewal_price_per_100k, monthly_allowance, features, sort_order)
      VALUES
        ('start',  'Start 启航版', 'start',  19800, 500000,   1,  3,  1.00, 1000, 0,        '标准 Skill 全量可用;基础权限;标准支持', 1),
        ('growth', 'Growth 成长版','growth', 39800, 1500000,  4, 10,  0.90, 900,  0,        '团队协作;部门额度;基础数据/系统连接', 2),
        ('ultra',  'Ultra 规模版', 'ultra',  88000, 5000000, 11, 30,  0.80, 800,  0,        '多级权限;预算控制;优先队列;客户成功服务', 3),
        ('enterprise', 'Enterprise 企业版', 'enterprise', 0, 0, 30, 999, 0.75, 700, 0, '专属环境;SLA;私有化/复杂集成;按需报价', 4)
    `);
    console.log('Seeded 4 plan templates');
  }

  // Extend credits_accounts with customer metadata
  await query(`ALTER TABLE credits_accounts ADD COLUMN IF NOT EXISTS company_name VARCHAR(128)`);
  await query(`ALTER TABLE credits_accounts ADD COLUMN IF NOT EXISTS contact_name VARCHAR(64)`);
  await query(`ALTER TABLE credits_accounts ADD COLUMN IF NOT EXISTS contact_email VARCHAR(128)`);
  await query(`ALTER TABLE credits_accounts ADD COLUMN IF NOT EXISTS subscription_start TIMESTAMPTZ`);
  await query(`ALTER TABLE credits_accounts ADD COLUMN IF NOT EXISTS subscription_end TIMESTAMPTZ`);
  await query(`ALTER TABLE credits_accounts ADD COLUMN IF NOT EXISTS plan_id VARCHAR(32)`);

  // ── v2 tables: Skill Pricing & Billing Events ──
  await query(`
    CREATE TABLE IF NOT EXISTS skill_prices (
      skill_id        VARCHAR(128) PRIMARY KEY,
      skill_name      VARCHAR(256) NOT NULL,
      description     TEXT,
      category        VARCHAR(64) NOT NULL,
      credit_per_unit BIGINT NOT NULL,
      billing_unit    VARCHAR(32) NOT NULL DEFAULT 'per_item',
      status          VARCHAR(16) NOT NULL DEFAULT 'live',
      sort_order      INTEGER NOT NULL DEFAULT 0,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_skill_prices_category ON skill_prices(category)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_skill_prices_status ON skill_prices(status)`);

  // v2.4: responsible_person for skill ownership tracking
  await query(`ALTER TABLE skill_prices ADD COLUMN IF NOT EXISTS responsible_person VARCHAR(64)`);

  // cost (元/单位) — direct cost per billing unit (token + external API)
  await query(`ALTER TABLE skill_prices ADD COLUMN IF NOT EXISTS cost NUMERIC`);

  // v2.6: service_line — business-line grouping (dealclaw / aochuang / xingqing / mio / csm / creative / internal / gateway)
  await query(`ALTER TABLE skill_prices ADD COLUMN IF NOT EXISTS service_line VARCHAR(64)`);

  // v2.5: activation workflow — approval gate before billing
  await query(`ALTER TABLE skill_prices ADD COLUMN IF NOT EXISTS activation_status VARCHAR(16) DEFAULT 'approved'`);
  await query(`ALTER TABLE skill_prices ADD COLUMN IF NOT EXISTS approved_by VARCHAR(64)`);
  await query(`ALTER TABLE skill_prices ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ`);
  await query(`CREATE INDEX IF NOT EXISTS idx_skill_prices_activation ON skill_prices(activation_status)`);

  await query(`
    CREATE TABLE IF NOT EXISTS price_change_log (
      id              SERIAL PRIMARY KEY,
      skill_id        VARCHAR(128) NOT NULL,
      old_credit      BIGINT,
      new_credit      BIGINT NOT NULL,
      changed_by      VARCHAR(64) NOT NULL DEFAULT 'admin',
      reason          TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS skill_billing_events (
      id              VARCHAR(64) PRIMARY KEY,
      tenant_id       VARCHAR(64) NOT NULL,
      task_id         VARCHAR(128),
      skill_id        VARCHAR(128) NOT NULL,
      skill_name      VARCHAR(256),
      quantity        INTEGER NOT NULL DEFAULT 1,
      credit_amount   BIGINT NOT NULL,
      unit_price      BIGINT,
      status          VARCHAR(16) NOT NULL DEFAULT 'estimated',
      transaction_id  VARCHAR(64),
      result_summary  TEXT,
      metadata        JSONB DEFAULT '{}',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_billing_events_tenant ON skill_billing_events(tenant_id, created_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_billing_events_skill ON skill_billing_events(skill_id, created_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_billing_events_task ON skill_billing_events(task_id)`);

  // ── v3: LLM token usage accounting (nexus-gateway LLM proxy) ──
  // Shadow accounting only — records raw input/output tokens per provider
  // model call. Never debits credits (folding tokens into credits is a
  // separate product decision); kept apart from skill_billing_events on
  // purpose so billing reports stay clean.
  await query(`
    CREATE TABLE IF NOT EXISTS llm_usage_events (
      id            VARCHAR(64) PRIMARY KEY,
      tenant_id     VARCHAR(64) NOT NULL,
      account_id    VARCHAR(64) NOT NULL,
      provider      VARCHAR(64) NOT NULL,
      model         VARCHAR(128) NOT NULL,
      input_tokens  BIGINT NOT NULL DEFAULT 0,
      output_tokens BIGINT NOT NULL DEFAULT 0,
      total_tokens  BIGINT NOT NULL DEFAULT 0,
      latency_ms    INTEGER,
      status        VARCHAR(16) NOT NULL DEFAULT 'ok',
      source        VARCHAR(32) NOT NULL DEFAULT 'proxy',
      request_id    VARCHAR(128),
      metadata      JSONB DEFAULT '{}',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_llm_usage_tenant ON llm_usage_events(tenant_id, created_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_llm_usage_created ON llm_usage_events(created_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_llm_usage_model ON llm_usage_events(provider, model)`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_usage_request_id ON llm_usage_events(request_id) WHERE request_id IS NOT NULL`);

  // ── v4: cache hit/miss token accounting (deepseek prompt caching) ──
  await query(`ALTER TABLE llm_usage_events ADD COLUMN IF NOT EXISTS cache_hit_tokens BIGINT NOT NULL DEFAULT 0`);
  await query(`ALTER TABLE llm_usage_events ADD COLUMN IF NOT EXISTS cache_miss_tokens BIGINT NOT NULL DEFAULT 0`);

  // ── v5: per-model token pricing (peak/off-peak, cache hit/miss) ──
  // Prices are CNY per 1M tokens. Peak/off-peak windows follow DeepSeek's
  // published schedule (workday 09:00-12:00 + 14:00-18:00 = peak; rest +
  // weekend = off-peak). Admin-editable via the pricing API.
  await query(`
    CREATE TABLE IF NOT EXISTS llm_token_pricing (
      provider                  VARCHAR(64)  NOT NULL,
      model                     VARCHAR(128) NOT NULL,
      input_cache_hit_peak      NUMERIC(14,8) NOT NULL,
      input_cache_hit_offpeak   NUMERIC(14,8) NOT NULL,
      input_cache_miss_peak     NUMERIC(14,8) NOT NULL,
      input_cache_miss_offpeak  NUMERIC(14,8) NOT NULL,
      output_peak               NUMERIC(14,8) NOT NULL,
      output_offpeak            NUMERIC(14,8) NOT NULL,
      currency                  VARCHAR(8)   NOT NULL DEFAULT 'CNY',
      updated_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      PRIMARY KEY (provider, model)
    )
  `);

  // ── v2.1: billing_mode column (live/shadow) ──
  await query(`ALTER TABLE skill_billing_events ADD COLUMN IF NOT EXISTS billing_mode VARCHAR(8) DEFAULT 'live'`);
  await query(`CREATE INDEX IF NOT EXISTS idx_billing_events_mode ON skill_billing_events(billing_mode, created_at DESC)`);

  // ── v2.5: Admin Users — JWT token-based auth ──
  await query(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id              VARCHAR(36) PRIMARY KEY,
      username        VARCHAR(64) NOT NULL UNIQUE,
      display_name    VARCHAR(128) NOT NULL,
      token_hash      VARCHAR(64) NOT NULL UNIQUE,
      role            VARCHAR(16) NOT NULL DEFAULT 'admin',
      is_active       BOOLEAN NOT NULL DEFAULT true,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_login_at   TIMESTAMPTZ,
      created_by      VARCHAR(64)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_admin_users_username ON admin_users(username)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_admin_users_active ON admin_users(is_active)`);

  // ── Seed default skill prices if table is empty ──
  const { rows: existingPrices } = await query('SELECT COUNT(*) as cnt FROM skill_prices');
  if (Number(existingPrices[0].cnt) === 0) {
    await seedDefaultPrices();
  }

  // ── v5: Seed default token pricing (DeepSeek official, CNY per 1M tokens) ──
  const { rows: existingTokenPricing } = await query('SELECT COUNT(*) as cnt FROM llm_token_pricing');
  if (Number(existingTokenPricing[0].cnt) === 0) {
    await query(`
      INSERT INTO llm_token_pricing
        (provider, model, input_cache_hit_peak, input_cache_hit_offpeak,
         input_cache_miss_peak, input_cache_miss_offpeak, output_peak, output_offpeak)
      VALUES
        ('deepseek', 'deepseek-v4-pro',   0.30, 0.15, 9.00, 4.50, 27.00, 13.50),
        ('deepseek', 'deepseek-v4-flash', 0.10, 0.05, 3.00, 1.50,  9.00,  4.50)
      ON CONFLICT (provider, model) DO NOTHING
    `);
  }

  // ── v2.2: Gateway agent billing entries (nexus-gateway estimate→settle) ──
  await seedGatewayPrices();

  // ── v2.5: Seed initial admin user ──
  await seedInitialAdmin();

  console.log('Migrations complete');
}

async function seedDefaultPrices() {
  const prices = [
    // ── 收费 Skill（10 个）── 权威定价：小元商业化方案 doc rev167 (2026-08-13)
    // 唯一真相源 = skill_prices 表；此处 seed 仅用于全新部署初始化，务必与 rev167 对齐
    { skillId: 'dealclaw-analyze-company',        skillName: '企业画像分析',           description: '爬官网+AI分析产品线/市场定位/竞争力→写入知识库',               category: 'insight',    creditPerUnit: 2000,   billingUnit: 'per_use',    sortOrder: 1 },
    { skillId: 'dealclaw-market-report',          skillName: '市场洞察报告',           description: '按品类+国家生成外贸市场决策与选品HTML报告',                    category: 'insight',    creditPerUnit: 1000,   billingUnit: 'per_report', sortOrder: 2 },
    { skillId: 'dealclaw-buyer-leads-push',       skillName: '买家线索推送',           description: '主动推送买家线索：持续匹配+筛选+主动送达',                       category: 'buyer',      creditPerUnit: 1000,   billingUnit: 'per_item',   sortOrder: 3 },
    { skillId: 'dealclaw-find-buyers',            skillName: '搜索买家',               description: '按产品+国家+买家类型搜索匹配买家，含公司简介+官网+推荐理由',    category: 'buyer',      creditPerUnit: 800,    billingUnit: 'per_item',   sortOrder: 4 },
    { skillId: 'dealclaw-exhibition-leads',       skillName: '展后线索处理',           description: '名片OCR/录音ASR→买家匹配→意向分级→展后跟进→写入线索池',        category: 'exhibition', creditPerUnit: 800,    billingUnit: 'per_person', sortOrder: 5 },
    { skillId: 'dealclaw-exhibition-invitation',  skillName: '展会邀约',               description: '搜展会目标买家→生成个性化邀约文案→邮件发送',                    category: 'exhibition', creditPerUnit: 200,    billingUnit: 'per_person', sortOrder: 6 },
    { skillId: 'dealclaw-email-founder-direct',   skillName: '一对一精准开发信',       description: '深度个性化→SMTP创始人直达，日限15封',                            category: 'outreach',   creditPerUnit: 100,    billingUnit: 'per_email',  sortOrder: 7 },
    { skillId: 'dealclaw-lead-import',            skillName: '导入线索',               description: '上传Excel/CSV→AI列映射→去重→写入线索池，来源标记用户导入',      category: 'admin',      creditPerUnit: 100,    billingUnit: 'per_use',    sortOrder: 8 },
    { skillId: 'dealclaw-email-growth-send',      skillName: '批量开发信群发',         description: '批量生成个性化开发信→Resend群发→自动序列跟进',                  category: 'outreach',   creditPerUnit: 50,     billingUnit: 'per_email',  sortOrder: 9 },
    { skillId: 'dealclaw-smart-reply',            skillName: '自动处理买家回复',       description: '监控买家回复→意图识别+询盘分类→生成建议回复/自动回复',          category: 'outreach',   creditPerUnit: 50,     billingUnit: 'per_reply',  sortOrder: 10 },

    // ── 免费 Skill（3 个）── credit_per_unit = 0, 仅登记不扣费
    { skillId: 'dealclaw-review',                 skillName: '画像偏好标注',           description: '用户对画像/买家标注✅❌→偏好晋升+双写知识库',                    category: 'admin',      creditPerUnit: 0,      billingUnit: 'per_use',    sortOrder: 50 },
    { skillId: 'dealclaw-knowledge-base',         skillName: '知识库浏览',             description: '企业知识库三层浏览（首页+主题页+资料层）',                       category: 'admin',      creditPerUnit: 0,      billingUnit: 'per_use',    sortOrder: 51 },
    { skillId: 'dealclaw-email-bindings',         skillName: '邮箱绑定',               description: '绑定代理邮箱→飞书群webhook，实现邮件通知',                       category: 'admin',      creditPerUnit: 0,      billingUnit: 'per_use',    sortOrder: 52 },
  ];

  for (const p of prices) {
    await query(
      `INSERT INTO skill_prices (skill_id, skill_name, description, category, credit_per_unit, billing_unit, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (skill_id) DO NOTHING`,
      [p.skillId, p.skillName, p.description, p.category, p.creditPerUnit, p.billingUnit, p.sortOrder]
    );
  }

  console.log(`Seeded ${prices.length} default skill prices`);
}

/**
 * Seed gateway agent billing entries so nexus-gateway can use
 * the estimate→settle billing-hook flow instead of direct debit.
 * Uses ON CONFLICT to safely add to existing tables.
 */
async function seedGatewayPrices() {
  const gatewayPrices = [
    { skillId: 'gateway.chat',    skillName: '网关-对话',   description: 'Nexus Gateway agent 对话请求（免费）',  category: 'gateway', creditPerUnit: 0,    billingUnit: 'per_call', sortOrder: 100 },
    { skillId: 'gateway.command', skillName: '网关-命令',   description: 'Nexus Gateway agent 命令执行',           category: 'gateway', creditPerUnit: 5000, billingUnit: 'per_call', sortOrder: 101 },
    { skillId: 'gateway.query',   skillName: '网关-查询',   description: 'Nexus Gateway agent 数据查询',           category: 'gateway', creditPerUnit: 2000, billingUnit: 'per_call', sortOrder: 102 },
    { skillId: 'gateway.action',  skillName: '网关-动作',   description: 'Nexus Gateway agent 写操作/动作',        category: 'gateway', creditPerUnit: 8000, billingUnit: 'per_call', sortOrder: 103 },
    { skillId: 'gateway.default', skillName: '网关-默认',   description: 'Nexus Gateway agent 未识别意图回退',       category: 'gateway', creditPerUnit: 2000, billingUnit: 'per_call', sortOrder: 104 },
  ];

  for (const p of gatewayPrices) {
    await query(
      `INSERT INTO skill_prices (skill_id, skill_name, description, category, credit_per_unit, billing_unit, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (skill_id) DO NOTHING`,
      [p.skillId, p.skillName, p.description, p.category, p.creditPerUnit, p.billingUnit, p.sortOrder]
    );
  }

  console.log(`Seeded ${gatewayPrices.length} gateway skill prices`);
}

/**
 * Seed initial admin user (admin/管理员) if admin_users table is empty.
 * The login token is printed to console — save it before deploying!
 */
async function seedInitialAdmin() {
  const { rows } = await query('SELECT COUNT(*) as cnt FROM admin_users');
  if (Number(rows[0].cnt) > 0) {
    console.log('Admin users already exist, skip seed');
    return;
  }

  // Import dynamically to avoid circular deps
  const { generateLoginToken } = await import('../services/admin-auth.js');
  const { createHmac } = await import('node:crypto');

  const loginToken = generateLoginToken();
  const JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'changeme-in-production';
  const tokenHash = createHmac('sha256', JWT_SECRET).update(loginToken).digest('hex');

  await query(
    `INSERT INTO admin_users (id, username, display_name, token_hash, role, created_by)
     VALUES ('adm_seed_001', 'admin', '管理员', $1, 'admin', 'system')`,
    [tokenHash]
  );

  console.log('');
  console.log('══════════════════════════════════════════════');
  console.log('  管理员账号已创建');
  console.log('  用户名: admin');
  console.log('  显示名: 管理员');
  console.log('  角色: admin');
  console.log(`  登录口令: ${loginToken}`);
  console.log('  ⚠️  请立即保存此口令！不会再次显示！');
  console.log('══════════════════════════════════════════════');
  console.log('');
}
