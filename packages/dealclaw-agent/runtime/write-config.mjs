import fs from 'node:fs';
import path from 'node:path';

const stateDir = process.env.OPENCLAW_STATE_DIR || '/data/state';
const workspace = process.env.OPENCLAW_WORKSPACE_DIR || '/data/workspace';
const configPath = process.env.OPENCLAW_CONFIG_PATH || path.join(stateDir, 'openclaw.json');
const timezone = process.env.DEALCLAW_TIMEZONE || 'Asia/Shanghai';
const gatewayPort = Number(process.env.OPENCLAW_GATEWAY_PORT || 18790);
const gatewayToken = (process.env.OPENCLAW_GATEWAY_TOKEN || '').trim();

function fail(msg) {
  console.error(`[dealclaw-runtime] ${msg}`);
  process.exit(1);
}

// ── LLM providers (admin-console managed, injected via envFrom) ──────
// LLM_PROVIDERS is a JSON doc: { providers: [{name, baseUrl, apiKey,
// models: [{id, reasoning?}]}], defaultModel: '<name>/<modelId>' }.
// Provider API keys are materialised as shell exports in
// <stateDir>/llm-env.sh, which entrypoint.sh sources before starting the
// gateway — the OpenClaw config references them by env id (never inline).
const llmEnvPath = path.join(stateDir, 'llm-env.sh');
fs.mkdirSync(stateDir, { recursive: true });
// ── V1 LLM_PROVIDERS parsing ─────────────────────────────────────────
// LLM_PROVIDERS is the V1 contract: a JSON doc { providers: [{name,
// baseUrl, apiKey, models: [{id, reasoning?}]}], defaultModel:
// '<name>/<modelId>' }. Provider API keys are materialised as shell
// exports in <stateDir>/llm-env.sh, which entrypoint.sh sources before
// starting the gateway — the OpenClaw config references them by env id
// (never inline).
let v1LlmDoc = null;
const llmRaw = (process.env.LLM_PROVIDERS || '').trim();
if (llmRaw) {
  try {
    v1LlmDoc = JSON.parse(llmRaw);
  } catch {
    fail('LLM_PROVIDERS is not valid JSON — refusing to start with a broken model config');
  }
  if (!v1LlmDoc || !Array.isArray(v1LlmDoc.providers)) {
    fail('LLM_PROVIDERS must contain a "providers" array');
  }
}

// ── Runtime Contract V2 (shadow dual-read) ────────────────────────────
// LLM_RUNTIME_CONTRACT_MODE: 'v1' (default) | 'shadow' | 'v2'
//
// - v1:     Read LLM_PROVIDERS only. Legacy behaviour, completely unchanged.
// - shadow: Read LLM_PROVIDERS for actual use. Additionally parse
//           LLM_RUNTIME_CONFIG_V2 (a RuntimeEnvelopeV2 JSON), normalise
//           it to the same llmDoc shape, and compare. Log mismatches but
//           never block — the V1 payload remains the source of truth.
// - v2:     Read LLM_RUNTIME_CONFIG_V2 as the sole source. Validate the
//           envelope strictly and fail closed on any error — no silent
//           fallback to V1.
//
// After mode resolution, `llmDoc` holds the active document (from V1 or
// V2) and the rest of write-config consumes it identically regardless
// of origin. This reuses the single OpenClaw renderer path — V2 is
// normalised INTO the V1 llmDoc IR, not rendered independently.

/**
 * Lightweight V2 envelope validator (plain JS, no provisioning-service dep).
 * Collects all structural issues rather than failing on the first — mirrors
 * the provisioning-service validateEnvelope() approach so that shadow-mode
 * logs and v2-mode fail-closed messages are actionable.
 * @param {unknown} raw
 * @returns {Array<{path: string[], message: string}>}
 */
function validateV2Envelope(raw) {
  const issues = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return [{ path: ['$'], message: 'expected object' }];
  }
  if (raw.schema !== 'agent') {
    issues.push({ path: ['schema'], message: `expected "agent", got ${JSON.stringify(raw.schema)}` });
  }
  if (raw.schemaVersion !== 2) {
    issues.push({ path: ['schemaVersion'], message: `expected 2, got ${JSON.stringify(raw.schemaVersion)}` });
  }
  if (typeof raw.payload !== 'object' || raw.payload === null || Array.isArray(raw.payload)) {
    issues.push({ path: ['payload'], message: 'expected object' });
    return issues;
  }
  const p = raw.payload;
  if (typeof p.directMode !== 'boolean') {
    issues.push({ path: ['payload', 'directMode'], message: 'expected boolean' });
  }
  if (!Array.isArray(p.providers)) {
    issues.push({ path: ['payload', 'providers'], message: 'expected array' });
    return issues;
  }
  for (let i = 0; i < p.providers.length; i++) {
    const prov = p.providers[i];
    const ppath = ['payload', 'providers', i];
    if (typeof prov !== 'object' || prov === null || Array.isArray(prov)) {
      issues.push({ path: ppath, message: 'expected object' });
      continue;
    }
    if (typeof prov.providerId !== 'string' || !prov.providerId) {
      issues.push({ path: [...ppath, 'providerId'], message: 'expected non-empty string' });
    }
    if (typeof prov.baseUrl !== 'string' || !/^https?:\/\//.test(prov.baseUrl)) {
      issues.push({ path: [...ppath, 'baseUrl'], message: 'expected http(s) URL string' });
    }
    if (typeof prov.apiKey !== 'string' || !prov.apiKey) {
      issues.push({ path: [...ppath, 'apiKey'], message: 'expected non-empty string' });
    }
    if (!Array.isArray(prov.models) || prov.models.length === 0) {
      issues.push({ path: [...ppath, 'models'], message: 'expected non-empty array' });
      continue;
    }
    for (let j = 0; j < prov.models.length; j++) {
      const m = prov.models[j];
      const mpath = [...ppath, 'models', j];
      if (typeof m !== 'object' || m === null || Array.isArray(m)) {
        issues.push({ path: mpath, message: 'expected object' });
        continue;
      }
      if (typeof m.modelId !== 'string' || !m.modelId) {
        issues.push({ path: [...mpath, 'modelId'], message: 'expected non-empty string' });
      }
      if (typeof m.upstreamModel !== 'string' || !m.upstreamModel) {
        issues.push({ path: [...mpath, 'upstreamModel'], message: 'expected non-empty string' });
      }
    }
  }
  return issues;
}

