import { Router, type Request, type Response, type NextFunction } from 'express';
import type pg from 'pg';
import {
  PRESET_RUNTIME_KEYS,
  upsertRuntimeConfig,
  deleteRuntimeConfig,
  listRuntimeConfigs,
  validateConfigKey,
} from '../services/runtime-config.js';
import { getMasterKey, MasterKeyError } from '../services/crypto.js';
import {
  pushSkillEnvToAllTenants,
  pushTenantSkillEnv,
  ENV_FROM_ONLY_KEYS,
} from '../services/skill-env.js';
import {
  LLM_PROVIDERS_KEY,
  LLM_MODEL_SELECTION_KEY,
  LlmProvidersError,
  pushLlmProviders,
  getGlobalLlmProviders,
  getTenantModelSelection,
  resolveEffectiveLlmProviders,
  validateLlmProviders,
  modelExistsIn,
  visionModelExistsIn,
} from '../services/llm-providers.js';
import type { ProvisioningConfig } from '../config.js';

/**
 * Admin API for per-tenant runtime configuration.
 *
 * Mounted with the same Bearer-token auth as the tenant routes
 * (PROVISIONING_API_TOKEN); the admin-web SPA calls these endpoints directly.
 *
 * Scope semantics: tenantId omitted/null → global defaults; tenantId set →
 * per-tenant override. Resolution at provisioning time merges the two,
 * tenant rows winning.
 *
 * After every write, the affected skill-env Secret(s) are pushed so existing
 * tenants pick the new value up hot (kubelet refreshes the mounted .env —
 * see services/skill-env.ts). The response carries a `push` summary and a
 * human-readable `hint` about the effective time for the admin UI.
 */
