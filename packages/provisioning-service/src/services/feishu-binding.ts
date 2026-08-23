/**
 * Feishu app binding — let an admin attach a Feishu (Lark) bot app to a
 * tenant's agent from the admin console, so the agent becomes reachable via
 * Feishu chat.
 *
 * How it works:
 *  1. Credentials (App ID + App Secret) are validated against the Feishu
 *     open API (tenant_access_token) BEFORE anything is persisted — a typo
 *     can never break an existing binding.
 *  2. The credentials are stored on the tenants row (app_id / app_secret)
 *     and materialized as the `dealclaw-bot-<tenantId>` Secret.
 *  3. A nexus-gateway Deployment+Service is created (or restarted) with
 *     DEALCLAW_PLATFORM=feishu and DEALCLAW_AGENT_URL pointing at the
 *     tenant's agent — the per-tenant dealclaw-agent, or the external
 *     agent (agent_endpoint) for external-agent tenants. The gateway
 *     connects to Feishu via an outbound WebSocket, so NO ingress change
 *     is required.
 *
 * Unbinding DISABLES the Feishu connection without deleting the gateway —
 * the gateway is also the tenant's LLM egress proxy, so it must stay up.
 * The bot Secret is rotated to placeholder credentials and the gateway is
 * rolled: the ws-client fails to obtain a tenant_access_token with the
 * placeholder and safely skips the Feishu long connection.
 */

import type pg from 'pg';
import { v4 as uuidv4 } from 'uuid';
import type { ProvisioningConfig } from '../config.js';
import {
  createSecret,
  putSecret,
  createDeployment,
  createService,
  restartDeployment,
} from './k8s-client.js';
import { LLM_PROXY_CONFIG_SECRET } from './llm-providers.js';

const FEISHU_APP_ID_PATTERN = /^cli_[a-zA-Z0-9]{4,64}$/;
const FEISHU_TOKEN_URL = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';

export interface FeishuBindingInfo {
  tenantId: string;
  bound: boolean;
  appId: string | null;
  platform: string;
  imOpenId: string | null;
}

export interface BindResult {
  ok: true;
  tenantId: string;
  appId: string;
  /** namespace the gateway runs in (tenant ns, or central ns for external agents) */
  gatewayNamespace: string;
  gatewayDeployment: string;
  agentUrl: string;
  /** true when a pre-existing gateway was rolled instead of freshly created */
  restarted: boolean;
  verifiedApp: { tenantKey?: string };
}

export class FeishuBindingError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'FeishuBindingError';
    this.status = status;
    this.code = code;
  }
}

/** Minimal pool interface so tests can stub the DB. */
interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Verify Feishu app credentials by requesting a tenant_access_token.
 * Throws FeishuBindingError(400) when the credentials are rejected.
 * `fetchImpl` is injectable for tests.
 */
