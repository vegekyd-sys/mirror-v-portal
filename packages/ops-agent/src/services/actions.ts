import type pg from 'pg';
import type { OpsConfig } from '../config.js';
import type { TransitionAction } from './state-machine.js';
import { deliverNotification } from './notifier.js';

/**
 * Execute state-machine actions by calling provisioning-service or external APIs.
 */

const SERVICES = ['dealclaw-agent', 'nexus-gateway'] as const;

async function scaleDeployment(
  baseUrl: string,
  token: string,
  tenantId: string,
  service: string,
  replicas: number,
): Promise<void> {
  const res = await fetch(`${baseUrl}/v1/tenants/${tenantId}/deployment/scale`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ service, replicas }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok && res.status !== 404) {
    const body = await res.text().catch(() => '');
    throw new Error(`Scale failed (${res.status}): ${body.slice(0, 200)}`);
  }
  // 404 = deployment doesn't exist (e.g. old tenant without nexus-gateway) — ignore
}

async function callDestroy(
  baseUrl: string,
  token: string,
  tenantId: string,
): Promise<void> {
  const res = await fetch(`${baseUrl}/v1/tenants/${tenantId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Destroy failed (${res.status}): ${body.slice(0, 200)}`);
  }
}

export async function executeActions(
  tenantId: string,
  actions: TransitionAction[],
  config: OpsConfig,
  pool?: pg.Pool,
): Promise<string[]> {
  const baseUrl = config.provisioningServiceUrl.replace(/\/$/, '');
  const token = config.provisioningApiToken;
  const results: string[] = [];

  for (const action of actions) {
    try {
      switch (action.type) {
        case 'suspend_pod': {
          for (const svc of SERVICES) {
            await scaleDeployment(baseUrl, token, tenantId, svc, 0);
          }
          console.log(JSON.stringify({ level: 'info', action: 'suspend_pod', tenantId }));
          results.push('suspend_pod');
          break;
        }
        case 'resume_pod': {
          for (const svc of SERVICES) {
            await scaleDeployment(baseUrl, token, tenantId, svc, 1);
          }
          console.log(JSON.stringify({ level: 'info', action: 'resume_pod', tenantId }));
          results.push('resume_pod');
          break;
        }
        case 'destroy_pod': {
          await callDestroy(baseUrl, token, tenantId);
          console.log(JSON.stringify({ level: 'info', action: 'destroy_pod', tenantId }));
          results.push('destroy_pod');
          break;
        }
        case 'notify': {
          const outcome = await deliverNotification(pool, tenantId, action, config);
          console.log(JSON.stringify({
            level: 'info',
            action: 'notify',
            tenantId,
            notificationType: action.name,
            channel: action.channel,
            dedupKey: action.dedupKey,
            outcome,
            message: action.message?.slice(0, 100),
          }));
          results.push(`${action.name}:${outcome}`);
          break;
        }
        case 'backup_data':
        case 'archive_data':
        case 'revoke_tokens':
        case 'trigger_monthly_reset':
          console.log(JSON.stringify({ level: 'info', action: action.type, tenantId }));
          results.push(action.type);
          break;
      }
    } catch (err: unknown) {
      const e = err as Error;
      results.push(`${action.type}:error`);
      console.error(JSON.stringify({
        level: 'error',
        action: action.type,
        tenantId,
        error: e.message,
      }));
    }
  }

  return results;
}
