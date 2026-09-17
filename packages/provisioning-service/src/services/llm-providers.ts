/**
 * Centrally-managed LLM provider library for tenant agents.
 *
 * The admin console maintains ONE global provider library as a runtime_configs
 * row (tenant_id NULL, key = LLM_PROVIDERS, encrypted): providers with
 * baseUrl + apiKey + model list plus a global default model. Individual
 * tenants do NOT get their own copy — instead each tenant may store a model
 * SELECTION (key = LLM_MODEL_SELECTION, tenant scope): a
 * '<provider>/<modelId>' reference into the global library. At push time the
 * effective blob (global providers + tenant-selection-or-global default) is
 * materialised into the tenant-config Secret (envFrom), and the agent's
 * write-config.mjs turns it into OpenClaw `models.providers` entries at boot.
 *
 * There is no built-in fallback provider any more: with an empty library the
 * agent boots without any model configured (conversations fail until an
 * admin adds providers and sets a default).
 *
 * Because model-provider credentials are consumed at boot (not from the hot
 * .env), changing the library or a selection requires writing the
 * tenant-config Secret followed by a rolling restart of the agent Deployment
 * — see pushLlmProviders().
 */

import type pg from 'pg';
import { decryptValue } from './crypto.js';
import {
  getSecret,
  putSecret,
  restartDeployment,
  deploymentExists,
  patchDeploymentEnvFromSecret,
} from './k8s-client.js';
import { ENV_FROM_ONLY_KEYS } from './skill-env.js';
import {
  renderAgentEnvelope,
  renderGatewayPayload,
} from './runtime-contract-v2.js';
import type { ProvisioningConfig } from '../config.js';

/** runtime_configs key holding the global provider JSON library. */
export const LLM_PROVIDERS_KEY = 'LLM_PROVIDERS';
/** runtime_configs key (tenant scope) holding a tenant's model selection. */
export const LLM_MODEL_SELECTION_KEY = 'LLM_MODEL_SELECTION';
/** tenant-config Secret key holding the V2 agent runtime envelope JSON. */
export const LLM_RUNTIME_CONFIG_V2_KEY = 'LLM_RUNTIME_CONFIG_V2';
/** tenant-config Secret key controlling which contract path the agent runs. */
export const LLM_RUNTIME_CONTRACT_MODE_KEY = 'LLM_RUNTIME_CONTRACT_MODE';
/** llm-proxy-config Secret key holding the V2 gateway routes JSON. */
export const LLM_RUNTIME_ROUTES_V2_KEY = 'LLM_RUNTIME_ROUTES_V2';

export interface LlmModelSpec {
  id: string;
  displayName?: string;
  modelType?: 'chat' | 'embedding' | 'rerank' | 'image-generation' | 'image-edit' | 'speech' | 'transcription' | 'audio-generation' | 'video-generation' | 'multimodal-embedding' | 'unknown';
  protocol?: 'openai-completions';
  contextWindow?: number;
  maxOutputTokens?: number;
  inputModalities?: Array<'text' | 'image' | 'audio' | 'video'>;
  reasoning?: boolean;
  /** True marks the model as vision-capable (accepts image input). */
  vision?: boolean;
  compat?: Record<string, boolean | string | number>;
}

export interface LlmProviderSpec {
  /** Provider id used by OpenClaw (`<name>/<model>` refs) and env-var derivation. */
  name: string;
  label?: string;
  baseUrl: string;
  apiKey: string;
  models: LlmModelSpec[];
}

export interface LlmProvidersConfig {
  providers: LlmProviderSpec[];
  /** '<providerName>/<modelId>' — becomes the agent's primary model. */
  defaultModel: string | null;
  /** '<providerName>/<modelId>' — the agent's image-understanding (vision) model. */
  imageModel: string | null;
  /**
   * '<providerName>/<modelId>' — the SYSTEM-DEFAULT compaction (context
   * summarisation) model. null → compaction follows each tenant's primary
   * model. Compaction prompts are long-context, so pointing this at a
   * fast-TTFB model fleet-wide avoids safeguard timeouts on slow primaries
   * (see the 2026-09-01 foldin incident).
   */
  compactionModel: string | null;
  /**
   * Ordered '<providerName>/<modelId>' fallback chain baked into the agent's
   * `agents.defaults.model.fallbacks` (OpenClaw model failover). When the
   * primary model fails over-worthy (timeout / rate limit / auth failure /
   * provider outage), OpenClaw retries with the next candidate in order;
   * the chain is turn-local — the next turn returns to the primary. Entries
   * may cross providers. Empty = no fallback.
   */
  fallbackModels: string[];
}

/** A tenant's model selection: primary + image model refs into the library. */
export interface TenantModelSelection {
  defaultModel: string | null;
  imageModel: string | null;
  /**
   * '<provider>/<modelId>' ref the agent's context-compaction (history
   * summarisation) runs on. null → follow the effective primary model
   * (default). Useful when the primary is a slow heavyweight model — the
   * compaction prompt is long-context and benefits from a faster TTFB model.
   */
  compactionModel: string | null;
  /**
   * Tenant-scoped override of the fallback chain. null → follow the global
   * library chain; an array (possibly empty) → the tenant's own ordered
   * '<provider>/<modelId>' chain (empty = never fall back). Unresolvable
   * entries are dropped at resolve time, mirroring the global chain's
   * fail-open semantics.
   */
  fallbackModels: string[] | null;
  /**
   * True → configure the REAL upstream baseUrl + apiKey directly into the
   * agent's OpenClaw config, bypassing the nexus-gateway LLM egress proxy
   * (and its value-added interceptions). False (default) → baseUrl is
   * rewritten to the tenant's nexus-gateway proxy, so balance checks /
   * accounting stay active. Used to A/B-isolate gateway-induced latency.
   */
  directMode: boolean;
  /**
   * Controls which runtime contract path the agent + gateway run:
   *  - 'v1'     → use only the legacy V1 payload (default, safest).
   *  - 'shadow' → dual-read V2 alongside V1 for comparison (no behavioral change).
   *  - 'v2'    → fully switch to the V2 runtime contract payload.
   * Defaults to 'v1' when the field is absent in the stored JSON blob.
   */
  runtimeContractMode: 'v1' | 'shadow' | 'v2';
}

const NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const MODEL_ID_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const MAX_PROVIDERS = 10;
const MAX_MODELS = 20;
const MAX_FALLBACK_MODELS = 5;

export class LlmProvidersError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmProvidersError';
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Validate and normalise the provider document coming from the admin UI.
 * Throws LlmProvidersError with a user-readable Chinese message on problems.
 */
export function validateLlmProviders(input: unknown): LlmProvidersConfig {
  if (typeof input !== 'object' || input === null) {
    throw new LlmProvidersError('请求体不合法');
  }
  const raw = input as Record<string, unknown>;
  const providersRaw = raw.providers;
  if (!Array.isArray(providersRaw)) {
    throw new LlmProvidersError('providers 必须是数组');
  }
  if (providersRaw.length > MAX_PROVIDERS) {
    throw new LlmProvidersError(`最多支持 ${MAX_PROVIDERS} 个提供商`);
  }

  const seenNames = new Set<string>();
  const providers: LlmProviderSpec[] = [];
  for (const p of providersRaw) {
    if (typeof p !== 'object' || p === null) {
      throw new LlmProvidersError('提供商条目不合法');
    }
    const item = p as Record<string, unknown>;
    const name = str(item.name);
    if (!NAME_PATTERN.test(name)) {
      throw new LlmProvidersError(
        `提供商 ID「${name || '(空)'}」不合法：小写字母开头，仅含小写字母/数字/_/-，最长 32 位`,
      );
    }
    if (seenNames.has(name)) {
      throw new LlmProvidersError(`提供商 ID 重复：${name}`);
    }
    seenNames.add(name);

    const baseUrl = str(item.baseUrl).replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s]+$/.test(baseUrl)) {
      throw new LlmProvidersError(`提供商 ${name} 的 Base URL 不合法（需 http(s):// 开头）`);
    }
    const apiKey = typeof item.apiKey === 'string' ? item.apiKey : '';
    if (!apiKey || apiKey.length > 1024) {
      throw new LlmProvidersError(`提供商 ${name} 缺少 API Key`);
    }
    const modelsRaw = item.models;
    if (!Array.isArray(modelsRaw) || modelsRaw.length === 0) {
      throw new LlmProvidersError(`提供商 ${name} 至少需要 1 个模型`);
    }
    if (modelsRaw.length > MAX_MODELS) {
      throw new LlmProvidersError(`提供商 ${name} 的模型数超过上限 ${MAX_MODELS}`);
    }
    const seenModels = new Set<string>();
    const models: LlmModelSpec[] = [];
    for (const m of modelsRaw) {
      if (typeof m === 'string') {
        if (!MODEL_ID_PATTERN.test(m)) throw new LlmProvidersError(`模型 ID「${m}」不合法`);
        if (seenModels.has(m)) throw new LlmProvidersError(`提供商 ${name} 模型重复：${m}`);
        seenModels.add(m);
        models.push({ id: m });
      } else if (typeof m === 'object' && m !== null) {
        const spec = m as Record<string, unknown>;
        const id = str(spec.id);
        if (!MODEL_ID_PATTERN.test(id)) throw new LlmProvidersError(`模型 ID「${id || '(空)'}」不合法`);
        if (seenModels.has(id)) throw new LlmProvidersError(`提供商 ${name} 模型重复：${id}`);
        seenModels.add(id);
        const positiveInt = (value: unknown): number | undefined =>
          typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
        const modalities = Array.isArray(spec.inputModalities)
          ? spec.inputModalities.filter((value): value is 'text' | 'image' | 'audio' | 'video' =>
              value === 'text' || value === 'image' || value === 'audio' || value === 'video')
          : undefined;
        const modelType = typeof spec.modelType === 'string' ? spec.modelType as LlmModelSpec['modelType'] : undefined;
        const allowedTypes = new Set(['chat', 'embedding', 'rerank', 'image-generation', 'image-edit', 'speech', 'transcription', 'audio-generation', 'video-generation', 'multimodal-embedding', 'unknown']);
        if (modelType !== undefined && !allowedTypes.has(modelType)) throw new LlmProvidersError(`模型 ${id} 的 modelType 不合法`);
        if (spec.protocol !== undefined && spec.protocol !== 'openai-completions') throw new LlmProvidersError(`模型 ${id} 的 protocol 不受支持`);
        models.push({
          id,
          ...(str(spec.displayName) ? { displayName: str(spec.displayName).slice(0, 128) } : {}),
          ...(modelType ? { modelType } : {}),
          ...(spec.protocol === 'openai-completions' ? { protocol: spec.protocol } : {}),
          ...(positiveInt(spec.contextWindow) ? { contextWindow: positiveInt(spec.contextWindow) } : {}),
          ...(positiveInt(spec.maxOutputTokens) ? { maxOutputTokens: positiveInt(spec.maxOutputTokens) } : {}),
          ...(modalities && modalities.length > 0 ? { inputModalities: [...new Set(modalities)] } : {}),
          ...(spec.reasoning === true ? { reasoning: true } : {}),
          ...(spec.vision === true ? { vision: true } : {}),
          ...(spec.compat && typeof spec.compat === 'object' && !Array.isArray(spec.compat)
            ? { compat: Object.fromEntries(Object.entries(spec.compat).filter(([, value]) => ['boolean', 'string', 'number'].includes(typeof value))) as Record<string, boolean | string | number> }
            : {}),
        });
      } else {
        throw new LlmProvidersError(`提供商 ${name} 的模型条目不合法`);
      }
    }
    providers.push({
      name,
      ...(str(item.label) ? { label: str(item.label).slice(0, 64) } : {}),
      baseUrl,
      apiKey,
      models,
    });
  }

  const defaultModel = str(raw.defaultModel) || null;
  if (defaultModel) {
    const [pName, ...rest] = defaultModel.split('/');
    const modelId = rest.join('/');
    const provider = providers.find((p) => p.name === pName);
    const model = provider?.models.find((m) => m.id === modelId);
    if (!model) {
      throw new LlmProvidersError(`默认模型 ${defaultModel} 不在已配置的提供商/模型列表中`);
    }
    if ((model.modelType && model.modelType !== 'chat') || (model.protocol && model.protocol !== 'openai-completions')) {
      throw new LlmProvidersError(`默认模型 ${defaultModel} 不是兼容的 chat 模型`);
    }
  }

  const imageModel = str(raw.imageModel) || null;
  if (imageModel) {
    const [pName, ...rest] = imageModel.split('/');
    const modelId = rest.join('/');
    const provider = providers.find((p) => p.name === pName);
    const model = provider?.models.find((m) => m.id === modelId);
    if (!model) {
      throw new LlmProvidersError(`视觉模型 ${imageModel} 不在已配置的提供商/模型列表中`);
    }
    if (model.vision !== true) {
      throw new LlmProvidersError(`视觉模型 ${imageModel} 未标记为视觉模型（请在模型列表里为它加 :vision 后缀）`);
    }
  }

  const compactionModel = str(raw.compactionModel) || null;
  if (compactionModel) {
    const [pName, ...rest] = compactionModel.split('/');
    const modelId = rest.join('/');
    const provider = providers.find((p) => p.name === pName);
    if (!provider || !provider.models.some((m) => m.id === modelId)) {
      throw new LlmProvidersError(`压缩模型 ${compactionModel} 不在已配置的提供商/模型列表中`);
    }
  }

  const fallbackModels: string[] = [];
  const fallbacksRaw = raw.fallbackModels;
  if (fallbacksRaw !== undefined && fallbacksRaw !== null) {
    if (!Array.isArray(fallbacksRaw)) {
      throw new LlmProvidersError('fallbackModels 必须是数组');
    }
    if (fallbacksRaw.length > MAX_FALLBACK_MODELS) {
      throw new LlmProvidersError(`备用模型最多 ${MAX_FALLBACK_MODELS} 个`);
    }
    for (const f of fallbacksRaw) {
      const ref = str(f);
      if (!ref) continue;
      if (!modelExistsIn({ providers, defaultModel, imageModel, compactionModel, fallbackModels }, ref)) {
        throw new LlmProvidersError(`备用模型 ${ref} 不在已配置的提供商/模型列表中`);
      }
      const [providerName, ...modelParts] = ref.split('/');
      const fallbackModel = providers.find((provider) => provider.name === providerName)
        ?.models.find((model) => model.id === modelParts.join('/'));
      if ((fallbackModel?.modelType && fallbackModel.modelType !== 'chat') ||
          (fallbackModel?.protocol && fallbackModel.protocol !== 'openai-completions')) {
        throw new LlmProvidersError(`备用模型 ${ref} 不是兼容的 chat 模型`);
      }
      if (defaultModel && ref === defaultModel) {
        throw new LlmProvidersError(`备用模型 ${ref} 与默认模型相同（备用链不应包含主模型）`);
      }
      if (fallbackModels.includes(ref)) continue; // 去重
      fallbackModels.push(ref);
    }
  }

  return { providers, defaultModel, imageModel, compactionModel, fallbackModels };
}

