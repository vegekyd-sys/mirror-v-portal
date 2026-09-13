import type { ModelRuntimeParamsV1 } from '../../domain/model-catalog.js';

export type ModelParamAdapter = 'provider-api' | 'builtin-catalog';
export type EvidenceSourceKind =
  | 'provider-api'
  | 'official-doc'
  | 'builtin-catalog'
  | 'manual-contract';

export interface FieldEvidence {
  field: string;
  sourceKind: EvidenceSourceKind;
  sourceUrl?: string;
  sourceVersion?: string;
  observedAt: string;
  rawValue: unknown;
  rawSha256: string;
  confidence: 'high' | 'medium' | 'low';
  notes?: string;
}

export interface ParamConflict {
  field: string;
  currentOverride: unknown;
  discovered: unknown;
  reason: 'override-differs-from-discovered';
}

export interface DiscoveryCandidate {
  modelId: string;
  params: ModelRuntimeParamsV1;
  evidence: FieldEvidence[];
  conflicts: ParamConflict[];
  unresolvedFields: string[];
  rawSha256: string;
}

export interface DiscoveryProviderContext {
  id: string;
  legacyProviderName: string;
  templateKey: string;
  baseUrl: string;
  updatedAt: string;
}

export interface DiscoveryInput {
  provider: DiscoveryProviderContext;
  modelIds: string[];
}

export interface DiscoverySource {
  kind: EvidenceSourceKind;
  url?: string;
  version?: string;
  observedAt: string;
  rawSha256: string;
}

export class ModelParamSourceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelParamSourceUnavailableError';
  }
}

export interface ModelParamSourceAdapter {
  readonly name: ModelParamAdapter;
  preview(input: DiscoveryInput): Promise<{
    candidates: DiscoveryCandidate[];
    source: DiscoverySource;
  }>;
}
