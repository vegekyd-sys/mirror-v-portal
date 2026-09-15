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
        scope                 TEXT,                            -- NULL=全量 rollout；非空=单租户（tenant_id）
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
      -- 存量库回填：rollout_batch_tasks 若先于 scope 列建表（旧版本），须先补列——
      -- 必须放在下方唯一索引引用 scope 之前执行，否则存量库会报 column "scope" does not exist。
      ALTER TABLE rollout_batch_tasks ADD COLUMN IF NOT EXISTS scope TEXT;
      CREATE INDEX IF NOT EXISTS idx_rollout_batch_tasks_status ON rollout_batch_tasks(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_rollout_batch_tasks_created ON rollout_batch_tasks(created_at DESC);
      -- 幂等入队去重：一个 service+image（全量，scope IS NULL）同一时刻只允许
      -- 一个进行中的任务，避免 rollout cron 重复触发导致任务堆积。单租户 pin
      -- （scope 非空）不去重——pin 是明确的单租户操作，每次入队新建任务。
      CREATE UNIQUE INDEX IF NOT EXISTS rollout_batch_tasks_active_uq
        ON rollout_batch_tasks(service, image)
        WHERE status IN ('pending','running') AND scope IS NULL;
      DO $$ 
      DECLARE v_def TEXT;
      BEGIN
        SELECT indexdef INTO v_def FROM pg_indexes WHERE indexname = 'rollout_batch_tasks_active_uq';
        IF v_def IS NOT NULL AND v_def NOT LIKE '%scope IS NULL%' THEN
          DROP INDEX rollout_batch_tasks_active_uq;
          CREATE UNIQUE INDEX rollout_batch_tasks_active_uq
            ON rollout_batch_tasks(service, image)
            WHERE status IN ('pending','running') AND scope IS NULL;
        END IF;
      END $$;

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

    // ── WeCom (企业微信) bot bindings — credential-based direct connection ─
    // One tenant ↔ one WeCom bot. `bot_id` is a non-sensitive identifier kept
    // for display only; the bot `secret` is materialized as the
    // `dealclaw-wecom-<tenantId>` Secret and is NEVER written to the DB.
    // UNIQUE(tenant_id) enforces single-binding. The channel only exists on
    // the OpenClaw message plane (fail-closed in write-config.mjs).
    await client.query(`
      CREATE TABLE IF NOT EXISTS wecom_bindings (
        id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        tenant_id       TEXT NOT NULL UNIQUE REFERENCES tenants(tenant_id) ON DELETE CASCADE,
        bot_id          TEXT,
        status          TEXT NOT NULL DEFAULT 'unbound'
                        CHECK (status IN ('unbound','bound','disabling','disabled')),
        bound_at        TIMESTAMPTZ,
        unbound_at      TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_wecom_bindings_tenant
        ON wecom_bindings(tenant_id, status);
      -- Partial unique index: the same WeCom bot can only be bound to one
      -- tenant at a time. PG table-level UNIQUE has no WHERE clause, so this
      -- must be a CREATE UNIQUE INDEX (NULL bot_id / non-bound rows excluded).
      CREATE UNIQUE INDEX IF NOT EXISTS wecom_bindings_bot_id_uq
        ON wecom_bindings(bot_id)
        WHERE bot_id IS NOT NULL AND status = 'bound';
    `);

    // ── DingTalk (钉钉) bot bindings — credential-based direct connection ─
    // One tenant ↔ one DingTalk bot. `client_id` is a non-sensitive identifier
    // kept for display only; the `client_secret` is materialized as the
    // `dealclaw-dingtalk-<tenantId>` Secret and is NEVER written to the DB.
    // UNIQUE(tenant_id) enforces single-binding. The channel only exists on
    // the OpenClaw message plane (fail-closed in write-config.mjs).
    await client.query(`
      CREATE TABLE IF NOT EXISTS dingtalk_bindings (
        id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        tenant_id       TEXT NOT NULL UNIQUE REFERENCES tenants(tenant_id) ON DELETE CASCADE,
        client_id       TEXT,
        status          TEXT NOT NULL DEFAULT 'unbound'
                        CHECK (status IN ('unbound','bound','disabling','disabled')),
        bound_at        TIMESTAMPTZ,
        unbound_at      TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_dingtalk_bindings_tenant
        ON dingtalk_bindings(tenant_id, status);
      -- Partial unique index: the same DingTalk bot can only be bound to one
      -- tenant at a time. PG table-level UNIQUE has no WHERE clause, so this
      -- must be a CREATE UNIQUE INDEX (NULL client_id / non-bound rows excluded).
      CREATE UNIQUE INDEX IF NOT EXISTS dingtalk_bindings_client_id_uq
        ON dingtalk_bindings(client_id)
        WHERE client_id IS NOT NULL AND status = 'bound';
    `);

    // ── Shared DM session (v0.9) — per-tenant toggle that merges Feishu and
    // WeChat DM conversations into a single session (agent:dealclaw:main),
    // enabling cross-channel conversation continuity. Suitable for single-user
    // tenants where the same person talks to the agent on both Feishu and
    // WeChat. Multi-user tenants should NOT enable this (sessions would cross-
    // contaminate). The toggle is materialised as the
    // DEALCLAW_SHARED_DM_SESSION env var on the agent Deployment; write-config
    // .mjs checks it with priority over DEALCLAW_SESSION_DM_SCOPE.
    await client.query(`
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS shared_dm_session BOOLEAN NOT NULL DEFAULT TRUE;
    `);

    // v0.10 — shared DM session is now DEFAULT ON. For environments where the
    // column already exists (v0.9 created it with DEFAULT FALSE), align the
    // column default and backfill existing rows so the admin console reflects
    // "enabled" consistently with the runtime. NOTE: write-config.mjs treats
    // an unset DEALCLAW_SHARED_DM_SESSION as enabled, but a tenant whose
    // Deployment env was explicitly set to '0' (manually disabled) keeps
    // DEALCLAW_SHARED_DM_SESSION=0 — the runtime stays "disabled" for those;
    // only the DB flag is realigned here.
    await client.query(`
      ALTER TABLE tenants ALTER COLUMN shared_dm_session SET DEFAULT TRUE;
      UPDATE tenants SET shared_dm_session = TRUE WHERE shared_dm_session = FALSE;
    `);

    // P0 structured model catalog is expand-only and remains shadow data until
    // an administrator explicitly publishes a compatibility snapshot.
    await client.query(`
      CREATE TABLE IF NOT EXISTS llm_provider_instances (
        id TEXT PRIMARY KEY, legacy_provider_name TEXT NOT NULL UNIQUE,
        template_key TEXT NOT NULL DEFAULT 'custom-openai', display_name TEXT,
        protocol TEXT NOT NULL DEFAULT 'openai-completions' CHECK (protocol IN ('openai-completions')),
        base_url TEXT NOT NULL, encrypted_api_key TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('legacy-import','manual','builtin-catalog')),
        enabled BOOLEAN NOT NULL DEFAULT TRUE, metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS llm_provider_models (
        id TEXT PRIMARY KEY, provider_instance_id TEXT NOT NULL REFERENCES llm_provider_instances(id) ON DELETE CASCADE,
        model_id TEXT NOT NULL, display_name TEXT, model_type TEXT NOT NULL DEFAULT 'unknown',
        runtime_enabled BOOLEAN NOT NULL DEFAULT FALSE, discovered_params JSONB, override_params JSONB,
        effective_params JSONB NOT NULL, params_schema_version INTEGER NOT NULL DEFAULT 1,
        params_status TEXT NOT NULL CHECK (params_status IN ('complete','incomplete','fallback','invalid')),
        source TEXT NOT NULL CHECK (source IN ('legacy-import','manual','builtin-catalog')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (model_type IN ('chat','embedding','rerank','image-generation','image-edit','speech','transcription','audio-generation','video-generation','multimodal-embedding','unknown')),
        CHECK (jsonb_typeof(effective_params)='object'), UNIQUE(provider_instance_id, model_id)
      );
      CREATE INDEX IF NOT EXISTS idx_llm_provider_models_runtime ON llm_provider_models(provider_instance_id, runtime_enabled);
      CREATE TABLE IF NOT EXISTS llm_catalog_import_runs (
        id UUID PRIMARY KEY, source_kind TEXT NOT NULL, source_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running','succeeded','partial','failed')),
        total_count INTEGER NOT NULL DEFAULT 0, succeeded_count INTEGER NOT NULL DEFAULT 0,
        skipped_count INTEGER NOT NULL DEFAULT 0, error_count INTEGER NOT NULL DEFAULT 0,
        report JSONB NOT NULL DEFAULT '{}'::jsonb, started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), finished_at TIMESTAMPTZ,
        UNIQUE(source_kind, source_fingerprint)
      );
      CREATE TABLE IF NOT EXISTS llm_catalog_snapshot_backups (
        id UUID PRIMARY KEY, runtime_config_id BIGINT REFERENCES runtime_configs(id) ON DELETE SET NULL,
        encrypted_value TEXT NOT NULL, source_fingerprint TEXT NOT NULL, actor TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE llm_provider_models ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 0;
      ALTER TABLE llm_provider_models ADD COLUMN IF NOT EXISTS discovered_at TIMESTAMPTZ;
      ALTER TABLE llm_provider_models ADD COLUMN IF NOT EXISTS discovery_run_id UUID;

      CREATE TABLE IF NOT EXISTS llm_model_discovery_runs (
        id UUID PRIMARY KEY,
        provider_instance_id TEXT NOT NULL REFERENCES llm_provider_instances(id) ON DELETE CASCADE,
        adapter TEXT NOT NULL CHECK (adapter IN ('provider-api','builtin-catalog')),
        status TEXT NOT NULL CHECK (status IN ('previewed','applied','failed','expired')),
        requested_model_ids JSONB NOT NULL,
        candidates JSONB NOT NULL,
        source_kind TEXT NOT NULL CHECK (source_kind IN ('provider-api','official-doc','builtin-catalog')),
        source_url TEXT,
        source_version TEXT,
        raw_response_sha256 TEXT NOT NULL CHECK (raw_response_sha256 ~ '^[a-f0-9]{64}$'),
        provider_revision TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        applied_at TIMESTAMPTZ,
        applied_selection_ids JSONB,
        apply_result JSONB,
        error_summary TEXT,
        CHECK (jsonb_typeof(requested_model_ids)='array'),
        CHECK (jsonb_typeof(candidates)='array')
      );
      CREATE INDEX IF NOT EXISTS idx_llm_model_discovery_runs_provider
        ON llm_model_discovery_runs(provider_instance_id, created_at DESC);

      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname='llm_provider_models_discovery_run_id_fkey'
             AND conrelid='llm_provider_models'::regclass
        ) THEN
          ALTER TABLE llm_provider_models ADD CONSTRAINT llm_provider_models_discovery_run_id_fkey
            FOREIGN KEY (discovery_run_id) REFERENCES llm_model_discovery_runs(id) ON DELETE SET NULL;
        END IF;
      END $$;

      CREATE TABLE IF NOT EXISTS llm_model_param_evidence (
        id UUID PRIMARY KEY,
        model_row_id TEXT NOT NULL REFERENCES llm_provider_models(id) ON DELETE CASCADE,
        run_id UUID REFERENCES llm_model_discovery_runs(id) ON DELETE SET NULL,
        layer TEXT NOT NULL CHECK (layer IN ('discovered','override')),
        field_name TEXT NOT NULL,
        value_json JSONB NOT NULL,
        source_kind TEXT NOT NULL CHECK (source_kind IN ('provider-api','official-doc','builtin-catalog','manual-contract')),
        source_url TEXT,
        source_version TEXT,
        observed_at TIMESTAMPTZ NOT NULL,
        raw_sha256 TEXT NOT NULL CHECK (raw_sha256 ~ '^[a-f0-9]{64}$'),
        confidence TEXT NOT NULL CHECK (confidence IN ('high','medium','low')),
        notes TEXT,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_llm_model_param_evidence_model
        ON llm_model_param_evidence(model_row_id, created_at DESC);
    `);

    // ── Immutable Release registry + per-tenant rollout status (P0-2) ──────
    // Every catalog publish creates an append-only Release row with an
    // encrypted canonical snapshot + compat payload + fingerprint. The
    // `llm_catalog_release_pointer` singleton tracks the current "desired"
    // release. `llm_tenant_release_status` tracks per-tenant desired/applied
    // state so the rollout worker can reconcile drift and report delivery.
    //   - `llm_provider_instances.revision` enables optimistic CAS for
    //     scoped rollout (compare-and-swap on the provider row).
    //   - `llm_push_tasks` gains release_id / scope_type / idempotency_key
    //     so a push task can be linked to its Release and de-duplicated.
    await client.query(`
      CREATE TABLE IF NOT EXISTS llm_catalog_releases (
        id                 UUID PRIMARY KEY,
        version            BIGINT NOT NULL,
        parent_id          UUID REFERENCES llm_catalog_releases(id) ON DELETE SET NULL,
        canonical_snapshot TEXT NOT NULL,
        compat_payload     TEXT NOT NULL,
        fingerprint        TEXT NOT NULL,
        parent_fingerprint TEXT,
        diff_summary       JSONB NOT NULL DEFAULT '{}'::jsonb,
        warnings           JSONB NOT NULL DEFAULT '[]'::jsonb,
        actor              TEXT,
        actor_type         TEXT NOT NULL DEFAULT 'admin' CHECK (actor_type IN ('admin','service')),
        status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','rolled-back')),
        idempotency_key    TEXT UNIQUE,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_llm_catalog_releases_version
        ON llm_catalog_releases(version DESC);
      CREATE INDEX IF NOT EXISTS idx_llm_catalog_releases_parent
        ON llm_catalog_releases(parent_id);

      CREATE TABLE IF NOT EXISTS llm_catalog_release_pointer (
        id          TEXT PRIMARY KEY DEFAULT 'current',
        release_id  UUID REFERENCES llm_catalog_releases(id) ON DELETE SET NULL,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      INSERT INTO llm_catalog_release_pointer (id) VALUES ('current') ON CONFLICT DO NOTHING;

      CREATE TABLE IF NOT EXISTS llm_tenant_release_status (
        tenant_id           TEXT NOT NULL,
        desired_release_id  UUID REFERENCES llm_catalog_releases(id) ON DELETE SET NULL,
        applied_release_id  UUID REFERENCES llm_catalog_releases(id) ON DELETE SET NULL,
        applied_fingerprint TEXT,
        applied_at          TIMESTAMPTZ,
        restart_reason      TEXT,
        delivery_status     TEXT CHECK (delivery_status IN ('pending','delivered','failed','skipped','unsupported')),
        error               TEXT,
        attempts            INTEGER NOT NULL DEFAULT 0,
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (tenant_id)
      );

      ALTER TABLE llm_provider_instances
        ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 0;

      ALTER TABLE llm_push_tasks
        ADD COLUMN IF NOT EXISTS release_id UUID REFERENCES llm_catalog_releases(id) ON DELETE SET NULL;
      ALTER TABLE llm_push_tasks
        ADD COLUMN IF NOT EXISTS scope_type TEXT NOT NULL DEFAULT 'full';
      ALTER TABLE llm_push_tasks
        ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
    `);

    // ── Global Model Policy (P0-1 Catalog Authority) ──────────────────────
    // Singleton row (id='current') holding the catalog-only model reference
    // policy: defaultModel / imageModel / compactionModel / fallbackModels.
    // These are stable model row IDs (lpm_...) that resolve into the catalog
    // at snapshot-build time — no legacy JSON skeleton required.
    // revision enables optimistic CAS so concurrent admin edits don't clobber.
    await client.query(`
      CREATE TABLE IF NOT EXISTS llm_global_model_policy (
        id               TEXT PRIMARY KEY DEFAULT 'current',
        default_model    TEXT,
        image_model      TEXT,
        compaction_model TEXT,
        fallback_models  TEXT[] NOT NULL DEFAULT '{}',
        revision         BIGINT NOT NULL DEFAULT 0,
        updated_by       TEXT,
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      INSERT INTO llm_global_model_policy (id) VALUES ('current') ON CONFLICT DO NOTHING;
    `);

    // ── Selection V2: stable model row IDs instead of legacy refs ────────
    // Tenant selection stored as stable lpm_ IDs, so provider renames don't
    // break references. Coexists with the legacy runtime_configs selection
    // during the dual-write / dual-read transition period.
    await client.query(`
      CREATE TABLE IF NOT EXISTS llm_tenant_selection_v2 (
        tenant_id           TEXT NOT NULL,
        default_model_id    TEXT,
        image_model_id      TEXT,
        compaction_model_id TEXT,
        fallback_model_ids  TEXT[] NOT NULL DEFAULT '{}',
        direct_mode         BOOLEAN NOT NULL DEFAULT FALSE,
        revision            BIGINT NOT NULL DEFAULT 0,
        updated_by          TEXT,
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (tenant_id)
      );
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
