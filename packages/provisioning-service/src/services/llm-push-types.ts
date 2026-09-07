/**
 * LLM push async task — shared status constants + row/DTO types.
 *
 * These types back the `llm_push_tasks` / `llm_push_task_items` tables (see
 * db/migrate.ts v0.11) and are consumed by services/llm-push-task.ts (worker
 * + lifecycle) and routes/llm-push.ts (SSE + REST). Keeping them in one place
 * avoids stringly-typed drift between the worker, the reaper, and the API.
 */

export type LlmPushTaskStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'cancelled';

export type LlmPushItemStatus = 'pending' | 'running' | 'succeeded' | 'skipped' | 'failed';

export type LlmPushKind = 'global_push' | 'tenant_push';

export type LlmPushTrigger = 'save' | 'delete' | 'selection' | 'retry';

/** Task statuses from which no worker will ever resume. */
export const LLM_PUSH_TASK_TERMINAL: readonly LlmPushTaskStatus[] = [
  'succeeded',
  'partial',
  'failed',
  'cancelled',
];

export function isTerminalTaskStatus(status: LlmPushTaskStatus): boolean {
  return (LLM_PUSH_TASK_TERMINAL as readonly string[]).includes(status);
}

/** Raw row shape returned by PostgreSQL for llm_push_tasks. */
export interface LlmPushTaskRecord {
  id: string;
  kind: LlmPushKind;
  scope: string | null;
  trigger: LlmPushTrigger;
  status: LlmPushTaskStatus;
  prev_library: string | null;
  next_library: string | null;
  total_count: number;
  succeeded_count: number;
  failed_count: number;
  skipped_count: number;
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

/** Raw row shape returned by PostgreSQL for llm_push_task_items. */
export interface LlmPushItemRecord {
  id: number;
  task_id: string;
  tenant_id: string;
  status: LlmPushItemStatus;
  restarted: boolean;
  gateway_restarted: boolean;
  skip_restart: boolean;
  error: string | null;
  attempts: number;
  started_at: Date | null;
  finished_at: Date | null;
  updated_at: Date;
}

/** Shape of the JSON body written to an SSE frame's `data:` line. */
export interface LlmPushSseEvent {
  taskId: string;
  event: 'snapshot' | 'item' | 'task' | 'done';
  [key: string]: unknown;
}
