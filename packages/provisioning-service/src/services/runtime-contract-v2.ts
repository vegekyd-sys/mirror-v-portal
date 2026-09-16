/**
 * RuntimeContractRenderer — renders canonical V2 IR from Catalog + Release.
 *
 * The renderer is the single source of truth for materializing V2 payloads:
 *  - `renderAgentPayload()` produces the dealclaw-agent payload.
 *  - `renderGatewayPayload()` produces the nexus-gateway payload.
 *  - `wrapEnvelope()` wraps a payload with release provenance.
 *  - `canonicalFingerprint()` computes a deterministic SHA-256 over the
 *    payload (excludes `generatedAt` so envelopes produced at different
 *    times with identical content share the same materialization fingerprint).
 *
 * Stable IDs (providerId, modelId) are passed through verbatim from the
 * Catalog Authority — they are never recomputed or derived here.
 *
 * This module does NOT modify any V1 code path. V1 continues to read
 * `LlmProvidersConfig` from `runtime_configs`; V2 runs in shadow mode.
 */

import { createHash } from 'node:crypto';
import type { LlmProvidersConfig, LlmModelSpec, LlmProviderSpec } from './llm-providers.js';
import type { CatalogReleaseRecord } from '../domain/catalog-release.js';
import type { TenantModelSelection } from './llm-providers.js';
import {
  RUNTIME_CONTRACT_V2_RENDERER_VERSION,
  type AgentRuntimePayloadV2,
  type GatewayRuntimePayloadV2,
  type GatewayRouteV2,
  type RuntimeEnvelopeV2,
  type RuntimeEnvelopePayload,
  type RuntimeModelRefV2,
  type RuntimeModelV2,
  type RuntimeProviderV2,
  type RuntimeCompatV2,
} from '../domain/runtime-contract-v2.js';
import type { ModelType, ModelModality } from '../domain/model-catalog.js';

// ── Slug derivation ──────────────────────────────────────────────────────

/**
 * Derive an opaque, deterministic runtimeKey from a provider name.
 * The key is a short slug suitable for agent config and gateway routing —
 * it does NOT expose the stable lpi_ ID to the runtime surface.
 */
export function deriveRuntimeKey(providerName: string): string {
  // Normalise: lowercase, replace non-alphanumeric with hyphen, trim leading/trailing.
  const slug = providerName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) return 'provider';
  return slug.slice(0, 32);
}

// ── Canonical JSON ──────────────────────────────────────────────────────

/**
 * Produce a canonical JSON string for fingerprinting:
 *  - Object keys are sorted lexicographically.
 *  - Arrays are sorted by a stable key (modelId, providerId, or runtimeKey)
 *    when the array elements are objects with that key; otherwise order
 *    is preserved.
 *  - `undefined` values are filtered out.
 *  - `generatedAt` is explicitly excluded from envelopes.
 */
