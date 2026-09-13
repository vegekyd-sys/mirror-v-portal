import { createHash } from 'node:crypto';
import type { ModelRuntimeParamsV1 } from '../../domain/model-catalog.js';
import type {
  DiscoveryCandidate,
  DiscoveryInput,
  FieldEvidence,
  ModelParamSourceAdapter,
} from './types.js';

interface BuiltinCatalogEntry {
  providerName: string;
  templateKey: string;
  modelId: string;
  params: ModelRuntimeParamsV1;
  sourceUrl: string;
  sourceVersion: string;
}

const QWEN_37_PLUS_PARAMS: ModelRuntimeParamsV1 = {
  contextWindow: 1_000_000,
  maxInputTokens: 991_808,
  maxOutputTokens: 131_072,
  maxReasoningTokens: 262_144,
  inputModalities: ['text', 'image', 'video'],
  outputModalities: ['text'],
  reasoning: true,
  vision: true,
  toolCalling: true,
  structuredOutput: true,
};

const BUILTIN_CATALOG: readonly BuiltinCatalogEntry[] = [{
  providerName: 'aochi-aliyun',
  templateKey: 'custom-openai',
  modelId: 'qwen3.7-plus',
  params: QWEN_37_PLUS_PARAMS,
  sourceUrl: 'https://help.aliyun.com/zh/model-studio/qwen3-7-plus',
  // The rolling alias was observed against this official snapshot. This does
  // not pin production calls to the dated model ID.
  sourceVersion: 'qwen3.7-plus-2026-05-26',
}];

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function isAliyunMaasEndpoint(baseUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase();
  const hasWorkspacePrefix = hostname.endsWith('.maas.aliyuncs.com') && hostname !== 'maas.aliyuncs.com';
  const normalizedPath = parsed.pathname.replace(/\/+$/, '') || '/';
  return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '' &&
    (parsed.port === '' || parsed.port === '443') && hasWorkspacePrefix &&
    normalizedPath === '/compatible-mode/v1' && parsed.search === '' && parsed.hash === '';
}

function exactEntry(input: DiscoveryInput, modelId: string): BuiltinCatalogEntry | null {
  const entry = BUILTIN_CATALOG.find((item) => (
    item.providerName === input.provider.legacyProviderName &&
    item.templateKey === input.provider.templateKey &&
    item.modelId === modelId
  ));
  return entry && isAliyunMaasEndpoint(input.provider.baseUrl) ? entry : null;
}

function evidenceFor(entry: BuiltinCatalogEntry, rawSha256: string, observedAt: string): FieldEvidence[] {
  return Object.entries(entry.params).map(([field, rawValue]) => ({
    field,
    sourceKind: 'official-doc',
    sourceUrl: entry.sourceUrl,
    sourceVersion: entry.sourceVersion,
    observedAt,
    rawValue,
    rawSha256,
    confidence: 'high',
  }));
}

/** Versioned official-document catalog using exact provider, host, and model keys. */
export class BuiltinModelParamSource implements ModelParamSourceAdapter {
  public readonly name = 'builtin-catalog' as const;

  constructor(private readonly clock: () => Date = () => new Date()) {}

  public async preview(input: DiscoveryInput): Promise<{
    candidates: DiscoveryCandidate[];
    source: {
      kind: 'official-doc';
      url?: string;
      version?: string;
      observedAt: string;
      rawSha256: string;
    };
  }> {
    const observedAt = this.clock().toISOString();
    const entries = input.modelIds.map((modelId) => exactEntry(input, modelId));
    const matched = entries.filter((entry): entry is BuiltinCatalogEntry => entry !== null);
    const sourcePayload = matched.map((entry) => ({
      providerName: entry.providerName,
      templateKey: entry.templateKey,
      modelId: entry.modelId,
      params: entry.params,
      sourceUrl: entry.sourceUrl,
      sourceVersion: entry.sourceVersion,
    }));
    const sourceHash = sha256(sourcePayload);
    const byModel = new Map(matched.map((entry) => [entry.modelId, entry]));
    const candidates: DiscoveryCandidate[] = input.modelIds.map((modelId) => {
      const entry = byModel.get(modelId);
      if (!entry) {
        return {
          modelId,
          params: {},
          evidence: [],
          conflicts: [],
          unresolvedFields: ['exact-alias-evidence'],
          rawSha256: sourceHash,
        };
      }
      return {
        modelId,
        params: entry.params,
        evidence: evidenceFor(entry, sourceHash, observedAt),
        conflicts: [],
        unresolvedFields: [],
        rawSha256: sourceHash,
      };
    });
    const first = matched[0];
    return {
      candidates,
      source: {
        kind: 'official-doc',
        ...(first ? { url: first.sourceUrl, version: first.sourceVersion } : {}),
        observedAt,
        rawSha256: sourceHash,
      },
    };
  }
}