/** True when '<provider>/<modelId>' exists in the given provider doc. */
export function modelExistsIn(doc: LlmProvidersConfig, ref: string): boolean {
  const [pName, ...rest] = ref.split('/');
  const modelId = rest.join('/');
  if (!pName || !modelId) return false;
  const provider = doc.providers.find((p) => p.name === pName);
  return !!provider && provider.models.some((m) => m.id === modelId);
}

/** True when '<provider>/<modelId>' resolves AND is marked vision-capable. */
export function visionModelExistsIn(doc: LlmProvidersConfig, ref: string): boolean {
  const [pName, ...rest] = ref.split('/');
  const modelId = rest.join('/');
  if (!pName || !modelId) return false;
  const provider = doc.providers.find((p) => p.name === pName);
  return !!provider && provider.models.some((m) => m.id === modelId && m.vision === true);
}

/**
 * The model ref a tenant would actually use under a given library:
 * a resolvable tenant selection wins, otherwise the library's global default.
 */
export function effectiveRefIn(
  doc: LlmProvidersConfig | null,
  selection: string | null,
): string | null {
  if (!doc) return null;
  if (selection && modelExistsIn(doc, selection)) return selection;
  return doc.defaultModel ?? null;
}

/**
 * The image model ref a tenant would actually use: a resolvable tenant image
 * selection wins, otherwise the library's global imageModel. Falls back to
 * null when nothing is configured (no vision model → image tools disabled).
 */
export function effectiveImageRefIn(
  doc: LlmProvidersConfig | null,
  imageSelection: string | null,
): string | null {
  if (!doc) return null;
  if (imageSelection && visionModelExistsIn(doc, imageSelection)) return imageSelection;
  if (doc.imageModel && visionModelExistsIn(doc, doc.imageModel)) return doc.imageModel;
  return null;
}

/**
 * The compaction model ref a tenant would actually use, WITHOUT the final
 * fallback to the primary: a resolvable tenant selection wins, otherwise the
 * library's global compactionModel. null → the caller falls back to the
 * effective primary (compaction follows the primary by default).
 */
export function effectiveCompactionRefIn(
  doc: LlmProvidersConfig | null,
  compactionSelection: string | null,
): string | null {
  if (!doc) return null;
  if (compactionSelection && modelExistsIn(doc, compactionSelection)) return compactionSelection;
  if (doc.compactionModel && modelExistsIn(doc, doc.compactionModel)) return doc.compactionModel;
  return null;
}

/**
 * The effective fallback chain for a tenant: the library's fallbackModels
 * filtered down to entries that still resolve into the library, minus the
 * tenant's effective primary (OpenClaw failover starts from the primary —
 * a candidate equal to it would be a no-op retry of the same model).
 */
