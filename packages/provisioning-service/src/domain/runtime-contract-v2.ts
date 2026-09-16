/**
 * Runtime Contract V2 — domain types and strict schema validator.
 *
 * The V2 contract replaces the V1 "LlmProvidersConfig" blob (a flat
 * provider→model list with global policy refs) with two purpose-specific
 * payloads:
 *
 *  - AgentRuntimePayloadV2: consumed by dealclaw-agent. Contains providers
 *    with opaque runtimeKeys and model lists, plus primary/image/compaction/
 *    fallback references expressed as {providerId, modelId} stable IDs.
 *
 *  - GatewayRuntimePayloadV2: consumed by nexus-gateway. Contains route
 *    entries that map runtimeKeys/aliases → upstream baseUrl + models,
 *    so the gateway can proxy without knowing provider names or API keys
 *    beyond what it already holds.
 *
 * Both payloads are wrapped in a RuntimeEnvelopeV2 that carries release
 * provenance (releaseId, version, fingerprint) and a materialization
 * fingerprint for drift detection.
 *
 * This module is pure (no I/O, no side-effects) and does NOT modify any V1
 * code path.  Stable IDs (providerId, modelId) originate from the Catalog
 * Authority (llm_provider_instances.id / llm_provider_models.id) and are
 * passed through verbatim — they are never recomputed here.
 */

import {
  MODEL_TYPES,
  MODEL_MODALITIES,
  type ModelType,
  type ModelModality,
} from './model-catalog.js';

// ── Mode ────────────────────────────────────────────────────────────────

/** Determines which contract path the runtime is executing. */
export type RuntimeContractMode = 'v1' | 'shadow' | 'v2';

// ── V2 model / provider / payload types ──────────────────────────────────

/** Compatibility metadata that the agent may need (e.g. vendor quirks). */
export interface RuntimeCompatV2 {
  [key: string]: boolean | string | number;
}

/** A single model entry inside a provider, expressed in canonical V2 form. */
export interface RuntimeModelV2 {
  /** Stable Catalog model row ID (lpm_…). Never recomputed. */
  modelId: string;
  /** The upstream model identifier the provider API expects (e.g. "qwen-max"). */
  upstreamModel: string;
  /** Alternative names the agent may use to reference this model. */
  aliases: string[];
  /** Human-readable display name; empty string if none. */
  displayName: string;
  /** Functional type of the model. */
  modelType: ModelType;
  /** Wire protocol the provider speaks. */
  protocol: 'openai-completions';
  /** Maximum context window in tokens, if known. */
  contextWindow: number | null;
  /** Maximum output tokens, if known. */
  maxOutputTokens: number | null;
  /** Input modalities the model accepts. */
  inputModalities: ModelModality[];
  /** Whether the model supports extended-reasoning / chain-of-thought. */
  reasoning: boolean;
  /** Whether the model accepts image input. */
  vision: boolean;
  /** Vendor-specific compatibility flags. */
  compat: RuntimeCompatV2;
}

/** A provider with its models, expressed in canonical V2 form. */
export interface RuntimeProviderV2 {
  /** Stable Catalog provider instance ID (lpi_…). Never recomputed. */
  providerId: string;
  /** Opaque slug the agent uses to reference this provider at runtime. */
  runtimeKey: string;
  /** Additional route aliases the gateway may match (sorted, deduped). */
  routeAliases: string[];
  /** Human-readable provider display name; empty string if none. */
  displayName: string;
  /** Upstream base URL the provider API lives at. */
  baseUrl: string;
  /** API key for the upstream provider (plaintext; only in agent payload). */
  apiKey: string;
  /** Models offered by this provider, sorted by modelId. */
  models: RuntimeModelV2[];
}

/** A stable reference to a model inside a specific provider. */
export interface RuntimeModelRefV2 {
  providerId: string;
  modelId: string;
}

/** Payload consumed by dealclaw-agent. */
export interface AgentRuntimePayloadV2 {
  /** True → bypass nexus-gateway and use upstream baseUrl + apiKey directly. */
  directMode: boolean;
  /** All providers with their models. */
  providers: RuntimeProviderV2[];
  /** Primary model reference (null = no model configured). */
  primary: RuntimeModelRefV2 | null;
  /** Image-understanding / vision model reference. */
  image: RuntimeModelRefV2 | null;
  /** Compaction (context summarisation) model reference. */
  compaction: RuntimeModelRefV2 | null;
  /** Ordered fallback chain (empty = no fallback). */
  fallbacks: RuntimeModelRefV2[];
}

