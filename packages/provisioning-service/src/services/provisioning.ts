import { v4 as uuidv4 } from 'uuid';
import {
  createNamespace,
  deleteNamespace,
  createSecret as k8sCreateSecret,
  createDeployment,
  createService,
  createPersistentVolumeClaim,
  createJob,
  deleteSecret,
  deleteDeployment,
  deleteService,
  deletePersistentVolumeClaim,
} from './k8s-client.js';
import { DEFAULT_RUNTIME_NAMESPACE, type ProvisioningConfig } from '../config.js';

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
   * Materialized as the `tenant-config` Secret in the tenant namespace,
   * which the dealclaw-agent Deployment consumes via envFrom.
   */
  runtimeSecretData?: Record<string, string>;
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
  const gwTag = options.nexusGatewayImageTag || process.env.NEXUS_GATEWAY_IMAGE_TAG || 'latest';
  const agentTag = options.dealclawAgentImageTag || process.env.DEALCLAW_AGENT_IMAGE_TAG || 'latest';
  const pvcSize = options.agentPvcSize || process.env.AGENT_PVC_SIZE || '10Gi';
  const pvcStorageClass = options.agentPvcStorageClass || process.env.AGENT_PVC_STORAGE_CLASS || 'alibabacloud-cnfs-nas';
  const pvcAccessMode = options.agentPvcAccessMode || (process.env.AGENT_PVC_ACCESS_MODE as 'ReadWriteOnce' | 'ReadWriteMany') || 'ReadWriteOnce';

  const nsName = tenantNamespace(tenant.tenantId); // per-tenant namespace
  // Central control-plane namespace where provisioning-service / credits-ledger / ops-agent run
  const centralNs = options.runtimeNamespace || process.env.RUNTIME_NAMESPACE || DEFAULT_RUNTIME_NAMESPACE;
  const tenantLabel = tenant.tenantId;

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
    result.secrets.push(botSecretName, agentConfigName, creditsConfigName, 'tenant-config');
    result.pods.push(gatewayName, agentName, agentPvcName);
    return result;
  }

  // === Production path: real K8s API calls ===
  try {
    // 0. Create per-tenant namespace first
    await createNamespace(nsName);

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
    });
    result.secrets.push(agentConfigName);

    await k8sCreateSecret(nsName, creditsConfigName, {
      DEALCLAW_CREDITS_ACCOUNT_ID: `acct_${tenantLabel}`,
      // Cross-namespace: credits-ledger runs in the central namespace
      DEALCLAW_CREDITS_LEDGER_URL: `http://credits-ledger.${centralNs}:8081`,
      DEALCLAW_CUSTOMER_KEY_REF: `tenant-keys/${tenantLabel}`,
      DEALCLAW_BOT_CREDENTIAL_REF: `bot/${tenantLabel}`,
    });
    result.secrets.push(creditsConfigName);

    // 1b. tenant-config Secret — runtime provider/tool credentials for
    // dealclaw-agent (envFrom). Built from the runtime_configs table
    // (global defaults + per-tenant overrides), managed via admin-dashboard.
    // Fail closed: without it the agent Pod cannot start.
    const runtimeSecretName = 'tenant-config';
    if (!options.runtimeSecretData || Object.keys(options.runtimeSecretData).length === 0) {
      throw new Error(
        'Runtime config is empty — configure global defaults (e.g. DEEPSEEK_API_KEY) via admin-dashboard before provisioning',
      );
    }
    await k8sCreateSecret(nsName, runtimeSecretName, options.runtimeSecretData);
    result.secrets.push(runtimeSecretName);

    // 2. nexus-gateway Deployment + Service
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
      ],
      env: [
        { name: 'DEALCLAW_PLATFORM', value: 'feishu' },
        { name: 'DEALCLAW_AGENT_URL', value: `http://dealclaw-agent-${tenantLabel}:18789` },
        { name: 'NODE_ENV', value: 'production' },
        // Contact writeback — lets nexus-gateway report the sender's im_open_id
        // so lifecycle notifications can be delivered via the notify relay.
        // Cross-namespace: provisioning-service runs in the central namespace.
        { name: 'PROVISIONING_SERVICE_URL', value: process.env.PROVISIONING_SERVICE_URL || `http://provisioning-service.${centralNs}:8082` },
        { name: 'PROVISIONING_API_TOKEN', value: process.env.PROVISIONING_API_TOKEN || '' },
      ],
      requests: { cpu: '100m', memory: '128Mi' },
      limits: { cpu: '300m', memory: '256Mi' },
      imagePullSecrets: [{ name: 'registry-secret-vpc' }],
      livenessPath: '/healthz',
      readinessPath: '/healthz',
    });
    await createService(nsName, gatewayName, 8080, gwLabels);
    result.pods.push(gatewayName);

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
      ],
      env: [
        { name: 'NODE_ENV', value: 'production' },
        { name: 'DEALCLAW_MODEL', value: 'deepseek/deepseek-chat' },
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
      ],
      volumeMounts: [
        { name: 'runtime-data', mountPath: '/data' },
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
