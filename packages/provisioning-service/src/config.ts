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

/**
 * 米奥（Mio）API 默认域名。供应商搜索 / 快速创建都走这个 host 下的
 * /blade-supplier 与 /blade-agent-adapter 路径。可用 MIO_API_BASE_URL 覆盖。
 */
export const DEFAULT_MIO_API_BASE_URL = 'https://micro.tradechina.com';

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
  /** Enable legacy runtime config shadow import into the structured catalog. */
  modelCatalogShadowImport?: boolean;
  /** Enable structured catalog reads and snapshot preview. */
  modelCatalogRead?: boolean;
  /** Enable explicit compatibility snapshot publishing. */
  modelCatalogSnapshotWrite?: boolean;
  /** Enable writes to discovered/override model parameter layers only. */
  modelCatalogParamWrite?: boolean;
  /** Enable the one-time Legacy global policy stable-ID backfill apply. */
  modelCatalogGlobalPolicyBackfillWrite?: boolean;
  /** LLM push worker 轮询间隔（毫秒） */
  llmPushWorkerIntervalMs: number;
  /** LLM push 任务租约 TTL（秒）——覆盖单租户最坏 ~40s 重启 */
  llmPushLeaseSeconds: number;
  /** Rollout batch worker 轮询间隔（毫秒） */
  rolloutBatchWorkerIntervalMs?: number;
  /** Rollout batch 任务租约 TTL（秒）——覆盖单租户 recreate ~6s */
  rolloutBatchLeaseSeconds?: number;
  /**
   * 米奥 API base URL（env MIO_API_BASE_URL，默认
   * DEFAULT_MIO_API_BASE_URL）。只有 host，不含 /blade-* 路径。
   */
  mioApiBaseUrl?: string;
  /**
   * 米奥 Blade-Auth bearer token（env MIO_BLADE_AUTH）。**只从 env 读**，
   * 任何情况下都不得写进代码、测试、日志或响应体。为空时米奥客户端会报
   * 明确错误（503 MIO_AUTH_NOT_CONFIGURED），不会静默降级成无鉴权调用。
   */
  mioBladeAuth?: string;
  /**
   * 当 Catalog 成为模型供应商管理的权威后，将旧 PUT/DELETE
   * /v1/admin/llm-providers 置为只读（返回 410）。默认 false 不破坏现有
   * 行为，生产切换时通过 env LEGACY_LLM_PROVIDERS_READONLY=true 开启。
   */
  legacyLlmProvidersReadonly?: boolean;
  /**
   * Break-glass：紧急情况下临时关闭 Catalog 权威，允许旧 API 写入 Legacy
   * JSON。激活时 Catalog Publish 被冻结（503），旧写 API 恢复可用但
   * 每次写入都记审计并创建 reconcile 待办。通过 env CATALOG_BREAK_GLASS=true
   * 开启，**只能在故障应急时短期使用**。
   */
  catalogBreakGlass?: boolean;
  /**
   * Selection V2 dual-read：V2 为主读，legacy shadow compare。默认 false
   * （legacy 为主读），通过 env SELECTION_V2_PRIMARY_READ=true 开启。
   */
  selectionV2PrimaryRead?: boolean;
  /**
   * Catalog Projection 从 Authority 构建：atomicPublish 在 Release 事务内
   * 用 buildCatalogSnapshot() 独立构建 snapshot，而非依赖调用方传入。
   * 默认 false（过渡期仍接受调用方传入的 snapshot），通过 env
   * CATALOG_PROJECTION_FROM_AUTHORITY=true 开启。
   */
  catalogProjectionFromAuthority?: boolean;
  /**
   * 企业微信扫码授权 source 来源标识（env WECOM_SCAN_SOURCE，默认
   * 'wecom-cli'，与官方 OpenClaw CLI 一致）。后续若向企业微信申请了独立
   * 品牌标识，通过 env 覆盖即可。
   */
  wecomScanSource?: string;
  /**
   * 企业微信扫码授权 plat 平台码（env WECOM_SCAN_PLAT，可选数字）。
   * 不配置时由 wecom-app-scan.ts 按运行时操作系统映射（darwin=1/win32=2/
   * linux=3/其他=0）。
   */
  wecomScanPlat?: number;
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
    modelCatalogShadowImport: process.env.MODEL_CATALOG_SHADOW_IMPORT === 'true',
    modelCatalogRead: process.env.MODEL_CATALOG_READ === 'true',
    modelCatalogSnapshotWrite: process.env.MODEL_CATALOG_SNAPSHOT_WRITE === 'true',
    modelCatalogParamWrite: process.env.MODEL_CATALOG_PARAM_WRITE === 'true',
    modelCatalogGlobalPolicyBackfillWrite:
      process.env.MODEL_CATALOG_GLOBAL_POLICY_BACKFILL_WRITE === 'true',
    llmPushWorkerIntervalMs: Number(process.env.LLM_PUSH_WORKER_INTERVAL_MS ?? 500),
    llmPushLeaseSeconds: Number(process.env.LLM_PUSH_LEASE_SECONDS ?? 600),
    rolloutBatchWorkerIntervalMs: Number(process.env.ROLLOUT_BATCH_WORKER_INTERVAL_MS ?? 500),
    rolloutBatchLeaseSeconds: Number(process.env.ROLLOUT_BATCH_LEASE_SECONDS ?? 600),
    mioApiBaseUrl: process.env.MIO_API_BASE_URL || DEFAULT_MIO_API_BASE_URL,
    // 空字符串代表"未配置"——由 mio-supplier-client 在真正调用时抛明确错误。
    // 这里绝不打印、绝不给默认值。
    mioBladeAuth: process.env.MIO_BLADE_AUTH || '',
    legacyLlmProvidersReadonly: process.env.LEGACY_LLM_PROVIDERS_READONLY === 'true',
    catalogBreakGlass: process.env.CATALOG_BREAK_GLASS === 'true',
    selectionV2PrimaryRead: process.env.SELECTION_V2_PRIMARY_READ === 'true',
    catalogProjectionFromAuthority: process.env.CATALOG_PROJECTION_FROM_AUTHORITY === 'true',
    wecomScanSource: process.env.WECOM_SCAN_SOURCE || 'wecom-cli',
    wecomScanPlat:
      process.env.WECOM_SCAN_PLAT !== undefined && process.env.WECOM_SCAN_PLAT !== ''
        ? Number(process.env.WECOM_SCAN_PLAT)
        : undefined,
  };
}
