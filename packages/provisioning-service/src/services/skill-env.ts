/**
 * Per-tenant skill-env (.env) hot-reload pipeline.
 *
 * Skill scripts inside dealclaw-agent (shell resolve_env helpers, Python
 * _client.py, apify tooling) read credentials from the conventional
 * `work/mio-api/.env` file at *invocation time* — every skill run is a fresh
 * process, so updating the file is enough to rotate keys without restarting
 * the agent.
 *
 * Pipeline (no rolling restart for key changes):
 *   admin-web edit → runtime_configs (global/tenant scope, encrypted)
 *     → this module builds the `.env` content and writes it as the single
 *       `.env` key of the `skill-env` Secret in the tenant namespace
 *     → kubelet refreshes the mounted Secret volume (~40-90s, atomic)
 *     → entrypoint.sh symlinks work/mio-api/.env → /run/secrets/skill-env/.env
 *     → next skill invocation reads the new value.
 *
 * One-time rollout: existing Deployments created before this feature lack the
 * Secret volume mount — the first push patches the Deployment to add it
 * (single rolling restart); afterwards key changes are hot.
 *
 * Model-provider keys (DEEPSEEK_API_KEY) stay envFrom-only: they are consumed
 * by write-config.mjs at container start and must NOT move to .env.
 */

import type pg from 'pg';
import { getSecret, putSecret, getDeployment, patchDeployment } from './k8s-client.js';
import { resolveTenantConfig } from './runtime-config.js';
import { decryptValue } from './crypto.js';
import type { ProvisioningConfig } from '../config.js';

export const SKILL_ENV_SECRET_NAME = 'skill-env';
export const SKILL_ENV_MOUNT_PATH = '/run/secrets/skill-env';
/** Volume mount secret file mode (group-readable for the fsGroup 1000). */
export const SKILL_ENV_DEFAULT_MODE = 0o440;

/**
 * Keys that never enter the .env file — model-provider credentials consumed
 * at container boot (write-config.mjs / entrypoint fail-closed check) via
 * the tenant-config Secret (envFrom).
 */
export const ENV_FROM_ONLY_KEYS = new Set(['DEEPSEEK_API_KEY']);

export class SkillEnvError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SkillEnvError';
  }
}

export interface EnvFileResult {
  content: string;
  /** Keys skipped because their value contains newlines (invalid in KEY=value). */
  skippedKeys: string[];
}

/**
 * Build the `.env` file content from the merged runtime config:
 * - DEEPSEEK_API_KEY (envFrom-only) excluded;
 * - MIO_CDP_SUPPLIER_ID (kept on the tenants row) injected when set;
 * - keys sorted alphabetically for stable diffs;
 * - multi-line values are skipped (would corrupt the KEY=value format).
 */
export function buildEnvFileContent(
  merged: Record<string, string>,
  mioCdpSupplierId?: string | null,
): EnvFileResult {
  const entries = new Map<string, string>();
  for (const [k, v] of Object.entries(merged)) {
    if (ENV_FROM_ONLY_KEYS.has(k)) continue;
    entries.set(k, v);
  }
  if (mioCdpSupplierId && !entries.has('MIO_CDP_SUPPLIER_ID')) {
    entries.set('MIO_CDP_SUPPLIER_ID', mioCdpSupplierId);
  }

  const skippedKeys: string[] = [];
  const lines: string[] = [];
  for (const k of [...entries.keys()].sort()) {
    const v = entries.get(k) as string;
    if (/[\r\n]/.test(v)) {
      skippedKeys.push(k);
      continue;
    }
    lines.push(`${k}=${v}`);
  }
  return { content: lines.join('\n') + (lines.length ? '\n' : ''), skippedKeys };
}

interface TenantRow {
  tenant_id: string;
  company_name: string | null;
  status: string;
  k8s_namespace: string | null;
  agent_endpoint: string | null;
  mio_cdp_supplier_id: string | null;
}

async function loadTenant(pool: pg.Pool, tenantId: string): Promise<TenantRow> {
  const { rows } = await pool.query<TenantRow>(
    `SELECT tenant_id, company_name, status, k8s_namespace, agent_endpoint, mio_cdp_supplier_id
       FROM tenants WHERE tenant_id = $1`,
    [tenantId],
  );
  if (!rows.length) {
    throw new SkillEnvError(404, 'NOT_FOUND', '租户不存在');
  }
  return rows[0];
}

