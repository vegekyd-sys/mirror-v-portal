import type pg from 'pg';
import type { ProvisioningConfig } from '../config.js';
import {
  deploymentExists,
  patchDeploymentEnvVar,
  restartDeployment,
} from './k8s-client.js';

/**
 * 存量租户 chatlog env backfill。
 *
 * 背景：dealclaw-chatlog 插件靠 agent Pod 的 `PROVISIONING_SERVICE_URL` +
 * `PROVISIONING_API_TOKEN` 两个环境变量决定是否上报对话（缺失则插件在
 * 启动时打印 "chat logging disabled" 并直接不注册）。这两个变量是在
 * 插件上线（~2026-08-30）之后才写进 provisionTenant 的 agent Deployment
 * env 列表的——存量租户的 Deployment 里没有 → 对话全 0。新租户走
 * provisionTenant 会自动带上，所以只有老企业是 0。
 *
 * 本函数遍历所有存量租户，幂等 patch 这两个 env（direct env 变更会触发
 * k8s 滚动更新），随后用 restartDeployment（scale 0→N）做一次干净重启，
 * 避免 RWO PVC 双 Pod 挂载 / SQLite 锁竞争。Idempotent：env 已存在且值
 * 一致时 patch 返回 false，可安全重跑。
 */
export interface ChatlogBackfillTenant {
  tenantId: string;
  namespace: string;
  patchedUrl: boolean;
  patchedToken: boolean;
  restarted: boolean;
  skipped: boolean;
  error?: string;
}

export interface ChatlogBackfillResult {
  tenants: ChatlogBackfillTenant[];
  summary: {
    total: number;
    patched: number;
    restarted: number;
    skipped: number;
    failed: number;
  };
}

export async function backfillChatlogEnv(
  pool: pg.Pool,
  config: ProvisioningConfig,
  opts: { restart?: boolean } = {},
): Promise<ChatlogBackfillResult> {
  const doRestart = opts.restart !== false;

  const { rows } = await pool.query(
    `SELECT tenant_id, k8s_namespace FROM tenants
      WHERE status <> 'destroyed' AND k8s_namespace IS NOT NULL
      ORDER BY created_at`,
  );

  const url =
    process.env.PROVISIONING_SERVICE_URL ||
    `http://provisioning-service.${config.runtimeNamespace}:8082`;
  const token = process.env.PROVISIONING_API_TOKEN || '';

  const tenants: ChatlogBackfillTenant[] = [];
  let patched = 0;
  let restarted = 0;
  let skipped = 0;
  let failed = 0;

  for (const r of rows as Array<{ tenant_id: string; k8s_namespace: string }>) {
    const tenantId = String(r.tenant_id);
    const namespace = r.k8s_namespace;
    const name = `dealclaw-agent-${tenantId}`;
    const t: ChatlogBackfillTenant = {
      tenantId,
      namespace,
      patchedUrl: false,
      patchedToken: false,
      restarted: false,
      skipped: false,
    };

    if (config.k8sDryRun) {
      t.skipped = true;
      skipped += 1;
      tenants.push(t);
      continue;
    }

    try {
      if (!(await deploymentExists(namespace, name))) {
        t.skipped = true;
        skipped += 1;
        tenants.push(t);
        continue;
      }

      t.patchedUrl = await patchDeploymentEnvVar(namespace, name, 'PROVISIONING_SERVICE_URL', url);
      // token 为空说明本服务自身也未配置鉴权 token——写空值无意义且可能
      // 覆盖已有正确值，跳过并在结果中体现（patchedToken=false）。
      if (token) {
        t.patchedToken = await patchDeploymentEnvVar(namespace, name, 'PROVISIONING_API_TOKEN', token);
      }

      if (doRestart) {
        t.restarted = await restartDeployment(namespace, name);
      }

      if (t.patchedUrl || t.patchedToken) patched += 1;
      if (t.restarted) restarted += 1;
      tenants.push(t);
    } catch (err: any) {
      t.error = err?.message || String(err);
      failed += 1;
      tenants.push(t);
    }
  }

  return {
    tenants,
    summary: { total: tenants.length, patched, restarted, skipped, failed },
  };
}
