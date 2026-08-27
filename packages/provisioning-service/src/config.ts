function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

/**
 * Fallback central control-plane namespace (where provisioning-service /
 * credits-ledger / ops-agent run). In-cluster this is always overridden via
 * the RUNTIME_NAMESPACE env var (injected from the Pod's own namespace via
 * the downward API in deployment.yaml), so cross-namespace service FQDNs
 * such as credits-ledger.<ns> resolve correctly regardless of environment.
 */
export const DEFAULT_RUNTIME_NAMESPACE = 'dealclaw-test';

export interface ProvisioningConfig {
  port: number;
  databaseUrl: string;
  /** Override for local dev/testing — skip actual K8s calls */
  k8sDryRun: boolean;
  /**
   * Central control-plane namespace. Tenants live in their own
   * dealclaw-<tenantId> namespaces; this value is used to build
   * cross-namespace service URLs (e.g. credits-ledger.<ns>:8081).
   */
  runtimeNamespace: string;
  /** ACR registry prefix for container images */
  imageRegistry: string;
  /** Image tags */
  nexusGatewayImageTag: string;
  dealclawAgentImageTag: string;
  /** Per-tenant dealclaw-agent PVC storage size (default 10Gi) */
  agentPvcSize: string;
  /** Storage class for per-tenant PVC */
  agentPvcStorageClass: string;
  /** Access mode for per-tenant PVC */
  agentPvcAccessMode: 'ReadWriteOnce' | 'ReadWriteMany';
  /** OSS endpoint for tenant data backup (e.g. oss-cn-shanghai.aliyuncs.com) */
  ossEndpoint: string;
  /** OSS bucket for tenant data backup */
  ossBucket: string;
  /** K8s secret name holding OSS accessKeyId + accessKeySecret */
  ossSecretName: string;
  /** Container image used for the backup Job */
  backupImage: string;
  /** credits-ledger base URL for account creation (customer-admin) */
  creditsLedgerUrl: string;
  /** shared service token for credits-ledger admin auth (BILLING_SERVICE_TOKEN) */
  creditsLedgerToken: string;
}

export function loadConfig(): ProvisioningConfig {
  return {
    port: Number(process.env.PORT ?? 8082),
    databaseUrl: required('DATABASE_URL'),
    k8sDryRun: process.env.K8S_DRY_RUN === 'true' || process.env.NODE_ENV !== 'production',
    runtimeNamespace: process.env.RUNTIME_NAMESPACE || DEFAULT_RUNTIME_NAMESPACE,
    imageRegistry: process.env.IMAGE_REGISTRY || 'ultronx-acr-registry-vpc.cn-shanghai.cr.aliyuncs.com/dealclaw',
    nexusGatewayImageTag: process.env.NEXUS_GATEWAY_IMAGE_TAG || 'latest',
    dealclawAgentImageTag: process.env.DEALCLAW_AGENT_IMAGE_TAG || 'latest',
    agentPvcSize: process.env.AGENT_PVC_SIZE || '100Gi',
    agentPvcStorageClass: process.env.AGENT_PVC_STORAGE_CLASS || 'alibabacloud-cnfs-nas',
    agentPvcAccessMode: (process.env.AGENT_PVC_ACCESS_MODE as 'ReadWriteOnce' | 'ReadWriteMany') || 'ReadWriteOnce',
    ossEndpoint: process.env.OSS_ENDPOINT || 'oss-cn-shanghai.aliyuncs.com',
    ossBucket: process.env.OSS_BUCKET || 'dealclaw-backup',
    ossSecretName: process.env.OSS_SECRET_NAME || 'dealclaw-oss',
    backupImage: process.env.BACKUP_IMAGE || 'ultronx-acr-registry-vpc.cn-shanghai.cr.aliyuncs.com/video-editor/ossutil:2.2.1',
    creditsLedgerUrl: process.env.CREDITS_LEDGER_URL || 'http://credits-ledger:8081',
    creditsLedgerToken: process.env.BILLING_SERVICE_TOKEN || process.env.PAYMENT_SERVICE_TOKEN || '',
  };
}