export interface SkillEnvViewEntry {
  key: string;
  source: 'tenant' | 'global' | 'tenant-record';
  isSecret: boolean;
  description: string | null;
  updatedAt: string;
  displayValue: string;
}

export interface SkillEnvView {
  tenantId: string;
  mioCdpSupplierId: string | null;
  entries: SkillEnvViewEntry[];
}

/**
 * Effective skill-env view for the admin detail card: merged global defaults
 * + tenant overrides, each entry tagged with its scope. Values are masked
 * for secret entries (same policy as the runtime-configs list API).
 */
export async function getTenantSkillEnvView(
  pool: pg.Pool,
  tenantId: string,
  canDecrypt: boolean,
): Promise<SkillEnvView> {
  const tenant = await loadTenant(pool, tenantId);
  const { rows: globalRows } = await pool.query(
    `SELECT config_key, encrypted_value, is_secret, description, updated_at
       FROM runtime_configs WHERE tenant_id IS NULL`,
  );
  const { rows: tenantRows } = await pool.query(
    `SELECT config_key, encrypted_value, is_secret, description, updated_at
       FROM runtime_configs WHERE tenant_id = $1`,
    [tenantId],
  );

  const entries = new Map<string, SkillEnvViewEntry>();
  const add = (r: any, source: 'tenant' | 'global') => {
    let displayValue = '••••••••';
    if (!r.is_secret && canDecrypt) {
      try {
        displayValue = decryptValue(r.encrypted_value);
      } catch {
        displayValue = '(解密失败)';
      }
    }
    entries.set(r.config_key, {
      key: r.config_key,
      source,
      isSecret: r.is_secret,
      description: r.description ?? null,
      updatedAt: r.updated_at,
      displayValue,
    });
  };
  for (const r of globalRows) add(r, 'global');
  for (const r of tenantRows) add(r, 'tenant'); // tenant overrides win
  if (tenant.mio_cdp_supplier_id && !entries.has('MIO_CDP_SUPPLIER_ID')) {
    entries.set('MIO_CDP_SUPPLIER_ID', {
      key: 'MIO_CDP_SUPPLIER_ID',
      source: 'tenant-record',
      isSecret: false,
      description: 'Mio CDP 供应商 ID（来自客户档案，随 .env 下发）',
      updatedAt: '',
      displayValue: tenant.mio_cdp_supplier_id,
    });
  }
  // envFrom-only keys are irrelevant for the .env card.
  for (const k of ENV_FROM_ONLY_KEYS) entries.delete(k);

  return {
    tenantId,
    mioCdpSupplierId: tenant.mio_cdp_supplier_id,
    entries: [...entries.values()].sort((a, b) => a.key.localeCompare(b.key)),
  };
}

export interface UpdateSecretResult {
  /** True when the skill-env Secret content was (re)written in the cluster. */
  pushed: boolean;
  /** Skip reason when not pushed (dry-run / external agent / not provisioned). */
  skippedReason?: string;
  skippedKeys: string[];
}

/**
 * Rebuild the .env content from runtime_configs (+ supplier id) and rewrite
 * the tenant's skill-env Secret. No Deployment change, no restart — running
 * agents pick the new file up via kubelet's automatic Secret refresh.
 */
export async function updateSkillEnvSecret(
  pool: pg.Pool,
  config: ProvisioningConfig,
  tenantId: string,
): Promise<UpdateSecretResult> {
  const tenant = await loadTenant(pool, tenantId);
  const hasOwnAgent = Boolean(tenant.k8s_namespace) && !tenant.agent_endpoint;
  if (config.k8sDryRun) {
    return { pushed: false, skippedReason: 'dry-run', skippedKeys: [] };
  }
  if (!hasOwnAgent) {
    return { pushed: false, skippedReason: 'no-own-agent', skippedKeys: [] };
  }

  const merged = await resolveTenantConfig(pool, tenantId);
  const { content, skippedKeys } = buildEnvFileContent(merged, tenant.mio_cdp_supplier_id);
  await putSecret(tenant.k8s_namespace as string, SKILL_ENV_SECRET_NAME, { '.env': content });
  return { pushed: true, skippedKeys };
}

export type SkillEnvRollout = 'none' | 'restarted' | 'skipped';

