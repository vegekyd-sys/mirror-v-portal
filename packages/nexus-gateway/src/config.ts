import type { KeyConfig, PlanTier } from './types/index.js';

export interface GatewayConfig {
  port: number;
  tenantId: string;
  /** 'web' = no IM channel; the gateway runs as the tenant's LLM egress proxy only. */
  platform: 'feishu' | 'dingtalk' | 'wecom' | 'web';
  planTier: PlanTier;
  agentUrl: string;
  // B3 FIX: credits-ledger URL for HTTP debit/balance calls
  creditsLedgerUrl: string;
  // B3 FIX: shared service token for credits-ledger auth (optional)
  creditsLedgerToken?: string;
  keyConfig: KeyConfig;
  // B4 FIX: bot secret for signature verification
  botSecret?: string;
  allowedAppIds?: string[];
  initialCredits: number;
  // WSClient — Feishu app credentials for long-connection
  appId?: string;
  appSecret?: string;
  // Contact writeback — where to report the sender's im_open_id so ops-agent
  // lifecycle notifications can be delivered (see central-gateway notify relay).
  provisioningServiceUrl?: string;
  provisioningApiToken?: string;
  /**
   * External chat forward timeouts (ms). Non-stream /v1/external/chat waits
   * for the full agent run; stream /v1/external/chat/stream covers the whole
   * SSE lifetime. Both env-tunable because agent runs (long LLM chains,
   * tool loops, session-lane queueing behind compaction) routinely exceed
   * the old hardcoded 120s and surfaced as spurious 504s.
   */
  externalChatTimeoutMs: number;
  externalChatStreamTimeoutMs: number;
  /**
   * LLM egress proxy — provider name → real upstream base URL. Injected via
   * the `llm-proxy-config` Secret (env LLM_UPSTREAMS, JSON) written by
   * provisioning-service at provider-library push time. Empty when the tenant
   * has no library configured (proxy routes then 404).
   */
  llmUpstreams: Record<string, string>;
  /** Runtime contract mode (default: v1). */
  runtimeContractMode?: 'v1' | 'shadow' | 'v2';
  /**
   * V2 route lookup map: runtimeKey/alias → route entry.
   * Built at config load time when mode=v2. Null/undefined in v1/shadow.
   */
  llmRouteMapV2?: Map<string, V2RouteEntry> | null;
  /**
   * Release ID from the V2 routes JSON (top-level `releaseId` field).
   * Populated in v2 mode when the V2 routes JSON includes it; null otherwise.
   */
  releaseIdV2?: string | null;
}