/**
 * Normalise a validated V2 agent envelope into the V1 llmDoc shape so that
 * downstream OpenClaw config generation can consume it identically.
 *
 * V2 providerId   → V1 provider.name
 * V2 upstreamModel → V1 model.id
 * V2 ref {providerId, modelId} → V1 "providerName/upstreamModel" string
 *   (resolved by looking up the model in the provider's models array)
 *
 * @param {ReturnType<typeof validateV2Envelope> extends never ? never : {payload: any}} envelope
 * @returns {{providers: any[], defaultModel?: string, imageModel?: string, compactionModel?: string, fallbackModels?: string[]}}
 */
function normalizeV2ToLlmDoc(envelope) {
  const payload = envelope.payload;

  const providers = payload.providers.map((p) => {
    const models = p.models.map((m) => {
      const model = { id: m.upstreamModel };
      if (m.modelType) model.modelType = m.modelType;
      if (m.protocol) model.protocol = m.protocol;
      if (typeof m.contextWindow === 'number' && m.contextWindow > 0) {
        model.contextWindow = m.contextWindow;
      }
      if (typeof m.maxOutputTokens === 'number' && m.maxOutputTokens > 0) {
        model.maxOutputTokens = m.maxOutputTokens;
      }
      if (Array.isArray(m.inputModalities) && m.inputModalities.length > 0) {
        model.inputModalities = m.inputModalities;
      }
      if (m.reasoning === true) model.reasoning = true;
      if (m.vision === true) model.vision = true;
      if (typeof m.displayName === 'string' && m.displayName) {
        model.displayName = m.displayName;
      }
      if (m.compat && typeof m.compat === 'object' && !Array.isArray(m.compat) && Object.keys(m.compat).length > 0) {
        model.compat = m.compat;
      }
      return model;
    });
    return {
      name: p.providerId,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      models,
    };
  });

  // Helper: convert a V2 ref {providerId, modelId} to a V1
  // "providerName/upstreamModel" string by looking up the model in the
  // V2 provider's models array (robust against composite vs. lpi_ IDs).
  function refToV1(ref) {
    if (!ref || typeof ref !== 'object') return null;
    if (typeof ref.providerId !== 'string' || typeof ref.modelId !== 'string') return null;
    const provider = payload.providers.find((p) => p.providerId === ref.providerId);
    if (!provider) return null;
    const model = provider.models.find((m) => m.modelId === ref.modelId);
    if (!model) return null;
    return `${ref.providerId}/${model.upstreamModel}`;
  }

  const doc = { providers };
  if (payload.primary) {
    const ref = refToV1(payload.primary);
    if (ref) doc.defaultModel = ref;
  }
  if (payload.image) {
    const ref = refToV1(payload.image);
    if (ref) doc.imageModel = ref;
  }
  if (payload.compaction) {
    const ref = refToV1(payload.compaction);
    if (ref) doc.compactionModel = ref;
  }
  if (Array.isArray(payload.fallbacks) && payload.fallbacks.length > 0) {
    const refs = payload.fallbacks.map(refToV1).filter((r) => r !== null);
    if (refs.length > 0) doc.fallbackModels = refs;
  }
  return doc;
}

/**
 * Compare a V1 llmDoc with a V2-normalised llmDoc for structural drift.
 * Returns an array of human-readable mismatch descriptions (empty = match).
 * Only compares fields that have a V2 equivalent; extra V1-only fields
 * (e.g. maxReasoningTokens) are not flagged. baseUrl is intentionally NOT
 * compared — see the in-loop comment below for the rationale.
 * @param {any} v1Doc
 * @param {any} v2Doc
 * @returns {string[]}
 */
