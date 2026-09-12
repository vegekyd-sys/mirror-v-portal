import pg from 'pg';

export async function migrate(pool?: pg.Pool): Promise<void> {
  const client = pool ?? new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        tenant_id       TEXT PRIMARY KEY,
        company_name    TEXT NOT NULL,
        contact_email    TEXT NOT NULL,
        contact_phone    TEXT,
        plan_tier       TEXT NOT NULL DEFAULT 'starter' CHECK (plan_tier IN ('starter','pro','enterprise')),
        status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','suspended','grace','destroyed')),
        k8s_namespace   TEXT,  -- shared namespace for all tenants; unique constraint removed
        credits_account_id TEXT,
        quota_agents    INTEGER NOT NULL DEFAULT 1,
        quota_credits_monthly BIGINT NOT NULL DEFAULT 1000000,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS tenant_status_log (
        id              BIGSERIAL PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
        from_status     TEXT,
        to_status       TEXT NOT NULL,
        reason          TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status);

      -- Add app credential columns (v0.3)
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS app_id TEXT;
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS app_secret TEXT;
      -- Drop per-tenant namespace unique constraint (now shared namespace)
      ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_k8s_namespace_key;
      CREATE INDEX IF NOT EXISTS idx_tenants_email ON tenants(contact_email);
      CREATE INDEX IF NOT EXISTS idx_tenant_log_tenant ON tenant_status_log(tenant_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tenant_log_time ON tenant_status_log(created_at);
    `);

    // Add columns for ops-agent state machine (if they don't exist yet)
    await client.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS subscription_end TIMESTAMPTZ`);
    await client.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS grace_until TIMESTAMPTZ`);

    // Notification delivery (v0.4):
    // - platform / im_open_id: where lifecycle notifications get delivered.
    //   im_open_id is captured by nexus-gateway on the tenant's first bot message.
    await client.query(`
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'feishu';
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS im_open_id TEXT;

      -- The original CHECK constraint only allowed the initial five states, but
      -- ops-agent writes 'low_credits' and provisioning writes 'provisioning' /
      -- 'provisioning_failed'. Rebuild the constraint with the full lifecycle set.
      ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_status_check;
      ALTER TABLE tenants ADD CONSTRAINT tenants_status_check CHECK (status IN (
        'pending','provisioning','provisioning_failed',
        'active','low_credits','suspended','grace','destroyed'
      ));

      -- Idempotent notification log. Owned by ops-agent; the UNIQUE dedup_key
      -- guarantees a lifecycle notification is delivered at most once per cycle.
      CREATE TABLE IF NOT EXISTS tenant_notifications (
        id                BIGSERIAL PRIMARY KEY,
        tenant_id         TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
        notification_type TEXT NOT NULL,
        channel           TEXT NOT NULL DEFAULT 'bot',
        dedup_key         TEXT NOT NULL UNIQUE,
        message           TEXT NOT NULL,
        delivered         BOOLEAN NOT NULL DEFAULT FALSE,
        delivery_error    TEXT,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        delivered_at      TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_tenant_notifications_tenant
        ON tenant_notifications(tenant_id, created_at DESC);
    `);

    // Per-tenant runtime configuration (v0.5):
    // Backs the admin-web "runtime config" management page. Values are
    // AES-256-GCM encrypted (see services/crypto.ts) before storage and are
    // materialized as the tenant-config Secret in the tenant's namespace at
    // provisioning time.
    //
    // tenant_id NULL = global default (shared provider keys); a non-NULL
    // tenant_id row overrides the global value for that tenant. Two partial
    // unique indexes are needed because plain UNIQUE treats NULLs as distinct.
    await client.query(`
      CREATE TABLE IF NOT EXISTS runtime_configs (
        id              BIGSERIAL PRIMARY KEY,
        tenant_id       TEXT REFERENCES tenants(tenant_id) ON DELETE CASCADE,
        config_key      TEXT NOT NULL,
        encrypted_value TEXT NOT NULL,
        is_secret       BOOLEAN NOT NULL DEFAULT TRUE,
        description     TEXT,
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS runtime_configs_global_key_uq
        ON runtime_configs(config_key) WHERE tenant_id IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS runtime_configs_tenant_key_uq
        ON runtime_configs(tenant_id, config_key) WHERE tenant_id IS NOT NULL;
    `);

    // Image release registry + rollout targets (v0.6):
    // Every CI build records its image here (Jenkins post-build hook) so the
    // admin console can list built versions and roll them out manually.
    // rollout_targets holds the console-controlled "desired fleet tag" per
    // service; ops-agent's rollout cron reads it (env tags are the fallback).
    await client.query(`
      CREATE TABLE IF NOT EXISTS image_releases (
        id            BIGSERIAL PRIMARY KEY,
        service       TEXT NOT NULL,
        tag           TEXT NOT NULL,
        image         TEXT NOT NULL,
        git_commit    TEXT,
        build_number  TEXT,
        build_env     TEXT,
        created_by    TEXT NOT NULL DEFAULT 'jenkins',
        notes         TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (service, tag)
      );
      CREATE INDEX IF NOT EXISTS idx_image_releases_service
        ON image_releases(service, created_at DESC);

      CREATE TABLE IF NOT EXISTS rollout_targets (
        service     TEXT PRIMARY KEY,
        tag         TEXT NOT NULL,
        updated_by  TEXT,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;

      -- Mio CDP supplier identity (v0.7): per-tenant credential for skills
      -- calling the Mio CDP API (X-Supplier-Id). Optional; unique among
      -- live tenants so one supplier maps to exactly one customer.
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS mio_cdp_supplier_id TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS tenants_mio_supplier_uq
        ON tenants(mio_cdp_supplier_id)
        WHERE mio_cdp_supplier_id IS NOT NULL AND status <> 'destroyed';

      -- External agent endpoint (v0.5): when set, the tenant does NOT get a
      -- per-tenant dealclaw-agent Deployment; chat is proxied straight to this
      -- URL instead. (Historically used by the built-in default tenant, which
      -- was removed — the column is kept for compatibility.)
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS agent_endpoint TEXT;

      -- Message plane (P2): 'gateway' = nexus-gateway WS bridge (default,
      -- legacy); 'openclaw' = in-agent @openclaw/feishu plugin owns the
      -- Feishu long connection (streaming cards, native groups). The gateway
      -- then serves purely as the LLM egress proxy.
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS message_plane TEXT NOT NULL DEFAULT 'gateway';
      ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_message_plane_check;
      ALTER TABLE tenants ADD CONSTRAINT tenants_message_plane_check
        CHECK (message_plane IN ('gateway','openclaw'));

      -- External API keys for third-party (Mio) token accounting access.
      -- Each key may be scoped to a single supplier (NULL = all suppliers).
      CREATE TABLE IF NOT EXISTS external_api_keys (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        key_hash    TEXT NOT NULL UNIQUE,
        key_prefix  TEXT NOT NULL,
        supplier_id TEXT,
        status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
        created_by  TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        revoked_at  TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_external_api_keys_status ON external_api_keys(status);
    `);

    // Chat message log (v0.8): the in-agent dealclaw-chatlog plugin reports
    // every inbound/outbound message (full text) so the admin console can
    // render a conversation history per agent.
    //   - direction: 'in' = user message, 'out' = agent reply.
    //   - sender_name/username: snapshot at ingest time (contact API may be
    //     unavailable or the org may rename people later); NULL when the
    //     tenant's Feishu app lacks contact:user.base:readonly.
    //   - run_id NULL/empty on outbound rows = proactive message (cron /
    //     heartbeat), used by the UI to filter them out.
    //   - Partial UNIQUE on message_id gives idempotent ingest: the plugin
    //     is fire-and-forget and may retry after timeouts.
    await client.query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id              BIGSERIAL PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
        direction       TEXT NOT NULL CHECK (direction IN ('in','out')),
        channel         TEXT,
        sender_open_id  TEXT,
        sender_name     TEXT,
        sender_username TEXT,
        content         TEXT NOT NULL,
        session_key     TEXT,
        message_id      TEXT,
        run_id          TEXT,
        success         BOOLEAN,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_tenant_msgid_uq
        ON chat_messages(tenant_id, message_id) WHERE message_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_chat_messages_tenant_time
        ON chat_messages(tenant_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_chat_messages_tenant_session
        ON chat_messages(tenant_id, session_key, created_at DESC);
    `);

    // Audit log (v0.9): every mutating admin/tenant operation is recorded —
    // both an automatic Express middleware capture (method/path/body, no
    // old-value) and explicit writes from high-risk handlers (old→new, e.g.
    // image-release promote, llm-provider updates, tenant status changes).
    //   - actor: admin JWT username, 'service-token' for machine callers, or
    //     'external:<keyPrefix>' for third-party API-key callers.
    //   - old_value/new_value: JSONB snapshots with secrets redacted.
    // Retention: pruned after 180 days (services/audit.ts pruneAuditLogs).
    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id            BIGSERIAL PRIMARY KEY,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        actor         TEXT NOT NULL,
        actor_type    TEXT NOT NULL DEFAULT 'admin' CHECK (actor_type IN ('admin','service','external')),
        action        TEXT NOT NULL,
        method        TEXT,
        path          TEXT,
        resource_type TEXT,
        resource_id   TEXT,
        tenant_id     TEXT,
        old_value     JSONB,
        new_value     JSONB,
        status_code   INTEGER,
        duration_ms   INTEGER,
        ip            TEXT,
        request_id    TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_audit_logs_time ON audit_logs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant ON audit_logs(tenant_id, created_at DESC) WHERE tenant_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor, created_at DESC);
    `);

    // Per-tenant image override ("pin", v0.10): lets the admin console lock a
    // single tenant's dealclaw-agent / nexus-gateway Deployment to a specific
    // image, so ops-agent's rollout cron (POST /v1/tenants/batch/deployment)
    // SKIPS that tenant instead of reverting it to the promoted rollout_target.
    // Absence of a row = "follow the fleet" (existing behaviour, zero backfill).
    await client.query(`
      CREATE TABLE IF NOT EXISTS tenant_image_overrides (
        tenant_id  TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
        service    TEXT NOT NULL CHECK (service IN ('dealclaw-agent','nexus-gateway')),
        image      TEXT NOT NULL,
        updated_by TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (tenant_id, service)
      );
    `);

    // ── LLM push async task (v0.11) ────────────────────────────────────────
    // 把「全局供应商库写入 → 逐租户物化 Secret + 滚动重启」从同步 HTTP 请求
    // 改为持久化任务：保存接口只入队（pending）立即返回，进程内 worker 用
    // FOR UPDATE SKIP LOCKED 认领，逐租户执行并边跑边推 SSE 进度。
    //   - prev_library / next_library 用与 runtime_configs 相同的 AES-256-GCM
    //     加密（services/crypto.ts encryptValue），worker 执行时再解密，避免
    //     密钥明文二处落库。快照式存储保证任务确定性（并发编辑不干扰在跑任务）。
    //   - 租约（lease_expires_at）覆盖进程崩溃/重启：reaper 回收超时 running
    //     任务回 pending，worker 断点续跑只处理仍 pending 的 item。
    await client.query(`
      CREATE TABLE IF NOT EXISTS llm_push_tasks (
        id                TEXT PRIMARY KEY,               -- 应用层 randomUUID()
        kind              TEXT NOT NULL CHECK (kind IN ('global_push','tenant_push')),
        scope             TEXT,                            -- NULL=全局；tenant_push 时为 tenant_id
        trigger           TEXT NOT NULL DEFAULT 'save' CHECK (trigger IN ('save','delete','selection','retry')),
        status            TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','running','succeeded','partial','failed','cancelled')),
        prev_library      TEXT,                            -- 加密 JSON（LlmProvidersConfig | null）
        next_library      TEXT,                            -- 加密 JSON（LlmProvidersConfig | null）
        total_count       INTEGER NOT NULL DEFAULT 0,
        succeeded_count   INTEGER NOT NULL DEFAULT 0,
        failed_count      INTEGER NOT NULL DEFAULT 0,
        skipped_count     INTEGER NOT NULL DEFAULT 0,
        error             TEXT,                            -- 任务级致命错误
        actor             TEXT,
        actor_type        TEXT NOT NULL DEFAULT 'admin' CHECK (actor_type IN ('admin','service')),
        lease_owner       TEXT,                            -- worker 进程标识
        lease_expires_at  TIMESTAMPTZ,                     -- 续租 TTL
        cancel_requested  BOOLEAN NOT NULL DEFAULT FALSE,  -- 协作式取消标记（v1 预留）
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at        TIMESTAMPTZ,
        finished_at       TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_llm_push_tasks_status ON llm_push_tasks(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_llm_push_tasks_created ON llm_push_tasks(created_at DESC);

      CREATE TABLE IF NOT EXISTS llm_push_task_items (
        id                BIGSERIAL PRIMARY KEY,
        task_id           TEXT NOT NULL REFERENCES llm_push_tasks(id) ON DELETE CASCADE,
        tenant_id         TEXT NOT NULL,
        status            TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','running','succeeded','skipped','failed')),
        restarted         BOOLEAN NOT NULL DEFAULT FALSE,  -- agent 是否滚动
        gateway_restarted BOOLEAN NOT NULL DEFAULT FALSE,  -- gateway 是否滚动
        skip_restart      BOOLEAN NOT NULL DEFAULT FALSE,  -- 差分判定无需重启但 Secret 已物化
        error             TEXT,
        attempts          INTEGER NOT NULL DEFAULT 0,
        started_at        TIMESTAMPTZ,
        finished_at       TIMESTAMPTZ,
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_llm_push_items_task ON llm_push_task_items(task_id, id);
      CREATE INDEX IF NOT EXISTS idx_llm_push_items_status ON llm_push_task_items(task_id, status);
    `);

    // ── Rollout batch async task (v0.12) ───────────────────────────────────
    // 把「全量镜像滚动」（POST /v1/tenants/batch/deployment）从同步串行 for
    // 循环改为持久化任务：入队（pending）立即返回 taskId，进程内 worker 用
    // FOR UPDATE SKIP LOCKED 认领，逐租户 recreate（scale 0 → patch → scale 1）
    // 并边跑边推 SSE 进度。解决原同步接口串行 ~114 租户耗时 10min+ 而调用方
    // （ops-agent）只等 120s 的超时缺口。
    //   - 幂等入队：同一 service+image 已有 pending/running 任务时复用该任务，
    //     避免 rollout cron 重复触发导致任务堆积。
    //   - 租约（lease_expires_at）覆盖进程崩溃/重启：reaper 回收超时 running
    //     任务回 pending，worker 断点续跑只处理仍 pending 的 item。
    await client.query(`
      CREATE TABLE IF NOT EXISTS rollout_batch_tasks (
        id                    TEXT PRIMARY KEY,               -- 应用层 randomUUID()
        service               TEXT NOT NULL CHECK (service IN ('dealclaw-agent','nexus-gateway')),
        image                 TEXT NOT NULL,                  -- 规范化后的完整镜像
        tag                   TEXT NOT NULL,                  -- 期望 tag（展示用）
        status                TEXT NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','running','succeeded','partial','failed','cancelled')),
        total_count           INTEGER NOT NULL DEFAULT 0,
        succeeded_count       INTEGER NOT NULL DEFAULT 0,
        already_current_count INTEGER NOT NULL DEFAULT 0,
        pinned_count          INTEGER NOT NULL DEFAULT 0,
        skipped_count         INTEGER NOT NULL DEFAULT 0,
        failed_count          INTEGER NOT NULL DEFAULT 0,
        error                 TEXT,                           -- 任务级致命错误
        actor                 TEXT,
        actor_type            TEXT NOT NULL DEFAULT 'service' CHECK (actor_type IN ('admin','service')),
        lease_owner           TEXT,                           -- worker 进程标识
        lease_expires_at      TIMESTAMPTZ,                    -- 续租 TTL
        cancel_requested      BOOLEAN NOT NULL DEFAULT FALSE, -- 协作式取消标记（预留）
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at            TIMESTAMPTZ,
        finished_at           TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_rollout_batch_tasks_status ON rollout_batch_tasks(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_rollout_batch_tasks_created ON rollout_batch_tasks(created_at DESC);
      -- 幂等入队去重：一个 service+image 同一时刻只允许一个进行中的任务
      CREATE UNIQUE INDEX IF NOT EXISTS rollout_batch_tasks_active_uq
        ON rollout_batch_tasks(service, image)
        WHERE status IN ('pending','running');

      CREATE TABLE IF NOT EXISTS rollout_batch_task_items (
        id          BIGSERIAL PRIMARY KEY,
        task_id     TEXT NOT NULL REFERENCES rollout_batch_tasks(id) ON DELETE CASCADE,
        tenant_id   TEXT NOT NULL,
        namespace   TEXT NOT NULL,                            -- k8s namespace（enumerate 时快照，避免 worker 重查）
        deployment  TEXT NOT NULL,                            -- deployment 名（展示/日志用）
        status      TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','running','succeeded','already_current','pinned','skipped','failed')),
        error       TEXT,
        attempts    INTEGER NOT NULL DEFAULT 0,
        started_at  TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_rollout_batch_items_task ON rollout_batch_task_items(task_id, id);
      CREATE INDEX IF NOT EXISTS idx_rollout_batch_items_status ON rollout_batch_task_items(task_id, status);
    `);

    // External chat API keys (v0.7) — authenticate third-party HTTP access
    // to the agent conversation endpoint (POST /api/external/chat). Scoped
    // per tenant (one enterprise = one tenant); optionally bound to a single
    // agent. Unlike external_api_keys (read-only, supplier-scoped), these
    // keys authorize WRITE access — triggering agent execution + LLM calls
    // that bill the tenant's credit account via llm-proxy.
    await client.query(`
      CREATE TABLE IF NOT EXISTS chat_api_keys (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
        agent_id        TEXT,
        name            TEXT NOT NULL,
        key_hash        TEXT NOT NULL,
        key_prefix      TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','revoked')),
        ip_allowlist    JSONB,
        rate_limit_rpm  INTEGER NOT NULL DEFAULT 60,
        created_by      TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        revoked_at      TIMESTAMPTZ,
        last_used_at    TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_chat_api_keys_hash
        ON chat_api_keys(key_hash) WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS idx_chat_api_keys_tenant
        ON chat_api_keys(tenant_id, created_at DESC);
    `);

    // ── WeChat bindings (v0.8) — personal WeChat QR-login direct connection ─
    // One tenant ↔ one WeChat account. The account token itself is stored by
    // the OpenClaw plugin in the tenant's PVC state directory
    // (/data/state/openclaw-weixin/accounts/{id}.json) — this table only
    // tracks the binding status, not the token. UNIQUE(tenant_id) enforces
    // single-binding; UNIQUE(account_id) prevents the same WeChat account
    // from being bound to two tenants (would cause monitor competition).
    await client.query(`
      CREATE TABLE IF NOT EXISTS wechat_bindings (
        id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        tenant_id       TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
        account_id      TEXT,
        weixin_user_id  TEXT,
        status          TEXT NOT NULL DEFAULT 'unbound'
                        CHECK (status IN (
                          'unbound','validating','bound','active',
                          'disabling','disabled','failed','expired'
                        )),
        session_id      TEXT,
        last_error      TEXT,
        bound_at        TIMESTAMPTZ,
        unbound_at      TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (tenant_id)
      );
      -- Partial unique index: prevents the same WeChat account from being
      -- bound to two tenants simultaneously. PostgreSQL table-level UNIQUE
      -- constraints do NOT support WHERE clauses — partial indexes must be
      -- CREATE UNIQUE INDEX. NULL account_id is excluded (unbound rows).
      CREATE UNIQUE INDEX IF NOT EXISTS wechat_bindings_account_uq
        ON wechat_bindings(account_id)
        WHERE account_id IS NOT NULL AND status IN ('validating','bound','active');
      CREATE INDEX IF NOT EXISTS idx_wechat_bindings_tenant
        ON wechat_bindings(tenant_id, status);
    `);

    console.log(JSON.stringify({
      level: 'info',
      action: 'migrate',
      message: 'Tenant registry migration complete',
    }));
  } finally {
    if (!pool) await client.end();
  }
}

// Run directly
const isMain = process.argv[1]?.includes('migrate');
if (isMain) {
  migrate().then(() => process.exit(0)).catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}
