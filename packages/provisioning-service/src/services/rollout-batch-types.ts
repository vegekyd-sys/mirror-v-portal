/**
 * Rollout batch async task — shared status constants + row/DTO types.
 *
 * These types back the `rollout_batch_tasks` / `rollout_batch_task_items`
 * tables (see db/migrate.ts v0.12) and are consumed by
 * services/rollout-batch-task.ts (worker + lifecycle) and the batch routes in
 * routes/tenants.ts (SSE + REST). They mirror the llm-push async pattern but
 * carry deployment-specific item outcomes (already_current / pinned / skipped)
 * instead of the LLM-push restart flags.
 */

export type RolloutBatchTaskStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'cancelled';

export type RolloutBatchItemStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'already_current'
  | 'pinned'
  | 'skipped'
  | 'failed';

export type RolloutBatchService = 'dealclaw-agent' | 'nexus-gateway';

/** Task statuses from which no worker will ever resume. */
export const ROLLOUT_BATCH_TASK_TERMINAL: readonly RolloutBatchTaskStatus[] = [
  'succeeded',
  'partial',
  'failed',
  'cancelled',
];

export function isTerminalRolloutBatchStatus(status: RolloutBatchTaskStatus): boolean {
  return (ROLLOUT_BATCH_TASK_TERMINAL as readonly string[]).includes(status);
}

/** Raw row shape returned by PostgreSQL for rollout_batch_tasks. */
export interface RolloutBatchTaskRecord {
  id: string;
  service: RolloutBatchService;
  image: string;
  tag: string;
  scope: string | null;
  status: RolloutBatchTaskStatus;
  total_count: number;
  succeeded_count: number;
  already_current_count: number;
  pinned_count: number;
  skipped_count: number;
  failed_count: number;
  error: string | null;
  actor: string | null;
  actor_type: 'admin' | 'service';
  lease_owner: string | null;
  lease_expires_at: Date | null;
  cancel_requested: boolean;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

/** Raw row shape returned by PostgreSQL for rollout_batch_task_items. */
export interface RolloutBatchItemRecord {
  id: number;
  task_id: string;
  tenant_id: string;
  namespace: string;
  deployment: string;
  status: RolloutBatchItemStatus;
  error: string | null;
  attempts: number;
  started_at: Date | null;
  finished_at: Date | null;
  updated_at: Date;
}

/** Public (脱敏) task view returned by the REST API. */
export interface RolloutBatchTaskView {
  id: string;
  service: RolloutBatchService;
  image: string;
  tag: string;
  scope: string | null;
  status: RolloutBatchTaskStatus;
  totalCount: number;
  succeededCount: number;
  alreadyCurrentCount: number;
  pinnedCount: number;
  skippedCount: number;
  failedCount: number;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface RolloutBatchItemView {
  tenantId: string;
  deployment: string;
  status: RolloutBatchItemStatus;
  error: string | null;
}