export async function verifyFeishuApp(
  appId: string,
  appSecret: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ tenantKey?: string }> {
  let res: Response;
  try {
    res = await fetchImpl(FEISHU_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err: unknown) {
    const e = err as any;
    throw new FeishuBindingError(
      502,
      'FEISHU_UNREACHABLE',
      `无法访问飞书开放平台校验凭据：${e?.message || e}（请检查集群出网）`,
    );
  }

  const body = await res.json().catch(() => ({} as any));
  if (!res.ok || (body as any)?.code !== 0) {
    throw new FeishuBindingError(
      400,
      'INVALID_CREDENTIALS',
      `飞书凭据校验失败：${(body as any)?.msg || `HTTP ${res.status}`}（请确认 App ID / App Secret 正确）`,
    );
  }
  return { tenantKey: (body as any)?.tenant_key || undefined };
}

/** Read the current binding state of a tenant. */
export async function getTenantFeishuBinding(pool: Queryable, tenantId: string): Promise<FeishuBindingInfo | null> {
  const { rows } = await pool.query(
    'SELECT tenant_id, app_id, platform, im_open_id FROM tenants WHERE tenant_id = $1',
    [tenantId],
  );
  if (!rows.length) return null;
  const t = rows[0];
  return {
    tenantId: t.tenant_id,
    bound: Boolean(t.app_id),
    appId: t.app_id ?? null,
    platform: t.platform ?? 'feishu',
    imOpenId: t.im_open_id ?? null,
  };
}

interface TenantRow {
  tenant_id: string;
  status: string;
  platform: string;
  app_id: string | null;
  k8s_namespace: string | null;
  agent_endpoint: string | null;
  plan_tier: string;
  quota_credits_monthly: string;
  credits_account_id: string | null;
}

/**
 * Bind (or re-bind) a Feishu app to a tenant's agent. Throws
 * FeishuBindingError for all user-facing failures.
 */
export async function bindTenantFeishuApp(
  pool: Queryable & pg.Pool,
  config: ProvisioningConfig,
  tenantId: string,
  input: { appId: string; appSecret: string },
  fetchImpl: FetchLike = fetch,
): Promise<BindResult> {
  const appId = (input.appId || '').trim();
  const appSecret = (input.appSecret || '').trim();

  if (!FEISHU_APP_ID_PATTERN.test(appId)) {
    throw new FeishuBindingError(400, 'BAD_APP_ID', 'App ID 格式不正确（应以 cli_ 开头，如 cli_aae4b7670ff8dbb4）');
  }
  if (!appSecret || appSecret.length < 8 || appSecret.length > 128) {
    throw new FeishuBindingError(400, 'BAD_APP_SECRET', 'App Secret 不能为空（8–128 个字符）');
  }

  const { rows } = await pool.query<TenantRow>(
    `SELECT tenant_id, status, platform, app_id, k8s_namespace, agent_endpoint,
            plan_tier, quota_credits_monthly, credits_account_id
       FROM tenants WHERE tenant_id = $1`,
    [tenantId],
  );
  if (!rows.length) {
    throw new FeishuBindingError(404, 'NOT_FOUND', '租户不存在');
  }
  const tenant = rows[0];
  if (tenant.status === 'destroyed') {
    throw new FeishuBindingError(400, 'TENANT_DESTROYED', '租户已销毁，无法绑定');
  }

  // One Feishu app must only be bound to one tenant — two gateways holding
  // the same app credentials would fight over the WS long connection.
  const { rows: conflicts } = await pool.query(
    `SELECT tenant_id, company_name FROM tenants
      WHERE app_id = $1 AND tenant_id <> $2 AND status <> 'destroyed'`,
    [appId, tenantId],
  );
  if (conflicts.length) {
    throw new FeishuBindingError(
      409,
      'APP_ALREADY_BOUND',
      `该飞书应用已绑定到租户「${conflicts[0].company_name || conflicts[0].tenant_id}」，请先解绑`,
    );
  }

  // 1. Verify against the Feishu open API before touching anything.
  const verified = await verifyFeishuApp(appId, appSecret, fetchImpl);

  // 2. Persist on the tenants row.
  await pool.query(
    `UPDATE tenants SET app_id = $1, app_secret = $2, platform = 'feishu', updated_at = NOW()
      WHERE tenant_id = $3`,
    [appId, appSecret, tenantId],
  );

  const centralNs = config.runtimeNamespace;
  // External-agent tenants have no namespace of their own — their gateway
  // runs in the control-plane namespace.
  const gatewayNs = tenant.k8s_namespace || centralNs;
  const agentUrl = tenant.agent_endpoint
    ? String(tenant.agent_endpoint).replace(/\/$/, '')
    : `http://dealclaw-agent-${tenantId}.${tenant.k8s_namespace}:18789`;

  if (config.k8sDryRun) {
    await pool.query(
      `INSERT INTO tenant_status_log (tenant_id, from_status, to_status, reason)
       VALUES ($1, $2, $2, $3)`,
      [tenantId, tenant.status, `DRY_RUN: Feishu app bound (${appId}); gateway would run in ${gatewayNs} → ${agentUrl}`],
    );
    return {
      ok: true,
      tenantId,
      appId,
      gatewayNamespace: gatewayNs,
      gatewayDeployment: `nexus-gateway-${tenantId}`,
      agentUrl,
      restarted: false,
      verifiedApp: verified,
    };
  }

  // 3. Secrets. The bot secret is UPSERTED (re-binding rotates credentials);
  // the agent-config / credits secrets only need to exist for the gateway's
  // envFrom — createSecret tolerates 409.
  const botSecretName = `dealclaw-bot-${tenantId}`;
  await putSecret(gatewayNs, botSecretName, {
    DEALCLAW_APP_ID: appId,
    DEALCLAW_APP_SECRET: appSecret,
  });

  const agentConfigName = `dealclaw-agent-config-${tenantId}`;
  await createSecret(gatewayNs, agentConfigName, {
    DEALCLAW_TENANT_ID: tenantId,
    DEALCLAW_PLAN_TIER: tenant.plan_tier,
    DEALCLAW_INITIAL_CREDITS: String(tenant.quota_credits_monthly ?? 0),
  });

  const creditsConfigName = `dealclaw-credits-${tenantId}`;
  await createSecret(gatewayNs, creditsConfigName, {
    DEALCLAW_CREDITS_ACCOUNT_ID: tenant.credits_account_id || `acct_${tenantId}`,
    DEALCLAW_CREDITS_LEDGER_URL: `http://credits-ledger.${centralNs}:8081`,
    // Shared token for the gateway's ledger calls (usage reports / balance)
    CREDITS_LEDGER_TOKEN: config.creditsLedgerToken,
    DEALCLAW_CUSTOMER_KEY_REF: `tenant-keys/${tenantId}`,
    DEALCLAW_BOT_CREDENTIAL_REF: `bot/${tenantId}`,
  });

  // LLM upstream map for the gateway's egress proxy. createSecret
  // tolerates 409 and KEEPS the existing content — pushLlmProviders is the
  // authoritative writer; this just guarantees the Secret exists so the
  // gateway's envFrom reference resolves.
  await createSecret(gatewayNs, LLM_PROXY_CONFIG_SECRET, { LLM_UPSTREAMS: '{}' });

  // 4. Gateway Deployment + Service. Prefer the promoted rollout target so a
  // freshly created gateway picks up the same version the fleet runs.
  let gwTag = config.nexusGatewayImageTag;
  try {
    const { rows: targets } = await pool.query(
      `SELECT tag FROM rollout_targets WHERE service = 'nexus-gateway' LIMIT 1`,
    );
    if (targets.length) gwTag = targets[0].tag;
  } catch { /* fall back to env tag */ }

  const gatewayName = `nexus-gateway-${tenantId}`;
  const gwLabels = {
    'app.kubernetes.io/part-of': 'dealclaw',
    'dealclaw.io/tenant-id': tenantId,
    'dealclaw.io/plan-tier': tenant.plan_tier,
    app: 'nexus-gateway',
  };

  await createDeployment({
    name: gatewayName,
    namespace: gatewayNs,
    image: `${config.imageRegistry}/nexus-gateway:${gwTag}`,
    port: 8080,
    labels: gwLabels,
    envFrom: [
      { secretRef: { name: botSecretName } },
      { secretRef: { name: agentConfigName } },
      { secretRef: { name: creditsConfigName } },
      { secretRef: { name: LLM_PROXY_CONFIG_SECRET } },
    ],
    env: [
      { name: 'DEALCLAW_PLATFORM', value: 'feishu' },
      { name: 'DEALCLAW_AGENT_URL', value: agentUrl },
      { name: 'NODE_ENV', value: 'production' },
      { name: 'PROVISIONING_SERVICE_URL', value: process.env.PROVISIONING_SERVICE_URL || `http://provisioning-service.${centralNs}:8082` },
      { name: 'PROVISIONING_API_TOKEN', value: process.env.PROVISIONING_API_TOKEN || '' },
    ],
    requests: { cpu: '200m', memory: '256Mi' },
    limits: { cpu: '1000m', memory: '512Mi' },
    imagePullSecrets: [{ name: 'registry-secret-vpc' }],
    livenessPath: '/healthz',
    readinessPath: '/healthz',
  });
  await createService(gatewayNs, gatewayName, 8080, gwLabels);

  // 5. Roll the Pod so a pre-existing gateway re-reads the rotated secret.
  const restarted = await restartDeployment(gatewayNs, gatewayName);

  await pool.query(
    `INSERT INTO tenant_status_log (tenant_id, from_status, to_status, reason)
     VALUES ($1, $2, $2, $3)`,
    [tenantId, tenant.status, `Feishu app bound: ${appId} — gateway ${gatewayName} in ${gatewayNs} → agent ${agentUrl}`],
  );

  return {
    ok: true,
    tenantId,
    appId,
    gatewayNamespace: gatewayNs,
    gatewayDeployment: gatewayName,
    agentUrl,
    restarted,
    verifiedApp: verified,
  };
}

export interface UnbindResult {
  ok: true;
  tenantId: string;
  /** the gateway Deployment is KEPT (it is the tenant's LLM egress proxy) */
  gatewayKept: string;
  gatewayNamespace: string | null;
  /** true when the gateway Pod was rolled to pick up the placeholder creds */
  restarted: boolean;
}

/**
 * Remove a tenant's Feishu binding. The gateway Deployment/Service is NOT
 * deleted — the gateway doubles as the tenant's LLM egress proxy (token
 * billing + balance interception), which must keep running. Instead the bot
 * Secret is rotated to placeholder credentials and the gateway is rolled:
 * the ws-client fails to obtain a tenant_access_token with placeholders and
 * safely skips the Feishu long connection. The agent itself is untouched.
 */
export async function unbindTenantFeishuApp(
  pool: Queryable & pg.Pool,
  config: ProvisioningConfig,
  tenantId: string,
): Promise<UnbindResult> {
  const { rows } = await pool.query<TenantRow>(
    `SELECT tenant_id, status, platform, app_id, k8s_namespace, agent_endpoint,
            plan_tier, quota_credits_monthly, credits_account_id
       FROM tenants WHERE tenant_id = $1`,
    [tenantId],
  );
  if (!rows.length) {
    throw new FeishuBindingError(404, 'NOT_FOUND', '租户不存在');
  }
  const tenant = rows[0];
  if (tenant.status === 'destroyed') {
    throw new FeishuBindingError(400, 'TENANT_DESTROYED', '租户已销毁');
  }
  if (!tenant.app_id) {
    throw new FeishuBindingError(404, 'NOT_BOUND', '该租户当前未绑定飞书应用');
  }

  const gatewayNs = tenant.k8s_namespace || config.runtimeNamespace;
  const gatewayName = `nexus-gateway-${tenantId}`;
  const botSecretName = `dealclaw-bot-${tenantId}`;

  let restarted = false;
  if (!config.k8sDryRun) {
    // Rotate the bot Secret to placeholders instead of deleting the
    // gateway — the LLM egress proxy must survive the unbind.
    await putSecret(gatewayNs, botSecretName, {
      DEALCLAW_APP_ID: `placeholder-${tenantId}`,
      DEALCLAW_APP_SECRET: uuidv4(),
    });
    restarted = await restartDeployment(gatewayNs, gatewayName);
  }

  await pool.query(
    `UPDATE tenants SET app_id = NULL, app_secret = NULL, platform = 'web', updated_at = NOW()
      WHERE tenant_id = $1`,
    [tenantId],
  );
  await pool.query(
    `INSERT INTO tenant_status_log (tenant_id, from_status, to_status, reason)
     VALUES ($1, $2, $2, $3)`,
    [tenantId, tenant.status, `Feishu app unbound: ${tenant.app_id} — gateway ${gatewayName} kept as LLM egress proxy, bot credentials rotated to placeholder`],
  );

  return {
    ok: true,
    tenantId,
    gatewayKept: gatewayName,
    gatewayNamespace: config.k8sDryRun ? null : gatewayNs,
    restarted,
  };
}
