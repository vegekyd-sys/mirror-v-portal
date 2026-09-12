import type { OpsConfig } from '../config.js';

export interface RolloutTarget {
  service: 'dealclaw-agent' | 'nexus-gateway';
  image: string;
}

export interface RolloutResult {
  timestamp: string;
  service: string;
  image: string;
  updated: number;
  total: number;
  failed: number;
  durationMs: number;
  error?: string;
}

interface BatchResponse {
  ok: boolean;
  updated: number;
  total: number;
  failed: number;
  skipped?: number;
  alreadyCurrent?: number;
  pinned?: number;
  results?: Array<{ tenantId: string; ok: boolean; skipped?: boolean; alreadyCurrent?: boolean; pinned?: boolean; error?: string }>;
  code?: string;
  message?: string;
}

/**
 * Fetch admin-promoted rollout targets from provisioning-service
 * (GET /v1/admin/rollout-targets, backed by the rollout_targets table and
 * managed via the admin console's image release page). Returns an empty map
 * on any error so the env-var fallback keeps working.
 */
async function fetchPromotedTargets(
  baseUrl: string,
  token: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const res = await fetch(`${baseUrl}/v1/admin/rollout-targets`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return map;
    const body = (await res.json()) as { ok?: boolean; targets?: Array<{ service: string; tag: string }> };
    for (const t of body.targets ?? []) {
      if (t?.service && t?.tag) map.set(t.service, t.tag);
    }
  } catch (err) {
    console.warn(`[rollout] failed to fetch promoted targets, falling back to env: ${(err as Error).message}`);
  }
  return map;
}

/**
 * Run a rollout check: for each service with a configured desired tag,
 * call provisioning-service's batch deployment API to update all active tenants.
 *
 * Desired tag resolution (per service): admin-promoted rollout_targets first,
 * then the ROLLOUT_*_TAG env vars as fallback.
 */
export async function runRolloutCycle(config: OpsConfig): Promise<RolloutResult[]> {
  const baseUrl = config.provisioningServiceUrl.replace(/\/$/, '');
  const promoted = await fetchPromotedTargets(baseUrl, config.provisioningApiToken);

  const targets: RolloutTarget[] = [];

  const gwTag = promoted.get('nexus-gateway') || config.rolloutNexusGatewayTag;
  if (gwTag) {
    targets.push({ service: 'nexus-gateway', image: gwTag });
  }
  const agentTag = promoted.get('dealclaw-agent') || config.rolloutDealclawAgentTag;
  if (agentTag) {
    targets.push({ service: 'dealclaw-agent', image: agentTag });
  }

  if (!targets.length) {
    return [];
  }

  const results: RolloutResult[] = [];

  for (const target of targets) {
    const start = Date.now();
    try {
      const body: BatchResponse = await callBatchDeploy(baseUrl, target, config.provisioningApiToken);
      results.push({
        timestamp: new Date().toISOString(),
        service: target.service,
        image: target.image,
        updated: body.updated ?? 0,
        total: body.total ?? 0,
        failed: body.failed ?? 0,
        durationMs: Date.now() - start,
      });

      // Log tenants already on the desired tag (no-op skipped, no patch issued)
      const alreadyCurrent = body.alreadyCurrent ?? 0;
      if (alreadyCurrent > 0) {
        console.log(`[rollout] ${target.service}: ${alreadyCurrent} tenants already on ${target.image}, no patch needed`);
      }

      // Log pinned tenants (operator-locked image, exempt from fleet rollout)
      const pinned = body.pinned ?? 0;
      if (pinned > 0) {
        console.log(`[rollout] ${target.service}: ${pinned} tenants pinned (skipped, operator-locked image)`);
      }

      // Log skipped tenants (deployment not found)
      const skipped = (body.results ?? []).filter(r => r.skipped);
      if (skipped.length > 0) {
        console.log(`[rollout] ${target.service}: ${skipped.length} tenants skipped (deployment not present)`);
      }

      // Log per-tenant results
      const failures = (body.results ?? []).filter(r => !r.ok);
      if (failures.length > 0) {
        console.warn(`[rollout] ${target.service} -> ${target.image}: ${failures.length} failures`);
        for (const f of failures) {
          console.warn(`[rollout]   ${f.tenantId}: ${f.error}`);
        }
      }
    } catch (err: unknown) {
      const e = err as Error;
      results.push({
        timestamp: new Date().toISOString(),
        service: target.service,
        image: target.image,
        updated: 0,
        total: 0,
        failed: 0,
        durationMs: Date.now() - start,
        error: e.message,
      });
      console.error(`[rollout] ${target.service} cycle failed: ${e.message}`);
    }
  }

  return results;
}

async function callBatchDeploy(baseUrl: string, target: RolloutTarget, token: string): Promise<BatchResponse> {
  // 1. Enqueue the rollout batch (async task facade). The endpoint returns a
  //    taskId immediately instead of blocking for the whole multi-tenant
  //    recreate — the old synchronous path took 10+ minutes and blew past the
  //    120s AbortSignal.
  const postRes = await fetch(`${baseUrl}/v1/tenants/batch/deployment`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ service: target.service, image: target.image }),
    signal: AbortSignal.timeout(30_000),
  });

  const postBody = (await postRes.json()) as {
    ok?: boolean;
    taskId?: string;
    reused?: boolean;
    code?: string;
    message?: string;
  };

  if (!postRes.ok) {
    throw new Error(`${postBody.code ?? 'HTTP ' + postRes.status}: ${postBody.message ?? 'batch deployment failed'}`);
  }
  if (!postBody.taskId) {
    throw new Error('batch deployment returned no taskId');
  }

  // 2. Poll the task until it reaches a terminal state. Recreating ~114
  //    tenants serially takes ~10 minutes, so the poll window is generous
  //    (30 min). The provisioning service de-duplicates a re-fire (cron
  //    overlap) to the same taskId, so this never races a duplicate rollout.
  const detailUrl = `${baseUrl}/v1/tenants/batch/deployment/${postBody.taskId}`;
  const deadline = Date.now() + 30 * 60 * 1000;

  while (Date.now() < deadline) {
    const detailRes = await fetch(detailUrl, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    const detail = (await detailRes.json()) as {
      ok?: boolean;
      status?: string;
      updated?: number;
      total?: number;
      failed?: number;
      skipped?: number;
      alreadyCurrent?: number;
      pinned?: number;
      results?: BatchResponse['results'];
      code?: string;
      message?: string;
    };

    if (!detailRes.ok) {
      throw new Error(`${detail.code ?? 'HTTP ' + detailRes.status}: ${detail.message ?? 'get batch detail failed'}`);
    }

    if (detail.status && ['succeeded', 'partial', 'failed', 'cancelled'].includes(detail.status)) {
      return {
        ok: true,
        updated: detail.updated ?? 0,
        total: detail.total ?? 0,
        failed: detail.failed ?? 0,
        skipped: detail.skipped ?? 0,
        alreadyCurrent: detail.alreadyCurrent ?? 0,
        pinned: detail.pinned ?? 0,
        results: detail.results,
      };
    }

    await new Promise((r) => setTimeout(r, 5_000));
  }

  throw new Error(`batch rollout task ${postBody.taskId} did not finish within 30 minutes`);
}
