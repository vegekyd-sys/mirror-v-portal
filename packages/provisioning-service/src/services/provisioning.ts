import { v4 as uuidv4 } from 'uuid';
import {
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
import type { ProvisioningConfig } from '../config.js';

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
  const runtimeNs = options.runtimeNamespace || process.env.RUNTIME_NAMESPACE || 'dealclaw-staging';
  const registry = options.imageRegistry || process.env.IMAGE_REGISTRY || 'ultronx-acr-registry-vpc.cn-shanghai.cr.aliyuncs.com/dealclaw';
  const gwTag = options.nexusGatewayImageTag || process.env.NEXUS_GATEWAY_IMAGE_TAG || 'latest';
  const agentTag = options.dealclawAgentImageTag || process.env.DEALCLAW_AGENT_IMAGE_TAG || 'latest';
  const pvcSize = options.agentPvcSize || process.env.AGENT_PVC_SIZE || '10Gi';
  const pvcStorageClass = options.agentPvcStorageClass || process.env.AGENT_PVC_STORAGE_CLASS || 'alibabacloud-cnfs-nas';
  const pvcAccessMode = options.agentPvcAccessMode || (process.env.AGENT_PVC_ACCESS_MODE as 'ReadWriteOnce' | 'ReadWriteMany') || 'ReadWriteOnce';

  const nsName = runtimeNs; // shared namespace — per design doc
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
    result.secrets.push(botSecretName, agentConfigName, creditsConfigName);
    result.pods.push(gatewayName, agentName, agentPvcName);
    return result;
  }

  // === Production path: real K8s API calls ===
  try {
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
      DEALCLAW_CREDITS_ACCOUNT_ID: `credits-${tenantLabel}`,
      DEALCLAW_CREDITS_LEDGER_URL: 'http://credits-ledger:8081',
      DEALCLAW_CUSTOMER_KEY_REF: `tenant-keys/${tenantLabel}`,
      DEALCLAW_BOT_CREDENTIAL_REF: `bot/${tenantLabel}`,
    });
    result.secrets.push(creditsConfigName);

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
        { name: 'PROVISIONING_SERVICE_URL', value: process.env.PROVISIONING_SERVICE_URL || 'http://provisioning-service:8082' },
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
        // Shared runtime provider credentials in the test namespace.
        // Production should use a tenant-scoped runtime Secret.
        { secretRef: { name: 'tenant-config' } },
      ],
      env: [
        { name: 'NODE_ENV', value: 'production' },
        { name: 'DEALCLAW_MODEL', value: 'deepseek/deepseek-chat' },
        // credits-ledger 地址 + 服务令牌（确定性计费 plugin 依赖）
        { name: 'DC_BILLING_URL', value: process.env.CREDITS_LEDGER_URL || 'http://credits-ledger:8081' },
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
  const namespace = options.runtimeNamespace || process.env.RUNTIME_NAMESPACE || 'dealclaw-staging';

  const gatewayName = `nexus-gateway-${tenantId}`;
  const agentName = `dealclaw-agent-${tenantId}`;
  const agentPvcName = `dealclaw-runtime-${tenantId}`;
  const secretNames = [
    `dealclaw-bot-${tenantId}`,
    `dealclaw-agent-config-${tenantId}`,
    `dealclaw-credits-${tenantId}`,
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
  const namespace = options.runtimeNamespace || config.runtimeNamespace;
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
