/**
 * Ops Agent — Tenant State Machine
 * 
 * Drives lifecycle transitions: active → low_credits → suspended → grace → destroyed.
 * Pure logic — no K8s dependency, no DB dependency (receives state, returns next state).
 */

export type TenantStatus = 'pending' | 'provisioning' | 'active' | 'low_credits' | 'suspended' | 'grace' | 'destroyed';

export interface TenantState {
  id: string;
  status: TenantStatus;
  creditsBalance: number;
  monthlyAllowance: number;
  monthlyUsed: number;
  /** null = no expiry configured (never auto-suspend for missing date) */
  subscriptionEnd: Date | null;
  suspendedAt: Date | null;
  graceUntil: Date | null;
  daysInCurrentStatus: number;
  hasPaymentPending: boolean;
}

export interface TransitionResult {
  from: TenantStatus;
  to: TenantStatus;
  reason: string;
  actions: TransitionAction[];
}

export type TransitionAction =
  | { type: 'notify'; name: NotifyName; channel: 'bot' | 'email' | 'all'; message: string; dedupKey: string }
  | { type: 'suspend_pod'; tenantId: string }
  | { type: 'resume_pod'; tenantId: string }
  | { type: 'backup_data'; tenantId: string }
  | { type: 'destroy_pod'; tenantId: string }
  | { type: 'revoke_tokens'; tenantId: string }
  | { type: 'archive_data'; tenantId: string }
  | { type: 'trigger_monthly_reset'; tenantId: string };

/** Stable identifiers for lifecycle notifications — stored in tenant_notifications.notification_type. */
export type NotifyName =
  | 'low-credits'
  | 'expiry-reminder-7d'
  | 'expiry-reminder-3d'
  | 'expiry-final-reminder'
  | 'subscription-expired'
  | 'service-suspended'
  | 'service-resumed'
  | 'grace-warning'
  | 'grace-15d-warning'
  | 'tenant-destroyed';

/**
 * Compute the next state transition for a tenant.
 * Returns the current state + required actions if no transition needed.
 */
export function computeTransition(state: TenantState): TransitionResult | null {
  const now = new Date();

  switch (state.status) {
    case 'active': {
      // Check credits
      if (state.monthlyAllowance > 0 && state.creditsBalance === 0) {
        return {
          from: 'active',
          to: 'low_credits',
          reason: 'Credits exhausted',
          actions: [
            notifyAction(state, 'low-credits', 'bot', createLowCreditsMessage(state), monthBucket()),
          ],
        };
      }

      // Check credits below 10%
      if (state.monthlyAllowance > 0 && state.creditsBalance < state.monthlyAllowance * 0.1) {
        return {
          from: 'active',
          to: 'low_credits',
          reason: 'Credits below 10% threshold',
          actions: [
            notifyAction(state, 'low-credits', 'bot', createLowCreditsMessage(state), monthBucket()),
          ],
        };
      }

      // Check subscription expiry — only when an expiry date is configured.
      if (state.subscriptionEnd) {
        const daysUntilExpiry = daysBetween(now, state.subscriptionEnd);
        if (daysUntilExpiry <= 0) {
          return {
            from: 'active',
            to: 'suspended',
            reason: 'Subscription expired',
            actions: [
              notifyAction(state, 'subscription-expired', 'all', createExpiredMessage(), subscriptionCycleKey(state)),
              { type: 'suspend_pod', tenantId: state.id },
            ],
          };
        }

        // Window-based expiry reminders. The state machine runs hourly, so a
        // reminder window (not an exact day) guarantees the tenant is warned
        // even if a cron cycle is missed; dedupKey suppresses repeats.
        const actions: TransitionAction[] = [];
        if (daysUntilExpiry <= 7 && daysUntilExpiry > 3) {
          actions.push(notifyAction(state, 'expiry-reminder-7d', 'bot', createExpiryReminder(7), subscriptionCycleKey(state)));
        } else if (daysUntilExpiry <= 3 && daysUntilExpiry > 1) {
          actions.push(notifyAction(state, 'expiry-reminder-3d', 'bot', createExpiryReminder(3), subscriptionCycleKey(state)));
        } else if (daysUntilExpiry <= 1) {
          actions.push(notifyAction(state, 'expiry-final-reminder', 'all', createFinalReminder(), subscriptionCycleKey(state)));
        }

        if (actions.length > 0) {
          return { from: 'active', to: 'active', reason: 'Expiry reminder', actions };
        }
      }

      return null; // No change needed
    }

    case 'low_credits': {
      // Client paid → back to active
      if (state.creditsBalance > state.monthlyAllowance * 0.1) {
        return {
          from: 'low_credits',
          to: 'active',
          reason: 'Credits replenished above threshold',
          actions: [],
        };
      }

      // 7 days in low_credits with no payment → suspend
      if (state.daysInCurrentStatus >= 7 && !state.hasPaymentPending) {
        return {
          from: 'low_credits',
          to: 'suspended',
          reason: '7 days without payment',
          actions: [
            notifyAction(state, 'service-suspended', 'all', createSuspendedMessage(), monthBucket()),
            { type: 'suspend_pod', tenantId: state.id },
          ],
        };
      }

      return null;
    }

    case 'suspended': {
      // Payment received → resume
      if (state.hasPaymentPending) {
        return {
          from: 'suspended',
          to: 'active',
          reason: 'Payment received, resuming service',
          actions: [
            notifyAction(state, 'service-resumed', 'bot', createResumedMessage(), suspendCycleKey(state)),
            { type: 'resume_pod', tenantId: state.id },
          ],
        };
      }

      // 7 days suspended → grace
      if (state.daysInCurrentStatus >= 7) {
        return {
          from: 'suspended',
          to: 'grace',
          reason: '7 days in suspended state',
          actions: [
            notifyAction(state, 'grace-warning', 'all', createGraceMessage(), suspendCycleKey(state)),
            { type: 'backup_data', tenantId: state.id },
          ],
        };
      }

      return null;
    }

    case 'grace': {
      // Payment during grace → resume
      if (state.hasPaymentPending) {
        return {
          from: 'grace',
          to: 'active',
          reason: 'Payment received during grace period',
          actions: [
            notifyAction(state, 'service-resumed', 'bot', createResumedMessage(), suspendCycleKey(state)),
            { type: 'resume_pod', tenantId: state.id },
          ],
        };
      }

      // Day 15+ — final deletion warning. Window (not exact day) so a missed
      // cron cycle cannot skip it; dedupKey guarantees a single delivery.
      if (state.daysInCurrentStatus >= 15 && state.daysInCurrentStatus < 30) {
        return {
          from: 'grace',
          to: 'grace',
          reason: '15-day deletion warning',
          actions: [
            notifyAction(state, 'grace-15d-warning', 'all', createGrace15dMessage(), suspendCycleKey(state)),
          ],
        };
      }

      // 30 days → destroyed
      if (state.daysInCurrentStatus >= 30) {
        return {
          from: 'grace',
          to: 'destroyed',
          reason: '30-day grace period expired',
          actions: [
            { type: 'destroy_pod', tenantId: state.id },
            { type: 'revoke_tokens', tenantId: state.id },
            { type: 'archive_data', tenantId: state.id },
            notifyAction(state, 'tenant-destroyed', 'all', createDestroyedMessage(), suspendCycleKey(state)),
          ],
        };
      }

      return null;
    }

    case 'pending':
    case 'provisioning':
    case 'destroyed':
      // No automatic transitions from these states
      return null;
  }
}

