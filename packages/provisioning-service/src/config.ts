function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export interface ProvisioningConfig {
  port: number;
  databaseUrl: string;
  /** Override for local dev/testing — skip actual K8s calls */
  k8sDryRun: boolean;
  /** Runtime namespace — all tenants deployed here (per design doc) */
  runtimeNamespace: string;
  /** ACR registry prefix for container images */
  imageRegistry: string;
  /** Image tags */
  nexusGatewayImageTag: string;
  dealclawAgentImageTag: string;
}

export function loadConfig(): ProvisioningConfig {
  return {
    port: Number(process.env.PORT ?? 8082),
    databaseUrl: required('DATABASE_URL'),
    k8sDryRun: process.env.K8S_DRY_RUN === 'true' || process.env.NODE_ENV !== 'production',
    runtimeNamespace: process.env.RUNTIME_NAMESPACE || 'dealclaw-staging',
    imageRegistry: process.env.IMAGE_REGISTRY || 'ultronx-acr-registry-vpc.cn-shanghai.cr.aliyuncs.com/dealclaw',
    nexusGatewayImageTag: process.env.NEXUS_GATEWAY_IMAGE_TAG || 'latest',
    dealclawAgentImageTag: process.env.DEALCLAW_AGENT_IMAGE_TAG || 'latest',
  };
}