/** A single V2 gateway route entry (parsed from LLM_RUNTIME_ROUTES_V2). */
export interface V2RouteEntry {
  runtimeKey: string;
  aliases: string[];
  providerId: string;
  upstreamBaseUrl: string;
  models: Array<{ modelId: string; upstreamModel: string }>;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

// ── Runtime Contract V2 (shadow dual-read) ────────────────────────────
// LLM_RUNTIME_CONTRACT_MODE: 'v1' (default) | 'shadow' | 'v2'
// LLM_RUNTIME_ROUTES_V2: JSON of GatewayRuntimePayloadV2 { routes: [...] }
//
// - v1:     Use LLM_UPSTREAMS only. Legacy behaviour, unchanged.
// - shadow: LLM_UPSTREAMS is the active routing source. Additionally parse
//           LLM_RUNTIME_ROUTES_V2, compare route targets, log mismatches.
//           Never blocks — V1 remains the routing authority.
// - v2:     LLM_RUNTIME_ROUTES_V2 is the sole routing source. Validate
//           strictly, build a routeKey/alias → entry map, and fail closed
//           on any error or alias conflict.

/** Result of validating the V2 routes JSON. */
interface V2RoutesResult {
  routes: V2RouteEntry[];
  /** Release ID from the V2 routes JSON top-level field (null if absent). */
  releaseId: string | null;
}

/**
 * Validate a parsed LLM_RUNTIME_ROUTES_V2 JSON object.
 * Returns the validated routes array + optional releaseId, or throws on
 * structural violations.
 */
function validateV2Routes(raw: unknown): V2RoutesResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('LLM_RUNTIME_ROUTES_V2: expected object with "routes" array');
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.routes)) {
    throw new Error('LLM_RUNTIME_ROUTES_V2: expected "routes" array');
  }
  const releaseId = typeof obj.releaseId === 'string' && obj.releaseId ? obj.releaseId : null;
  const routes: V2RouteEntry[] = [];
  for (let i = 0; i < obj.routes.length; i++) {
    const r = obj.routes[i];
    if (typeof r !== 'object' || r === null || Array.isArray(r)) {
      throw new Error(`LLM_RUNTIME_ROUTES_V2: routes[${i}] expected object`);
    }
    const rt = r as Record<string, unknown>;
    if (typeof rt.runtimeKey !== 'string' || !rt.runtimeKey) {
      throw new Error(`LLM_RUNTIME_ROUTES_V2: routes[${i}].runtimeKey expected non-empty string`);
    }
    if (typeof rt.providerId !== 'string' || !rt.providerId) {
      throw new Error(`LLM_RUNTIME_ROUTES_V2: routes[${i}].providerId expected non-empty string`);
    }
    if (typeof rt.upstreamBaseUrl !== 'string' || !/^https?:\/\//.test(rt.upstreamBaseUrl)) {
      throw new Error(`LLM_RUNTIME_ROUTES_V2: routes[${i}].upstreamBaseUrl expected http(s) URL`);
    }
    const aliases = Array.isArray(rt.aliases) ? rt.aliases.filter((a: unknown) => typeof a === 'string' && a.length > 0) as string[] : [];
    let models: V2RouteEntry['models'] = [];
    if (Array.isArray(rt.models)) {
      models = rt.models.map((m: unknown, j: number) => {
        if (typeof m !== 'object' || m === null || Array.isArray(m)) {
          throw new Error(`LLM_RUNTIME_ROUTES_V2: routes[${i}].models[${j}] expected object`);
        }
        const mo = m as Record<string, unknown>;
        if (typeof mo.modelId !== 'string' || !mo.modelId) {
          throw new Error(`LLM_RUNTIME_ROUTES_V2: routes[${i}].models[${j}].modelId expected non-empty string`);
        }
        if (typeof mo.upstreamModel !== 'string' || !mo.upstreamModel) {
          throw new Error(`LLM_RUNTIME_ROUTES_V2: routes[${i}].models[${j}].upstreamModel expected non-empty string`);
        }
        return { modelId: mo.modelId, upstreamModel: mo.upstreamModel };
      });
    }
    routes.push({
      runtimeKey: rt.runtimeKey,
      aliases,
      providerId: rt.providerId,
      upstreamBaseUrl: rt.upstreamBaseUrl.replace(/\/+$/, ''),
      models,
    });
  }
  return { routes, releaseId };
}

/**
 * Build a route lookup map from validated V2 routes.
 * Each runtimeKey and alias is registered as a key → route entry.
 * Throws on alias/runtimeKey conflicts (fail-closed at startup).
 */
function buildV2RouteMap(routes: V2RouteEntry[]): Map<string, V2RouteEntry> {
  const map = new Map<string, V2RouteEntry>();
  for (const route of routes) {
    // Register runtimeKey
    if (map.has(route.runtimeKey)) {
      const existing = map.get(route.runtimeKey)!;
      throw new Error(
        `LLM_RUNTIME_ROUTES_V2: alias conflict — runtimeKey "${route.runtimeKey}" ` +
        `is shared by providerId "${existing.providerId}" and "${route.providerId}" (fail-closed)`,
      );
    }
    map.set(route.runtimeKey, route);
    // Register aliases
    for (const alias of route.aliases) {
      if (map.has(alias)) {
        const existing = map.get(alias)!;
        const existingLabel = existing.runtimeKey === route.runtimeKey
          ? `alias of "${existing.runtimeKey}"`
          : `runtimeKey/alias of "${existing.runtimeKey}"`;
        throw new Error(
          `LLM_RUNTIME_ROUTES_V2: alias conflict — "${alias}" is registered to ` +
          `${existingLabel} (providerId "${existing.providerId}") and also to ` +
          `route "${route.runtimeKey}" (providerId "${route.providerId}") (fail-closed)`,
        );
      }
      map.set(alias, route);
    }
  }
  return map;
}