export interface PushResult {
  ok: true;
  tenantId: string;
  /** True when the Secret was rewritten in the tenant namespace. */
  secretUpdated: boolean;
  rollout: SkillEnvRollout;
  skippedReason?: string;
  skippedKeys: string[];
  warnings: string[];
  /** Human-readable effective-time hint for the admin UI. */
  hint: string;
}

export const HINT_HOT = '已推送：约 1 分钟内自动生效（无需重启，skill 下次调用即用新值）';
export const HINT_FIRST_MOUNT =
  '已推送并完成首次挂载：agent 将滚动重启一次（约 10–30 秒），此后修改 Key 不再需要重启，约 1 分钟内生效';
export const HINT_SKIPPED = '已保存：该租户无独立 agent（或处于 dry-run），未推送';
export const HINT_FAILED = '已保存，但推送失败：可稍后在客户详情页点「同步到 agent」重试';

/**
 * Full push: rewrite the skill-env Secret AND make sure the agent Deployment
 * mounts it. Adding the volume to a pre-existing Deployment changes the pod
 * template → exactly one rolling restart (rollout='restarted'); on subsequent
 * pushes the mount is already there → rollout='none' (hot).
 */
export async function pushTenantSkillEnv(
  pool: pg.Pool,
  config: ProvisioningConfig,
  tenantId: string,
): Promise<PushResult> {
  const tenant = await loadTenant(pool, tenantId);
  if (tenant.status === 'destroyed') {
    throw new SkillEnvError(400, 'TENANT_DESTROYED', '租户已销毁，无法推送');
  }
  const hasOwnAgent = Boolean(tenant.k8s_namespace) && !tenant.agent_endpoint;

  if (config.k8sDryRun || !hasOwnAgent) {
    return {
      ok: true,
      tenantId,
      secretUpdated: false,
      rollout: 'skipped',
      skippedReason: config.k8sDryRun ? 'dry-run' : 'no-own-agent',
      skippedKeys: [],
      warnings: [],
      hint: HINT_SKIPPED,
    };
  }

  const warnings: string[] = [];
  const merged = await resolveTenantConfig(pool, tenantId);
  const { content, skippedKeys } = buildEnvFileContent(merged, tenant.mio_cdp_supplier_id);
  if (skippedKeys.length) {
    warnings.push(`以下 key 的值含换行、未写入 .env：${skippedKeys.join(', ')}`);
  }
  const namespace = tenant.k8s_namespace as string;
  await putSecret(namespace, SKILL_ENV_SECRET_NAME, { '.env': content });

  // Also strip skill keys from the legacy tenant-config Secret so stale
  // envFrom values (from provisioning time) cannot shadow the hot .env file
  // after the next pod start. envFrom-only keys are preserved.
  try {
    const existing = await getSecret(namespace, 'tenant-config');
    if (existing) {
      const decoded: Record<string, string> = {};
      for (const [k, v] of Object.entries(existing.data)) {
        try {
          decoded[k] = Buffer.from(v, 'base64').toString('utf8');
        } catch {
          decoded[k] = v;
        }
      }
      const envFromKeys = Object.keys(decoded).filter((k) => ENV_FROM_ONLY_KEYS.has(k));
      const staleKeys = Object.keys(decoded).filter((k) => !ENV_FROM_ONLY_KEYS.has(k));
      if (staleKeys.length) {
        const next: Record<string, string> = {};
        for (const k of envFromKeys) next[k] = decoded[k];
        await putSecret(namespace, 'tenant-config', next);
        warnings.push(`已从 tenant-config Secret 移除 skill 专用 key（${staleKeys.join(', ')}），避免旧值遮蔽 .env`);
      }
    }
  } catch (err) {
    // Best-effort cleanup — a failure here must not fail the whole push.
    warnings.push(`tenant-config Secret 清理失败（不影响本次推送）：${err instanceof Error ? err.message : String(err)}`);
  }

  // Ensure the Deployment mounts the Secret volume. One-time: the patch only
  // fires when the volume/mount is missing.
  const agentDeployment = `dealclaw-agent-${tenantId}`;
  let rollout: SkillEnvRollout = 'none';
  let deploymentMissing = false;
  try {
    const dep = await getDeployment(namespace, agentDeployment);
    if (!dep) {
      // Deployment absent (e.g. mid deprovision / not yet created): the Secret
      // is already written; the next provisioning run creates the Deployment
      // with the skill-env mount baked in, so there is nothing to patch here.
      rollout = 'skipped';
      deploymentMissing = true;
      warnings.push('Deployment 不存在（可能正在回收或重建），已跳过挂载检查；下次创建 agent 时会自动挂载 skill-env');
    } else {
      const podSpec = dep.spec?.template?.spec ?? {};
      const containers: Array<Record<string, any>> = podSpec.containers ?? [];
      const agent = containers.find((c) => (c.name ?? '') === agentDeployment) ?? containers[0];
      const hasVolume = (podSpec.volumes ?? []).some((v: any) => v?.name === 'skill-env');
      const hasMount = (agent?.volumeMounts ?? []).some((m: any) => m?.name === 'skill-env');
      if (!hasVolume || !hasMount) {
        const patched = await patchDeployment(namespace, agentDeployment, {
          spec: {
            template: {
              spec: {
                volumes: [
                  {
                    name: 'skill-env',
                    secret: { secretName: SKILL_ENV_SECRET_NAME, defaultMode: SKILL_ENV_DEFAULT_MODE },
                  },
                ],
                containers: [
                  {
                    name: agent?.name ?? agentDeployment,
                    volumeMounts: [
                      { name: 'skill-env', mountPath: SKILL_ENV_MOUNT_PATH, readOnly: true },
                    ],
                  },
                ],
              },
            },
          },
        });
        rollout = patched ? 'restarted' : 'skipped';
      }
    }
  } catch (err) {
    const e = err as any;
    if (!/404|not found/i.test(e?.message || '')) {
      warnings.push(`Deployment 挂载检查失败（Key 已写入 Secret，重启后会生效）：${e?.message || err}`);
    } else {
      rollout = 'skipped';
    }
  }

  const hint =
    rollout === 'restarted'
      ? HINT_FIRST_MOUNT
      : rollout === 'skipped' && deploymentMissing
        ? '已推送：agent Deployment 当前不存在（可能在回收/重建中），下次创建 agent 时自动带上新 Key'
        : HINT_HOT;

  await pool.query(
    `INSERT INTO tenant_status_log (tenant_id, from_status, to_status, reason)
     VALUES ($1, $2, $2, $3)`,
    [
      tenantId,
      tenant.status,
      `skill-env Secret pushed${rollout === 'restarted' ? ' (agent deployment patched to mount it — one rollout)' : ''}${skippedKeys.length ? `; skipped: ${skippedKeys.join(',')}` : ''}`,
    ],
  );

  return {
    ok: true,
    tenantId,
    secretUpdated: true,
    rollout,
    skippedKeys,
    warnings,
    hint,
  };
}