// ── Notification messages (zh-CN — delivered to Feishu users) ──

function createLowCreditsMessage(s: TenantState): string {
  const remaining = s.creditsBalance.toLocaleString();
  const allowance = s.monthlyAllowance.toLocaleString();
  return `⚠️ 你的 DealClaw 积分即将用尽：剩余 ${remaining} / ${allowance}。请前往 https://dealclaw.cn/billing 充值，避免服务中断。`;
}

function createExpiryReminder(days: number): string {
  return `📅 你的 DealClaw 订阅将在 ${days} 天内到期，请及时续费以避免服务中断。`;
}

function createFinalReminder(): string {
  return `⚠️ 最后提醒：你的 DealClaw 订阅明天到期，立即续费以保持 AI 销售助手运行。`;
}

function createExpiredMessage(): string {
  return `🛑 你的 DealClaw 订阅已到期，服务已暂停。数据将保留 30 天，续费后可立即恢复。`;
}

function createSuspendedMessage(): string {
  return `🛑 因积分不足且未及时充值，你的 DealClaw 服务已暂停。数据已保留，23 天内续费即可恢复。`;
}

function createResumedMessage(): string {
  return `✅ 已收到付款！你的 DealClaw 服务已恢复，感谢继续使用。`;
}

function createGraceMessage(): string {
  return `⚠️ 你的 DealClaw 数据将在 30 天后永久删除，这是恢复服务的最后机会。`;
}

function createGrace15dMessage(): string {
  return `⚠️ 你的 DealClaw 数据将在 15 天后永久删除。如需恢复服务，请尽快完成付款。`;
}

function createDestroyedMessage(): string {
  return `你的 DealClaw 数据已被永久删除。如需再次使用，请重新入驻。`;
}

// ── Notify action / dedup-key helpers ──

function notifyAction(
  state: TenantState,
  name: NotifyName,
  channel: 'bot' | 'email' | 'all',
  message: string,
  cycleMarker: string,
): TransitionAction & { type: 'notify' } {
  return { type: 'notify', name, channel, message, dedupKey: `${name}:${state.id}:${cycleMarker}` };
}

/** Monthly bucket — credit-related notifications may repeat each billing cycle. */
function monthBucket(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Subscription period marker — reminders re-fire after a renewal changes the end date. */
function subscriptionCycleKey(state: TenantState): string {
  return state.subscriptionEnd ? state.subscriptionEnd.toISOString() : 'no-expiry';
}

/** Suspension cycle marker — unique per suspend→grace→destroy/resume cycle. */
function suspendCycleKey(state: TenantState): string {
  return state.suspendedAt ? state.suspendedAt.toISOString() : 'unknown-cycle';
}

// ── Helpers ──

function daysBetween(a: Date, b: Date): number {
  return Math.ceil((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}
