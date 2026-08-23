import { v4 as uuidv4 } from 'uuid';
import type pg from 'pg';
import {
  createNamespace,
  deleteNamespace,
  createSecret as k8sCreateSecret,
  getSecret,
  copySecretToNamespace,
  createDeployment,
  createService,
  createPersistentVolumeClaim,
  createJob,
  deleteSecret,
  deleteDeployment,
  deleteService,
  deletePersistentVolumeClaim,
  getDeployment,
  patchDeployment,
  patchDeploymentEnvFromSecret,
  patchDeploymentEnvVar,
} from './k8s-client.js';
import { DEFAULT_RUNTIME_NAMESPACE, type ProvisioningConfig } from '../config.js';
import {
  buildEnvFileContent,
  ENV_FROM_ONLY_KEYS,
  SKILL_ENV_DEFAULT_MODE,
  SKILL_ENV_MOUNT_PATH,
  SKILL_ENV_SECRET_NAME,
} from './skill-env.js';
import { getPromotedTag } from './rollout-targets.js';

/** Per-tenant namespace name — each tenant is fully isolated in its own namespace. */
export function tenantNamespace(tenantId: string): string {
  return `dealclaw-${tenantId}`;
}

export interface TenantProvision {
  tenantId: string;
  companyName: string;
  contactEmail: string;
  planTier: 'starter' | 'pro' | 'enterprise';
  quotaAgents: number;
  quotaCreditsMonthly: number;
  appId?: string;
  appSecret?: string;
  /**
   * Optional per-tenant Mio CDP supplier identifier. Injected into the
   * agent-config Secret as MIO_CDP_SUPPLIER_ID so tenant skills calling
   * the Mio CDP API pick it up from the environment.
   */
  mioCdpSupplierId?: string;
  /** IM platform the tenant's gateway binds to. Defaults to 'feishu';
   *  tenants served only via web chat use 'web'. */
  platform?: string;
  /**
   * Message plane (P2): 'gateway' = nexus-gateway WS bridge (default);
   * 'openclaw' = in-agent @openclaw/feishu plugin owns the Feishu WS
   * connection and the gateway serves purely as the LLM egress proxy.
   */
  messagePlane?: 'gateway' | 'openclaw';
}

export interface ProvisionOptions {
  dryRun?: boolean;
  runtimeNamespace?: string;
  imageRegistry?: string;
  nexusGatewayImageTag?: string;
  dealclawAgentImageTag?: string;
  agentPvcSize?: string;
  agentPvcStorageClass?: string;
  agentPvcAccessMode?: 'ReadWriteOnce' | 'ReadWriteMany';
  /**
   * Merged runtime config (global defaults + tenant overrides, decrypted).
   * Split at provisioning time: envFrom-only keys (DEEPSEEK_API_KEY…) are
   * materialized as the `tenant-config` Secret (envFrom of dealclaw-agent),
   * the rest as the `skill-env` Secret's single `.env` key (mounted file,
   * hot-rotatable without restarts).
   */
  runtimeSecretData?: Record<string, string>;
  /**
   * DB pool used to resolve the promoted rollout target tags
   * (rollout_targets table — written by the image-release promote flow).
   * When provided AND a tag is promoted, the promoted tag overrides both
   * the explicit option tags and env vars, so a freshly provisioned
   * gateway/agent runs the same version the fleet was rolled to. Failures
   * fall back silently to the env-configured tags.
   */
  dbPool?: Pick<pg.Pool, 'query'>;
}

export interface ProvisionResult {
  namespace: string;
  secrets: string[];
  pods: string[];
  warnings: string[];
}

/**
 * Provision K8s resources for a new tenant.
 *
 * Production: creates tenant-scoped secrets plus dedicated nexus-gateway and
 * dealclaw-agent Deployment+Service resources in a shared runtime namespace.
 * Dev/test (K8S_DRY_RUN=true): returns planned resources without creating them.
 */