/** A single gateway routing entry. */
export interface GatewayRouteV2 {
  /** Opaque slug matching the agent's provider runtimeKey. */
  runtimeKey: string;
  /** Additional aliases the gateway accepts for this route. */
  aliases: string[];
  /** Stable provider ID for audit / cross-reference. */
  providerId: string;
  /** Upstream base URL the gateway proxies to. */
  upstreamBaseUrl: string;
  /** Models exposed on this route, sorted by modelId. */
  models: Array<{
    modelId: string;
    upstreamModel: string;
  }>;
}

/** Payload consumed by nexus-gateway. */
export interface GatewayRuntimePayloadV2 {
  routes: GatewayRouteV2[];
}

// ── Envelope ─────────────────────────────────────────────────────────────

/** Type tag for the payload inside the envelope. */
export type RuntimeEnvelopePayload =
  | { schema: 'agent'; payload: AgentRuntimePayloadV2 }
  | { schema: 'gateway'; payload: GatewayRuntimePayloadV2 };

/** Generic envelope that wraps a V2 payload with release provenance. */
export interface RuntimeEnvelopeV2<T extends RuntimeEnvelopePayload = RuntimeEnvelopePayload> {
  schema: T['schema'];
  schemaVersion: 2;
  /** Renderer version (bumped when canonical IR format changes). */
  rendererVersion: number;
  releaseId: string;
  releaseVersion: number;
  releaseFingerprint: string;
  /** SHA-256 of the canonical payload (excludes envelope metadata). */
  materializationFingerprint: string;
  /** ISO 8601 timestamp — excluded from fingerprint computation. */
  generatedAt: string;
  /** Tenant ID for agent payloads; null for gateway payloads. */
  tenantId: string | null;
  payload: T['payload'];
}

// ── Constants ────────────────────────────────────────────────────────────

/** Current canonical renderer version. Bumped when the IR format changes. */
export const RUNTIME_CONTRACT_V2_RENDERER_VERSION = 1;

/** Maximum number of providers / models / fallbacks allowed in V2. */
export const V2_MAX_PROVIDERS = 20;
export const V2_MAX_MODELS_PER_PROVIDER = 50;
export const V2_MAX_FALLBACKS = 20;

// ── Validation ───────────────────────────────────────────────────────────

export interface V2ValidationIssue {
  path: Array<string | number>;
  message: string;
}

export class RuntimeContractV2ValidationError extends Error {
  constructor(public readonly issues: V2ValidationIssue[]) {
    super(
      issues
        .map((issue) => `${issue.path.join('.') || '$'}: ${issue.message}`)
        .join('; '),
    );
    this.name = 'RuntimeContractV2ValidationError';
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asObject(
  value: unknown,
  path: Array<string | number>,
  issues: V2ValidationIssue[],
): Record<string, unknown> {
  if (!isObject(value)) {
    issues.push({ path, message: 'expected object' });
    return {};
  }
  return value;
}

function strictKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: Array<string | number>,
  issues: V2ValidationIssue[],
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      issues.push({ path: [...path, key], message: 'unknown field' });
    }
  }
}

function asString(
  value: unknown,
  path: Array<string | number>,
  issues: V2ValidationIssue[],
  maxLen = 256,
): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLen) {
    issues.push({ path, message: `expected string length 1..${maxLen}` });
    return '';
  }
  return value;
}

function asOptionalString(
  value: unknown,
  path: Array<string | number>,
  issues: V2ValidationIssue[],
  maxLen = 256,
): string | null {
  if (value === null || value === undefined) return null;
  return asString(value, path, issues, maxLen);
}

/** Like asString but allows empty strings (for displayName which defaults to ''). */
function asStringAllowEmpty(
  value: unknown,
  path: Array<string | number>,
  issues: V2ValidationIssue[],
  maxLen = 256,
): string {
  if (typeof value !== 'string' || value.length > maxLen) {
    issues.push({ path, message: `expected string (max ${maxLen})` });
    return '';
  }
  return value;
}

function asBoolean(
  value: unknown,
  path: Array<string | number>,
  issues: V2ValidationIssue[],
): boolean {
  if (typeof value !== 'boolean') {
    issues.push({ path, message: 'expected boolean' });
    return false;
  }
  return value;
}

function asPositiveInt(
  value: unknown,
  path: Array<string | number>,
  issues: V2ValidationIssue[],
): number | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    issues.push({ path, message: 'expected positive safe integer' });
    return null;
  }
  return value;
}