export function effectiveFallbacksIn(
  doc: LlmProvidersConfig | null,
  selection: string | null,
): string[] {
  if (!doc || doc.fallbackModels.length === 0) return [];
  const primary = effectiveRefIn(doc, selection);
  return doc.fallbackModels.filter((ref) => ref !== primary && modelExistsIn(doc, ref));
}

/**
 * The effective fallback chain for a tenant WITH its own override applied:
 * selection.fallbackModels (when set) wins over the library chain, then the
 * same filtering as effectiveFallbacksIn applies — drop the tenant's
 * effective primary and entries that no longer resolve into the library.
 */
export function effectiveFallbacksFor(
  doc: LlmProvidersConfig | null,
  selection: TenantModelSelection | null,
): string[] {
  if (!doc) return [];
  const primary = effectiveRefIn(doc, selection?.defaultModel ?? null);
  const chain = selection?.fallbackModels ?? doc.fallbackModels;
  return chain.filter((ref) => ref !== primary && modelExistsIn(doc, ref));
}

/**
 * Credential signature of the provider backing a model ref (baseUrl + apiKey).
 * Models are deliberately excluded: adding a model to a provider does not
 * invalidate the currently-running config of tenants not using that model.
 */
export function providerCredentialSignature(
  doc: LlmProvidersConfig | null,
  ref: string | null,
): string | null {
  if (!doc || !ref) return null;
  const pName = ref.slice(0, ref.indexOf('/'));
  const provider = doc.providers.find((p) => p.name === pName);
  if (!provider) return null;
  return `${provider.baseUrl}|${provider.apiKey}`;
}

/**
 * Spec signature of the model backing a model ref (id + reasoning/vision
 * flags). Unlike providerCredentialSignature, this DOES include the model
 * itself — a tenant whose effective model is edited in place (e.g. reasoning
 * flipped on) must restart to re-materialize the change.
 */
export function modelSpecSignature(
  doc: LlmProvidersConfig | null,
  ref: string | null,
): string | null {
  if (!doc || !ref) return null;
  const pName = ref.slice(0, ref.indexOf('/'));
  const modelId = ref.slice(ref.indexOf('/') + 1);
  const provider = doc.providers.find((p) => p.name === pName);
  if (!provider) return null;
  const model = provider.models.find((m) => m.id === modelId);
  if (!model) return null;
  const compat = model.compat
    ? Object.fromEntries(Object.entries(model.compat).sort(([left], [right]) => left.localeCompare(right)))
    : undefined;
  return JSON.stringify({
    protocol: model.protocol ?? 'openai-completions',
    id: model.id,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    inputModalities: model.inputModalities ? [...model.inputModalities].sort() : undefined,
    reasoning: model.reasoning === true,
    vision: model.vision === true,
    compat,
  });
}

/** Detailed restart analysis with human/machine-readable reason codes. */
export interface RestartAnalysis {
  restart: boolean;
  reasons: string[];
}

/**
 * Detailed version of tenantNeedsLlmRestart that also returns the list of
 * reason codes explaining WHY a restart is needed. The reason codes are
 * stable identifiers (not user-facing strings) suitable for the impact
 * manifest:
 *
 *   default_model_ref_changed        — effective primary model ref changed
 *   default_model_credential_changed — same ref, provider baseUrl/apiKey changed
 *   default_model_spec_changed       — same ref, in-place model spec edited
 *   image_model_ref_changed          — effective image model ref changed
 *   image_model_spec_changed         — same ref, in-place model spec edited
 *   image_model_credential_changed   — same ref, provider credentials changed
 *   compaction_model_ref_changed     — effective compaction model ref changed
 *   compaction_model_spec_changed    — same ref, in-place model spec edited
 *   compaction_model_credential_changed — same ref, provider credentials changed
 *   fallback_chain_changed           — fallback chain membership/order changed
 *   fallback_model_credential_changed — credential behind a fallback model changed
 *   fallback_model_spec_changed      — in-place spec of a fallback model changed
 */
export function analyzeTenantLlmRestart(
  prev: LlmProvidersConfig | null,
  now: LlmProvidersConfig | null,
  selection: TenantModelSelection | null,
): RestartAnalysis {
  const reasons: string[] = [];
  const selDefault = selection?.defaultModel ?? null;
  const selImage = selection?.imageModel ?? null;
  const selCompaction = selection?.compactionModel ?? null;

  // ── Default (primary) model ──
  const beforeRef = effectiveRefIn(prev, selDefault);
  const afterRef = effectiveRefIn(now, selDefault);
  if (beforeRef !== afterRef) {
    reasons.push('default_model_ref_changed');
  } else {
    if (
      providerCredentialSignature(prev, beforeRef) !==
      providerCredentialSignature(now, afterRef)
    ) {
      reasons.push('default_model_credential_changed');
    }
    if (modelSpecSignature(prev, beforeRef) !== modelSpecSignature(now, afterRef)) {
      reasons.push('default_model_spec_changed');
    }
  }

  // ── Image (vision) model ──
  const beforeImage = effectiveImageRefIn(prev, selImage);
  const afterImage = effectiveImageRefIn(now, selImage);
  if (beforeImage !== afterImage) {
    reasons.push('image_model_ref_changed');
  } else {
    if (modelSpecSignature(prev, beforeImage) !== modelSpecSignature(now, afterImage)) {
      reasons.push('image_model_spec_changed');
    }
    if (
      providerCredentialSignature(prev, beforeImage) !==
      providerCredentialSignature(now, afterImage)
    ) {
      reasons.push('image_model_credential_changed');
    }
  }

  // ── Compaction model (tenant override → global → primary fallback) ──
  const beforeCompaction = effectiveCompactionRefIn(prev, selCompaction)
    ?? effectiveRefIn(prev, selDefault);
  const afterCompaction = effectiveCompactionRefIn(now, selCompaction)
    ?? effectiveRefIn(now, selDefault);
  if (beforeCompaction !== afterCompaction) {
    reasons.push('compaction_model_ref_changed');
  } else {
    if (
      modelSpecSignature(prev, beforeCompaction) !==
      modelSpecSignature(now, afterCompaction)
    ) {
      reasons.push('compaction_model_spec_changed');
    }
    if (
      providerCredentialSignature(prev, beforeCompaction) !==
      providerCredentialSignature(now, afterCompaction)
    ) {
      reasons.push('compaction_model_credential_changed');
    }
  }

  // ── Fallback chain (tenant override-aware) ──
  const beforeFallbacks = effectiveFallbacksFor(prev, selection);
  const afterFallbacks = effectiveFallbacksFor(now, selection);
  if (JSON.stringify(beforeFallbacks) !== JSON.stringify(afterFallbacks)) {
    reasons.push('fallback_chain_changed');
  } else {
    for (const ref of afterFallbacks) {
      if (providerCredentialSignature(now, ref) !== providerCredentialSignature(prev, ref)) {
        reasons.push('fallback_model_credential_changed');
        break;
      }
      if (modelSpecSignature(now, ref) !== modelSpecSignature(prev, ref)) {
        reasons.push('fallback_model_spec_changed');
        break;
      }
    }
  }

  return { restart: reasons.length > 0, reasons };
}

