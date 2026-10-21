import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import pg, { type PoolClient } from "pg";
import { PgBoss } from "pg-boss";
import { normalizeInboundAttachments, type InboundAttachment } from "./inbound-media.js";
import type { Config } from "./config.js";

export interface Tenant {
  id: string;
  name: string;
  app_id: string | null;
  secret: string | null;
  sandbox_name: string | null;
  state: string;
  last_activity: Date;
  idle_seconds: number;
  last_error: string | null;
  wake_count: number;
  last_wake_ms: number | null;
  snapshot_id: string | null;
  template_id: string;
  template_version: string;
  template_snapshot_id: string | null;
  runtime_provider?: "vercel" | "alibaba";
  /** Unsealed per-tenant secrets, attached just before boot; never persisted on this object. */
  runtime_env?: Record<string, string>;
}
export interface ChannelBinding {
  tenant_id: string;
  channel: string;
  external_id: string | null;
  credentials: string;
  cursor: string | null;
  state: string;
  last_error: string | null;
}
export interface Run {
  schedule_id?: string;
  schedule_kind?: string;
  chat_id?: string;
  id: string;
  tenant_id: string;
  request_key: string;
  session_key: string;
  channel: string;
  text: string;
  attachments?: InboundAttachment[];
  inherit_attachments?: boolean;
  status: string;
  output: string;
  error: string | null;
  message_id: string | null;
  delivery: string;
  created_at: Date;
  completed_at: Date | null;
}
/** A template may keep its VMs awake longer than the default (V's Worker pool is costly to cold-start). */
export function templateIdleSeconds(config: Config, templateId: string): number {
  const value = config.templates?.[templateId]?.idleTimeoutSeconds;
  return Number.isInteger(value) && value! >= 15 && value! <= 1800 ? value! : config.idleTimeoutSeconds;
}

