import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import pg, { type PoolClient } from "pg";
import { PgBoss } from "pg-boss";
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
}
export interface Run {
  id: string;
  tenant_id: string;
  request_key: string;
  session_key: string;
  channel: string;
  text: string;
  status: string;
  output: string;
  error: string | null;
  message_id: string | null;
  delivery: string;
  created_at: Date;
  completed_at: Date | null;
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
    `);
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
      expireInSeconds: 90,
    });
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
  ) {
    const existing = appId
      ? await this.pool.query<Tenant>(
          "SELECT * FROM elastic_tenants WHERE app_id=$1",
          [appId],
        )
      : { rows: [] };
    if (existing.rows[0]) return existing.rows[0];
    await this.pool.query(
      "INSERT INTO elastic_tenants(id,name,app_id,secret,idle_seconds) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING",
      [
        id,
        name,
        appId || null,
        appSecret ? this.seal(appSecret) : null,
        this.config.idleTimeoutSeconds,
      ],
    );
    return this.tenant(id);
  }
  async enqueue(
    tenantId: string,
    key: string,
    sessionKey: string,
    text: string,
    channel = "web",
    messageId?: string,
  ) {
    if (!text.trim() || text.length > 32000 || !key || key.length > 250)
      throw new Error("INVALID_MESSAGE");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<Run>(
        `INSERT INTO elastic_runs(id,tenant_id,request_key,session_key,text,channel,message_id)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id,request_key) DO NOTHING RETURNING *`,
        [
          randomUUID(),
          tenantId,
          key,
          sessionKey,
          text,
          channel,
          messageId || null,
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
