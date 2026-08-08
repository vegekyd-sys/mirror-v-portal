/**
 * Ops Agent — Scheduler
 * 
 * Runs periodic scans on all tenants:
 * - Every hour: credit checks, expiry reminders, status transitions
 * - Monthly: credit allowance reset
 * - Continuously: health check (when K8s available)
 */

import { computeTransition, type TenantState, type TransitionResult } from './state-machine.js';

export interface ScanResult {
  timestamp: string;
  scanned: number;
  transitions: TransitionResult[];
  errors: string[];
  durationMs: number;
}

/**
 * Scan all tenants and compute required transitions.
 * M0: receives tenant list as parameter (from DB when available).
 */
export function scanTenants(tenants: TenantState[]): ScanResult {
  const start = Date.now();
  const transitions: TransitionResult[] = [];
  const errors: string[] = [];

  for (const tenant of tenants) {
    try {
      const result = computeTransition(tenant);
      if (result) transitions.push(result);
    } catch (err: any) {
      errors.push(`Tenant ${tenant.id}: ${err.message}`);
    }
  }

  return {
    timestamp: new Date().toISOString(),
    scanned: tenants.length,
    transitions,
    errors,
    durationMs: Date.now() - start,
  };
}

/**
 * Compute notification schedule: which reminders to send today.
 */
export function getNotificationsForToday(subscriptionEnd: Date): string[] {
  const now = new Date();
  const days = Math.ceil((subscriptionEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

  const notifications: string[] = [];
  if (days === 7) notifications.push('7-day expiry reminder');
  if (days === 3) notifications.push('3-day expiry reminder');
  if (days === 1) notifications.push('Final 1-day reminder');
  if (days <= 0) notifications.push('Subscription expired — suspend');

  return notifications;
}

/**
 * Check if monthly credits should be reset.
 */
export function shouldResetMonthly(monthResetAt: Date): boolean {
  return new Date() >= monthResetAt;
}

/**
 * Get the next monthly reset date.
 */
export function nextMonthlyReset(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 1);
}