export async function provisionTenant(
  tenant: TenantProvision,
  options: ProvisionOptions = {},
): Promise<ProvisionResult> {
  const dryRun = options.dryRun ?? (process.env.K8S_DRY_RUN === 'true' || process.env.NODE_ENV !== 'production');
  const registry = options.imageRegistry || process.env.IMAGE_REGISTRY || 'ultronx-acr-registry-vpc.cn-shanghai.cr.aliyuncs.com/dealclaw';
  let gwTag = options.nexusGatewayImageTag || process.env.NEXUS_GATEWAY_IMAGE_TAG || 'latest';
  let agentTag = options.dealclawAgentImageTag || process.env.DEALCLAW_AGENT_IMAGE_TAG || 'latest';
  const pvcSize = options.agentPvcSize || process.env.AGENT_PVC_SIZE || '10Gi';
  const pvcStorageClass = options.agentPvcStorageClass || process.env.AGENT_PVC_STORAGE_CLASS || 'alibabacloud-cnfs-nas';
  const pvcAccessMode = options.agentPvcAccessMode || (process.env.AGENT_PVC_ACCESS_MODE as 'ReadWriteOnce' | 'ReadWriteMany') || 'ReadWriteOnce';

  const nsName = tenantNamespace(tenant.tenantId); // per-tenant namespace
  // Central control-plane namespace where provisioning-service / credits-ledger / ops-agent run
  const centralNs = options.runtimeNamespace || process.env.RUNTIME_NAMESPACE || DEFAULT_RUNTIME_NAMESPACE;
  const tenantLabel = tenant.tenantId;
  const messagePlane = tenant.messagePlane === 'openclaw' ? 'openclaw' : 'gateway';

  const result: ProvisionResult = {
    namespace: nsName,
    secrets: [],
    pods: [],
    warnings: [],
  };

  const labels = {
    'app.kubernetes.io/part-of': 'dealclaw',
    'dealclaw.io/tenant-id': tenantLabel,
    'dealclaw.io/plan-tier': tenant.planTier,
  };

  const botSecretName = `dealclaw-bot-${tenantLabel}`;
  const agentConfigName = `dealclaw-agent-config-${tenantLabel}`;
  const creditsConfigName = `dealclaw-credits-${tenantLabel}`;
  const gatewayName = `nexus-gateway-${tenantLabel}`;
  const agentName = `dealclaw-agent-${tenantLabel}`;
  const agentPvcName = `dealclaw-runtime-${tenantLabel}`;

  if (dryRun) {
    result.warnings.push(`DRY_RUN: would provision in namespace ${nsName}`);
    result.secrets.push(botSecretName, agentConfigName, creditsConfigName, 'tenant-config', 'llm-proxy-config', SKILL_ENV_SECRET_NAME);
    result.pods.push(gatewayName, agentName, agentPvcName);
    return result;
  }

  // === Production path: real K8s API calls ===
  try {
    // 0a. Prefer the promoted rollout targets so a freshly provisioned
    // gateway and agent pick up the same version the fleet runs (the
    // image-release promote flow updates rollout_targets; ops-agent rolls
    // existing tenants, this covers NEW tenants). No promoted tag yet →
    // keep the env-configured tags above.
    const promotedGwTag = await getPromotedTag(options.dbPool, 'nexus-gateway');
    if (promotedGwTag) gwTag = promotedGwTag;
    const promotedAgentTag = await getPromotedTag(options.dbPool, 'dealclaw-agent');
    if (promotedAgentTag) agentTag = promotedAgentTag;

    // 0. Create per-tenant namespace first
    await createNamespace(nsName);

    // 0b. Copy the image pull secret into the tenant namespace. The
    // Deployments created below reference `registry-secret-vpc`, but that
    // dockerconfig secret only exists in the control-plane namespace —
    // without copying it, tenant pods fail with ErrImagePull.
    const pullSecretName = 'registry-secret-vpc';
    const pullSecret = await getSecret(centralNs, pullSecretName);
    if (pullSecret && Object.keys(pullSecret.data).length > 0) {
      await copySecretToNamespace(nsName, pullSecretName, pullSecret.type, pullSecret.data);
      result.secrets.push(pullSecretName);
    } else {
      result.warnings.push(
        `Image pull secret ${pullSecretName} not found in ${centralNs} — tenant pods may fail to pull images`,
      );
    }

    // 1. Secrets
    await k8sCreateSecret(nsName, botSecretName, {
      DEALCLAW_APP_ID: tenant.appId || `placeholder-${tenantLabel}`,
      DEALCLAW_APP_SECRET: tenant.appSecret || uuidv4(),
    });
    result.secrets.push(botSecretName);

    await k8sCreateSecret(nsName, agentConfigName, {
      DEALCLAW_TENANT_ID: tenantLabel,
      DEALCLAW_PLAN_TIER: tenant.planTier,
      DEALCLAW_INITIAL_CREDITS: String(tenant.quotaCreditsMonthly),
      ...(tenant.mioCdpSupplierId ? { MIO_CDP_SUPPLIER_ID: tenant.mioCdpSupplierId } : {}),
    });
    result.secrets.push(agentConfigName);

    await k8sCreateSecret(nsName, creditsConfigName, {
      DEALCLAW_CREDITS_ACCOUNT_ID: `acct_${tenantLabel}`,
      // Cross-namespace: credits-ledger runs in the central namespace
      DEALCLAW_CREDITS_LEDGER_URL: `http://credits-ledger.${centralNs}:8081`,
      // Shared service token so the gateway's LLM usage reports and balance
      // lookups pass credits-ledger's requireServiceOrAdmin.
      CREDITS_LEDGER_TOKEN: process.env.BILLING_SERVICE_TOKEN || process.env.PAYMENT_SERVICE_TOKEN || '',
      DEALCLAW_CUSTOMER_KEY_REF: `tenant-keys/${tenantLabel}`,
      DEALCLAW_BOT_CREDENTIAL_REF: `bot/${tenantLabel}`,
    });
    result.secrets.push(creditsConfigName);

    // 1b. tenant-config Secret — runtime provider credentials for
    // dealclaw-agent (envFrom). Built from the runtime_configs table
    // (global defaults + per-tenant overrides), managed via admin-web.
    // Fail closed: without it the agent Pod cannot start.
    // Only envFrom-only keys (model provider keys like DEEPSEEK_API_KEY,
    // consumed at container boot) belong here — skill/tool keys live in the
    // skill-env Secret (step 1c) so they can be rotated without a restart
    // and cannot shadow the hot .env file via envFrom.
    const runtimeSecretName = 'tenant-config';
    if (!options.runtimeSecretData || Object.keys(options.runtimeSecretData).length === 0) {
      throw new Error(
        'Runtime config is empty — configure global defaults (e.g. DEEPSEEK_API_KEY) via the admin console before provisioning',
      );
    }
    const envFromData: Record<string, string> = {};
    for (const [k, v] of Object.entries(options.runtimeSecretData)) {
      if (ENV_FROM_ONLY_KEYS.has(k)) envFromData[k] = v;
    }
    if (Object.keys(envFromData).length === 0) {
      result.warnings.push(
        'Runtime config has no envFrom-only key (大模型供应商页的提供商库) — the agent will boot without any model configured',
      );
    }
    await k8sCreateSecret(nsName, runtimeSecretName, envFromData);
    result.secrets.push(runtimeSecretName);

    // 1c. skill-env Secret — the single `.env` file mounted at
    // /run/secrets/skill-env and symlinked into the agent workspace as
    // work/mio-api/.env by entrypoint.sh. Skill scripts read it at
    // invocation time, so key rotation = Secret update, no restart.
    const skillEnv = buildEnvFileContent(options.runtimeSecretData, tenant.mioCdpSupplierId);
    await k8sCreateSecret(nsName, SKILL_ENV_SECRET_NAME, { '.env': skillEnv.content });
    result.secrets.push(SKILL_ENV_SECRET_NAME);

    // 1d. llm-proxy-config Secret — the LLM upstream map consumed by the
    // tenant's nexus-gateway (envFrom, LLM_UPSTREAMS JSON: providerName →
    // real baseUrl). Created empty here; pushLlmProviders keeps it in sync
    // with the global provider library. The agent's LLM_PROVIDERS blob
    // points at the gateway's /v1/llm/<provider> route, so this mapping is
    // what lets the gateway forward to the real upstream.
    const llmProxyConfigName = 'llm-proxy-config';
    await k8sCreateSecret(nsName, llmProxyConfigName, { LLM_UPSTREAMS: '{}' });
    result.secrets.push(llmProxyConfigName);

    // 2. nexus-gateway Deployment + Service — created for EVERY tenant
    // (always-create). The gateway is the tenant's LLM egress proxy
    // (billing + balance interception) regardless of IM platform; for
    // web-platform tenants DEALCLAW_PLATFORM=web and the ws-client safely
    // skips the Feishu long connection (bot Secret holds placeholder
    // credentials).
    {
      const gwLabels = { ...labels, app: 'nexus-gateway' };
      await createDeployment({
        name: gatewayName,
        namespace: nsName,
        image: `${registry}/nexus-gateway:${gwTag}`,
        port: 8080,
        labels: gwLabels,
        envFrom: [
          { secretRef: { name: botSecretName } },
          { secretRef: { name: agentConfigName } },
          { secretRef: { name: creditsConfigName } },
          { secretRef: { name: llmProxyConfigName } },
        ],
        env: [
          { name: 'DEALCLAW_PLATFORM', value: tenant.platform || 'feishu' },
          // P2: 'openclaw' → the in-agent feishu plugin owns the message
          // plane; the gateway must not hold a competing WS client.
          { name: 'DEALCLAW_MESSAGE_PLANE', value: messagePlane },
          { name: 'DEALCLAW_AGENT_URL', value: `http://dealclaw-agent-${tenantLabel}:18789` },
          { name: 'NODE_ENV', value: 'production' },
          // Contact writeback — lets nexus-gateway report the sender's im_open_id
          // so lifecycle notifications can be delivered via the notify relay.
          // Cross-namespace: provisioning-service runs in the central namespace.
          { name: 'PROVISIONING_SERVICE_URL', value: process.env.PROVISIONING_SERVICE_URL || `http://provisioning-service.${centralNs}:8082` },
          { name: 'PROVISIONING_API_TOKEN', value: process.env.PROVISIONING_API_TOKEN || '' },
        ],
        // SSE stream-through headroom for the LLM proxy path
        requests: { cpu: '200m', memory: '256Mi' },
        limits: { cpu: '1000m', memory: '512Mi' },
        imagePullSecrets: [{ name: 'registry-secret-vpc' }],
        livenessPath: '/healthz',
        readinessPath: '/healthz',
      });
      await createService(nsName, gatewayName, 8080, gwLabels);
      result.pods.push(gatewayName);
    }

    // 3. dealclaw-agent Deployment + Service + per-tenant PVC
    const agentLabels = { ...labels, app: 'dealclaw-agent' };

    // Per-tenant PVC for runtime data persistence (/data)
    await createPersistentVolumeClaim({
      namespace: nsName,
      name: agentPvcName,
      size: pvcSize,
      storageClassName: pvcStorageClass,
      accessMode: pvcAccessMode,
      labels: agentLabels,
    });

    await createDeployment({
      name: agentName,
      namespace: nsName,
      image: `${registry}/dealclaw-agent:${agentTag}`,
      port: 18789,
      labels: agentLabels,
      envFrom: [
        { secretRef: { name: agentConfigName } },
        // Runtime provider/tool credentials — the tenant-config Secret is
        // created in this tenant's namespace by provisionTenant (step 1b).
        { secretRef: { name: 'tenant-config' } },
        // P2 openclaw plane: the agent's feishu channel needs the bot
        // credentials (write-config reads DEALCLAW_APP_ID/SECRET via envFrom).
        ...(messagePlane === 'openclaw' ? [{ secretRef: { name: botSecretName } }] : []),
      ],
      env: [
        { name: 'NODE_ENV', value: 'production' },
        { name: 'DEALCLAW_MODEL', value: 'deepseek/deepseek-chat' },
        // P2 message plane switch for write-config.mjs (channels.feishu).
        { name: 'DEALCLAW_MESSAGE_PLANE', value: messagePlane },
        // Contact writeback — the dealclaw-contact plugin reports the
        // sender's im_open_id so lifecycle notifications can be delivered.
        { name: 'PROVISIONING_SERVICE_URL', value: process.env.PROVISIONING_SERVICE_URL || `http://provisioning-service.${centralNs}:8082` },
        { name: 'PROVISIONING_API_TOKEN', value: process.env.PROVISIONING_API_TOKEN || '' },
        // credits-ledger 地址 + 服务令牌（确定性计费 plugin 依赖）
        // Cross-namespace: credits-ledger runs in the central namespace.
        { name: 'DC_BILLING_URL', value: process.env.CREDITS_LEDGER_URL || `http://credits-ledger.${centralNs}:8081` },
        { name: 'DC_BILLING_TOKEN', value: process.env.BILLING_SERVICE_TOKEN || process.env.PAYMENT_SERVICE_TOKEN || '' },
      ],
      requests: { cpu: '500m', memory: '1Gi' },
      limits: { cpu: '2000m', memory: '2Gi' },
      imagePullSecrets: [{ name: 'registry-secret-vpc' }],
      runAsUser: 1000,
      livenessPath: '/healthz',
      readinessPath: '/healthz',
      volumes: [
        { name: 'runtime-data', persistentVolumeClaim: { claimName: agentPvcName } },
        // Per-tenant skill-env (.env) — hot-rotatable credentials for skill
        // scripts; kubelet refreshes the mounted file automatically.
        {
          name: 'skill-env',
          secret: { secretName: SKILL_ENV_SECRET_NAME, defaultMode: SKILL_ENV_DEFAULT_MODE },
        },
      ],
      volumeMounts: [
        { name: 'runtime-data', mountPath: '/data' },
        { name: 'skill-env', mountPath: SKILL_ENV_MOUNT_PATH, readOnly: true },
      ],
    });
    await createService(nsName, agentName, 18789, agentLabels);
    result.pods.push(agentName);

    result.warnings.push(`Provisioned in namespace ${nsName}`);
  } catch (err) {
    throw new Error(`K8s provisioning failed for tenant ${tenantLabel}: ${err instanceof Error ? err.message : String(err)}`);
  }

  return result;
}