function asStringArray(
  value: unknown,
  path: Array<string | number>,
  issues: V2ValidationIssue[],
  max = 50,
): string[] {
  if (!Array.isArray(value) || value.length > max) {
    issues.push({ path, message: `expected array of at most ${max} strings` });
    return [];
  }
  const result: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (typeof item !== 'string' || item.length < 1 || item.length > 128) {
      issues.push({
        path: [...path, i],
        message: 'expected non-empty string (max 128)',
      });
    } else {
      result.push(item);
    }
  }
  return result;
}

function asModelModalityArray(
  value: unknown,
  path: Array<string | number>,
  issues: V2ValidationIssue[],
): ModelModality[] {
  if (!Array.isArray(value) || value.length > MODEL_MODALITIES.length) {
    issues.push({ path, message: 'expected modality array' });
    return [];
  }
  const result: ModelModality[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (!MODEL_MODALITIES.includes(item as ModelModality)) {
      issues.push({ path: [...path, i], message: 'invalid modality' });
    } else {
      result.push(item as ModelModality);
    }
  }
  return result;
}

function asCompat(
  value: unknown,
  path: Array<string | number>,
  issues: V2ValidationIssue[],
): RuntimeCompatV2 {
  if (value === null || value === undefined) return {};
  if (!isObject(value)) {
    issues.push({ path, message: 'expected object' });
    return {};
  }
  const result: RuntimeCompatV2 = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      (typeof item !== 'boolean' && typeof item !== 'string' && typeof item !== 'number') ||
      (typeof item === 'number' && !Number.isFinite(item)) ||
      (typeof item === 'string' && item.length > 256)
    ) {
      issues.push({
        path: [...path, key],
        message: 'expected boolean, finite number, or string <= 256',
      });
    } else {
      result[key] = item as boolean | string | number;
    }
  }
  return result;
}

// ── Model validation ─────────────────────────────────────────────────────

function validateRuntimeModelV2(
  value: unknown,
  path: Array<string | number>,
  issues: V2ValidationIssue[],
): RuntimeModelV2 {
  const raw = asObject(value, path, issues);
  strictKeys(
    raw,
    [
      'modelId', 'upstreamModel', 'aliases', 'displayName', 'modelType',
      'protocol', 'contextWindow', 'maxOutputTokens', 'inputModalities',
      'reasoning', 'vision', 'compat',
    ],
    path,
    issues,
  );
  const modelId = asString(raw.modelId, [...path, 'modelId'], issues, 128);
  const upstreamModel = asString(raw.upstreamModel, [...path, 'upstreamModel'], issues, 128);
  const aliases = asStringArray(raw.aliases, [...path, 'aliases'], issues, 20);
  const displayName = asStringAllowEmpty(raw.displayName, [...path, 'displayName'], issues, 256);
  let modelType: ModelType = 'unknown';
  if (!MODEL_TYPES.includes(raw.modelType as ModelType)) {
    issues.push({ path: [...path, 'modelType'], message: 'invalid model type' });
  } else {
    modelType = raw.modelType as ModelType;
  }
  if (raw.protocol !== 'openai-completions') {
    issues.push({ path: [...path, 'protocol'], message: 'expected openai-completions' });
  }
  const contextWindow = asPositiveInt(raw.contextWindow, [...path, 'contextWindow'], issues);
  const maxOutputTokens = asPositiveInt(raw.maxOutputTokens, [...path, 'maxOutputTokens'], issues);
  const inputModalities = asModelModalityArray(raw.inputModalities, [...path, 'inputModalities'], issues);
  const reasoning = asBoolean(raw.reasoning, [...path, 'reasoning'], issues);
  const vision = asBoolean(raw.vision, [...path, 'vision'], issues);
  const compat = asCompat(raw.compat, [...path, 'compat'], issues);
  return {
    modelId,
    upstreamModel,
    aliases,
    displayName,
    modelType,
    protocol: 'openai-completions',
    ...(contextWindow !== null ? { contextWindow } : { contextWindow: null }),
    ...(maxOutputTokens !== null ? { maxOutputTokens } : { maxOutputTokens: null }),
    inputModalities,
    reasoning,
    vision,
    compat,
  };
}

// ── Provider validation ──────────────────────────────────────────────────

