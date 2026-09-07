/**
 * LLM push async task — task lifecycle + worker + reaper.
 *
 * Replaces the old synchronous `pushLlmProviders` loop (which blocked the
 * admin HTTP request for the whole multi-tenant rollout) with a persistent
 * job queue:
 *
 *   - enqueueLlmPush: save handler inserts a `llm_push_tasks` row (pending)
 *     with the prev/next library encrypted snapshots, then returns immediately.
 *   - startLlmPushWorker: a process-local polling loop claims pending tasks
 *     with `FOR UPDATE SKIP LOCKED` and executes them tenant-by-tenant,
 *     publishing progress to the SseBroker as it goes.
 *   - startLlmPushReaper: recycles running tasks whose lease expired (worker
 *     crash / restart), resetting their in-flight items so a re-claim resumes
 *     from where it left off.
 *
 * Crash safety: every item outcome is persisted before the next starts; a
 * re-claimed task only re-runs still-`pending` items. `applyTenantLlmConfig`
 * is idempotent (Secret upsert + annotation patch), so a crash between
 * "Secret written" and "item recorded" re-runs safely.
 */
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { decryptValue, encryptValue } from './crypto.js';
import {
  applyTenantLlmConfig,
  type LlmProvidersConfig,
} from './llm-providers.js';
import type { ProvisioningConfig } from '../config.js';
import type { SseBroker } from './sse-broker.js';
import type {
  LlmPushItemRecord,
  LlmPushItemStatus,
  LlmPushTaskRecord,
  LlmPushTaskStatus,
} from './llm-push-types.js';

/** Stable-ish process identity for lease ownership. */
const WORKER_ID = `${process.env.HOSTNAME ?? 'worker'}-${randomUUID().slice(0, 8)}`;

export interface EnqueueLlmPushInput {
  kind: 'global_push' | 'tenant_push';
  scope: string | null;
  trigger: 'save' | 'delete' | 'selection' | 'retry';
  prevLibrary: LlmProvidersConfig | null;
  nextLibrary: LlmProvidersConfig | null;
  actor: string;
  actorType: 'admin' | 'service';
}

