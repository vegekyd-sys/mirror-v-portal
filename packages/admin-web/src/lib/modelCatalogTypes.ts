/** API contracts for the P1 structured model catalog and pricing shadow views. */

export type ParamsStatus = 'complete' | 'incomplete' | 'fallback' | 'invalid';

export interface ModelRuntimeParams {
  contextWindow?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxReasoningTokens?: number;
  inputModalities?: string[];
  outputModalities?: string[];
  reasoning?: boolean;
  vision?: boolean;
  toolCalling?: boolean;
  structuredOutput?: boolean;
  embedding?: { dimensions?: number; maxBatchSize?: number };
  rerank?: { maxDocuments?: number; maxDocumentTokens?: number };
  image?: { sizes?: string[]; qualities?: string[] };
  audio?: { formats?: string[]; voices?: string[]; maxSeconds?: number };
  video?: { maxSeconds?: number; resolutions?: string[]; fps?: number[] };
}

export interface CatalogProvider {
  id: string;
  legacyProviderName: string;
  templateKey: string;
  displayName?: string;
  protocol: string;
  baseUrl: string;
  source: string;
  enabled: boolean;
  hasApiKey: boolean;
  /** CAS revision number (P2 write API); absent on P1 read-only responses. */
  revision?: number;
  /** API key mask returned by detail endpoint (e.g. abcd••••wxyz). */
  apiKeyMask?: string;
}

export interface CatalogModel {
  id: string;
  providerInstanceId: string;
  modelId: string;
  displayName?: string;
  modelType: string;
  runtimeEnabled: boolean;
  effectiveParams: ModelRuntimeParams;
  paramsStatus: ParamsStatus;
  schemaVersion: number;
  /** CAS revision number (P2 write API); absent on P1 read-only responses. */
  revision?: number;
}

export interface CatalogImportRun {
  id: string;
  sourceKind: string;
  sourceFingerprint: string;
  status: string;
  totalCount: number;
  succeededCount: number;
  skippedCount: number;
  errorCount: number;
  startedAt: string;
  finishedAt: string | null;
}

export interface CatalogSnapshotBackup {
  id: string;
  runtimeConfigId: string | null;
  sourceFingerprint: string;
  actor: string | null;
  createdAt: string;
}

export interface CatalogStatus {
  totals: { providers: number; models: number };
  modelStatuses: Record<ParamsStatus, number>;
  recentImportRuns: CatalogImportRun[];
  recentSnapshotBackups: CatalogSnapshotBackup[];
}

export interface CatalogImportReport {
  runId: string;
  sourceFingerprint: string;
  dryRun: boolean;
  totalCount: number;
  succeededCount: number;
  skippedCount: number;
  errorCount: number;
  references: Record<string, string | string[] | null>;
  items: Array<{ provider: string; model?: string; status: 'imported' | 'skipped' | 'error'; reason?: string }>;
}

export interface SnapshotDiff {
  addedProviders: string[];
  removedProviders: string[];
  changedProviders: string[];
  addedModels: string[];
  removedModels: string[];
  changedModels: string[];
  affectedProviders: string[];
  fallbackWarnings: Array<{ providerName: string; modelId: string; fallbackFields: string[] }>;
  changedReferences: Array<{
    reference: 'defaultModel' | 'imageModel' | 'compactionModel' | 'fallbackModels';
    before: string | string[] | null;
    after: string | string[] | null;
  }>;
  fingerprint: string;
}

export interface SnapshotPreview {
  fingerprint: string;
  diff: SnapshotDiff;
}

export interface PricingDeltaSample {
  usageEventId: string;
  tenantId: string;
  provider: string;
  model: string;
  status: string;
  amount: string | null;
  currency: string | null;
  legacyAmount: string | null;
  deltaAmount: string | null;
  createdAt: string;
}

export interface PricingShadowSummary {
  planCount: number;
  shadowStatuses: {
    resolved: number;
    unknown: number;
    conflict: number;
    free: number;
    pending: number;
  };
  legacyComparisonCount: number;
  deltaCounts: { zero: number; nonzero: number };
  deltaSamples: PricingDeltaSample[];
}

export interface SnapshotMutationResponse {
  ok: boolean;
  taskId: string;
  streamUrl: string;
}

// ── P2 structured catalog management API contracts ──

/** Global model selection policy (default / image / compaction / fallback). */
export interface GlobalModelPolicy {
  defaultModel: string | null;
  imageModel: string | null;
  compactionModel: string | null;
  fallbackModels: string[];
  revision: number;
}

/** Immutable catalog release record. */
export interface CatalogRelease {
  id: string;
  version: number;
  parentId: string | null;
  fingerprint: string;
  parentFingerprint: string | null;
  diffSummary: Record<string, unknown>;
  warnings: unknown[];
  actor: string | null;
  actorType: string;
  status: string;
  createdAt: string;
}

/** Impact manifest returned by GET /rollout/impact-preview. */
export interface ImpactManifest {
  releaseId: string | null;
  fingerprint: string;
  totalTenants: number;
  affectedTenants: number;
  unaffectedTenants: number;
  pinnedTenants: number;
  entries: TenantImpactEntry[];
}

/** Per-tenant impact entry inside an ImpactManifest. */
export interface TenantImpactEntry {
  tenantId: string;
  tenantName: string | null;
  internal: boolean;
  affected: boolean;
  affectedReasons: string[];
  agentRestart: boolean;
  gatewayRestart: boolean;
  currentAppliedReleaseId: string | null;
  desiredReleaseId: string | null;
  deliveryStatus: string | null;
}

/** Per-tenant release delivery status from GET /rollout/status. */
export interface TenantReleaseStatus {
  tenantId: string;
  desiredReleaseId: string | null;
  appliedReleaseId: string | null;
  appliedFingerprint: string | null;
  deliveryStatus: string | null;
  attempts: number;
  updatedAt: string;
}

/** Rollout scope type for POST /rollout. */
export type RolloutScopeType = 'full' | 'allowlist' | 'single' | 'affected' | 'canary';

/** Response from POST /rollout (scoped rollout creation). */
export interface RolloutCreateResponse {
  ok: boolean;
  rolloutId: string;
  message?: string;
}

/** Pure catalog snapshot returned by GET /catalog-preview. */
export interface CatalogPreview {
  fingerprint: string;
  providers: Array<{
    id: string;
    legacyProviderName: string;
    displayName?: string;
    templateKey: string;
    protocol: string;
    baseUrl: string;
    enabled: boolean;
    models: Array<{
      modelId: string;
      displayName?: string;
      modelType: string;
      runtimeEnabled: boolean;
      paramsStatus: string;
    }>;
  }>;
  policy: GlobalModelPolicy;
}
