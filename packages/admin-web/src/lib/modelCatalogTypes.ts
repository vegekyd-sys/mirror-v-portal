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
