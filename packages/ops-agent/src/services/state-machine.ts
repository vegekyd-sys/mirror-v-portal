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
  subscriptionEnd: Date;
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
  | { type: 'notify'; channel: 'bot' | 'email' | 'all'; message: string }
  | { type: 'suspend_pod'; tenantId: string }
  | { type: 'resume_pod'; tenantId: string }
  | { type: 'backup_data'; tenantId: string }
  | { type: 'destroy_pod'; tenantId: string }
  | { type: 'revoke_tokens'; tenantId: string }
  | { type: 'archive_data'; tenantId: string }
  | { type: 'trigger_monthly_reset'; tenantId: string };

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
            { type: 'notify', channel: 'bot', message: createLowCreditsMessage(state) },
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
            { type: 'notify', channel: 'bot', message: createLowCreditsMessage(state) },
          ],
        };
      }

      // Check subscription expiry
      const daysUntilExpiry = daysBetween(now, state.subscriptionEnd);
      if (daysUntilExpiry <= 0) {
        return {
          from: 'active',
          to: 'suspended',
          reason: 'Subscription expired',
          actions: [
            { type: 'notify', channel: 'all', message: createExpiredMessage(state) },
            { type: 'suspend_pod', tenantId: state.id },
          ],
        };
      }

      // Expiry reminders
      const actions: TransitionAction[] = [];
      if (daysUntilExpiry === 7) {
        actions.push({ type: 'notify', channel: 'bot', message: createExpiryReminder(state, 7) });
      } else if (daysUntilExpiry === 3) {
        actions.push({ type: 'notify', channel: 'bot', message: createExpiryReminder(state, 3) });
      } else if (daysUntilExpiry === 1) {
        actions.push({ type: 'notify', channel: 'all', message: createFinalReminder(state) });
      }

      if (actions.length > 0) {
        return { from: 'active', to: 'active', reason: 'Expiry reminder', actions };
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
            { type: 'notify', channel: 'all', message: createSuspendedMessage(state) },
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
            { type: 'notify', channel: 'bot', message: '✅ Payment received! Your DealClaw service is now active.' },
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
            { type: 'notify', channel: 'all', message: createGraceMessage(state) },
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
            { type: 'notify', channel: 'bot', message: '✅ Payment received! Your DealClaw service is restored.' },
            { type: 'resume_pod', tenantId: state.id },
          ],
        };
      }

      // Day 15 — final deletion warning
      if (state.daysInCurrentStatus === 15) {
        return {
          from: 'grace',
          to: 'grace',
          reason: '15-day deletion warning',
          actions: [
            { type: 'notify', channel: 'email', message: 'Your DealClaw data will be permanently deleted in 15 days. To restore service, please make payment.' },
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
            { type: 'notify', channel: 'email', message: 'Your DealClaw data has been permanently deleted.' },
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

// ── Notification messages ──

function createLowCreditsMessage(s: TenantState): string {
  const remaining = s.creditsBalance.toLocaleString();
  const allowance = s.monthlyAllowance.toLocaleString();
  return `⚠️ Your DealClaw credits are running low: ${remaining}/${allowance} remaining. Consider topping up at https://dealclaw.cn/billing`;
}

function createExpiryReminder(s: TenantState, days: number): string {
  return `📅 Your DealClaw subscription expires in ${days} days. Renew now to avoid service interruption.`;
}

function createFinalReminder(s: TenantState): string {
  return `⚠️ FINAL NOTICE: Your DealClaw subscription expires TOMORROW. Renew now to keep your AI sales agent running.`;
}

function createExpiredMessage(s: TenantState): string {
  return `🛑 Your DealClaw subscription has expired. Your agent has been paused. Data is preserved for 30 days. Renew to resume service.`;
}

function createSuspendedMessage(s: TenantState): string {
  return `🛑 Your DealClaw service has been suspended due to insufficient credits. Data preserved — renew within 23 days to restore service.`;
}

function createGraceMessage(s: TenantState): string {
  return `⚠️ Your DealClaw data will be permanently deleted in 30 days. Last chance to restore your service.`;
}

// ── Helpers ──

function daysBetween(a: Date, b: Date): number {
  return Math.ceil((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}