/**
 * True when a library change actually affects a tenant: its effective model
 * changed (selection no longer resolves / default switched / provider removed),
 * its effective image model changed, or the credentials behind either model
 * changed. Adding an unrelated provider or model does NOT require a restart —
 * the tenant's live config is untouched.
 *
 * This is a thin wrapper around {@link analyzeTenantLlmRestart} that preserves
 * the original boolean return type for backward compatibility with existing
 * callers (e.g. applyTenantLlmConfig).
 */
export function tenantNeedsLlmRestart(
  prev: LlmProvidersConfig | null,
  now: LlmProvidersConfig | null,
  selection: TenantModelSelection | null,
): boolean {
  return analyzeTenantLlmRestart(prev, now, selection).restart;
}

/**
 * The global provider library (decrypted + re-validated). Returns null when
 * no row exists or the stored data is corrupt — callers treat both as
 * "library empty".
 */
export async function getGlobalLlmProviders(
  pool: pg.Pool,
): Promise<LlmProvidersConfig | null> {
  const { rows } = await pool.query(
    `SELECT encrypted_value FROM runtime_configs WHERE tenant_id IS NULL AND config_key = $1`,
    [LLM_PROVIDERS_KEY],
  );
  if (!rows.length) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decryptValue(rows[0].encrypted_value));
  } catch {
    return null;
  }
  try {
    return validateLlmProviders(parsed);
  } catch {
    return null;
  }
}

/**
 * A tenant's model selection: { defaultModel, imageModel } — each a
 * '<provider>/<modelId>' ref or null (follow the global default). A selection
 * that no longer resolves into the library (provider removed) is ignored —
 * the tenant falls back to the global default instead of failing.
 */
