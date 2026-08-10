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
  results?: Array<{ tenantId: string; ok: boolean; error?: string }>;
  code?: string;
  message?: string;
}

/**
 * Run a rollout check: for each service with a configured desired tag,
 * call provisioning-service's batch deployment API to update all active tenants.
 */
export async function runRolloutCycle(config: OpsConfig): Promise<RolloutResult[]> {
  const targets: RolloutTarget[] = [];

  if (config.rolloutNexusGatewayTag) {
    targets.push({ service: 'nexus-gateway', image: config.rolloutNexusGatewayTag });
  }
  if (config.rolloutDealclawAgentTag) {
    targets.push({ service: 'dealclaw-agent', image: config.rolloutDealclawAgentTag });
  }

  if (!targets.length) {
    return [];
  }

  const results: RolloutResult[] = [];
  const baseUrl = config.provisioningServiceUrl.replace(/\/$/, '');

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
  const res = await fetch(`${baseUrl}/v1/tenants/batch/deployment`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ service: target.service, image: target.image }),
    signal: AbortSignal.timeout(120_000),
  });

  const body = await res.json() as BatchResponse;

  if (!res.ok) {
    throw new Error(`${body.code ?? 'HTTP ' + res.status}: ${body.message ?? 'batch deployment failed'}`);
  }

  return body;
}