function validateRuntimeProviderV2(
  value: unknown,
  path: Array<string | number>,
  issues: V2ValidationIssue[],
): RuntimeProviderV2 {
  const raw = asObject(value, path, issues);
  strictKeys(
    raw,
    ['providerId', 'runtimeKey', 'routeAliases', 'displayName', 'baseUrl', 'apiKey', 'models'],
    path,
    issues,
  );
  const providerId = asString(raw.providerId, [...path, 'providerId'], issues, 128);
  const runtimeKey = asString(raw.runtimeKey, [...path, 'runtimeKey'], issues, 64);
  const routeAliases = asStringArray(raw.routeAliases, [...path, 'routeAliases'], issues, 20);
  const displayName = asStringAllowEmpty(raw.displayName, [...path, 'displayName'], issues, 256);
  const baseUrl = asString(raw.baseUrl, [...path, 'baseUrl'], issues, 2048);
  const apiKey = asString(raw.apiKey, [...path, 'apiKey'], issues, 4096);
  let models: RuntimeModelV2[] = [];
  if (!Array.isArray(raw.models) || raw.models.length > V2_MAX_MODELS_PER_PROVIDER) {
    issues.push({
      path: [...path, 'models'],
      message: `expected array of at most ${V2_MAX_MODELS_PER_PROVIDER} models`,
    });
  } else {
    models = raw.models.map((m, i) =>
      validateRuntimeModelV2(m, [...path, 'models', i], issues),
    );
  }
  return {
    providerId,
    runtimeKey,
    routeAliases,
    displayName,
    baseUrl,
    apiKey,
    models,
  };
}

// ── Model ref validation ─────────────────────────────────────────────────

function validateRuntimeModelRefV2(
  value: unknown,
  path: Array<string | number>,
  issues: V2ValidationIssue[],
): RuntimeModelRefV2 | null {
  if (value === null || value === undefined) return null;
  const raw = asObject(value, path, issues);
  strictKeys(raw, ['providerId', 'modelId'], path, issues);
  const providerId = asString(raw.providerId, [...path, 'providerId'], issues, 128);
  const modelId = asString(raw.modelId, [...path, 'modelId'], issues, 128);
  return { providerId, modelId };
}

// ── Agent payload validation ─────────────────────────────────────────────

function validateAgentRuntimePayloadV2(
  value: unknown,
  path: Array<string | number>,
  issues: V2ValidationIssue[],
): AgentRuntimePayloadV2 {
  const raw = asObject(value, path, issues);
  strictKeys(
    raw,
    ['directMode', 'providers', 'primary', 'image', 'compaction', 'fallbacks'],
    path,
    issues,
  );
  const directMode = asBoolean(raw.directMode, [...path, 'directMode'], issues);
  let providers: RuntimeProviderV2[] = [];
  if (!Array.isArray(raw.providers) || raw.providers.length > V2_MAX_PROVIDERS) {
    issues.push({
      path: [...path, 'providers'],
      message: `expected array of at most ${V2_MAX_PROVIDERS} providers`,
    });
  } else {
    providers = raw.providers.map((p, i) =>
      validateRuntimeProviderV2(p, [...path, 'providers', i], issues),
    );
  }
  const primary = validateRuntimeModelRefV2(raw.primary, [...path, 'primary'], issues);
  const image = validateRuntimeModelRefV2(raw.image, [...path, 'image'], issues);
  const compaction = validateRuntimeModelRefV2(raw.compaction, [...path, 'compaction'], issues);
  let fallbacks: RuntimeModelRefV2[] = [];
  if (!Array.isArray(raw.fallbacks) || raw.fallbacks.length > V2_MAX_FALLBACKS) {
    issues.push({
      path: [...path, 'fallbacks'],
      message: `expected array of at most ${V2_MAX_FALLBACKS} refs`,
    });
  } else {
    fallbacks = raw.fallbacks.map((f, i) => {
      const ref = validateRuntimeModelRefV2(f, [...path, 'fallbacks', i], issues);
      return ref ?? { providerId: '', modelId: '' };
    });
  }
  return { directMode, providers, primary, image, compaction, fallbacks };
}

// ── Gateway payload validation ───────────────────────────────────────────

function validateGatewayRouteV2(
  value: unknown,
  path: Array<string | number>,
  issues: V2ValidationIssue[],
): GatewayRouteV2 {
  const raw = asObject(value, path, issues);
  strictKeys(
    raw,
    ['runtimeKey', 'aliases', 'providerId', 'upstreamBaseUrl', 'models'],
    path,
    issues,
  );
  const runtimeKey = asString(raw.runtimeKey, [...path, 'runtimeKey'], issues, 64);
  const aliases = asStringArray(raw.aliases, [...path, 'aliases'], issues, 20);
  const providerId = asString(raw.providerId, [...path, 'providerId'], issues, 128);
  const upstreamBaseUrl = asString(raw.upstreamBaseUrl, [...path, 'upstreamBaseUrl'], issues, 2048);
  let models: GatewayRouteV2['models'] = [];
  if (!Array.isArray(raw.models) || raw.models.length > V2_MAX_MODELS_PER_PROVIDER) {
    issues.push({
      path: [...path, 'models'],
      message: `expected array of at most ${V2_MAX_MODELS_PER_PROVIDER} models`,
    });
  } else {
    models = raw.models.map((m, i) => {
      const mRaw = asObject(m, [...path, 'models', i], issues);
      strictKeys(mRaw, ['modelId', 'upstreamModel'], [...path, 'models', i], issues);
      return {
        modelId: asString(mRaw.modelId, [...path, 'models', i, 'modelId'], issues, 128),
        upstreamModel: asString(mRaw.upstreamModel, [...path, 'models', i, 'upstreamModel'], issues, 128),
      };
    });
  }
  return { runtimeKey, aliases, providerId, upstreamBaseUrl, models };
}