function canonicalJson(value: unknown, excludeKeys: Set<string> = new Set()): string {
  if (Array.isArray(value)) {
    // If elements are objects with a stable key, sort for determinism.
    const stableKeys = ['modelId', 'providerId', 'runtimeKey'];
    const sortKey = stableKeys.find((key) =>
      value.every(
        (item) =>
          typeof item === 'object' &&
          item !== null &&
          !Array.isArray(item) &&
          key in item,
      ),
    );
    const sorted = sortKey
      ? [...value].sort((a, b) => {
          const av = String((a as Record<string, unknown>)[sortKey]);
          const bv = String((b as Record<string, unknown>)[sortKey]);
          return av < bv ? -1 : av > bv ? 1 : 0;
        })
      : value;
    return `[${sorted.map((item) => canonicalJson(item, excludeKeys)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key, item]) => item !== undefined && !excludeKeys.has(key))
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item, excludeKeys)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

// ── Model rendering ──────────────────────────────────────────────────────

function renderModel(
  spec: LlmModelSpec,
  providerId: string,
): RuntimeModelV2 {
  const compat: RuntimeCompatV2 = {};
  if (spec.compat) {
    // Sort keys for canonical output.
    for (const [key, val] of Object.entries(spec.compat).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      compat[key] = val;
    }
  }
  return {
    modelId: `${providerId}/${spec.id}`, // Stable composite ID for V2
    upstreamModel: spec.id,
    aliases: [], // No aliases in V1 source; V2 authority may add later
    displayName: spec.displayName ?? '',
    modelType: (spec.modelType ?? 'unknown') as ModelType,
    protocol: 'openai-completions',
    contextWindow: spec.contextWindow ?? null,
    maxOutputTokens: spec.maxOutputTokens ?? null,
    inputModalities: (spec.inputModalities ?? ['text']) as ModelModality[],
    reasoning: spec.reasoning === true,
    vision: spec.vision === true,
    compat,
  };
}

// ── Provider rendering ───────────────────────────────────────────────────

function renderProvider(
  spec: LlmProviderSpec,
): RuntimeProviderV2 {
  const providerId = spec.name; // V1 provider name acts as stable ID until lpi_ migration
  const runtimeKey = deriveRuntimeKey(spec.name);
  return {
    providerId,
    runtimeKey,
    routeAliases: [],
    displayName: spec.label ?? '',
    baseUrl: spec.baseUrl,
    apiKey: spec.apiKey,
    models: spec.models
      .map((m) => renderModel(m, providerId))
      .sort((a, b) => a.modelId.localeCompare(b.modelId)),
  };
}

// ── Ref resolution ───────────────────────────────────────────────────────

/**
 * Parse a legacy "providerName/modelId" reference into a V2 stable ref.
 * In the V2 shadow phase, the provider name IS the providerId (until lpi_
 * migration lands). The modelId is the upstream model identifier.
 */
function parseLegacyRef(
  ref: string | null,
): RuntimeModelRefV2 | null {
  if (!ref) return null;
  const slashIdx = ref.indexOf('/');
  if (slashIdx < 0) return null;
  const providerId = ref.slice(0, slashIdx);
  const modelId = `${providerId}/${ref.slice(slashIdx + 1)}`;
  if (!providerId || !modelId) return null;
  return { providerId, modelId };
}

/**
 * Resolve a model reference using tenant override if a selection is provided.
 * When `selection` is non-null, the tenant's value (even if null) overrides
 * the global. When `selection` is null, the global is used.
 */
function resolveRefWithTenant(
  globalRef: string | null,
  tenantRef: string | null | undefined,
  hasSelection: boolean,
): RuntimeModelRefV2 | null {
  if (hasSelection) {
    return parseLegacyRef(tenantRef ?? null);
  }
  return parseLegacyRef(globalRef);
}

// ── Agent payload renderer ───────────────────────────────────────────────

/**
 * Render the dealclaw-agent runtime payload from a Catalog snapshot and
 * (optionally) a tenant selection.
 *
 * @param snapshot  The Catalog compatibility snapshot (LlmProvidersConfig).
 * @param selection The tenant's model selection override, or null for global.
 * @param _release  The Release record (unused for payload content, but
 *                  required by the envelope wrapper for provenance).
 */
export function renderAgentPayload(
  snapshot: LlmProvidersConfig,
  selection: TenantModelSelection | null,
): AgentRuntimePayloadV2 {
  const directMode = selection?.directMode ?? false;
  const hasSelection = selection !== null;
  const providers = snapshot.providers
    .map(renderProvider)
    .sort((a, b) => a.providerId.localeCompare(b.providerId));

  const primary = resolveRefWithTenant(
    snapshot.defaultModel,
    selection?.defaultModel,
    hasSelection,
  );
  const image = resolveRefWithTenant(
    snapshot.imageModel,
    selection?.imageModel,
    hasSelection,
  );
  const compaction = resolveRefWithTenant(
    snapshot.compactionModel,
    selection?.compactionModel,
    hasSelection,
  );

  // Fallback: tenant override if non-null, otherwise global chain.
  const fallbackSource =
    hasSelection && selection!.fallbackModels !== null && selection!.fallbackModels !== undefined
      ? selection!.fallbackModels
      : snapshot.fallbackModels;
  const fallbacks = fallbackSource
    .map((ref) => parseLegacyRef(ref))
    .filter((ref): ref is RuntimeModelRefV2 => ref !== null);

  return { directMode, providers, primary, image, compaction, fallbacks };
}

// ── Gateway payload renderer ─────────────────────────────────────────────

/**
 * Render the nexus-gateway runtime payload from a Catalog snapshot.
 * Gateway routes never include API keys — the gateway holds its own
 * credentials.
 */
export function renderGatewayPayload(
  snapshot: LlmProvidersConfig,
): GatewayRuntimePayloadV2 {
  const routes: GatewayRouteV2[] = snapshot.providers.map((provider) => {
    const runtimeKey = deriveRuntimeKey(provider.name);
    return {
      runtimeKey,
      aliases: [],
      providerId: provider.name,
      upstreamBaseUrl: provider.baseUrl,
      models: provider.models
        .map((m) => ({
          modelId: `${provider.name}/${m.id}`,
          upstreamModel: m.id,
        }))
        .sort((a, b) => a.modelId.localeCompare(b.modelId)),
    };
  });
  return { routes: routes.sort((a, b) => a.runtimeKey.localeCompare(b.runtimeKey)) };
}

// ── Envelope wrapper ─────────────────────────────────────────────────────

/**
 * Wrap a V2 payload in a RuntimeEnvelopeV2 with release provenance.
 * The materializationFingerprint is computed over the canonical payload
 * (excluding `generatedAt`).
 */
export function wrapEnvelope<T extends RuntimeEnvelopePayload>(
  payloadWrapper: T,
  release: { id: string; version: number; fingerprint: string },
  tenantId: string | null = null,
): RuntimeEnvelopeV2<T> {
  const generatedAt = new Date().toISOString();
  const materializationFingerprint = canonicalFingerprint(payloadWrapper.payload);
  return {
    schema: payloadWrapper.schema,
    schemaVersion: 2,
    rendererVersion: RUNTIME_CONTRACT_V2_RENDERER_VERSION,
    releaseId: release.id,
    releaseVersion: release.version,
    releaseFingerprint: release.fingerprint,
    materializationFingerprint,
    generatedAt,
    tenantId,
    payload: payloadWrapper.payload,
  };
}

// ── Fingerprint ──────────────────────────────────────────────────────────

/** Keys excluded from the envelope-level fingerprint computation. */
const ENVELOPE_EXCLUDE = new Set(['generatedAt']);

/**
 * Compute a deterministic SHA-256 fingerprint over any V2 value.
 * For envelopes, `generatedAt` is excluded so identical content produces
 * the same fingerprint regardless of when it was generated.
 */
export function canonicalFingerprint(value: unknown): string {
  return createHash('sha256')
    .update(canonicalJson(value, ENVELOPE_EXCLUDE))
    .digest('hex');
}

// ── Convenience: render + wrap in one call ───────────────────────────────

/**
 * Render and wrap an agent payload envelope in a single call.
 * Useful for the shadow-mode writer that materializes a full envelope
 * from a snapshot + selection + release.
 */
export function renderAgentEnvelope(
  snapshot: LlmProvidersConfig,
  selection: TenantModelSelection | null,
  release: { id: string; version: number; fingerprint: string },
  tenantId: string | null,
): RuntimeEnvelopeV2<{ schema: 'agent'; payload: AgentRuntimePayloadV2 }> {
  const payload = renderAgentPayload(snapshot, selection);
  return wrapEnvelope({ schema: 'agent', payload }, release, tenantId);
}

/**
 * Render and wrap a gateway payload envelope in a single call.
 */
export function renderGatewayEnvelope(
  snapshot: LlmProvidersConfig,
  release: { id: string; version: number; fingerprint: string },
): RuntimeEnvelopeV2<{ schema: 'gateway'; payload: GatewayRuntimePayloadV2 }> {
  const payload = renderGatewayPayload(snapshot);
  return wrapEnvelope({ schema: 'gateway', payload }, release, null);
}