/** Public (脱敏) task view returned by the REST API — never exposes libraries. */
export interface LlmPushTaskView {
  id: string;
  kind: string;
  scope: string | null;
  trigger: string;
  status: LlmPushTaskStatus;
  totalCount: number;
  succeededCount: number;
  failedCount: number;
  skippedCount: number;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface LlmPushItemView {
  tenantId: string;
  status: LlmPushItemStatus;
  restarted: boolean;
  gatewayRestarted: boolean;
  skipRestart: boolean;
  error: string | null;
}

interface CountRow {
  succeeded_count: number;
  failed_count: number;
  skipped_count: number;
}

function decryptLibraryOrThrow(encrypted: string | null): LlmProvidersConfig | null {
  if (!encrypted) return null;
  // Throws on decrypt failure — a changed master key must fail the task
  // (fail-closed) rather than silently materialising an empty library.
  return JSON.parse(decryptValue(encrypted)) as LlmProvidersConfig;
}

/** Create a pending task and return its id. */
export async function enqueueLlmPush(
  pool: pg.Pool,
  input: EnqueueLlmPushInput,
): Promise<{ taskId: string; status: 'pending' }> {
  const taskId = randomUUID();
  await pool.query(
    `INSERT INTO llm_push_tasks
       (id, kind, scope, trigger, prev_library, next_library, actor, actor_type)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      taskId,
      input.kind,
      input.scope,
      input.trigger,
      input.prevLibrary ? encryptValue(JSON.stringify(input.prevLibrary)) : null,
      input.nextLibrary ? encryptValue(JSON.stringify(input.nextLibrary)) : null,
      input.actor,
      input.actorType,
    ],
  );
  return { taskId, status: 'pending' };
}

/**
 * Atomically claim the oldest pending task. `FOR UPDATE SKIP LOCKED` makes
 * concurrent replicas claim distinct tasks without a coordination service.
 */
export async function claimNextTask(
  pool: pg.Pool,
  leaseSeconds: number,
): Promise<LlmPushTaskRecord | null> {
  const { rows } = await pool.query<LlmPushTaskRecord>(
    `WITH next AS (
       SELECT id FROM llm_push_tasks
       WHERE status = 'pending'
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE llm_push_tasks t
     SET status = 'running',
         lease_owner = $1,
         lease_expires_at = NOW() + ($2::int * interval '1 second'),
         started_at = COALESCE(started_at, NOW())
     FROM next
     WHERE t.id = next.id
     RETURNING t.*`,
    [WORKER_ID, leaseSeconds],
  );
  return rows[0] ?? null;
}

/** Count the task's items (0 → not yet enumerated). */
async function countItems(pool: pg.Pool, taskId: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM llm_push_task_items WHERE task_id = $1`,
    [taskId],
  );
  return rows[0]?.n ?? 0;
}

/** Enumerate the task's target tenants into items (idempotent, runs once). */
async function enumerateTargets(pool: pg.Pool, task: LlmPushTaskRecord): Promise<number> {
  let tenantIds: string[];
  if (task.kind === 'tenant_push' && task.scope) {
    tenantIds = [task.scope];
  } else {
    const { rows } = await pool.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM tenants
        WHERE status <> 'destroyed' AND k8s_namespace IS NOT NULL AND agent_endpoint IS NULL
        ORDER BY created_at`,
    );
    tenantIds = rows.map((r) => r.tenant_id);
  }
  if (tenantIds.length > 0) {
    const values = tenantIds.map((_, i) => `($1, $${i + 2})`).join(', ');
    await pool.query(
      `INSERT INTO llm_push_task_items (task_id, tenant_id) VALUES ${values}`,
      [task.id, ...tenantIds],
    );
  }
  await pool.query(`UPDATE llm_push_tasks SET total_count = $1 WHERE id = $2`, [
    tenantIds.length,
    task.id,
  ]);
  return tenantIds.length;
}

/** Claim the next pending item (defensive SKIP LOCKED for future replicas). */
async function claimNextItem(
  pool: pg.Pool,
  taskId: string,
): Promise<LlmPushItemRecord | null> {
  const { rows } = await pool.query<LlmPushItemRecord>(
    `WITH next AS (
       SELECT id FROM llm_push_task_items
       WHERE task_id = $1 AND status = 'pending'
       ORDER BY id
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE llm_push_task_items i
     SET status = 'running', attempts = attempts + 1,
         started_at = COALESCE(started_at, NOW()), updated_at = NOW()
     FROM next
     WHERE i.id = next.id
     RETURNING i.*`,
    [taskId],
  );
  return rows[0] ?? null;
}

/** Persist one item outcome + atomically bump the task's counter. */
async function recordItemResult(
  pool: pg.Pool,
  taskId: string,
  tenantId: string,
  outcome: Awaited<ReturnType<typeof applyTenantLlmConfig>>,
): Promise<void> {
  const status: LlmPushItemStatus = outcome.ok
    ? outcome.skipped
      ? 'skipped'
      : 'succeeded'
    : 'failed';
  await pool.query(
    `UPDATE llm_push_task_items
     SET status = $1, restarted = $2, gateway_restarted = $3, skip_restart = $4,
         error = $5, finished_at = NOW(), updated_at = NOW()
     WHERE task_id = $6 AND tenant_id = $7 AND status = 'running'`,
    [status, outcome.restarted, outcome.gatewayRestarted, outcome.skipRestart, outcome.error ?? null, taskId, tenantId],
  );
  const column =
    status === 'succeeded' ? 'succeeded_count' : status === 'skipped' ? 'skipped_count' : 'failed_count';
  await pool.query(`UPDATE llm_push_tasks SET ${column} = ${column} + 1 WHERE id = $1`, [taskId]);
}

async function renewLease(pool: pg.Pool, taskId: string, leaseSeconds: number): Promise<void> {
  await pool.query(
    `UPDATE llm_push_tasks SET lease_expires_at = NOW() + ($2::int * interval '1 second') WHERE id = $1`,
    [taskId, leaseSeconds],
  );
}

async function isCancelRequested(pool: pg.Pool, taskId: string): Promise<boolean> {
  const { rows } = await pool.query<{ cancel_requested: boolean }>(
    `SELECT cancel_requested FROM llm_push_tasks WHERE id = $1`,
    [taskId],
  );
  return rows[0]?.cancel_requested === true;
}

/** Recompute the task counters from the authoritative items table. */
async function recount(pool: pg.Pool, taskId: string): Promise<CountRow> {
  const { rows } = await pool.query<CountRow>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'succeeded') AS succeeded_count,
       COUNT(*) FILTER (WHERE status = 'failed')    AS failed_count,
       COUNT(*) FILTER (WHERE status = 'skipped')   AS skipped_count
     FROM llm_push_task_items WHERE task_id = $1`,
    [taskId],
  );
  return rows[0];
}

function buildTaskHint(task: LlmPushTaskRecord): string {
  if (task.total_count === 0) return '没有需要推送的租户';
  const done = task.succeeded_count + task.skipped_count;
  if (task.failed_count === 0) {
    return `已完成：${done}/${task.total_count} 个租户已同步，滚动重启生效约 1–2 分钟`;
  }
  return `已完成：${done}/${task.total_count} 个租户成功，${task.failed_count} 个失败（可在进度页重试）`;
}

async function getTaskById(pool: pg.Pool, taskId: string): Promise<LlmPushTaskRecord | null> {
  const { rows } = await pool.query<LlmPushTaskRecord>(
    `SELECT * FROM llm_push_tasks WHERE id = $1`,
    [taskId],
  );
  return rows[0] ?? null;
}

/** Set the task's terminal status, recounting from items (final consistency). */
async function finishTask(
  pool: pg.Pool,
  taskId: string,
  status: LlmPushTaskStatus,
  error: string | null,
): Promise<LlmPushTaskRecord | null> {
  const counts = await recount(pool, taskId);
  await pool.query(
    `UPDATE llm_push_tasks
     SET status = $1, succeeded_count = $2, failed_count = $3, skipped_count = $4,
         error = $5, lease_owner = NULL, lease_expires_at = NULL, finished_at = NOW()
     WHERE id = $6`,
    [status, counts.succeeded_count, counts.failed_count, counts.skipped_count, error, taskId],
  );
  return getTaskById(pool, taskId);
}

/** Full run of one claimed task. Publishes snapshot/item/task/done to SSE. */
export async function executeTask(
  pool: pg.Pool,
  config: ProvisioningConfig,
  broker: SseBroker,
  task: LlmPushTaskRecord,
): Promise<void> {
  const taskId = task.id;
  try {
    const prevLibrary = decryptLibraryOrThrow(task.prev_library);
    const nextLibrary = decryptLibraryOrThrow(task.next_library);

    if ((await countItems(pool, taskId)) === 0) {
      await enumerateTargets(pool, task);
    }
    const current = (await getTaskById(pool, taskId)) ?? task;
    broker.publish(taskId, 'snapshot', {
      taskId,
      status: current.status,
      totalCount: current.total_count,
      succeededCount: current.succeeded_count,
      failedCount: current.failed_count,
      skippedCount: current.skipped_count,
      error: current.error,
    });

    for (;;) {
      if (await isCancelRequested(pool, taskId)) {
        await finishTask(pool, taskId, 'cancelled', null);
        break;
      }
      const item = await claimNextItem(pool, taskId);
      if (!item) break; // no pending items left

      const outcome = await applyTenantLlmConfig(
        pool,
        config,
        item.tenant_id,
        nextLibrary,
        prevLibrary,
        task.scope,
      );
      await recordItemResult(pool, taskId, item.tenant_id, outcome);
      await renewLease(pool, taskId, config.llmPushLeaseSeconds);

      broker.publish(taskId, 'item', {
        taskId,
        tenantId: item.tenant_id,
        status: outcome.ok ? (outcome.skipped ? 'skipped' : 'succeeded') : 'failed',
        restarted: outcome.restarted,
        gatewayRestarted: outcome.gatewayRestarted,
        skipRestart: outcome.skipRestart,
        error: outcome.error ?? null,
      });
    }

    const finished = await getTaskById(pool, taskId);
    if (finished && finished.status !== 'cancelled') {
      const counts = await recount(pool, taskId);
      const finalStatus: LlmPushTaskStatus =
        counts.failed_count === 0
          ? 'succeeded'
          : counts.succeeded_count + counts.skipped_count === 0
            ? 'failed'
            : 'partial';
      await finishTask(pool, taskId, finalStatus, null);
    }

    const done = await getTaskById(pool, taskId);
    if (done) {
      broker.publish(taskId, 'task', {
        taskId,
        status: done.status,
        totalCount: done.total_count,
        succeededCount: done.succeeded_count,
        failedCount: done.failed_count,
        skippedCount: done.skipped_count,
        error: done.error,
        hint: buildTaskHint(done),
      });
    }
    broker.publish(taskId, 'done', { taskId });
    broker.close(taskId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[llm-push] executeTask ${taskId} failed:`, message);
    await finishTask(pool, taskId, 'failed', message);
    broker.publish(taskId, 'task', {
      taskId,
      status: 'failed',
      error: message,
    });
    broker.publish(taskId, 'done', { taskId });
    broker.close(taskId);
  }
}

// ── Queries (REST) ──

function toTaskView(t: LlmPushTaskRecord): LlmPushTaskView {
  return {
    id: t.id,
    kind: t.kind,
    scope: t.scope,
    trigger: t.trigger,
    status: t.status,
    totalCount: t.total_count,
    succeededCount: t.succeeded_count,
    failedCount: t.failed_count,
    skippedCount: t.skipped_count,
    error: t.error,
    createdAt: t.created_at.toISOString(),
    startedAt: t.started_at?.toISOString() ?? null,
    finishedAt: t.finished_at?.toISOString() ?? null,
  };
}

export async function listTasks(
  pool: pg.Pool,
  opts: { limit?: number; offset?: number; status?: string } = {},
): Promise<{ tasks: LlmPushTaskView[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const params: unknown[] = [limit, offset];
  let where = '';
  if (opts.status) {
    params.push(opts.status);
    where = 'WHERE status = $3';
  }
  const { rows } = await pool.query<LlmPushTaskRecord>(
    `SELECT * FROM llm_push_tasks ${where} ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    params,
  );
  const { rows: countRows } = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM llm_push_tasks ${where}`,
    opts.status ? [opts.status] : [],
  );
  return { tasks: rows.map(toTaskView), total: countRows[0]?.n ?? 0 };
}

export async function getTaskDetail(
  pool: pg.Pool,
  taskId: string,
): Promise<{ task: LlmPushTaskView; items: LlmPushItemView[] } | null> {
  const task = await getTaskById(pool, taskId);
  if (!task) return null;
  const { rows } = await pool.query<LlmPushItemRecord>(
    `SELECT * FROM llm_push_task_items WHERE task_id = $1 ORDER BY id`,
    [taskId],
  );
  const items: LlmPushItemView[] = rows.map((r) => ({
    tenantId: r.tenant_id,
    status: r.status,
    restarted: r.restarted,
    gatewayRestarted: r.gateway_restarted,
    skipRestart: r.skip_restart,
    error: r.error,
  }));
  return { task: toTaskView(task), items };
}

/** Reset failed items back to pending (and reopen a terminal task) for retry. */
export async function retryFailedItems(
  pool: pg.Pool,
  taskId: string,
  tenantIds?: string[],
): Promise<number> {
  const resetParams: unknown[] = [taskId];
  let tenantFilter = '';
  if (tenantIds && tenantIds.length > 0) {
    resetParams.push(tenantIds);
    tenantFilter = 'AND tenant_id = ANY($2::text[])';
  }
  const { rowCount } = await pool.query(
    `UPDATE llm_push_task_items
     SET status = 'pending', error = NULL, started_at = NULL, finished_at = NULL, updated_at = NOW()
     WHERE task_id = $1 AND status = 'failed' ${tenantFilter}`,
    resetParams,
  );
  // Reopen a terminal task so the worker re-claims it (counters are recomputed
  // on the next finishTask from the items table, so no manual counter fix-up).
  await pool.query(
    `UPDATE llm_push_tasks
     SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL,
         finished_at = NULL, error = NULL
     WHERE id = $1 AND status IN ('succeeded','partial','failed','cancelled')`,
    [taskId],
  );
  return rowCount ?? 0;
}

/** Cooperative cancel: pending → cancelled; running → flag checked between items. */
export async function requestCancel(pool: pg.Pool, taskId: string): Promise<boolean> {
  const task = await getTaskById(pool, taskId);
  if (!task) return false;
  if (task.status === 'pending') {
    await pool.query(`UPDATE llm_push_tasks SET status = 'cancelled' WHERE id = $1`, [taskId]);
  } else if (task.status === 'running') {
    await pool.query(`UPDATE llm_push_tasks SET cancel_requested = TRUE WHERE id = $1`, [taskId]);
  }
  return true;
}

/**
 * Recycle running tasks whose lease expired, resetting their in-flight items
 * back to pending so a re-claim resumes from where the dead worker left off.
 */
export async function reapStaleTasks(pool: pg.Pool): Promise<number> {
  await pool.query(
    `UPDATE llm_push_task_items i
     SET status = 'pending', started_at = NULL
     FROM llm_push_tasks t
     WHERE i.task_id = t.id
       AND i.status = 'running'
       AND t.status = 'running'
       AND t.lease_expires_at < NOW()`,
  );
  const { rowCount } = await pool.query(
    `UPDATE llm_push_tasks
     SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL
     WHERE status = 'running' AND lease_expires_at < NOW()`,
  );
  return rowCount ?? 0;
}

/**
 * Prune FINISHED tasks older than `retentionDays`. The per-tenant items are
 * removed by the `ON DELETE CASCADE` foreign key. Only terminal statuses are
 * touched — running/pending are the reaper's concern, never pruned here.
 */
export async function pruneOldLlmPushTasks(
  pool: pg.Pool,
  retentionDays = 30,
): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM llm_push_tasks
     WHERE status IN ('succeeded','partial','failed','cancelled')
       AND finished_at < NOW() - ($1::int * interval '1 day')`,
    [retentionDays],
  );
  return rowCount ?? 0;
}

// ── Process loops (started from index.ts) ──

/**
 * Polling worker loop. A `running` flag keeps a single task in flight per
 * process (tenant items are executed sequentially — same semantics as the old
 * synchronous loop). Returns the interval handle (unref'd by the caller).
 */
export function startLlmPushWorker(
  pool: pg.Pool,
  config: ProvisioningConfig,
  broker: SseBroker,
): NodeJS.Timeout {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const task = await claimNextTask(pool, config.llmPushLeaseSeconds);
      if (task) await executeTask(pool, config, broker, task);
    } catch (err) {
      console.error('[llm-push] worker tick failed:', err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), config.llmPushWorkerIntervalMs);
  timer.unref();
  void tick();
  return timer;
}

/** Reaper loop recycling expired-running tasks. Returns the interval handle. */
export function startLlmPushReaper(
  pool: pg.Pool,
  intervalMs = 30_000,
): NodeJS.Timeout {
  const reap = async (): Promise<void> => {
    try {
      const n = await reapStaleTasks(pool);
      if (n > 0) console.log(`[llm-push] reaper recycled ${n} stale task(s)`);
    } catch (err) {
      console.error('[llm-push] reaper tick failed:', err);
    }
  };
  const timer = setInterval(() => void reap(), intervalMs);
  timer.unref();
  return timer;
}

/**
 * Daily pruner removing finished tasks older than the retention window.
 * Keeps the llm_push_tasks history bounded without external tooling — the
 * same pattern as the audit-log pruner in index.ts.
 */
export function startLlmPushPruner(
  pool: pg.Pool,
  retentionDays = 30,
  intervalMs = 24 * 60 * 60 * 1000,
): NodeJS.Timeout {
  const prune = async (): Promise<void> => {
    try {
      const n = await pruneOldLlmPushTasks(pool, retentionDays);
      if (n > 0) console.log(`[llm-push] pruner deleted ${n} finished task(s) older than ${retentionDays}d`);
    } catch (err) {
      console.error('[llm-push] pruner tick failed:', err);
    }
  };
  const timer = setInterval(() => void prune(), intervalMs);
  timer.unref();
  return timer;
}