function validateGatewayRuntimePayloadV2(
  value: unknown,
  path: Array<string | number>,
  issues: V2ValidationIssue[],
): GatewayRuntimePayloadV2 {
  const raw = asObject(value, path, issues);
  strictKeys(raw, ['routes'], path, issues);
  let routes: GatewayRouteV2[] = [];
  if (!Array.isArray(raw.routes) || raw.routes.length > V2_MAX_PROVIDERS) {
    issues.push({
      path: [...path, 'routes'],
      message: `expected array of at most ${V2_MAX_PROVIDERS} routes`,
    });
  } else {
    routes = raw.routes.map((r, i) =>
      validateGatewayRouteV2(r, [...path, 'routes', i], issues),
    );
  }
  return { routes };
}

// ── Envelope validation ──────────────────────────────────────────────────

function validateEnvelopeKeys(
  raw: Record<string, unknown>,
  path: Array<string | number>,
  issues: V2ValidationIssue[],
): void {
  strictKeys(
    raw,
    [
      'schema', 'schemaVersion', 'rendererVersion', 'releaseId',
      'releaseVersion', 'releaseFingerprint', 'materializationFingerprint',
      'generatedAt', 'tenantId', 'payload',
    ],
    path,
    issues,
  );
}

/**
 * Validate an arbitrary object as a RuntimeEnvelopeV2.
 * Throws `RuntimeContractV2ValidationError` on any schema violation.
 */
export function validateEnvelope(envelope: unknown): RuntimeEnvelopeV2 {
  const issues: V2ValidationIssue[] = [];
  const path: Array<string | number> = [];
  const raw = asObject(envelope, path, issues);
  validateEnvelopeKeys(raw, path, issues);

  if (typeof raw.schema !== 'string' || (raw.schema !== 'agent' && raw.schema !== 'gateway')) {
    issues.push({ path: [...path, 'schema'], message: 'expected "agent" or "gateway"' });
  }
  if (raw.schemaVersion !== 2) {
    issues.push({ path: [...path, 'schemaVersion'], message: 'expected 2' });
  }
  if (typeof raw.rendererVersion !== 'number' || !Number.isSafeInteger(raw.rendererVersion) || raw.rendererVersion < 1) {
    issues.push({ path: [...path, 'rendererVersion'], message: 'expected positive safe integer' });
  }
  asString(raw.releaseId, [...path, 'releaseId'], issues, 128);
  if (typeof raw.releaseVersion !== 'number' || !Number.isSafeInteger(raw.releaseVersion) || raw.releaseVersion < 1) {
    issues.push({ path: [...path, 'releaseVersion'], message: 'expected positive safe integer' });
  }
  asString(raw.releaseFingerprint, [...path, 'releaseFingerprint'], issues, 128);
  asString(raw.materializationFingerprint, [...path, 'materializationFingerprint'], issues, 128);
  if (typeof raw.generatedAt !== 'string' || raw.generatedAt.length < 1) {
    issues.push({ path: [...path, 'generatedAt'], message: 'expected ISO 8601 string' });
  }
  if (raw.tenantId !== null && raw.tenantId !== undefined) {
    asString(raw.tenantId, [...path, 'tenantId'], issues, 128);
  }

  // Validate payload based on schema tag.
  if (raw.schema === 'agent') {
    validateAgentRuntimePayloadV2(raw.payload, [...path, 'payload'], issues);
  } else if (raw.schema === 'gateway') {
    validateGatewayRuntimePayloadV2(raw.payload, [...path, 'payload'], issues);
  } else {
    // Already reported above; still validate as a generic object to collect nested issues.
    asObject(raw.payload, [...path, 'payload'], issues);
  }

  if (issues.length) {
    throw new RuntimeContractV2ValidationError(issues);
  }
  return raw as unknown as RuntimeEnvelopeV2;
}