function compareLlmDocs(v1Doc, v2Doc) {
  const mismatches = [];
  const v1 = v1Doc || { providers: [] };
  const v2 = v2Doc || { providers: [] };

  // Provider set
  const v1Names = (v1.providers || []).map((p) => p.name).sort();
  const v2Names = (v2.providers || []).map((p) => p.name).sort();
  if (JSON.stringify(v1Names) !== JSON.stringify(v2Names)) {
    mismatches.push(`provider set: v1=[${v1Names.join(',')}] v2=[${v2Names.join(',')}]`);
  }

  // Per-provider model list (baseUrl intentionally NOT compared)
  for (const v2Prov of v2.providers || []) {
    const v1Prov = (v1.providers || []).find((p) => p.name === v2Prov.name);
    if (!v1Prov) continue; // already flagged in provider set
    // NOTE: baseUrl is intentionally NOT compared. V1 stores the proxy URL
    // (nexus-gateway:8080/v1/llm/<name>) for the agent to call the gateway,
    // while V2 stores the real upstream URL. This is by design — not drift.
    const v1ModelIds = (v1Prov.models || []).map((m) => m.id).sort();
    const v2ModelIds = (v2Prov.models || []).map((m) => m.id).sort();
    if (JSON.stringify(v1ModelIds) !== JSON.stringify(v2ModelIds)) {
      mismatches.push(`provider ${v2Prov.name} models: v1=[${v1ModelIds.join(',')}] v2=[${v2ModelIds.join(',')}]`);
    }
  }

  // Refs
  const v1Default = v1.defaultModel || null;
  const v2Default = v2.defaultModel || null;
  if (v1Default !== v2Default) {
    mismatches.push(`defaultModel: v1=${v1Default} v2=${v2Default}`);
  }
  const v1Image = v1.imageModel || null;
  const v2Image = v2.imageModel || null;
  if (v1Image !== v2Image) {
    mismatches.push(`imageModel: v1=${v1Image} v2=${v2Image}`);
  }
  const v1Comp = v1.compactionModel || null;
  const v2Comp = v2.compactionModel || null;
  if (v1Comp !== v2Comp) {
    mismatches.push(`compactionModel: v1=${v1Comp} v2=${v2Comp}`);
  }
  const v1Fb = v1.fallbackModels || [];
  const v2Fb = v2.fallbackModels || [];
  if (JSON.stringify(v1Fb) !== JSON.stringify(v2Fb)) {
    mismatches.push(`fallbackModels: v1=[${v1Fb.join(',')}] v2=[${v2Fb.join(',')}]`);
  }
  return mismatches;
}

// ── Mode resolution ───────────────────────────────────────────────────
const runtimeContractMode = process.env.LLM_RUNTIME_CONTRACT_MODE || 'v1';
let llmDoc = null;

if (runtimeContractMode === 'v2') {
  // V2 is the sole source — fail closed on any error, no silent fallback.
  const v2Raw = (process.env.LLM_RUNTIME_CONFIG_V2 || '').trim();
  if (!v2Raw || v2Raw === '{}') {
    // Empty V2 → no providers (same as empty V1 LLM_PROVIDERS)
    llmDoc = null;
  } else {
    let v2Envelope;
    try {
      v2Envelope = JSON.parse(v2Raw);
    } catch {
      fail('LLM_RUNTIME_CONFIG_V2 is not valid JSON — refusing to start (mode=v2, fail-closed)');
    }
    const issues = validateV2Envelope(v2Envelope);
    if (issues.length > 0) {
      const formatted = issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
      fail(`LLM_RUNTIME_CONFIG_V2 validation failed (mode=v2, fail-closed):\n${formatted}`);
    }
    llmDoc = normalizeV2ToLlmDoc(v2Envelope);
    if (!llmDoc || !Array.isArray(llmDoc.providers)) {
      fail('LLM_RUNTIME_CONFIG_V2 normalised to invalid llmDoc (mode=v2, fail-closed)');
    }
    console.log(
      `[dealclaw-runtime] V2 contract active: ${llmDoc.providers.length} provider(s)` +
      (v2Envelope.releaseId ? ` from release ${v2Envelope.releaseId}` : ''),
    );
  }
} else if (runtimeContractMode === 'shadow') {
  // V1 is the actual source of truth; V2 is parsed for comparison only.
  llmDoc = v1LlmDoc;

  const v2Raw = (process.env.LLM_RUNTIME_CONFIG_V2 || '').trim();
  if (!v2Raw || v2Raw === '{}') {
    console.warn('[dealclaw-runtime] shadow: LLM_RUNTIME_CONFIG_V2 is empty — no V2 comparison (V1 remains active)');
  } else {
    let v2Envelope;
    try {
      v2Envelope = JSON.parse(v2Raw);
    } catch {
      console.warn('[dealclaw-runtime] shadow: LLM_RUNTIME_CONFIG_V2 is not valid JSON — V2 comparison skipped (V1 remains active)');
    }
    if (v2Envelope) {
      const issues = validateV2Envelope(v2Envelope);
      if (issues.length > 0) {
        const formatted = issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
        console.warn(`[dealclaw-runtime] shadow: V2 envelope has ${issues.length} validation issue(s):\n${formatted}`);
      } else {
        const v2LlmDoc = normalizeV2ToLlmDoc(v2Envelope);
        const mismatches = compareLlmDocs(v1LlmDoc, v2LlmDoc);
        if (mismatches.length > 0) {
          console.warn(`[dealclaw-runtime] shadow: V1/V2 drift detected (${mismatches.length} mismatch(es)):`);
          for (const m of mismatches) {
            console.warn(`[dealclaw-runtime] shadow mismatch: ${m}`);
          }
        } else {
          console.log('[dealclaw-runtime] shadow: V1 and V2 payloads match — no drift detected');
        }
      }
    }
  }
} else {
  // v1 (default): V1 only, completely unchanged behaviour.
  llmDoc = v1LlmDoc;
}

function defaultModelSpec(id, reasoning, vision) {
  // deepseek models align with V's spec: 1M context / 384K output,
  // native reasoning_effort + deepseek thinking format (lets
  // reasoningDefault/thinkingDefault actually reach the model instead of
  // falling back to default reasoning).
  const isDeepseek = id.startsWith('deepseek');
  return {
    id,
    name: id,
    ...(reasoning ? { reasoning: true } : {}),
    input: vision ? ['text', 'image'] : ['text'],
    contextWindow: isDeepseek ? 1_000_000 : 131_072,
    maxTokens: isDeepseek ? 384_000 : (reasoning ? 65_536 : 8_192),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: {
      supportsUsageInStreaming: true,
      ...(isDeepseek ? { supportsReasoningEffort: true, thinkingFormat: 'deepseek' } : {}),
      maxTokensField: 'max_tokens',
    },
  };
}

  // No built-in fallback provider: with an empty library the agent boots with
  // no model configured (admin must add providers in the console first).
  const providers = {};
  let primaryModel = null;
  let imageModel = null;
  let compactionModel = null;
  const fallbackModels = [];

