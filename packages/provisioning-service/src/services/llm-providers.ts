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
import type { ProvisioningConfig } from '../config.js';

/** runtime_configs key holding the global provider JSON library. */
export const LLM_PROVIDERS_KEY = 'LLM_PROVIDERS';
/** runtime_configs key (tenant scope) holding a tenant's model selection. */
export const LLM_MODEL_SELECTION_KEY = 'LLM_MODEL_SELECTION';

export interface LlmModelSpec {
  id: string;
  reasoning?: boolean;
  /** True marks the model as vision-capable (accepts image input). */
  vision?: boolean;
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
   * True → configure the REAL upstream baseUrl + apiKey directly into the
   * agent's OpenClaw config, bypassing the nexus-gateway LLM egress proxy
   * (and its value-added interceptions). False (default) → baseUrl is
   * rewritten to the tenant's nexus-gateway proxy, so balance checks /
   * accounting stay active. Used to A/B-isolate gateway-induced latency.
   */
  directMode: boolean;
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
        models.push({
          id,
          ...(spec.reasoning === true ? { reasoning: true } : {}),
          ...(spec.vision === true ? { vision: true } : {}),
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
    if (!provider || !provider.models.some((m) => m.id === modelId)) {
      throw new LlmProvidersError(`默认模型 ${defaultModel} 不在已配置的提供商/模型列表中`);
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
      if (!modelExistsIn({ providers, defaultModel, imageModel, fallbackModels }, ref)) {
        throw new LlmProvidersError(`备用模型 ${ref} 不在已配置的提供商/模型列表中`);
      }
      if (defaultModel && ref === defaultModel) {
        throw new LlmProvidersError(`备用模型 ${ref} 与默认模型相同（备用链不应包含主模型）`);
      }
      if (fallbackModels.includes(ref)) continue; // 去重
      fallbackModels.push(ref);
    }
  }

  return { providers, defaultModel, imageModel, fallbackModels };
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
  return JSON.stringify(model);
}

/**
 * True when a library change actually affects a tenant: its effective model
 * changed (selection no longer resolves / default switched / provider removed),
 * its effective image model changed, or the credentials behind either model
 * changed. Adding an unrelated provider or model does NOT require a restart —
 * the tenant's live config is untouched.
 */
export function tenantNeedsLlmRestart(
  prev: LlmProvidersConfig | null,
  now: LlmProvidersConfig | null,
  selection: TenantModelSelection | null,
): boolean {
  const selDefault = selection?.defaultModel ?? null;
  const selImage = selection?.imageModel ?? null;

  const beforeRef = effectiveRefIn(prev, selDefault);
  const afterRef = effectiveRefIn(now, selDefault);
  if (beforeRef !== afterRef) return true;
  if (
    providerCredentialSignature(prev, beforeRef) !==
    providerCredentialSignature(now, afterRef)
  ) {
    return true;
  }
  // In-place model edits (reasoning/vision flags) also require a restart.
  if (modelSpecSignature(prev, beforeRef) !== modelSpecSignature(now, afterRef)) {
    return true;
  }

  const beforeImage = effectiveImageRefIn(prev, selImage);
  const afterImage = effectiveImageRefIn(now, selImage);
  if (beforeImage !== afterImage) return true;
  if (modelSpecSignature(prev, beforeImage) !== modelSpecSignature(now, afterImage)) {
    return true;
  }
  if (
    providerCredentialSignature(prev, beforeImage) !==
    providerCredentialSignature(now, afterImage)
  ) {
    return true;
  }

  // Fallback chain: a changed chain (or changed credentials behind any of
  // its models) must re-materialise the agent's fallbacks at boot.
  const beforeFallbacks = effectiveFallbacksIn(prev, selDefault);
  const afterFallbacks = effectiveFallbacksIn(now, selDefault);
  if (JSON.stringify(beforeFallbacks) !== JSON.stringify(afterFallbacks)) return true;
  for (const ref of afterFallbacks) {
    if (providerCredentialSignature(now, ref) !== providerCredentialSignature(prev, ref)) {
      return true;
    }
  }
  return false;
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
      const directMode = parsed.directMode === true;
      return { defaultModel, imageModel, directMode };
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
  /** selection ?? globalConfig.defaultModel ?? null */
  effectiveModel: string | null;
  /** imageSelection ?? globalConfig.imageModel ?? null */
  effectiveImageModel: string | null;
  /** Library fallbacks minus the tenant's effective primary, resolvable only. */
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
): Promise<EffectiveLlmProviders> {
  const globalConfig = await getGlobalLlmProviders(pool);
  if (!globalConfig || globalConfig.providers.length === 0) {
    return {
      globalConfig: null,
      selection: null,
      imageSelection: null,
      effectiveModel: null,
      effectiveImageModel: null,
      effectiveFallbacks: [],
      blob: null,
    };
  }
  let selection: string | null = null;
  let imageSelection: string | null = null;
  if (tenantId) {
    const sel = await getTenantModelSelection(pool, tenantId);
    if (sel?.defaultModel && modelExistsIn(globalConfig, sel.defaultModel)) {
      selection = sel.defaultModel;
    }
    if (sel?.imageModel && visionModelExistsIn(globalConfig, sel.imageModel)) {
      imageSelection = sel.imageModel;
    }
  }
  const effectiveModel = selection ?? globalConfig.defaultModel ?? null;
  const effectiveImageModel =
    imageSelection ?? (globalConfig.imageModel && visionModelExistsIn(globalConfig, globalConfig.imageModel)
      ? globalConfig.imageModel
      : null);
  // Fallbacks are library-global but must exclude THIS tenant's effective
  // primary (no-op retry) and any entry that no longer resolves.
  const effectiveFallbacks = effectiveFallbacksIn(globalConfig, selection);
  const blob = JSON.stringify({
    ...globalConfig,
    defaultModel: effectiveModel,
    imageModel: effectiveImageModel,
    fallbackModels: effectiveFallbacks,
  });
  return {
    globalConfig,
    selection,
    imageSelection,
    effectiveModel,
    effectiveImageModel,
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

  const results: LlmPushResult['tenants'] = [];
  let skippedCount = 0;
  for (const tenantId of targets) {
    try {
      if (config.k8sDryRun) {
        results.push({ tenantId, ok: true, restarted: false });
        continue;
      }
      const { rows: tenantRows } = await pool.query(
        `SELECT k8s_namespace FROM tenants WHERE tenant_id = $1`,
        [tenantId],
      );
      const namespace = tenantRows[0]?.k8s_namespace;
      if (!namespace) {
        results.push({ tenantId, ok: true, restarted: false });
        continue;
      }

      // Effective blob = global library + this tenant's resolved default.
      const { globalConfig, blob } = await resolveEffectiveLlmProviders(pool, tenantId);
      const rawSelection = await getTenantModelSelection(pool, tenantId);
      const directMode = rawSelection?.directMode === true;

      // Differential roll: tenant-scoped writes always roll (their selection
      // just changed); global writes only roll when the tenant's live model
      // or its provider credentials actually changed. Unchanged tenants keep
      // the materialised Secret but their agent keeps running untouched.
      const needsRestart =
        scope !== null ||
        tenantNeedsLlmRestart(prevLibrary, globalConfig, rawSelection);

      // Proxy mode (default): rewrite each provider's baseUrl to the tenant's
      // LLM egress proxy (nexus-gateway /v1/llm/<name>). The REAL baseUrl
      // moves into the llm-proxy-config Secret the gateway reads via envFrom,
      // and the API key travels unchanged in the blob (Authorization
      // passthrough) — OpenClaw / write-config.mjs need zero changes.
      //
      // Direct mode (opt-in per tenant): keep the REAL baseUrl + apiKey in
      // the blob so OpenClaw calls the upstream directly, bypassing the
      // gateway and its value-added interceptions (balance check, accounting
      // tee, rate limits). Used to A/B-isolate gateway-induced latency.
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
      await putSecret(namespace, 'tenant-config', next);

      // llm-proxy-config: the gateway's providerName → real baseUrl map.
      // Written even when the library is empty so stale mappings are
      // cleared instead of lingering in the Secret.
      await putSecret(namespace, LLM_PROXY_CONFIG_SECRET, {
        LLM_UPSTREAMS: JSON.stringify(upstreams),
      });

      //存量网关可能没有挂 llm-proxy-config envFrom（代理化之前创建）——
      // 幂等补挂；404（网关不存在）静默跳过。
      await patchDeploymentEnvFromSecret(namespace, `nexus-gateway-${tenantId}`, LLM_PROXY_CONFIG_SECRET);

      // 存量租户的 dealclaw-credits Secret 缺 CREDITS_LEDGER_TOKEN（网关
      // 记账上报/余额查询的共享 token）——幂等 backfill，已有或本服务未
      // 配置 token 时跳过。
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
      // (rewritten provider blob) and the gateway (upstream map) ONLY when
      // this tenant's live model actually changed.
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
      } else {
        skippedCount += 1;
      }
      results.push({ tenantId, ok: true, restarted, gatewayRestarted });
    } catch (err) {
      results.push({
        tenantId,
        ok: false,
        restarted: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