export interface PushAllResult {
  tenants: Array<{ tenantId: string; ok: boolean; rollout?: SkillEnvRollout; error?: string }>;
  hint: string;
}

/**
 * Push the skill-env Secret to every live tenant with its own agent
 * (used when a *global-default* runtime config changes). Sequential to keep
 * API-server load bounded; per-tenant failures are collected, not thrown.
 */
export async function pushSkillEnvToAllTenants(
  pool: pg.Pool,
  config: ProvisioningConfig,
): Promise<PushAllResult> {
  const { rows } = await pool.query(
    `SELECT tenant_id FROM tenants
      WHERE status <> 'destroyed' AND k8s_namespace IS NOT NULL AND agent_endpoint IS NULL
      ORDER BY created_at`,
  );
  const results: PushAllResult['tenants'] = [];
  for (const r of rows) {
    try {
      const res = await pushTenantSkillEnv(pool, config, r.tenant_id);
      results.push({ tenantId: r.tenant_id, ok: true, rollout: res.rollout });
    } catch (err) {
      results.push({
        tenantId: r.tenant_id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const okCount = results.filter((r) => r.ok).length;
  const firstMounts = results.filter((r) => r.rollout === 'restarted').length;
  const hint =
    okCount === 0
      ? '没有需要推送的租户'
      : firstMounts > 0
        ? `已推送 ${okCount}/${results.length} 个租户；其中 ${firstMounts} 个首次挂载会滚动重启一次，其余约 1 分钟内热生效`
        : `已推送 ${okCount}/${results.length} 个租户：约 1 分钟内自动生效（无需重启，skill 下次调用即用新值）`;
  return { tenants: results, hint };
}