if (llmDoc && llmDoc.providers.length > 0) {
  const exportLines = [];
  const nextProviders = {};
  for (const p of llmDoc.providers) {
    if (!p || typeof p.name !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(p.name)) {
      fail(`LLM_PROVIDERS: invalid provider name ${JSON.stringify(p?.name)}`);
    }
    if (typeof p.baseUrl !== 'string' || !/^https?:\/\//.test(p.baseUrl)) {
      fail(`LLM_PROVIDERS: provider ${p.name} needs an http(s) baseUrl`);
    }
    if (typeof p.apiKey !== 'string' || !p.apiKey) {
      fail(`LLM_PROVIDERS: provider ${p.name} needs an apiKey`);
    }
    if (!Array.isArray(p.models) || p.models.length === 0) {
      fail(`LLM_PROVIDERS: provider ${p.name} needs at least one model`);
    }
    const envName = `LLM_KEY_${p.name.toUpperCase().replace(/-/g, '_')}`;
    const compatibleModels = p.models.flatMap((m) => {
      const spec = typeof m === 'string' ? { id: m } : m;
      if (!spec || typeof spec.id !== 'string' || !spec.id) {
        fail(`LLM_PROVIDERS: provider ${p.name} has an invalid model entry`);
      }
      // Missing fields are legacy-compatible; explicit non-chat/non-supported
      // entries stay in the catalog but never enter OpenClaw's chat list.
      if ((spec.modelType && spec.modelType !== 'chat') ||
          (spec.protocol && spec.protocol !== 'openai-completions')) return [];
      const fallback = defaultModelSpec(spec.id, spec.reasoning === true, spec.vision === true);
      const contextWindow = Number.isSafeInteger(spec.contextWindow) && spec.contextWindow > 0
        ? spec.contextWindow : fallback.contextWindow;
      const maxTokens = Number.isSafeInteger(spec.maxOutputTokens) && spec.maxOutputTokens > 0
        ? spec.maxOutputTokens : fallback.maxTokens;
      const input = Array.isArray(spec.inputModalities) &&
        spec.inputModalities.length > 0 &&
        spec.inputModalities.every((value) => ['text', 'image', 'audio', 'video'].includes(value))
        ? [...new Set(spec.inputModalities)]
        : fallback.input;
      return [{ ...fallback, name: typeof spec.displayName === 'string' ? spec.displayName : spec.id, contextWindow, maxTokens, input }];
    });
    if (compatibleModels.length === 0) {
      console.warn(`[dealclaw-runtime] LLM_PROVIDERS: provider ${p.name} has no chat-compatible models — skipped`);
      continue;
    }
    nextProviders[p.name] = {
      baseUrl: p.baseUrl.replace(/\/+$/, ''),
      api: 'openai-completions',
      apiKey: { source: 'env', provider: 'default', id: envName },
      // Per-request idle timeout: cloud default is 120s which trips on slow
      // upstreams; raise to 600s so transient stalls fall through to the
      // fallback chain instead of hard-failing the turn.
      timeoutSeconds: Number(process.env.DEALCLAW_LLM_PROVIDER_TIMEOUT_SECONDS || 600),
      models: compatibleModels,
    };
    // Single-quote the secret; escape embedded quotes safely.
    const quoted = `'${p.apiKey.replace(/'/g, `'\\''`)}'`;
    exportLines.push(`export ${envName}=${quoted}`);
  }
  Object.keys(providers).forEach((k) => delete providers[k]);
  Object.assign(providers, nextProviders);
  fs.writeFileSync(llmEnvPath, `${exportLines.join('\n')}\n`, { mode: 0o600 });
  console.log(`[dealclaw-runtime] LLM providers configured: ${Object.keys(nextProviders).join(', ')}`);

  if (typeof llmDoc.defaultModel === 'string' && llmDoc.defaultModel) {
    const [pName, ...rest] = llmDoc.defaultModel.split('/');
    const modelId = rest.join('/');
    if (!nextProviders[pName] || !nextProviders[pName].models.some((m) => m.id === modelId)) {
      fail(`LLM_PROVIDERS: defaultModel ${llmDoc.defaultModel} not found in configured providers`);
    }
    primaryModel = llmDoc.defaultModel;
  } else {
    // No explicit default → first chat-compatible provider model.
    const firstProviderName = Object.keys(nextProviders)[0];
    const firstModel = firstProviderName ? nextProviders[firstProviderName].models[0] : null;
    primaryModel = firstProviderName && firstModel ? `${firstProviderName}/${firstModel.id}` : null;
  }

  // ── Fallback chain (OpenClaw model failover) ───────────────────────
  // llmDoc.fallbackModels: ordered '<provider>/<model>' refs. Fail-open:
  // entries that no longer resolve are skipped with a warning (the blob is
  // materialised server-side already filtered, this is belt-and-braces for
  // hand-edited Secrets). The primary itself is excluded (no-op retry).
  if (Array.isArray(llmDoc.fallbackModels)) {
    for (const ref of llmDoc.fallbackModels) {
      if (typeof ref !== 'string' || !ref || ref === primaryModel) continue;
      const [pName, ...rest] = ref.split('/');
      const modelId = rest.join('/');
      if (!nextProviders[pName] || !nextProviders[pName].models.some((m) => m.id === modelId)) {
        console.warn(`[dealclaw-runtime] LLM_PROVIDERS: fallbackModel ${ref} not found in configured providers — skipped`);
        continue;
      }
      if (!fallbackModels.includes(ref)) fallbackModels.push(ref);
    }
    if (fallbackModels.length > 0) {
      console.log(`[dealclaw-runtime] model fallback chain: ${fallbackModels.join(' -> ')}`);
    }
  }

  // ── Image (vision) model ────────────────────────────────────────────
  // llmDoc.imageModel is a '<provider>/<modelId>' ref; it must resolve to a
  // model marked vision: true, otherwise we fail closed (a mis-configured
  // imageModel must never silently point at a text-only model).
  if (typeof llmDoc.imageModel === 'string' && llmDoc.imageModel) {
    const [pName, ...rest] = llmDoc.imageModel.split('/');
    const modelId = rest.join('/');
    const model = nextProviders[pName]?.models.find((m) => m.id === modelId);
    if (!model) {
      fail(`LLM_PROVIDERS: imageModel ${llmDoc.imageModel} not found in configured providers`);
    }
    if (!Array.isArray(model.input) || !model.input.includes('image')) {
      fail(`LLM_PROVIDERS: imageModel ${llmDoc.imageModel} is not vision-capable (add :vision to its model entry)`);
    }
    imageModel = llmDoc.imageModel;
  }

  // ── Compaction model ─────────────────────────────────────────────────
  // llmDoc.compactionModel is a '<provider>/<modelId>' ref for the context-
  // engine's safeguard compaction (history summarisation). Compaction prompts
  // are long-context, so a tenant whose primary is a slow heavyweight model
  // may point compaction at a faster one (see the 2026-09-01 foldin
  // incident: 6-minute compaction timeouts). Fail-open: an unresolvable ref
  // falls back to the primary with a warning instead of blocking boot.
  if (typeof llmDoc.compactionModel === 'string' && llmDoc.compactionModel) {
    const [pName, ...rest] = llmDoc.compactionModel.split('/');
    const modelId = rest.join('/');
    if (!nextProviders[pName] || !nextProviders[pName].models.some((m) => m.id === modelId)) {
      console.warn(`[dealclaw-runtime] LLM_PROVIDERS: compactionModel ${llmDoc.compactionModel} not found in configured providers — falling back to primary`);
    } else {
      compactionModel = llmDoc.compactionModel;
    }
  }
} else {
  // No providers configured — remove any stale exports file so a
  // previously-configured key can never linger on disk. The gateway still
  // starts, but with no model: conversations will fail until an admin
  // configures providers in the console.
  try { fs.unlinkSync(llmEnvPath); } catch { /* not present */ }
  console.warn('[dealclaw-runtime] no LLM providers configured — agent starts WITHOUT a model');
}

// ── Feishu channel (P2 direct connection) ─────────────────────────────
// DEALCLAW_MESSAGE_PLANE=openclaw switches the tenant's message plane
// from the nexus-gateway bridge to the official @openclaw/feishu plugin.
// Preferred source: the trusted install managed by entrypoint.sh
// (`openclaw plugins install` into the PVC state dir — trusted plugins get
// openKeyedStore access, i.e. persistent feishu-dedup). Fallback: the
// image-baked sideload copy at /opt/dealclaw/plugins/feishu (load.paths —
// no trusted identity, dedup degrades to in-memory). Credentials come
// from the tenant's bot Secret (envFrom); the appSecret is referenced by
// env id, never inlined into the config file.
const FEISHU_PLUGIN_DIR = '/opt/dealclaw/plugins/feishu/node_modules/@openclaw/feishu';
const WECHAT_PLUGIN_DIR = '/opt/dealclaw/plugins/weixin/node_modules/@tencent-weixin/openclaw-weixin';
const WECOM_PLUGIN_DIR = '/opt/dealclaw/plugins/wecom/node_modules/@wecom/wecom-openclaw-plugin';
const DINGTALK_PLUGIN_DIR = '/opt/dealclaw/plugins/dingtalk/node_modules/@dingtalk-real-ai/dingtalk-connector';
const messagePlane = process.env.DEALCLAW_MESSAGE_PLANE || 'gateway';
const feishuAppId = (process.env.DEALCLAW_APP_ID || '').trim();
const feishuAppSecret = (process.env.DEALCLAW_APP_SECRET || '').trim();
const feishuDirect =
  messagePlane === 'openclaw' &&
  feishuAppId &&
  feishuAppSecret &&
  !feishuAppId.startsWith('placeholder-');

// ── WeChat (personal WeChat direct connection) ────────────────────────
// DEALCLAW_WECHAT_BOUND=1 + openclaw plane → enable channels["openclaw-weixin"].
// Unlike Feishu, WeChat account credentials are obtained via QR login (not
// appId/appSecret) and stored by the plugin in the PVC state directory.
// write-config only needs to declare the channel enabled; the plugin reads
// account files from $OPENCLAW_STATE_DIR/openclaw-weixin/accounts.json.
const wechatBound = process.env.DEALCLAW_WECHAT_BOUND === '1' && messagePlane === 'openclaw';

// Enterprise channel credentials originate from Kubernetes Secrets. DingTalk
// supports an env SecretRef; WeCom 2026.7.2 only accepts a string, so its secret
// is materialized into the 0600 openclaw.json. A BOUND flag without complete
// credentials is treated as disabled to avoid a half-configured channel.
const wecomBotId = (process.env.DEALCLAW_WECOM_BOT_ID || '').trim();
const wecomSecret = (process.env.DEALCLAW_WECOM_SECRET || '').trim();
const wecomBound =
  process.env.DEALCLAW_WECOM_BOUND === '1' &&
  messagePlane === 'openclaw' &&
  Boolean(wecomBotId && wecomSecret);
const dingtalkClientId = (process.env.DEALCLAW_DINGTALK_CLIENT_ID || '').trim();
const dingtalkClientSecret = (process.env.DEALCLAW_DINGTALK_CLIENT_SECRET || '').trim();
const dingtalkBound =
  process.env.DEALCLAW_DINGTALK_BOUND === '1' &&
  messagePlane === 'openclaw' &&
  Boolean(dingtalkClientId && dingtalkClientSecret);

// ── Shared DM session (Feishu + WeChat cross-channel merge) ──────────
// Three-state, DEFAULT ON (v0.10): DEALCLAW_SHARED_DM_SESSION
//   '1'        → explicitly enabled  → dmScope 'main'
//   '0'        → explicitly disabled → falls through to wechatBound /
//                escape-hatch / per-channel-peer
//   <unset>    → DEFAULT enabled     → dmScope 'main'
// The per-tenant admin toggle materialises '1'/'0'; a tenant that has never
// touched the toggle leaves the env unset and therefore defaults to merged.
const sharedDmSession = process.env.DEALCLAW_SHARED_DM_SESSION !== '0';

if (messagePlane === 'openclaw' && !feishuDirect && !wechatBound && !wecomBound && !dingtalkBound) {
  console.warn('[dealclaw-runtime] DEALCLAW_MESSAGE_PLANE=openclaw but no channel credentials — channels NOT enabled');
}

const pluginLoadPaths = [
  path.join(workspace, 'plugins', 'dealclaw-billing'),
  path.join(workspace, 'plugins', 'dealclaw-contact'),
  path.join(workspace, 'plugins', 'dealclaw-chatlog'),
];
if (feishuDirect && process.env.DEALCLAW_FEISHU_TRUSTED !== '1') pluginLoadPaths.push(FEISHU_PLUGIN_DIR);
if (wechatBound && process.env.DEALCLAW_WECHAT_TRUSTED !== '1') pluginLoadPaths.push(WECHAT_PLUGIN_DIR);
if (wecomBound && process.env.DEALCLAW_WECOM_TRUSTED !== '1') pluginLoadPaths.push(WECOM_PLUGIN_DIR);
if (dingtalkBound && process.env.DEALCLAW_DINGTALK_TRUSTED !== '1') pluginLoadPaths.push(DINGTALK_PLUGIN_DIR);

const deniedTools = [
  'message',
  'gateway',
  // cron is intentionally ALLOWED: without it the agent has no durable way to
  // honour 「明天提醒我跟进」 and falls back to backgrounding `sleep`, which dies
  // on the next pod restart / image upgrade — the reminder is then lost
  // silently. AGENTS.md 「延时提醒一律走调度器」 assumes this tool exists.
  // Safe to expose: the agent cron tool hard-rejects payload.kind="command"
  // (assertNoCronCommandPayload), so it can only schedule systemEvent/agentTurn
  // jobs, never shell. The six product crons stay on the CLI path in
  // runtime/dc-cron-*.sh, which the tool can neither create nor edit.
  'nodes',
  // sessions_* orchestration tools are intentionally ALLOWED (full set):
  // - sessions_spawn: delegate long multi-tool tasks (find-buyers crawls) to an
  //   isolated sub-session with its own runTimeoutSeconds, escaping the 1800s
  //   run ceiling without blocking the Feishu reply (P1 async).
  // - sessions_list: enumerate spawned sub-sessions and their status.
  // - sessions_history: read a sub-session's transcript.
  // - sessions_send: append follow-up instructions to a running sub-session.
  // Together they give the main agent the full orchestration surface it needs to
  // manage long-running delegated work. Spawned sub-agents still do NOT inherit
  // these (they run in leaf mode), so only the main orchestrator can fan out.
  'image_generate',
  'video_generate',
  'music_generate',
  'tts',
  'skill_workshop',
];

const config = {
  // openclaw 的配置保护机制（missing-meta-vs-last-good 检测）要求顶层存在
  // meta.lastTouchedVersion / meta.lastTouchedAt 字段。write-config 直接写文件
  // 绕过了 openclaw 的写入路径，若缺失 meta 会被判定为「外部 clobber」并回滚到
  // last-good 快照，导致新绑定的渠道（企业微信/钉钉）配置永远无法生效。
  // 详见 2026-09-16 企业微信扫码绑定排查（租户 a3f6ac0b…）。
  meta: {
    lastTouchedVersion: 'dealclaw-runtime',
    lastTouchedAt: new Date().toISOString(),
  },
  models: {
    mode: 'merge',
    providers,
  },
  gateway: {
    mode: 'local',
    bind: 'loopback',
    port: gatewayPort,
    // Shared-token auth so the CLI (cron add / agent) authenticates as an
    // operator.admin client instead of triggering device-pairing scope-upgrade
    // (which needs manual approval and blocks unattended tenant startup).
    // Falls back to none when no token is injected.
    auth: gatewayToken ? { mode: 'token', token: gatewayToken } : { mode: 'none' },
    http: {
      endpoints: {
        responses: {
          enabled: true,
          maxBodyBytes: 1_048_576,
          maxUrlParts: 0,
          files: { allowUrl: false, maxBytes: 5_242_880, maxChars: 60_000 },
          images: { allowUrl: false, maxBytes: 10_485_760 },
        },
      },
    },
  },
  agents: {
    defaults: {
      workspace,
      ...(primaryModel
        ? {
            model: {
              primary: primaryModel,
              // OpenClaw model failover: on failover-worthy errors (timeout /
              // rate limit / auth failure / provider outage) the turn retries
              // with the next candidate; turn-local — next turn back to primary.
              ...(fallbackModels.length > 0 ? { fallbacks: fallbackModels } : {}),
            },
          }
        : {}),
      ...(imageModel ? { imageModel: { primary: imageModel } } : {}),
      // Run-level ceiling (upstream OpenClaw default is 48h; we cap it lower
      // to bound runaway tool loops). 1800s accommodates long multi-tool
      // tasks (e.g. find-buyers crawls); provider idle timeouts stay lower
      // (see provider timeoutSeconds below).
      timeoutSeconds: Number(process.env.DEALCLAW_AGENT_RUN_TIMEOUT_SECONDS || 1800),
      // reasoning off (skip reasoning tokens — faster first-token + streaming)
      reasoningDefault: 'off',
      // Reasoning model + high thinking caused "思考过载" (b4083949 / 158a70e):
      // every tool step re-reasoned, final turn spent 6281 thinking chars to
      // emit 8 chars of answer, hitting the 15min run ceiling. Drop one notch
      // (high → medium) to bound thinking without disabling it.
      thinkingDefault: 'medium',
      // Sub-agent delegation: 'prefer' strongly instructs the main agent to
      // hand non-trivial work (find-buyers / 开发信 crawls) to sessions_spawn
      // sub-agents instead of grinding through it inline and hitting the run
      // ceiling. Sub-agents run with their own runTimeoutSeconds and push
      // results back via completion events.
      // - maxConcurrent: cap concurrent sub-agents per main session (fan-out bound).
      // - maxSpawnDepth: 1 = no nesting (default) — sub-agents cannot spawn
      //   further sub-agents, so only the main orchestrator can fan out.
      // - runTimeoutSeconds: sub-agent default run ceiling (7200s = 2h), 4x the
      //   main run ceiling (1800s) so delegated long tasks outlive the parent turn.
      subagents: {
        delegationMode: 'prefer',
        maxConcurrent: 4,
        maxSpawnDepth: 1,
        runTimeoutSeconds: 7200,
      },
      contextTokens: 1_000_000,
      typingMode: 'instant',
      // Multi-user tenants: each Feishu peer gets its own concurrent budget
      // instead of one global run slot.
      maxConcurrent: Number(process.env.DEALCLAW_AGENT_MAX_CONCURRENT || 5),
      userTimezone: timezone,
      memorySearch: { enabled: true, provider: 'none' },
      // Trim stale cache-tagged tool results so long single sessions don't
      // balloon towards the 131k window (mirrors the V/Makaron workstation).
      contextPruning: {
        mode: 'cache-ttl',
        ttl: '1m',
        keepLastAssistants: 1,
        softTrimRatio: 0.15,
        hardClearRatio: 0.25,
        minPrunableToolChars: 12_000,
      },
      // Safeguard compaction: summarise history instead of hard-failing when
      // the context overflows. Uses the dedicated compaction model when
      // configured, else the primary model (tenant gateway proxy).
      compaction: {
        mode: 'safeguard',
        reserveTokens: 50_000,
        keepRecentTokens: 8_000,
        reserveTokensFloor: 50_000,
        maxHistoryShare: 0.35,
        recentTurnsPreserve: 3,
        truncateAfterCompaction: true,
        timeoutSeconds: 360,
        ...((compactionModel || primaryModel) ? { model: compactionModel || primaryModel } : {}),
        notifyUser: true,
        qualityGuard: { enabled: true, maxRetries: 1 },
      },
      contextLimits: {
        toolResultMaxChars: 32_000,
      },
    },
    list: [
      {
        id: 'dealclaw',
        name: 'DealClaw',
        identity: { name: '出海精灵小元', emoji: '🤝' },
        workspace,
        // Auto-discover all skills from workspace skills/ directory
        skills: (() => {
          const skillsDir = path.join(workspace, 'skills');
          try {
            return fs.readdirSync(skillsDir).filter(name =>
              fs.statSync(path.join(skillsDir, name)).isDirectory()
            );
          } catch { return []; }
        })(),
        tools: {
          profile: 'coding',
          deny: deniedTools,
        },
      },
    ],
  },
  tools: {
    profile: 'coding',
    deny: deniedTools,
    elevated: { enabled: false },
  },
  plugins: {
    // Preserve the existing allow-list behavior for Feishu and personal Weixin;
    // append enterprise channel plugin IDs only when the tenant enables them.
    allow: [
      'feishu',
      'openclaw-weixin',
      ...(wecomBound ? ['wecom-openclaw-plugin'] : []),
      ...(dingtalkBound ? ['dingtalk-connector'] : []),
    ],
    load: {
      paths: pluginLoadPaths,
    },
    entries: {
      'dealclaw-billing': {
        enabled: true,
      },
      'dealclaw-contact': {
        enabled: true,
      },
      'dealclaw-chatlog': {
        enabled: true,
        // agent_end 属会话级钩子（读完整对话消息）：非 bundled 插件必须显式
        // 声明 allowConversationAccess=true，否则注册时被安全门静默拦截
        // （2026-08-31 Build #142 实证：typed hook "agent_end" blocked）。
        hooks: { allowConversationAccess: true },
      },
      ...(feishuDirect ? { feishu: { enabled: true } } : {}),
      ...(wechatBound ? { 'openclaw-weixin': { enabled: true } } : {}),
      ...(wecomBound ? { 'wecom-openclaw-plugin': { enabled: true } } : {}),
      ...(dingtalkBound ? { 'dingtalk-connector': { enabled: true } } : {}),
    },
  },
  ...(feishuDirect || wechatBound || wecomBound || dingtalkBound
    ? {
        channels: {
          ...(feishuDirect ? {
            feishu: {
              enabled: true,
              appId: feishuAppId,
              appSecret: { source: 'env', provider: 'default', id: 'DEALCLAW_APP_SECRET' },
              // D1: per-tenant isolated Feishu app — open DMs, zero onboarding.
              dmPolicy: 'open',
              allowFrom: ['*'],
              // Group policy: 'open' (respond in all groups) by default; set
              // DEALCLAW_FEISHU_GROUP_POLICY=allowlist to restrict to whitelist.
              groupPolicy: process.env.DEALCLAW_FEISHU_GROUP_POLICY || 'open',
              // Respond in groups without an explicit @mention by default;
              // set DEALCLAW_FEISHU_REQUIRE_MENTION=true to restore mention-gating.
              requireMention: process.env.DEALCLAW_FEISHU_REQUIRE_MENTION === 'true',
              streaming: true,
              // Show "typing…" indicator while the agent run is in flight.
              // Set DEALCLAW_FEISHU_TYPING_INDICATOR=false to disable (quota optimisation).
              typingIndicator: process.env.DEALCLAW_FEISHU_TYPING_INDICATOR !== 'false',
              // D2: full workplace tool suite (requires app scopes).
              tools: { doc: true, chat: true, wiki: true, drive: true, perm: true, bitable: true },
            },
          } : {}),
          ...(wechatBound ? {
            'openclaw-weixin': {
              enabled: true,
              // Account list comes from PVC state dir (accounts.json);
              // no appId/appSecret here — plugin manages credentials via QR login.
            },
          } : {}),
          ...(wecomBound ? {
            wecom: {
              enabled: true,
              connectionMode: 'websocket',
              botId: wecomBotId,
              // Plugin 2026.7.2 only accepts a string here; OpenClaw SecretRef is
              // not supported by this plugin version. openclaw.json is written 0600.
              secret: wecomSecret,
              dmPolicy: 'open',
              allowFrom: ['*'],
              groupPolicy: 'open',
            },
          } : {}),
          ...(dingtalkBound ? {
            'dingtalk-connector': {
              enabled: true,
              clientId: dingtalkClientId,
              clientSecret: { source: 'env', provider: 'default', id: 'DEALCLAW_DINGTALK_CLIENT_SECRET' },
              dmPolicy: 'open',
              allowFrom: ['*'],
              groupPolicy: 'open',
            },
          } : {}),
        },
      }
    : {}),
  // Group-chat history/visibility (mirrors the V/Makaron workstation): keep
  // a 50-message window and auto-publish replies in groups.
  messages: {
    groupChat: {
      historyLimit: 50,
      visibleReplies: 'automatic',
    },
    // In-flight user messages steer the current run (merged after a 1s
    // debounce) instead of queueing behind it — mirrors the workstation
    // config; kills the "second message waits minutes" UX. Set
    // DEALCLAW_MESSAGE_QUEUE_MODE=off to restore strict FIFO queueing.
    ...(process.env.DEALCLAW_MESSAGE_QUEUE_MODE !== 'off'
      ? {
          queue: {
            mode: process.env.DEALCLAW_MESSAGE_QUEUE_MODE || 'steer',
            debounceMs: 1_000,
            cap: 20,
            drop: 'summarize',
          },
        }
      : {}),
  },
  // DM session scope (priority order):
  //   1. sharedDmSession → 'main': all Feishu + WeChat DMs merge into one
  //      session (agent:dealclaw:main). DEFAULT ON unless
  //      DEALCLAW_SHARED_DM_SESSION is explicitly '0'. Highest priority.
  //   2. wechatBound → 'per-account-channel-peer': WeChat multi-account
  //      isolates DM sessions by account + channel + peer (reached only when
  //      the shared session is explicitly disabled).
  //   3. DEALCLAW_SESSION_DM_SCOPE escape-hatch → overrides the Feishu-only
  //      default (e.g. 'main' for legacy single-session behaviour).
  //   4. Default → 'per-channel-peer': each Feishu user gets an independent
  //      conversation.
  // Sessions are pruned after 14d to bound PVC growth.
  session: {
    dmScope: sharedDmSession
      ? 'main'
      : wechatBound
        ? 'per-account-channel-peer'
        : (process.env.DEALCLAW_SESSION_DM_SCOPE || 'per-channel-peer'),
    maintenance: {
      mode: 'enforce',
      pruneAfter: '14d',
      maxEntries: 500,
      resetArchiveRetention: '14d',
    },
  },
  logging: {
    redactSensitive: 'tools',
  },
};

fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
// writeFileSync's mode only applies when creating a file. Enforce owner-only
// permissions after every rewrite because WeCom's plugin schema requires its
// secret to be materialized as a string in this file.
fs.chmodSync(configPath, 0o600);
console.log(`[dealclaw-runtime] wrote OpenClaw config: ${configPath}`);
