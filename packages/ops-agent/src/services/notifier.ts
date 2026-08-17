/**
 * Ops Agent — Notification delivery
 *
 * Delivers lifecycle notifications through central-gateway's notify relay,
 * with at-most-once semantics enforced by tenant_notifications.dedup_key.
 *
 * Why the relay (and not the tenant's own nexus-gateway): the suspend_pod
 * action scales tenant Pods to zero at exactly the moment suspension/grace
 * notifications must be sent. central-gateway is always on.
 *
 * Sequence per notify action:
 *   1. INSERT ... ON CONFLICT (dedup_key) DO NOTHING → duplicate? stop.
 *   2. POST central-gateway /internal/v1/notify.
 *   3. Mark the row delivered / record the delivery error.
 */

import type pg from 'pg';
import type { OpsConfig } from '../config.js';
import type { TransitionAction } from './state-machine.js';

type NotifyAction = Extract<TransitionAction, { type: 'notify' }>;

export type NotifyOutcome =
  | 'notify:sent'
  | 'notify:duplicate'
  | 'notify:relay-not-configured'
  | 'notify:relay-failed'
  | 'notify:not-delivered'
  | 'notify:error';

/**
 * Idempotently deliver one notify action.
 * Never throws — delivery problems are returned as outcome labels so the
 * cron cycle can record them in the transition log.
 */
export async function deliverNotification(
  pool: pg.Pool | undefined,
  tenantId: string,
  action: NotifyAction,
  config: OpsConfig,
): Promise<NotifyOutcome> {
  let notificationId: number | null = null;

  // 1. Dedup gate — the UNIQUE dedup_key guarantees at-most-once delivery.
  if (pool) {
    try {
      const inserted = await pool.query(
        `INSERT INTO tenant_notifications (tenant_id, notification_type, channel, dedup_key, message)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (dedup_key) DO NOTHING
         RETURNING id`,
        [tenantId, action.name, action.channel, action.dedupKey, action.message],
      );
      if (inserted.rowCount === 0) {
        return 'notify:duplicate';
      }
      notificationId = inserted.rows[0]?.id ?? null;
    } catch (err: any) {
      console.error(JSON.stringify({
        level: 'error',
        action: 'notify_dedup_insert',
        tenantId,
        dedupKey: action.dedupKey,
        error: err.message,
      }));
      // Dedup store broken → refuse to send rather than risk duplicates.
      return 'notify:error';
    }
  }

  // 2. Relay delivery
  if (!config.centralGatewayUrl || !config.internalApiToken) {
    await markDeliveryError(pool, notificationId, 'relay not configured (CENTRAL_GATEWAY_URL / INTERNAL_API_TOKEN missing)');
    return 'notify:relay-not-configured';
  }

  try {
    const res = await fetch(`${config.centralGatewayUrl.replace(/\/$/, '')}/internal/v1/notify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.internalApiToken}`,
      },
      body: JSON.stringify({
        tenantId,
        channel: action.channel,
        notificationType: action.name,
        dedupKey: action.dedupKey,
        message: action.message,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const body = await res.json().catch(() => null) as
      | { ok?: boolean; delivered?: string[]; reason?: string; error?: string }
      | null;

    if (res.ok && body?.ok) {
      await markDelivered(pool, notificationId);
      return 'notify:sent';
    }

    // Relay answered but could not deliver (no contact yet, unsupported
    // platform, Feishu error...). Record why for operators.
    const reason = body?.error || body?.reason || `relay HTTP ${res.status}`;
    await markDeliveryError(pool, notificationId, reason);
    return body ? 'notify:not-delivered' : 'notify:relay-failed';
  } catch (err: any) {
    await markDeliveryError(pool, notificationId, err.message);
    return 'notify:relay-failed';
  }
}

async function markDelivered(pool: pg.Pool | undefined, notificationId: number | null): Promise<void> {
  if (!pool || notificationId === null) return;
  try {
    await pool.query(
      `UPDATE tenant_notifications SET delivered = TRUE, delivered_at = NOW(), delivery_error = NULL WHERE id = $1`,
      [notificationId],
    );
  } catch (err: any) {
    console.warn(`[notifier] markDelivered failed: ${err.message}`);
  }
}

async function markDeliveryError(pool: pg.Pool | undefined, notificationId: number | null, error: string): Promise<void> {
  if (!pool || notificationId === null) return;
  try {
    await pool.query(
      `UPDATE tenant_notifications SET delivery_error = $2 WHERE id = $1`,
      [notificationId, error.slice(0, 500)],
    );
  } catch (err: any) {
    console.warn(`[notifier] markDeliveryError failed: ${err.message}`);
  }
}
