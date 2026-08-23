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
  LlmProvidersError,
  pushLlmProviders,
  resolveLlmProviders,
  validateLlmProviders,
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

  // ── LLM providers (大模型提供商) ────────────────────────────────────
  // The provider set lives in ONE runtime_configs row (key LLM_PROVIDERS,
  // encrypted JSON). These endpoints round-trip the decrypted document so
  // the admin form can edit real values, then materialise it into the
  // affected tenants' tenant-config Secrets with a rolling restart.

  // GET /v1/admin/llm-providers?tenantId=<id> — effective doc for the scope
  router.get('/v1/admin/llm-providers', async (req: Request, res: Response) => {
    try {
      const tenantId =
        typeof req.query.tenantId === 'string' && req.query.tenantId ? req.query.tenantId : null;
      if (tenantId && !(await tenantExists(tenantId))) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Tenant not found' });
        return;
      }
      const r = await resolveLlmProviders(pool, tenantId);
      res.json({ ...r, tenantId });
    } catch (err) {
      console.error('resolveLlmProviders failed:', err);
      res.status(500).json({ code: 'INTERNAL' });
    }
  });

  // PUT /v1/admin/llm-providers — save + push the provider doc for one scope
  router.put('/v1/admin/llm-providers', async (req: Request, res: Response) => {
    try {
      const { tenantId, providers, defaultModel } = req.body ?? {};
      const scope = typeof tenantId === 'string' && tenantId ? tenantId : null;
      if (scope && !(await tenantExists(scope))) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Tenant not found' });
        return;
      }

      const doc = validateLlmProviders({ providers, defaultModel });

      // Persist as a single encrypted runtime_configs row (empty provider
      // list is not allowed — use DELETE to clear the scope instead).
      const blob = JSON.stringify(doc);
      await upsertRuntimeConfig(pool, {
        tenantId: scope,
        key: LLM_PROVIDERS_KEY,
        value: blob,
        isSecret: true,
        description: '大模型提供商配置（agent 启动时经 envFrom 注入，改动需滚动重启生效）',
      });

      const push = await pushLlmProviders(pool, config, scope);
      res.json({ ok: true, tenantId: scope, push });
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

  // DELETE /v1/admin/llm-providers?tenantId=<id> — clear the scope's doc
  router.delete('/v1/admin/llm-providers', async (req: Request, res: Response) => {
    try {
      const tenantId =
        typeof req.query.tenantId === 'string' && req.query.tenantId ? req.query.tenantId : null;
      if (tenantId && !(await tenantExists(tenantId))) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Tenant not found' });
        return;
      }
      const deleted = await deleteRuntimeConfig(pool, tenantId, LLM_PROVIDERS_KEY);
      if (deleted === 0) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'No LLM provider config in this scope' });
        return;
      }
      const push = await pushLlmProviders(pool, config, tenantId);
      res.json({ ok: true, tenantId, push });
    } catch (err) {
      console.error('DELETE llm-providers failed:', err);
      res.status(500).json({ code: 'INTERNAL' });
    }
  });

  return router;
}