/**
 * Compare V1 upstreams with V2 routes for structural drift.
 * Logs mismatches (warn) but never throws — shadow mode is non-blocking.
 * Does NOT log API keys or secrets — only route targets (runtimeKey, baseUrl).
 */
function compareV1V2Routes(v1: Record<string, string>, v2: V2RouteEntry[]): void {
  const v1Keys = new Set(Object.keys(v1));
  const v2Keys = new Set(v2.map(r => r.runtimeKey));
  const v2AliasKeys = new Set(v2.flatMap(r => r.aliases));

  // V1 providers not in V2 routes
  for (const k of v1Keys) {
    if (!v2Keys.has(k) && !v2AliasKeys.has(k)) {
      console.warn(`[config] shadow mismatch: V1 provider "${k}" has no matching V2 route or alias`);
    }
  }

  // V2 routes not in V1
  for (const route of v2) {
    if (!v1Keys.has(route.runtimeKey)) {
      // Check if any alias matches a V1 key
      const aliasMatch = route.aliases.find(a => v1Keys.has(a));
      if (!aliasMatch) {
        console.warn(`[config] shadow mismatch: V2 route "${route.runtimeKey}" (providerId "${route.providerId}") has no matching V1 provider`);
      }
    }
  }

  // URL target comparison for matching routes
  for (const route of v2) {
    const v1Url = v1[route.runtimeKey];
    if (v1Url && v1Url.replace(/\/+$/, '') !== route.upstreamBaseUrl) {
      console.warn(
        `[config] shadow mismatch: route "${route.runtimeKey}" baseUrl ` +
        `v1=${v1Url.replace(/\/+$/, '')} v2=${route.upstreamBaseUrl}`,
      );
    }
    // Also check aliases
    for (const alias of route.aliases) {
      const v1AliasUrl = v1[alias];
      if (v1AliasUrl && v1AliasUrl.replace(/\/+$/, '') !== route.upstreamBaseUrl) {
        console.warn(
          `[config] shadow mismatch: alias "${alias}" baseUrl ` +
          `v1=${v1AliasUrl.replace(/\/+$/, '')} v2=${route.upstreamBaseUrl}`,
        );
      }
    }
  }

  // Summary
  const v1Count = v1Keys.size;
  const v2Count = v2.length;
  if (v1Count === v2Count) {
    console.log(`[config] shadow: V1 (${v1Count} provider(s)) and V2 (${v2Count} route(s)) route counts match`);
  } else {
    console.warn(`[config] shadow: route count mismatch — V1 has ${v1Count} provider(s), V2 has ${v2Count} route(s)`);
  }
}