export function createRuntimeConfigRoutes(
  pool: pg.Pool,
  config: ProvisioningConfig,
  authMiddleware?: (req: Request, res: Response, next: NextFunction) => void,
) {
  const router = Router();

  if (authMiddleware) {
    router.use(authMiddleware);
  }

  function masterKeyAvailable(): boolean {
    try {
      return getMasterKey() !== null;
    } catch {
      return false;
    }
  }

  async function tenantExists(tenantId: string): Promise<boolean> {
    const { rows } = await pool.query('SELECT 1 FROM tenants WHERE tenant_id = $1', [tenantId]);
    return rows.length > 0;
  }

  /**
   * Push the affected skill-env Secret(s) after a write. Best-effort: the
   * config row is already saved, so a push failure must not fail the request
   * — it is surfaced in the response for the UI to display.
   */
  async function pushAfterWrite(scope: string | null): Promise<{
    status: 'ok' | 'failed' | 'skipped';
    rollout?: string;
    detail?: string;
    hint: string;
    tenants?: Array<{ tenantId: string; ok: boolean }>;
  }> {
    try {
      if (scope) {
        const r = await pushTenantSkillEnv(pool, config, scope);
        return {
          status: 'ok',
          rollout: r.rollout,
          detail: r.warnings.join('；') || undefined,
          hint: r.hint,
        };
      }
      const r = await pushSkillEnvToAllTenants(pool, config);
      const failed = r.tenants.filter((t) => !t.ok);
      return {
        status: 'ok',
        hint: r.hint + (failed.length ? `；${failed.length} 个租户推送失败（${failed[0].tenantId}：${failed[0].error}）` : ''),
        tenants: r.tenants.map((t) => ({ tenantId: t.tenantId, ok: t.ok })),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('skill-env push failed:', message);
      return {
        status: 'failed',
        detail: message,
        hint: '已保存，但推送到租户失败：可稍后在客户详情页点「同步到 agent」重试',
      };
    }
  }

  // GET /v1/admin/runtime-configs/presets — known keys for UI hints
  router.get('/v1/admin/runtime-configs/presets', (_req: Request, res: Response) => {
    res.json({ presets: PRESET_RUNTIME_KEYS });
  });

  // GET /v1/admin/runtime-configs?tenantId=<id> — list one scope (masked values)
  router.get('/v1/admin/runtime-configs', async (req: Request, res: Response) => {
    try {
      const tenantId = typeof req.query.tenantId === 'string' && req.query.tenantId ? req.query.tenantId : null;
      if (tenantId && !(await tenantExists(tenantId))) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Tenant not found' });
        return;
      }
      const items = await listRuntimeConfigs(pool, tenantId, masterKeyAvailable());
      res.json({ items, tenantId, keyConfigured: masterKeyAvailable() });
    } catch (err) {
      console.error('listRuntimeConfigs failed:', err);
      res.status(500).json({ code: 'INTERNAL' });
    }
  });

  // PUT /v1/admin/runtime-configs — upsert one entry in the given scope
  router.put('/v1/admin/runtime-configs', async (req: Request, res: Response) => {
    try {
      const { tenantId, key, value, isSecret, description } = req.body ?? {};
      const scope = typeof tenantId === 'string' && tenantId ? tenantId : null;

      if (scope && !(await tenantExists(scope))) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Tenant not found' });
        return;
      }
      if (typeof isSecret !== 'undefined' && typeof isSecret !== 'boolean') {
        res.status(400).json({ code: 'VALIDATION', message: 'isSecret must be boolean' });
        return;
      }
      if (typeof description !== 'undefined' && typeof description !== 'string') {
        res.status(400).json({ code: 'VALIDATION', message: 'description must be string' });
        return;
      }
      // The LLM provider blob has a dedicated endpoint that also pushes the
      // tenant-config Secret + rolls the agent; block the generic path so it
      // can never be saved without being materialised.
      if (String(key) === LLM_PROVIDERS_KEY) {
        res.status(400).json({
          code: 'VALIDATION',
          message: 'LLM_PROVIDERS 请使用 /v1/admin/llm-providers 接口维护',
        });
        return;
      }
      if (String(key) === LLM_MODEL_SELECTION_KEY) {
        res.status(400).json({
          code: 'VALIDATION',
          message: 'LLM_MODEL_SELECTION 请使用 /v1/admin/llm-providers/selection 接口维护',
        });
        return;
      }

      await upsertRuntimeConfig(pool, { tenantId: scope, key, value, isSecret, description });

      // Model-provider keys (envFrom-only) intentionally skip the skill-env
      // push — they are consumed at container boot, not from .env.
      let push: Awaited<ReturnType<typeof pushAfterWrite>> = {
        status: 'skipped',
        hint: '该 key 仅在开通/重启时经 envFrom 注入，本次不推送（skill .env 不含此 key）',
      };
      if (!ENV_FROM_ONLY_KEYS.has(String(key))) {
        push = await pushAfterWrite(scope);
      }
      res.json({ ok: true, key, tenantId: scope, push });
    } catch (err) {
      if (err instanceof MasterKeyError) {
        res.status(503).json({ code: 'RUNTIME_CONFIG_KEY_NOT_CONFIGURED', message: err.message });
        return;
      }
      if (err instanceof Error && (err.message.startsWith('Invalid config key') || err.message.startsWith('Config value'))) {
        res.status(400).json({ code: 'VALIDATION', message: err.message });
        return;
      }
      console.error('upsertRuntimeConfig failed:', err);
      res.status(500).json({ code: 'INTERNAL' });
    }
  });

  // DELETE /v1/admin/runtime-configs/:key?tenantId=<id> — delete one scope entry
  router.delete('/v1/admin/runtime-configs/:key', async (req: Request, res: Response) => {
    try {
      const key = validateConfigKey(req.params.key);
      if (key === LLM_PROVIDERS_KEY) {
        res.status(400).json({
          code: 'VALIDATION',
          message: 'LLM_PROVIDERS 请使用 DELETE /v1/admin/llm-providers 维护',
        });
        return;
      }
      if (key === LLM_MODEL_SELECTION_KEY) {
        res.status(400).json({
          code: 'VALIDATION',
          message: 'LLM_MODEL_SELECTION 请使用 PUT /v1/admin/llm-providers/selection 维护',
        });
        return;
      }
      const tenantId = typeof req.query.tenantId === 'string' && req.query.tenantId ? req.query.tenantId : null;

      if (tenantId && !(await tenantExists(tenantId))) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Tenant not found' });
        return;
      }

      const deleted = await deleteRuntimeConfig(pool, tenantId, key);
      if (deleted === 0) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Config entry not found in this scope' });
        return;
      }
      const push = await pushAfterWrite(tenantId);
      res.json({ ok: true, key, tenantId, push });
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Invalid config key')) {
        res.status(400).json({ code: 'VALIDATION', message: err.message });
        return;
      }
      console.error('deleteRuntimeConfig failed:', err);
      res.status(500).json({ code: 'INTERNAL' });
    }
  });

  // ── LLM providers (大模型供应商集中管理) ────────────────────────────
  // The provider library lives in ONE GLOBAL runtime_configs row (key
  // LLM_PROVIDERS, encrypted JSON): providers with credentials + a global
  // default model. Tenants never hold credentials — each may store a model
  // SELECTION (LLM_MODEL_SELECTION, tenant scope) referencing the library.
  // Pushes materialise the effective blob (library + resolved default) into
  // the tenant-config Secret with a rolling restart.

  // GET /v1/admin/llm-providers[?tenantId=<id>] — the global library
  // (decrypted for editing); with tenantId also that tenant's selection and
  // the effective model.
  router.get('/v1/admin/llm-providers', async (req: Request, res: Response) => {
    try {
      const tenantId =
        typeof req.query.tenantId === 'string' && req.query.tenantId ? req.query.tenantId : null;
      if (tenantId && !(await tenantExists(tenantId))) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Tenant not found' });
        return;
      }
      const eff = await resolveEffectiveLlmProviders(pool, tenantId);
      res.json({
        config: eff.globalConfig,
        selection: eff.selection,
        effectiveModel: eff.effectiveModel,
        imageSelection: eff.imageSelection,
        effectiveImageModel: eff.effectiveImageModel,
        tenantId,
      });
    } catch (err) {
      console.error('GET llm-providers failed:', err);
      res.status(500).json({ code: 'INTERNAL' });
    }
  });

  // PUT /v1/admin/llm-providers — save the GLOBAL library + push all tenants
  router.put('/v1/admin/llm-providers', async (req: Request, res: Response) => {
    try {
      const { providers, defaultModel, imageModel } = req.body ?? {};

      const doc = validateLlmProviders({ providers, defaultModel, imageModel });

      // Snapshot the PREVIOUS library before overwriting — the differential
      // push uses it to roll only tenants whose live model actually changed.
      const prevLibrary = await getGlobalLlmProviders(pool);

      // Persist as a single encrypted runtime_configs row (empty provider
      // list is not allowed — use DELETE to clear the library instead).
      const blob = JSON.stringify(doc);
      await upsertRuntimeConfig(pool, {
        tenantId: null,
        key: LLM_PROVIDERS_KEY,
        value: blob,
        isSecret: true,
        description: '大模型供应商库（全局；agent 启动时经 envFrom 注入，改动需滚动重启生效）',
      });

      const push = await pushLlmProviders(pool, config, null, prevLibrary);
      res.json({ ok: true, push });
    } catch (err) {
      if (err instanceof MasterKeyError) {
        res.status(503).json({ code: 'RUNTIME_CONFIG_KEY_NOT_CONFIGURED', message: err.message });
        return;
      }
      if (err instanceof LlmProvidersError) {
        res.status(400).json({ code: 'VALIDATION', message: err.message });
        return;
      }
      console.error('PUT llm-providers failed:', err);
      res.status(500).json({ code: 'INTERNAL' });
    }
  });

  // DELETE /v1/admin/llm-providers — clear the global library + push all tenants
  router.delete('/v1/admin/llm-providers', async (_req: Request, res: Response) => {
    try {
      const prevLibrary = await getGlobalLlmProviders(pool);
      const deleted = await deleteRuntimeConfig(pool, null, LLM_PROVIDERS_KEY);
      if (deleted === 0) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'No LLM provider library configured' });
        return;
      }
      const push = await pushLlmProviders(pool, config, null, prevLibrary);
      res.json({ ok: true, push });
    } catch (err) {
      console.error('DELETE llm-providers failed:', err);
      res.status(500).json({ code: 'INTERNAL' });
    }
  });

  // ── Tenant model selection ─────────────────────────────────────────
  // GET /v1/admin/llm-providers/selection?tenantId=<id> — raw selection row
  // (even when it no longer resolves) + effective view, for the agent page.
  router.get('/v1/admin/llm-providers/selection', async (req: Request, res: Response) => {
    try {
      const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId : '';
      if (!tenantId || !(await tenantExists(tenantId))) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Tenant not found' });
        return;
      }
      const library = await getGlobalLlmProviders(pool);
      const rawSelection = await getTenantModelSelection(pool, tenantId);
      const eff = await resolveEffectiveLlmProviders(pool, tenantId);
      res.json({
        tenantId,
        rawSelection: rawSelection?.defaultModel ?? null,
        rawImageSelection: rawSelection?.imageModel ?? null,
        selection: eff.selection,
        effectiveModel: eff.effectiveModel,
        imageSelection: eff.imageSelection,
        effectiveImageModel: eff.effectiveImageModel,
        libraryEmpty: !library || library.providers.length === 0,
        globalDefaultModel: library?.defaultModel ?? null,
        globalImageModel: library?.imageModel ?? null,
        directMode: rawSelection?.directMode === true,
      });
    } catch (err) {
      console.error('GET llm-providers/selection failed:', err);
      res.status(500).json({ code: 'INTERNAL' });
    }
  });

  // PUT /v1/admin/llm-providers/selection — set/clear a tenant's model
  // selection (body: { tenantId, defaultModel?: '<p>/<m>' | null,
  // imageModel?: '<p>/<m>' | null }) and roll just that tenant's agent.
  // Missing keys keep the existing value; null/'' clears that slot.
  router.put('/v1/admin/llm-providers/selection', async (req: Request, res: Response) => {
    try {
      const { tenantId } = req.body ?? {};
      if (typeof tenantId !== 'string' || !tenantId || !(await tenantExists(tenantId))) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Tenant not found' });
        return;
      }

      const library = await getGlobalLlmProviders(pool);
      const libraryEmpty = !library || library.providers.length === 0;

      // Explicitly-provided keys (string OR null) override; missing keys keep
      // the tenant's current value. null/'' clears that slot.
      const body = (req.body ?? {}) as Record<string, unknown>;
      const hasDefaultKey = 'defaultModel' in body;
      const hasImageKey = 'imageModel' in body;
      const hasDirectKey = 'directMode' in body;

      const ref = typeof body.defaultModel === 'string' ? body.defaultModel.trim() : '';
      const imgRef = typeof body.imageModel === 'string' ? body.imageModel.trim() : '';

      // A selection row exists when at least one model is chosen. Direct mode
      // is a separate tenant-level switch — keep it even when the tenant
      // follows the global default model (nextDefault/nextImage both null).
      const current = await getTenantModelSelection(pool, tenantId);

      const nextDefault = hasDefaultKey
        ? ref || null
        : current?.defaultModel ?? null;
      const nextImage = hasImageKey
        ? imgRef || null
        : current?.imageModel ?? null;
      const nextDirect = hasDirectKey
        ? body.directMode === true
        : current?.directMode === true;

      if (nextDefault || nextImage || nextDirect) {
        if (nextDefault && libraryEmpty) {
          res.status(400).json({
            code: 'VALIDATION',
            message: '供应商库为空：请先在「模型供应商」页添加供应商并设置默认模型',
          });
          return;
        }
        if (nextDefault && !modelExistsIn(library!, nextDefault)) {
          res.status(400).json({
            code: 'VALIDATION',
            message: `模型 ${nextDefault} 不在全局供应商库中（请重新选择）`,
          });
          return;
        }
        if (nextImage && !visionModelExistsIn(library!, nextImage)) {
          res.status(400).json({
            code: 'VALIDATION',
            message: `视觉模型 ${nextImage} 不在库中或未标记为视觉模型（请重新选择）`,
          });
          return;
        }
        await upsertRuntimeConfig(pool, {
          tenantId,
          key: LLM_MODEL_SELECTION_KEY,
          value: JSON.stringify({ defaultModel: nextDefault, imageModel: nextImage, directMode: nextDirect }),
          isSecret: false,
          description: '租户模型选择（引用全局供应商库，默认跟随系统默认；directMode 控制是否绕过网关直连上游）',
        });
      } else {
        // No model chosen and direct mode off — clear the selection row;
        // the tenant follows the global default again.
        await deleteRuntimeConfig(pool, tenantId, LLM_MODEL_SELECTION_KEY);
      }

      const push = await pushLlmProviders(pool, config, tenantId);
      res.json({
        ok: true,
        tenantId,
        selection: nextDefault,
        imageSelection: nextImage,
        directMode: nextDirect,
        push,
      });
    } catch (err) {
      if (err instanceof MasterKeyError) {
        res.status(503).json({ code: 'RUNTIME_CONFIG_KEY_NOT_CONFIGURED', message: err.message });
        return;
      }
      if (err instanceof LlmProvidersError) {
        res.status(400).json({ code: 'VALIDATION', message: err.message });
        return;
      }
      console.error('PUT llm-providers/selection failed:', err);
      res.status(500).json({ code: 'INTERNAL' });
    }
  });

  return router;
}