export class Store {
  readonly pool: pg.Pool;
  readonly boss: PgBoss;
  constructor(readonly config: Config) {
    this.pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: 16,
      connectionTimeoutMillis: 5000,
    });
    this.boss = new PgBoss({
      connectionString: config.databaseUrl,
      schema: "nexus_jobs",
      max: 6,
    });
    this.boss.on("error", (error) => console.error("[queue]", error.message));
  }
  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS elastic_tenants (
        id text PRIMARY KEY, name text NOT NULL, app_id text UNIQUE, secret text,
        sandbox_name text UNIQUE, state text NOT NULL DEFAULT 'sleeping',
        last_activity timestamptz NOT NULL DEFAULT now(), idle_seconds integer NOT NULL CHECK (idle_seconds BETWEEN 15 AND 1800),
        last_error text, wake_count integer NOT NULL DEFAULT 0, last_wake_ms integer,
        snapshot_id text, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS elastic_runs (
        id uuid PRIMARY KEY, tenant_id text NOT NULL REFERENCES elastic_tenants(id),
        request_key text NOT NULL, session_key text NOT NULL, channel text NOT NULL,
        text text NOT NULL, status text NOT NULL DEFAULT 'queued', output text NOT NULL DEFAULT '', error text,
        message_id text, delivery text NOT NULL DEFAULT 'none',
        created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
        UNIQUE(tenant_id, request_key)
      );
      CREATE TABLE IF NOT EXISTS elastic_streams (
        run_id uuid PRIMARY KEY REFERENCES elastic_runs(id), card_id text NOT NULL,
        message_id text, sequence integer NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS elastic_runs_pending ON elastic_runs(tenant_id, created_at) WHERE status IN ('queued','running');
      CREATE TABLE IF NOT EXISTS elastic_events (
        seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        run_id uuid REFERENCES elastic_runs(id), tenant_id text NOT NULL REFERENCES elastic_tenants(id),
        kind text NOT NULL, data jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS elastic_events_run ON elastic_events(run_id,seq);
      CREATE INDEX IF NOT EXISTS elastic_events_tenant ON elastic_events(tenant_id,seq DESC);
      -- Credentials for surfaces other than Feishu, whose app_id/secret live on
      -- the tenant row. One binding per tenant per channel; the cursor carries
      -- protocol state that must survive a manager restart (e.g. the iLink
      -- long-poll position), so a restart does not replay or skip messages.
      CREATE TABLE IF NOT EXISTS elastic_channel_bindings (
        tenant_id text NOT NULL REFERENCES elastic_tenants(id) ON DELETE CASCADE,
        channel text NOT NULL,
        external_id text,
        credentials text NOT NULL,
        cursor text,
        state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','revoked')),
        last_error text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, channel)
      );
      CREATE INDEX IF NOT EXISTS elastic_channel_bindings_active
        ON elastic_channel_bindings(channel) WHERE state = 'active';
      -- Operator-bound runtime secrets (e.g. a customer's own 星擎 account),
      -- sealed like channel credentials and injected as env at sandbox boot.
      CREATE TABLE IF NOT EXISTS elastic_tenant_secrets (
        tenant_id text NOT NULL REFERENCES elastic_tenants(id) ON DELETE CASCADE,
        name text NOT NULL,
        value text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, name)
      );
    `);
    await this.pool.query(`ALTER TABLE elastic_tenants ADD COLUMN IF NOT EXISTS runtime_provider text NOT NULL DEFAULT 'vercel' CHECK (runtime_provider IN ('vercel','alibaba'))`);
    await this.pool.query(`ALTER TABLE elastic_tenants ADD COLUMN IF NOT EXISTS template_id text NOT NULL DEFAULT 'dealclaw'`);
    await this.pool.query(`ALTER TABLE elastic_tenants ADD COLUMN IF NOT EXISTS template_version text NOT NULL DEFAULT 'dealclaw-base.v2'`);
    await this.pool.query(`ALTER TABLE elastic_tenants ADD COLUMN IF NOT EXISTS template_snapshot_id text`);
    await this.pool.query(`ALTER TABLE elastic_runs ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(attachments) = 'array')`);
    await this.pool.query(`ALTER TABLE elastic_runs ADD COLUMN IF NOT EXISTS inherit_attachments boolean NOT NULL DEFAULT true`);
    await this.boss.start();
    await this.boss.createQueue("agent-turn", {
      retryLimit: 1000,
      retryDelay: 3,
      expireInSeconds: 900,
    });
    await this.boss.updateQueue("agent-turn", {
      retryLimit: 1000,
      retryDelay: 3,
      expireInSeconds: 900,
    });
    await this.boss.createQueue("feishu-reply", {
      retryLimit: 8,
      retryDelay: 10,
      expireInSeconds: 300,
    });
    await this.boss.updateQueue("feishu-reply", {
      retryLimit: 8,
      retryDelay: 10,
      expireInSeconds: 300,
    });
  }
  /** Credentials are sealed with the same key as tenant secrets; never stored plain. */
  async bindChannel(
    tenantId: string,
    channel: string,
    credentials: Record<string, unknown>,
    externalId?: string,
  ) {
    const { rows } = await this.pool.query<ChannelBinding>(
      `INSERT INTO elastic_channel_bindings(tenant_id,channel,external_id,credentials,state,last_error,updated_at)
       VALUES($1,$2,$3,$4,'active',NULL,now())
       ON CONFLICT (tenant_id,channel) DO UPDATE
         SET external_id=EXCLUDED.external_id, credentials=EXCLUDED.credentials,
             state='active', last_error=NULL, updated_at=now()
       RETURNING *`,
      [tenantId, channel, externalId ?? null, this.seal(JSON.stringify(credentials))],
    );
    return rows[0];
  }
  async channelBindings(channel: string) {
    const { rows } = await this.pool.query<ChannelBinding>(
      "SELECT * FROM elastic_channel_bindings WHERE channel=$1 AND state='active'",
      [channel],
    );
    return rows;
  }
  async channelBinding(tenantId: string, channel: string) {
    const { rows } = await this.pool.query<ChannelBinding>(
      "SELECT * FROM elastic_channel_bindings WHERE tenant_id=$1 AND channel=$2",
      [tenantId, channel],
    );
    return rows[0];
  }
  channelCredentials<T = Record<string, unknown>>(binding: ChannelBinding): T {
    return JSON.parse(this.unseal(binding.credentials)) as T;
  }
  /** Persist protocol position. Kept separate from credentials: it changes every poll. */
  async saveChannelCursor(tenantId: string, channel: string, cursor: string) {
    await this.pool.query(
      "UPDATE elastic_channel_bindings SET cursor=$3, updated_at=now() WHERE tenant_id=$1 AND channel=$2",
      [tenantId, channel, cursor],
    );
  }
  async revokeChannel(tenantId: string, channel: string, reason?: string) {
    await this.pool.query(
      "UPDATE elastic_channel_bindings SET state='revoked', last_error=$3, updated_at=now() WHERE tenant_id=$1 AND channel=$2",
      [tenantId, channel, reason ?? null],
    );
  }
  /** Replace a tenant's whole secret set; an empty set unbinds. */
  async setTenantSecrets(tenantId: string, values: Record<string, string>) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM elastic_tenant_secrets WHERE tenant_id=$1", [tenantId]);
      for (const [name, value] of Object.entries(values))
        await client.query(
          "INSERT INTO elastic_tenant_secrets(tenant_id,name,value) VALUES($1,$2,$3)",
          [tenantId, name, this.seal(value)],
        );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async tenantSecretEnv(tenantId: string): Promise<Record<string, string>> {
    const { rows } = await this.pool.query<{ name: string; value: string }>(
      "SELECT name,value FROM elastic_tenant_secrets WHERE tenant_id=$1",
      [tenantId],
    );
    return Object.fromEntries(rows.map((row) => [row.name, this.unseal(row.value)]));
  }
  /** Names and timestamps only: secret values never leave the manager. */
  async tenantSecretStatus(tenantId: string) {
    const { rows } = await this.pool.query<{ name: string; updated_at: Date }>(
      "SELECT name,updated_at FROM elastic_tenant_secrets WHERE tenant_id=$1 ORDER BY name",
      [tenantId],
    );
    return {
      names: rows.map((row) => row.name),
      updatedAt: rows.reduce<Date | null>((latest, row) => (!latest || row.updated_at > latest ? row.updated_at : latest), null),
    };
  }
  seal(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(
      "aes-256-gcm",
      Buffer.from(this.config.encryptionKey, "hex"),
      iv,
    );
    return Buffer.concat([
      iv,
      cipher.update(value),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString("base64");
  }
  unseal(value: string): string {
    const b = Buffer.from(value, "base64");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(this.config.encryptionKey, "hex"),
      b.subarray(0, 12),
    );
    decipher.setAuthTag(b.subarray(-16));
    return Buffer.concat([
      decipher.update(b.subarray(12, -16)),
      decipher.final(),
    ]).toString();
  }
  async tenant(
    id: string,
    db: Pick<PoolClient, "query"> = this.pool,
  ): Promise<Tenant> {
    const { rows } = await db.query<Tenant>(
      "SELECT * FROM elastic_tenants WHERE id=$1",
      [id],
    );
    if (!rows[0]) throw new Error("TENANT_NOT_FOUND");
    return rows[0];
  }
  async run(id: string): Promise<Run> {
    const { rows } = await this.pool.query<Run>(
      "SELECT * FROM elastic_runs WHERE id=$1",
      [id],
    );
    if (!rows[0]) throw new Error("RUN_NOT_FOUND");
    return rows[0];
  }
  async event(
    tenantId: string,
    kind: string,
    data: object = {},
    runId: string | null = null,
  ) {
    await this.pool.query(
      "INSERT INTO elastic_events(tenant_id,run_id,kind,data) VALUES($1,$2,$3,$4)",
      [tenantId, runId, kind, data],
    );
  }
  async createTenant(
    id: string,
    name: string,
    appId?: string,
    appSecret?: string,
    runtimeProvider: "vercel" | "alibaba" = "vercel",
    template: { id: string; version: string; snapshotId: string } = {
      id: "dealclaw", version: "dealclaw-base.v2", snapshotId: this.config.snapshotId ?? "",
    },
    makaronApiKey?: string,
  ) {
    const existing = appId
      ? await this.pool.query<Tenant>(
          "SELECT * FROM elastic_tenants WHERE app_id=$1",
          [appId],
        )
      : { rows: [] };
    if (existing.rows[0]) {
      if ((existing.rows[0].runtime_provider ?? "vercel") !== runtimeProvider)
        throw Error("TENANT_PROVIDER_IMMUTABLE");
      if (existing.rows[0].template_id !== template.id || existing.rows[0].template_version !== template.version)
        throw Error("TENANT_TEMPLATE_IMMUTABLE");
      return this.provisionTemplateAccount(existing.rows[0], makaronApiKey);
    }
    await this.pool.query(
      "INSERT INTO elastic_tenants(id,name,app_id,secret,idle_seconds,runtime_provider,template_id,template_version,template_snapshot_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING",
      [
        id,
        name,
        appId || null,
        appSecret ? this.seal(appSecret) : null,
        templateIdleSeconds(this.config, template.id),
        runtimeProvider,
        template.id,
        template.version,
        template.snapshotId || null,
      ],
    );
    return this.provisionTemplateAccount(await this.tenant(id), makaronApiKey);
  }
  private async provisionTemplateAccount(tenant: Tenant, accountKey?: string): Promise<Tenant> {
    const settings = this.config.makaronProvisioning;
    if (tenant.template_id !== "makaron" || (!settings && !accountKey)) return tenant;
    if (accountKey && (typeof accountKey !== "string" || !/^mk_live_[A-Za-z0-9_-]{20,200}$/.test(accountKey))) throw Error("INVALID_MAKARON_CREDENTIAL");
    const result = await this.locked(tenant.id, async () => {
      // A validated existing account binds before boot; it must not also receive
      // an unused guest identity or overwrite another account on a retry.
      if (accountKey) {
        await this.pool.query("INSERT INTO elastic_tenant_secrets(tenant_id,name,value) VALUES($1,'MAKARON_API_KEY',$2) ON CONFLICT(tenant_id,name) DO NOTHING", [tenant.id, this.seal(accountKey)]);
        const bound = await this.tenantSecretEnv(tenant.id);
        if (bound.MAKARON_API_KEY !== accountKey) throw Error("MAKARON_BINDING_CHANGED");
        return { bound: true, reused: true };
      }
      const moduleUrl = new URL("../runtime/makaron-account-provision.mjs", import.meta.url).href;
      const { ensureMakaronAccount } = await import(moduleUrl);
      return ensureMakaronAccount({ tenant, ...settings, store: {
        tenantSecretStatus: (id: string) => this.tenantSecretStatus(id),
        bindMakaronCredential: async (id: string, key: string) => {
          const inserted = await this.pool.query(
            "INSERT INTO elastic_tenant_secrets(tenant_id,name,value) VALUES($1,$2,$3) ON CONFLICT(tenant_id,name) DO NOTHING RETURNING name",
            [id, "MAKARON_API_KEY", this.seal(key)],
          );
          if (!inserted.rowCount) throw Error("MAKARON_BINDING_CHANGED");
        },
        event: (id: string, kind: string, data: object) => this.event(id, kind, data),
      } });
    });
    if (!result) throw Error("MAKARON_BINDING_BUSY");
    return tenant;
  }
  async enqueue(
    tenantId: string,
    key: string,
    sessionKey: string,
    text: string,
    channel = "web",
    messageId?: string,
    attachments: InboundAttachment[] = [],
    options: {inheritAttachments?: boolean} = {},
  ) {
    if (options.inheritAttachments !== undefined && typeof options.inheritAttachments !== "boolean") throw Error("INVALID_ATTACHMENT_POLICY");
    const media = normalizeInboundAttachments(attachments,tenantId);
    if (typeof text !== "string" || (!text.trim() && !media.length) || text.length > 32000 || !key || key.length > 250)
      throw new Error("INVALID_MESSAGE");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<Run>(
        `INSERT INTO elastic_runs(id,tenant_id,request_key,session_key,text,channel,message_id,attachments,inherit_attachments)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) ON CONFLICT(tenant_id,request_key) DO NOTHING RETURNING *`,
        [
          randomUUID(),
          tenantId,
          key,
          sessionKey,
          text,
          channel,
          messageId || null,
          JSON.stringify(media),
          options.inheritAttachments !== false,
        ],
      );
      if (result.rows[0]) {
        await this.boss.send(
          "agent-turn",
          { runId: result.rows[0].id },
          {
            db: { executeSql: (sql, values) => client.query(sql, values) },
            singletonKey: result.rows[0].id,
            group: { id: tenantId },
          },
        );
        await client.query(
          "UPDATE elastic_tenants SET last_activity=now() WHERE id=$1",
          [tenantId],
        );
      }
      const run =
        result.rows[0] ||
        (
          await client.query<Run>(
            "SELECT * FROM elastic_runs WHERE tenant_id=$1 AND request_key=$2",
            [tenantId, key],
          )
        ).rows[0];
      await client.query("COMMIT");
      return run;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  /** Previous received image in this exact conversation; failed reception blocks inheritance. */
  async previousAttachments(run: Run): Promise<InboundAttachment[]> {
    const {rows} = await this.pool.query<{attachments: InboundAttachment[]; inherit_attachments: boolean}>(
      `SELECT attachments,inherit_attachments FROM elastic_runs WHERE tenant_id=$1 AND session_key=$2 AND channel=$3
       AND (created_at,id)<(SELECT created_at,id FROM elastic_runs WHERE id=$4 AND tenant_id=$1)
       AND status NOT IN ('queued','running')
       AND (jsonb_array_length(attachments)>0 OR inherit_attachments=false)
       ORDER BY created_at DESC,id DESC LIMIT 1`,
      [run.tenant_id,run.session_key,run.channel,run.id],
    );
    if(rows[0]?.inherit_attachments === false) return [];
    return normalizeInboundAttachments(rows[0]?.attachments ?? [],run.tenant_id);
  }
  async locked<T>(
    tenantId: string,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T | undefined> {
    const client = await this.pool.connect();
    let held = false;
    let lost = false;
    const onError = () => {
      lost = true;
    };
    client.on("error", onError);
    try {
      held = (
        await client.query(
          "SELECT pg_try_advisory_lock(82417,hashtext($1)) AS acquired",
          [tenantId],
        )
      ).rows[0].acquired;
      if (!held) return undefined;
      const result = await fn(client);
      if (lost) throw new Error("LEASE_CONNECTION_LOST");
      return result;
    } finally {
      if (held && !lost)
        await client
          .query("SELECT pg_advisory_unlock(82417,hashtext($1))", [tenantId])
          .catch(() => {
            lost = true;
          });
      client.removeListener("error", onError);
      client.release(lost);
    }
  }
  async close() {
    await this.boss.stop({ graceful: true, timeout: 650000 });
    await this.pool.end();
  }
}