export async function getTenantModelSelection(
  pool: pg.Pool,
  tenantId: string,
): Promise<TenantModelSelection | null> {
  const { rows } = await pool.query(
    `SELECT encrypted_value FROM runtime_configs WHERE tenant_id = $1 AND config_key = $2`,
    [tenantId, LLM_MODEL_SELECTION_KEY],
  );
  if (!rows.length) return null;
  try {
    const parsed = JSON.parse(decryptValue(rows[0].encrypted_value));
    // Back-compat: legacy rows only carried defaultModel.
    if (parsed && typeof parsed === 'object' && 'defaultModel' in parsed) {
      const defaultModel =
        typeof parsed.defaultModel === 'string' ? parsed.defaultModel.trim() || null : null;
      const imageModel =
        typeof parsed.imageModel === 'string' ? parsed.imageModel.trim() || null : null;
      const compactionModel =
        typeof parsed.compactionModel === 'string' ? parsed.compactionModel.trim() || null : null;
      const directMode = parsed.directMode === true;
      // Per-tenant runtime contract mode: 'v1' (default), 'shadow', or 'v2'.
      // Unknown / missing values default to 'v1' for backward compatibility.
      const runtimeContractMode =
        parsed.runtimeContractMode === 'shadow' || parsed.runtimeContractMode === 'v2'
          ? parsed.runtimeContractMode
          : 'v1';
      // Array (even empty) = tenant's own chain; anything else = follow global.
      const fallbackModels = Array.isArray(parsed.fallbackModels)
        ? (parsed.fallbackModels as unknown[])
            .filter((r): r is string => typeof r === 'string' && r.trim() !== '')
            .map((r: string) => r.trim())
        : null;
      return { defaultModel, imageModel, compactionModel, fallbackModels, directMode, runtimeContractMode };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Bulk-read the direct-mode flag for many tenants in one query (used by the
 * agent list view). Returns a tenantId → boolean map; tenants without a
 * selection row (or with a corrupt row) are absent and treated as false.
 */
export async function getTenantDirectModeMap(
  pool: pg.Pool,
  tenantIds: string[],
): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  if (tenantIds.length === 0) return result;
  const { rows } = await pool.query(
    `SELECT tenant_id, encrypted_value FROM runtime_configs
      WHERE config_key = $1 AND tenant_id = ANY($2::text[])`,
    [LLM_MODEL_SELECTION_KEY, tenantIds],
  );
  for (const r of rows) {
    try {
      const parsed = JSON.parse(decryptValue(r.encrypted_value));
      if (parsed && typeof parsed === 'object' && parsed.directMode === true) {
        result.set(r.tenant_id, true);
      }
    } catch {
      // corrupt / undecryptable row → treat as false
    }
  }
  return result;
}

export interface EffectiveLlmProviders {
  /** Global library (null when empty/corrupt). */
  globalConfig: LlmProvidersConfig | null;
  /** Tenant's own primary-model selection, if it resolves into the library. */
  selection: string | null;
  /** Tenant's own image-model selection, if it resolves (vision). */
  imageSelection: string | null;
  /** Tenant's own compaction-model selection, if it resolves. */
  compactionSelection: string | null;
  /** Tenant's own fallback chain override (null = follows the global chain). */
  fallbackSelection: string[] | null;
  /** selection ?? globalConfig.defaultModel ?? null */
  effectiveModel: string | null;
  /** imageSelection ?? globalConfig.imageModel ?? null */
  effectiveImageModel: string | null;
  /** compactionSelection ?? effectiveModel (compaction follows the primary by default). */
  effectiveCompactionModel: string | null;
  /** (fallbackSelection ?? library chain) minus the effective primary, resolvable only. */
  effectiveFallbacks: string[];
  /** Serialised blob to inject as the LLM_PROVIDERS env var, or null. */
  blob: string | null;
}

/**
 * Effective provider doc for a tenant: the GLOBAL library's providers with
 * the default model resolved as tenant-selection → global default → none,
 * and the image model resolved as tenant-image-selection → global imageModel
 * → none. The materialised blob is what write-config.mjs parses at boot.
 */
export async function resolveEffectiveLlmProviders(
  pool: pg.Pool,
  tenantId: string | null,
  libraryOverride?: LlmProvidersConfig | null,
): Promise<EffectiveLlmProviders> {
  const globalConfig =
    libraryOverride !== undefined ? libraryOverride : await getGlobalLlmProviders(pool);
  if (!globalConfig || globalConfig.providers.length === 0) {
    return {
      globalConfig: null,
      selection: null,
      imageSelection: null,
      compactionSelection: null,
      fallbackSelection: null,
      effectiveModel: null,
      effectiveImageModel: null,
      effectiveCompactionModel: null,
      effectiveFallbacks: [],
      blob: null,
    };
  }
  let selection: string | null = null;
  let imageSelection: string | null = null;
  let compactionSelection: string | null = null;
  let sel: TenantModelSelection | null = null;
  if (tenantId) {
    sel = await getTenantModelSelection(pool, tenantId);
    if (sel?.defaultModel && modelExistsIn(globalConfig, sel.defaultModel)) {
      selection = sel.defaultModel;
    }
    if (sel?.imageModel && visionModelExistsIn(globalConfig, sel.imageModel)) {
      imageSelection = sel.imageModel;
    }
    if (sel?.compactionModel && modelExistsIn(globalConfig, sel.compactionModel)) {
      compactionSelection = sel.compactionModel;
    }
  }
  const effectiveModel = selection ?? globalConfig.defaultModel ?? null;
  const effectiveImageModel =
    imageSelection ?? (globalConfig.imageModel && visionModelExistsIn(globalConfig, globalConfig.imageModel)
      ? globalConfig.imageModel
      : null);
  // Compaction: tenant override → global compaction model → the effective
  // primary (compaction prompts are long-context; a faster-TTFB model keeps
  // the safeguard from timing out — the 2026-09-01 foldin incident).
  const effectiveCompactionModel =
    effectiveCompactionRefIn(globalConfig, sel?.compactionModel ?? null) ?? effectiveModel;
  // Tenant override wins over the library chain; both are then filtered to
  // exclude THIS tenant's effective primary (no-op retry) and entries that
  // no longer resolve.
  const fallbackSelection = sel?.fallbackModels ?? null;
  const effectiveFallbacks = effectiveFallbacksFor(globalConfig, sel);
  const blob = JSON.stringify({
    ...globalConfig,
    defaultModel: effectiveModel,
    imageModel: effectiveImageModel,
    compactionModel: effectiveCompactionModel,
    fallbackModels: effectiveFallbacks,
  });
  return {
    globalConfig,
    selection,
    imageSelection,
    compactionSelection,
    fallbackSelection,
    effectiveModel,
    effectiveImageModel,
    effectiveCompactionModel,
    effectiveFallbacks,
    blob,
  };
}

export interface LlmPushResult {
  tenants: Array<{
    tenantId: string;
    ok: boolean;
    restarted: boolean;
    /** gateway rolled so the new upstream map / envFrom took effect */
    gatewayRestarted?: boolean;
    error?: string;
  }>;
  hint: string;
}

/** LLM egress proxy route prefix the rewritten provider baseUrl points at. */
export function llmProxyBaseUrl(tenantId: string, providerName: string): string {
  // Same-namespace short name — the agent and its gateway share the
  // tenant's namespace, so plain service DNS resolution applies.
  return `http://nexus-gateway-${tenantId}:8080/v1/llm/${providerName}`;
}

/** Name of the per-tenant Secret holding the LLM_UPSTREAMS map. */
export const LLM_PROXY_CONFIG_SECRET = 'llm-proxy-config';

/**
 * Materialise the current effective LLM_PROVIDERS blob into every affected
 * tenant's tenant-config Secret (envFrom) and roll the agent so the new
 * providers are picked up at boot. Global writes target all live tenants;
 * tenant-scoped writes target just that tenant.
 *
 * The rolling restart is DIFFERENTIAL: when `prevLibrary` is supplied (global
 * library writes), a tenant is only restarted if its effective model changed
 * or the credentials behind that model changed. Tenants whose live model is
 * untouched still get their Secret materialised (cheap, invisible — keeps the
 * snapshot fresh so a future selection resolves immediately, and preserves
 * the idempotent self-healing passes), but their agent/gateway are NOT rolled.
 *
 * Key rotation here is NOT hot: envFrom values only apply on pod start, so
 * each affected agent is rolling-restarted (restartDeployment).
 */
export interface TenantPushOutcome {
  tenantId: string;
  ok: boolean;
  /** True when no work was done (dry-run / tenant without a namespace). */
  skipped: boolean;
  restarted: boolean;
  gatewayRestarted: boolean;
  /** True when the Secret was materialised but no restart was needed (差分). */
  skipRestart: boolean;
  error?: string;
  /** Non-fatal V2 dual-render warning (V1 still delivered). */
  v2Warning?: string;
}

/**
 * Materialise ONE tenant's effective LLM_PROVIDERS blob into its Secrets and
 * (differentially) roll its agent + gateway. The pure, reusable core shared
 * by the synchronous selection path (pushLlmProviders) and the asynchronous
 * worker (services/llm-push-task.ts).
 *
 * `nowLibrary` / `prevLibrary` are passed explicitly so the async worker can
 * feed its encrypted task snapshot without re-reading the live global row;
 * the synchronous path passes the just-read library. `scope !== null` (a
 * tenant-scoped selection write) always rolls that tenant.
 */
export async function applyTenantLlmConfig(
  pool: pg.Pool,
  config: ProvisioningConfig,
  tenantId: string,
  nowLibrary: LlmProvidersConfig | null,
  prevLibrary: LlmProvidersConfig | null,
  scope: string | null,
): Promise<TenantPushOutcome> {
  try {
    if (config.k8sDryRun) {
      return { tenantId, ok: true, skipped: true, restarted: false, gatewayRestarted: false, skipRestart: false };
    }
    const { rows: tenantRows } = await pool.query(
      `SELECT k8s_namespace FROM tenants WHERE tenant_id = $1`,
      [tenantId],
    );
    const namespace = tenantRows[0]?.k8s_namespace;
    if (!namespace) {
      return { tenantId, ok: true, skipped: true, restarted: false, gatewayRestarted: false, skipRestart: false };
    }

    // Effective blob = provided library snapshot + this tenant's selection.
    const { globalConfig, blob } = await resolveEffectiveLlmProviders(pool, tenantId, nowLibrary);
    const rawSelection = await getTenantModelSelection(pool, tenantId);
    const directMode = rawSelection?.directMode === true;
    // Per-tenant runtime contract mode: read from the selection, default 'v1'.
    const contractMode = rawSelection?.runtimeContractMode ?? 'v1';

    // Differential roll: tenant-scoped writes always roll (their selection
    // just changed); global writes only roll when the tenant's live model
    // or its provider credentials actually changed.
    const needsRestart =
      scope !== null ||
      tenantNeedsLlmRestart(prevLibrary, globalConfig, rawSelection);

    // Proxy mode (default): rewrite each provider's baseUrl to the tenant's
    // LLM egress proxy (nexus-gateway /v1/llm/<name>). The REAL baseUrl
    // moves into the llm-proxy-config Secret the gateway reads via envFrom.
    const upstreams: Record<string, string> = {};
    let proxyBlob: string | null = null;
    if (globalConfig && blob) {
      const doc = JSON.parse(blob) as LlmProvidersConfig;
      if (directMode) {
        proxyBlob = blob; // keep real baseUrl + apiKey
        for (const p of doc.providers) upstreams[p.name] = p.baseUrl;
      } else {
        doc.providers = doc.providers.map((p) => {
          upstreams[p.name] = p.baseUrl;
          return { ...p, baseUrl: llmProxyBaseUrl(tenantId, p.name) };
        });
        proxyBlob = JSON.stringify(doc);
      }
    }

    // tenant-config: keep only envFrom-only keys, then set or drop
    // LLM_PROVIDERS (rewritten to proxy URLs) according to the config.
    const next: Record<string, string> = {};
    const existing = await getSecret(namespace, 'tenant-config');
    if (existing) {
      for (const [k, v] of Object.entries(existing.data)) {
        if (!ENV_FROM_ONLY_KEYS.has(k)) continue;
        try {
          next[k] = Buffer.from(v, 'base64').toString('utf8');
        } catch {
          next[k] = v;
        }
      }
    }
    if (proxyBlob) next[LLM_PROVIDERS_KEY] = proxyBlob;
    else delete next[LLM_PROVIDERS_KEY];

    // ── V2 dual-render (shadow mode) ────────────────────────────────────
    // Render V2 payloads alongside V1 and write them into the same Secrets.
    // V2 failures do NOT block V1 delivery — the agent can still boot from
    // the V1 blob. A V2 warning is recorded but the task stays 'delivered'.
    // Build release provenance for V2 envelopes. The real release
    // id/fingerprint come from the push task; here we use synthetic values
    // since the shadow-mode writer runs inside applyTenantLlmConfig and
    // doesn't have direct access to the release record.
    const releaseProvenance = {
      id: 'shadow',
      version: 0,
      fingerprint: 'shadow',
    };
    let v2Warning: string | null = null;
    if (globalConfig && blob) {
      try {
        const effectiveDoc = JSON.parse(blob) as LlmProvidersConfig;
        const agentEnvelope = renderAgentEnvelope(
          effectiveDoc,
          rawSelection,
          releaseProvenance,
          tenantId,
        );
        next[LLM_RUNTIME_CONFIG_V2_KEY] = JSON.stringify(agentEnvelope);
        next[LLM_RUNTIME_CONTRACT_MODE_KEY] = contractMode;
      } catch (v2err) {
        v2Warning = `V2 agent render failed: ${v2err instanceof Error ? v2err.message : String(v2err)}`;
        // Leave existing V2 keys untouched — don't delete on failure.
      }
    } else {
      // No library → empty V2 payload, keep mode as contractMode.
      next[LLM_RUNTIME_CONFIG_V2_KEY] = '{}';
      next[LLM_RUNTIME_CONTRACT_MODE_KEY] = contractMode;
    }
    await putSecret(namespace, 'tenant-config', next);

    // llm-proxy-config: the gateway's providerName → real baseUrl map.
    const proxySecretData: Record<string, string> = {
      LLM_UPSTREAMS: JSON.stringify(upstreams),
    };
    // Gap 1: Write the runtime contract mode to llm-proxy-config so the
    // gateway (which reads env vars via envFrom from this Secret) can see
    // it. Without this, the gateway always defaults to 'v1'.
    proxySecretData[LLM_RUNTIME_CONTRACT_MODE_KEY] = contractMode;
    // V2 gateway routes — only in proxy mode (not directMode).
    if (!directMode && globalConfig && blob) {
      try {
        const effectiveDoc = JSON.parse(blob) as LlmProvidersConfig;
        const gatewayPayload = renderGatewayPayload(effectiveDoc);
        // Include releaseId as a top-level field in the V2 routes JSON so
        // the gateway can attach it to stable usage attribution (Step 8).
        proxySecretData[LLM_RUNTIME_ROUTES_V2_KEY] = JSON.stringify({
          ...gatewayPayload,
          releaseId: releaseProvenance.id,
        });
      } catch (v2err) {
        if (!v2Warning) {
          v2Warning = `V2 gateway render failed: ${v2err instanceof Error ? v2err.message : String(v2err)}`;
        }
        proxySecretData[LLM_RUNTIME_ROUTES_V2_KEY] = '{}';
      }
    } else if (directMode) {
      // directMode: do NOT write gateway V2 (agent bypasses the gateway).
      proxySecretData[LLM_RUNTIME_ROUTES_V2_KEY] = '{}';
    } else {
      // No library → empty V2 routes placeholder.
      proxySecretData[LLM_RUNTIME_ROUTES_V2_KEY] = '{}';
    }
    await putSecret(namespace, LLM_PROXY_CONFIG_SECRET, proxySecretData);

    // 存量网关可能没有挂 llm-proxy-config envFrom——幂等补挂。
    await patchDeploymentEnvFromSecret(namespace, `nexus-gateway-${tenantId}`, LLM_PROXY_CONFIG_SECRET);

    // 存量租户的 dealclaw-credits Secret 缺 CREDITS_LEDGER_TOKEN——幂等 backfill。
    const creditsSecretName = `dealclaw-credits-${tenantId}`;
    if (config.creditsLedgerToken) {
      const creditsSecret = await getSecret(namespace, creditsSecretName);
      if (creditsSecret && !(creditsSecret.data && 'CREDITS_LEDGER_TOKEN' in creditsSecret.data)) {
        const merged: Record<string, string> = {};
        for (const [k, v] of Object.entries(creditsSecret.data ?? {})) {
          merged[k] = Buffer.from(v, 'base64').toString('utf8');
        }
        merged['CREDITS_LEDGER_TOKEN'] = config.creditsLedgerToken;
        await putSecret(namespace, creditsSecretName, merged);
      }
    }

    // envFrom values only apply on pod start — roll BOTH the agent
    // (rewritten provider blob) and the gateway (upstream map) when needed.
    let restarted = false;
    let gatewayRestarted = false;
    if (needsRestart) {
      const deployName = `dealclaw-agent-${tenantId}`;
      restarted = (await deploymentExists(namespace, deployName))
        ? await restartDeployment(namespace, deployName)
        : false;
      gatewayRestarted = (await deploymentExists(namespace, `nexus-gateway-${tenantId}`))
        ? await restartDeployment(namespace, `nexus-gateway-${tenantId}`)
        : false;
    }

    return {
      tenantId,
      ok: true,
      skipped: false,
      restarted,
      gatewayRestarted,
      skipRestart: !needsRestart,
      ...(v2Warning ? { v2Warning } : {}),
    };
  } catch (err) {
    return {
      tenantId,
      ok: false,
      skipped: false,
      restarted: false,
      gatewayRestarted: false,
      skipRestart: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function pushLlmProviders(
  pool: pg.Pool,
  config: ProvisioningConfig,
  scope: string | null,
  prevLibrary: LlmProvidersConfig | null = null,
): Promise<LlmPushResult> {
  const targets: string[] = [];
  if (scope) {
    targets.push(scope);
  } else {
    // Migration: drop legacy tenant-scoped full LLM_PROVIDERS overrides from
    // the pre-library era — tenants now only hold a model selection and the
    // library itself is global.
    await pool.query(
      `DELETE FROM runtime_configs WHERE config_key = $1 AND tenant_id IS NOT NULL`,
      [LLM_PROVIDERS_KEY],
    );
    const { rows } = await pool.query(
      `SELECT tenant_id FROM tenants
        WHERE status <> 'destroyed' AND k8s_namespace IS NOT NULL AND agent_endpoint IS NULL
        ORDER BY created_at`,
    );
    targets.push(...rows.map((r: any) => r.tenant_id));
  }

  // Snapshot the live library once for the whole run (the async worker passes
  // its encrypted task snapshot instead of re-reading here).
  const nowLibrary = await getGlobalLlmProviders(pool);

  const results: LlmPushResult['tenants'] = [];
  let skippedCount = 0;
  for (const tenantId of targets) {
    const outcome = await applyTenantLlmConfig(pool, config, tenantId, nowLibrary, prevLibrary, scope);
    if (outcome.ok && outcome.skipRestart) skippedCount += 1;
    results.push({
      tenantId,
      ok: outcome.ok,
      restarted: outcome.restarted,
      gatewayRestarted: outcome.gatewayRestarted,
      ...(outcome.error ? { error: outcome.error } : {}),
    });
  }

  const okCount = results.filter((r) => r.ok).length;
  const restartCount = results.filter((r) => r.restarted).length;
  const gatewayRestartCount = results.filter((r) => r.gatewayRestarted).length;
  const failed = results.filter((r) => !r.ok);
  let hint: string;
  if (results.length === 0) {
    hint = '没有需要推送的租户';
  } else if (okCount === 0) {
    hint = `已保存，但推送全部失败（${failed[0]?.tenantId}：${failed[0]?.error}）`;
  } else {
    hint =
      `已写入 ${okCount}/${results.length} 个租户的 tenant-config Secret` +
      (restartCount > 0
        ? `，${restartCount} 个 agent 正在滚动重启，重启完成后新模型配置生效（约 1–2 分钟）`
        : skippedCount > 0
          ? `；${skippedCount} 个租户模型配置未变，跳过重启（Secret 已同步，后续切换时即时生效）`
          : '；agent 下次重启时生效') +
      (gatewayRestartCount > 0 ? `；${gatewayRestartCount} 个网关已滚动（上游映射同步）` : '') +
      (failed.length ? `；${failed.length} 个租户推送失败（${failed[0].tenantId}：${failed[0].error}）` : '');
  }
  return { tenants: results, hint };
}