export function loadConfig(): GatewayConfig {
  const tenantId = required('DEALCLAW_TENANT_ID');
  const platform = (process.env.DEALCLAW_PLATFORM ?? 'feishu') as GatewayConfig['platform'];

  if (!['feishu', 'dingtalk', 'wecom', 'web'].includes(platform)) {
    throw new Error(`Unsupported DEALCLAW_PLATFORM: ${platform}`);
  }

  // LLM egress proxy upstream map — JSON { "<providerName>": "<baseUrl>" }.
  // Written by provisioning-service into the llm-proxy-config Secret.
  let llmUpstreams: Record<string, string> = {};
  const upstreamsRaw = (process.env.LLM_UPSTREAMS || '').trim();
  if (upstreamsRaw) {
    try {
      const parsed = JSON.parse(upstreamsRaw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string' && /^https?:\/\//.test(v)) llmUpstreams[k] = v.replace(/\/+$/, '');
        }
      }
    } catch {
      console.warn('[config] LLM_UPSTREAMS is not valid JSON — LLM proxy disabled');
    }
  }

  // ── Runtime Contract V2 mode resolution ──────────────────────────────
  const runtimeContractMode = (process.env.LLM_RUNTIME_CONTRACT_MODE || 'v1') as 'v1' | 'shadow' | 'v2';
  let llmRouteMapV2: Map<string, V2RouteEntry> | null = null;
  let releaseIdV2: string | null = null;
  const v2RoutesRaw = (process.env.LLM_RUNTIME_ROUTES_V2 || '').trim();

  if (runtimeContractMode === 'v2') {
    if (!v2RoutesRaw || v2RoutesRaw === '{}') {
      // Empty V2 → no routes (all providers will 404)
      llmRouteMapV2 = new Map();
      console.warn('[config] V2 mode active with no routes — all LLM proxy calls will 404');
    } else {
      let v2Parsed: unknown;
      try {
        v2Parsed = JSON.parse(v2RoutesRaw);
      } catch {
        throw new Error('LLM_RUNTIME_ROUTES_V2 is not valid JSON (mode=v2, fail-closed)');
      }
      const v2Result = validateV2Routes(v2Parsed);
      llmRouteMapV2 = buildV2RouteMap(v2Result.routes); // throws on alias conflict
      releaseIdV2 = v2Result.releaseId;
      console.log(`[config] V2 contract active: ${v2Result.routes.length} route(s)${releaseIdV2 ? ` release=${releaseIdV2}` : ''}`);
    }
  } else if (runtimeContractMode === 'shadow') {
    if (v2RoutesRaw && v2RoutesRaw !== '{}') {
      try {
        const v2Parsed = JSON.parse(v2RoutesRaw);
        const v2Result = validateV2Routes(v2Parsed);
        compareV1V2Routes(llmUpstreams, v2Result.routes);
      } catch (err) {
        console.warn(`[config] shadow: V2 routes parse/validate failed — ${err instanceof Error ? err.message : err}`);
      }
    } else {
      console.warn('[config] shadow: LLM_RUNTIME_ROUTES_V2 is empty — no V2 comparison (V1 remains active)');
    }
  }

  return {
    port: Number(process.env.PORT ?? 8080),
    tenantId,
    platform,
    planTier: (process.env.DEALCLAW_PLAN_TIER ?? 'starter') as PlanTier,
    agentUrl: required('DEALCLAW_AGENT_URL'),
    // Tenant credits secrets carry DEALCLAW_-prefixed keys; keep the bare
    // names as aliases for local/dev runs.
    creditsLedgerUrl:
      process.env.DEALCLAW_CREDITS_LEDGER_URL ?? process.env.CREDITS_LEDGER_URL ?? 'http://credits-ledger:8081',
    creditsLedgerToken:
      process.env.DEALCLAW_CREDITS_LEDGER_TOKEN ?? process.env.CREDITS_LEDGER_TOKEN ?? process.env.BILLING_SERVICE_TOKEN,
    initialCredits: Number(process.env.DEALCLAW_INITIAL_CREDITS ?? 0),
    botSecret: process.env.DEALCLAW_BOT_SECRET,
    allowedAppIds: process.env.DEALCLAW_ALLOWED_APP_IDS?.split(',').map(s => s.trim()),
    appId: process.env.DEALCLAW_APP_ID,
    appSecret: process.env.DEALCLAW_APP_SECRET,
    provisioningServiceUrl: process.env.PROVISIONING_SERVICE_URL,
    provisioningApiToken: process.env.PROVISIONING_API_TOKEN,
    externalChatTimeoutMs: Number(process.env.DEALCLAW_EXTERNAL_CHAT_TIMEOUT_MS ?? 300_000),
    externalChatStreamTimeoutMs: Number(process.env.DEALCLAW_EXTERNAL_CHAT_STREAM_TIMEOUT_MS ?? 600_000),
    llmUpstreams,
    runtimeContractMode,
    llmRouteMapV2,
    releaseIdV2,
    keyConfig: {
      customerKeyRef: required('DEALCLAW_CUSTOMER_KEY_REF'),
      botCredentialRef: required('DEALCLAW_BOT_CREDENTIAL_REF'),
      // 账户 id 统一归一化为 acct_<tenantId>（兼容历史 credits- 前缀的坏值）
      creditsAccountId: (() => {
        const raw = process.env.DEALCLAW_CREDITS_ACCOUNT_ID;
        if (!raw) return `acct_${tenantId}`;
        return `acct_${raw.replace(/^acct_/, '').replace(/^credits-/, '')}`;
      })(),
      configVersion: process.env.DEALCLAW_CONFIG_VERSION ?? '1',
    },
  };
}