/**
 * Destroy tenant resources.
 */
export async function deprovisionTenant(
  tenantId: string,
  options: { dryRun?: boolean; runtimeNamespace?: string } = {},
): Promise<{ deleted: boolean; warnings: string[] }> {
  const dryRun = options.dryRun ?? (process.env.K8S_DRY_RUN === 'true' || process.env.NODE_ENV !== 'production');
  const namespace = tenantNamespace(tenantId);

  const gatewayName = `nexus-gateway-${tenantId}`;
  const agentName = `dealclaw-agent-${tenantId}`;
  const agentPvcName = `dealclaw-runtime-${tenantId}`;
  const secretNames = [
    `dealclaw-bot-${tenantId}`,
    `dealclaw-agent-config-${tenantId}`,
    `dealclaw-credits-${tenantId}`,
    'tenant-config',
    'llm-proxy-config',
    SKILL_ENV_SECRET_NAME,
  ];

  if (dryRun) {
    return {
      deleted: true,
      warnings: [`DRY_RUN: would delete tenant ${tenantId} resources from namespace ${namespace}`],
    };
  }

  try {
    // Delete controllers first so their Pods terminate and release the volume.
    await Promise.all([
      deleteDeployment(namespace, gatewayName),
      deleteDeployment(namespace, agentName),
    ]);
    await Promise.all([
      deleteService(namespace, gatewayName),
      deleteService(namespace, agentName),
      ...secretNames.map(name => deleteSecret(namespace, name)),
    ]);
    // Delete the per-tenant PVC after the Pod has released it.
    await deletePersistentVolumeClaim(namespace, agentPvcName);
    // Delete the tenant's namespace (removes any remaining resources).
    await deleteNamespace(namespace);
    return { deleted: true, warnings: [`Deleted tenant ${tenantId} resources from namespace ${namespace}`] };
  } catch (err) {
    return {
      deleted: false,
      warnings: [`Failed to delete tenant ${tenantId} resources: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
}

// ── P2: message-plane switch ──────────────────────────────────────────────

export type MessagePlane = 'gateway' | 'openclaw';

export interface SwitchPlaneResult {
  ok: boolean;
  plane: MessagePlane;
  steps: string[];
  warnings: string[];
}

/**
 * Switch a tenant's Feishu message plane between the nexus-gateway WS bridge
 * ('gateway') and the in-agent @openclaw/feishu plugin ('openclaw').
 *
 * Ordering matters: Feishu load-balances WS events across connections, so
 * exactly one client may hold the long connection at a time.
 *   gateway → openclaw: stop the gateway WS FIRST (roll gateway), then
 *                        enable channels on the agent (roll agent).
 *   openclaw → gateway: disable agent channels FIRST (roll agent), then
 *                        restore the gateway WS (roll gateway).
 *
 * Each patch changes the pod template → K8s rolls the deployment; env-var
 * patches are no-ops when the value is already set (idempotent re-runs).
 */
export async function switchTenantMessagePlane(
  tenantId: string,
  plane: MessagePlane,
): Promise<SwitchPlaneResult> {
  const ns = tenantNamespace(tenantId);
  const gatewayName = `nexus-gateway-${tenantId}`;
  const agentName = `dealclaw-agent-${tenantId}`;
  const botSecretName = `dealclaw-bot-${tenantId}`;
  const steps: string[] = [];
  const warnings: string[] = [];

  if (plane === 'openclaw') {
    // 1. Gateway stops holding the Feishu WS (rolls the deployment).
    const gwStopped = await patchDeploymentEnvVar(ns, gatewayName, 'DEALCLAW_MESSAGE_PLANE', 'openclaw');
    steps.push(gwStopped ? 'gateway: DEALCLAW_MESSAGE_PLANE=openclaw (rolling, WS stops)' : 'gateway: already on openclaw plane');
    if (!gwStopped) {
      // Distinguish "already set" from "deployment missing".
      const deploy = await getDeployment(ns, gatewayName);
      if (!deploy) warnings.push(`gateway deployment not found in ${ns}`);
    }

    // 2. Agent gets bot credentials + plane flag (write-config generates
    //    channels.feishu on next boot). envFrom patch is idempotent.
    const envFromOk = await patchDeploymentEnvFromSecret(ns, agentName, botSecretName);
    if (!envFromOk) {
      const deploy = await getDeployment(ns, agentName);
      if (!deploy) warnings.push(`agent deployment not found in ${ns}`);
      // else: secret already referenced — fine.
    }
    const agentRolled = await patchDeploymentEnvVar(ns, agentName, 'DEALCLAW_MESSAGE_PLANE', 'openclaw');
    steps.push(agentRolled ? 'agent: DEALCLAW_MESSAGE_PLANE=openclaw (rolling, feishu channel enabled)' : 'agent: already on openclaw plane');
  } else {
    // 1. Agent drops channels.feishu first (write-config no longer emits it).
    const agentRolled = await patchDeploymentEnvVar(ns, agentName, 'DEALCLAW_MESSAGE_PLANE', 'gateway');
    steps.push(agentRolled ? 'agent: DEALCLAW_MESSAGE_PLANE=gateway (rolling, feishu channel disabled)' : 'agent: already on gateway plane');

    // 2. Gateway restores the Feishu WS long connection.
    const gwStarted = await patchDeploymentEnvVar(ns, gatewayName, 'DEALCLAW_MESSAGE_PLANE', 'gateway');
    steps.push(gwStarted ? 'gateway: DEALCLAW_MESSAGE_PLANE=gateway (rolling, WS starts)' : 'gateway: already on gateway plane');
    if (!gwStarted) {
      const deploy = await getDeployment(ns, gatewayName);
      if (!deploy) warnings.push(`gateway deployment not found in ${ns}`);
    }
    // NB: the bot Secret stays in the agent's envFrom — harmless (the agent
    // ignores the credentials unless plane=openclaw) and keeps re-switching
    // to a single-patch operation.
    warnings.push('agent keeps bot-secret envFrom attached (ignored on gateway plane)');
  }

  return { ok: warnings.filter(w => w.includes('not found')).length === 0, plane, steps, warnings };
}

/**
 * Back up (or archive) a tenant's runtime data by creating a one-shot K8s Job
 * that mounts the tenant PVC and uploads /data to OSS via ossutil.
 *
 * mode 'backup'  → OSS Standard tier (fast recovery)
 * mode 'archive' → OSS Archive tier (cheap long-term retention before destroy)
 */
export async function backupTenantData(
  tenantId: string,
  config: ProvisioningConfig,
  options: { mode?: 'backup' | 'archive'; runtimeNamespace?: string } = {},
): Promise<{ ok: boolean; jobName: string; warnings: string[] }> {
  const mode = options.mode ?? 'backup';
  const namespace = tenantNamespace(tenantId);
  const pvcName = `dealclaw-runtime-${tenantId}`;
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '').replace(/T/, '-');
  const jobName = `dealclaw-${mode}-${tenantId}-${timestamp}`;
  const prefix = `${tenantId}/${mode}/${timestamp}`;

  const labels = {
    'app.kubernetes.io/part-of': 'dealclaw',
    'dealclaw.io/tenant-id': tenantId,
    'dealclaw.io/job-type': `${mode}-data`,
  };

  // Storage class header for archive tier
  const storageClassFlag = mode === 'archive'
    ? ' --meta X-Oss-Storage-Class:Archive'
    : '';

  const command = [
    '/bin/sh',
    '-c',
    [
      'ossutil config -i "$OSS_ACCESS_KEY_ID" -k "$OSS_ACCESS_KEY_SECRET" -e "$OSS_ENDPOINT" >/dev/null 2>&1',
      `ossutil cp -r /data "oss://$OSS_BUCKET/${prefix}/" --update${storageClassFlag}`,
    ].join(' && '),
  ];

  const env = [
    { name: 'OSS_ENDPOINT', value: config.ossEndpoint },
    { name: 'OSS_BUCKET', value: config.ossBucket },
    { name: 'OSS_ACCESS_KEY_ID', valueFrom: { secretKeyRef: { name: config.ossSecretName, key: 'accessKeyId' } } },
    { name: 'OSS_ACCESS_KEY_SECRET', valueFrom: { secretKeyRef: { name: config.ossSecretName, key: 'accessKeySecret' } } },
  ];

  try {
    await createJob({
      namespace,
      name: jobName,
      labels,
      image: config.backupImage,
      command,
      env,
      volumeName: 'runtime-data',
      pvcClaimName: pvcName,
      mountPath: '/data',
      ttlSecondsAfterFinished: mode === 'backup' ? 86_400 : 604_800,
      backoffLimit: 1,
      imagePullSecrets: [{ name: 'registry-secret-vpc' }],
    });

    return {
      ok: true,
      jobName,
      warnings: [`${mode} Job ${jobName} created for tenant ${tenantId}`],
    };
  } catch (err) {
    return {
      ok: false,
      jobName,
      warnings: [`Failed to create ${mode} Job: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
}

/**
 * Restore a tenant's runtime data from OSS back to its PVC.
 *
 * Creates the per-tenant PVC if it doesn't exist (e.g. after destroy),
 * then runs a one-shot Job that downloads from OSS to /data via ossutil.
 *
 * source 'archive' (default) → oss://bucket/<tenantId>/archive/
 * source 'backup'  → oss://bucket/<tenantId>/backup/
 */
export async function restoreTenantData(
  tenantId: string,
  config: ProvisioningConfig,
  options: { source?: 'backup' | 'archive'; runtimeNamespace?: string } = {},
): Promise<{ ok: boolean; jobName: string; warnings: string[] }> {
  const source = options.source ?? 'archive';
  const namespace = tenantNamespace(tenantId);
  const pvcName = `dealclaw-runtime-${tenantId}`;
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '').replace(/T/, '-');
  const jobName = `dealclaw-restore-${tenantId}-${timestamp}`;
  const prefix = `${tenantId}/${source}`;

  const labels = {
    'app.kubernetes.io/part-of': 'dealclaw',
    'dealclaw.io/tenant-id': tenantId,
    'dealclaw.io/job-type': 'restore-data',
  };

  const command = [
    '/bin/sh',
    '-c',
    [
      'ossutil config -i "$OSS_ACCESS_KEY_ID" -k "$OSS_ACCESS_KEY_SECRET" -e "$OSS_ENDPOINT" >/dev/null 2>&1',
      `ossutil cp -r "oss://$OSS_BUCKET/${prefix}/" /data --update`,
    ].join(' && '),
  ];

  const env = [
    { name: 'OSS_ENDPOINT', value: config.ossEndpoint },
    { name: 'OSS_BUCKET', value: config.ossBucket },
    { name: 'OSS_ACCESS_KEY_ID', valueFrom: { secretKeyRef: { name: config.ossSecretName, key: 'accessKeyId' } } },
    { name: 'OSS_ACCESS_KEY_SECRET', valueFrom: { secretKeyRef: { name: config.ossSecretName, key: 'accessKeySecret' } } },
  ];

  try {
    // Recreate the PVC if the tenant was destroyed (deprovision deletes it).
    await createPersistentVolumeClaim({
      namespace,
      name: pvcName,
      size: config.agentPvcSize,
      storageClassName: config.agentPvcStorageClass,
      accessMode: config.agentPvcAccessMode,
      labels: { ...labels, app: 'dealclaw-agent' },
    });

    await createJob({
      namespace,
      name: jobName,
      labels,
      image: config.backupImage,
      command,
      env,
      volumeName: 'runtime-data',
      pvcClaimName: pvcName,
      mountPath: '/data',
      ttlSecondsAfterFinished: 86_400,
      backoffLimit: 1,
      imagePullSecrets: [{ name: 'registry-secret-vpc' }],
    });

    return {
      ok: true,
      jobName,
      warnings: [`restore Job ${jobName} created for tenant ${tenantId} (source=${source})`],
    };
  } catch (err) {
    return {
      ok: false,
      jobName,
      warnings: [`Failed to create restore Job: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
}
