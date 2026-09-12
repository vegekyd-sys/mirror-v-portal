/**
 * Rollout batch async task — task lifecycle + worker + reaper + pruner.
 *
 * Replaces the old synchronous `POST /v1/tenants/batch/deployment` loop (which
 * serially recreated every tenant Deployment and blocked the HTTP request for
 * 10+ minutes, blowing past the ops-agent caller's 120s AbortSignal) with a
 * persistent job queue mirroring the llm-push async pattern:
 *
 *   - enqueueRolloutBatch: the batch route inserts a pending task and returns
 *     { taskId } immediately. Idempotent per (service, image) via a partial
 *     unique index — a cron re-fire while a task is still in flight reuses the
 *     existing task instead of piling up a duplicate.
 *   - startRolloutBatchWorker: a process-local polling loop claims pending
 *     tasks with FOR UPDATE SKIP LOCKED and recreates each tenant's Deployment
 *     (scale 0 → patch image → scale 1) one by one, publishing progress to the
 *     SseBroker.
 *   - startRolloutBatchReaper: recycles running tasks whose lease expired
 *     (worker crash / restart), resetting in-flight items so a re-claim resumes.
 *
 * Crash safety: every item outcome is persisted before the next starts. A
 * re-claimed task only re-runs still-`pending` items. `updateDeploymentImageRecreate`
 * is effectively idempotent (already-on-target is skipped at the item level),
 * so a crash between "deployment patched" and "item recorded" re-runs safely.
 */
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { ProvisioningConfig } from '../config.js';
import type { SseBroker } from './sse-broker.js';
import { getDeployment, updateDeploymentImageRecreate } from './k8s-client.js';
import { getOverrideMap } from './tenant-image-overrides.js';
import type {
  RolloutBatchItemRecord,
  RolloutBatchItemStatus,
  RolloutBatchService,
  RolloutBatchTaskRecord,
  RolloutBatchTaskStatus,
  RolloutBatchTaskView,
} from './rollout-batch-types.js';
import { isTerminalRolloutBatchStatus } from './rollout-batch-types.js';

/** Stable-ish process identity for lease ownership. */
const WORKER_ID = `${process.env.HOSTNAME ?? 'worker'}-${randomUUID().slice(0, 8)}`;

export interface EnqueueRolloutBatchInput {
  service: RolloutBatchService;
  image: string; // 规范化后的完整镜像
  tag: string;   // 期望 tag（展示用）
  actor: string | null;
  actorType: 'admin' | 'service';
}

interface RolloutBatchCountRow {
  succeeded_count: number;
  already_current_count: number;
  pinned_count: number;
  skipped_count: number;
  failed_count: number;
}

/** Outcome of a single tenant's Deployment recreate attempt. */
interface RolloutItemOutcome {
  status: Extract<RolloutBatchItemStatus, 'succeeded' | 'already_current' | 'skipped' | 'failed'>;
  error: string | null;
}

/**
 * Idempotently enqueue a rollout batch and return its task id. If a
 * pending/running task for the same service+image already exists, return that
 * task id instead of inserting a duplicate (the partial unique index
 * `rollout_batch_tasks_active_uq` backstops this against concurrent races).
 */
export async function enqueueRolloutBatch(
  pool: pg.Pool,
  input: EnqueueRolloutBatchInput,
): Promise<{ taskId: string; status: 'pending'; reused: boolean }> {
  // Fast path: reuse an in-flight task for the same service+image.
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM rollout_batch_tasks
     WHERE service = $1 AND image = $2 AND status IN ('pending','running')
     ORDER BY created_at
     LIMIT 1`,
    [input.service, input.image],
  );
  if (existing.rows[0]) {
    return { taskId: existing.rows[0].id, status: 'pending', reused: true };
  }

  const taskId = randomUUID();
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO rollout_batch_tasks (id, service, image, tag, actor, actor_type)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (service, image) WHERE status IN ('pending','running') DO NOTHING
     RETURNING id`,
    [taskId, input.service, input.image, input.tag, input.actor, input.actorType],
  );
  if (inserted.rows[0]) {
    return { taskId, status: 'pending', reused: false };
  }
  // Lost a concurrent race — reuse the winner.
  const winner = await pool.query<{ id: string }>(
    `SELECT id FROM rollout_batch_tasks
     WHERE service = $1 AND image = $2 AND status IN ('pending','running')
     ORDER BY created_at
     LIMIT 1`,
    [input.service, input.image],
  );
  return { taskId: winner.rows[0]?.id ?? taskId, status: 'pending', reused: true };
}

/**
 * Atomically claim the oldest pending task. `FOR UPDATE SKIP LOCKED` makes
 * concurrent replicas claim distinct tasks without a coordination service.
 */
async function claimNextRolloutBatchTask(
  pool: pg.Pool,
  leaseSeconds: number,
): Promise<RolloutBatchTaskRecord | null> {
  const { rows } = await pool.query<RolloutBatchTaskRecord>(
    `WITH next AS (
       SELECT id FROM rollout_batch_tasks
       WHERE status = 'pending'
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE rollout_batch_tasks t
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

async function countRolloutBatchItems(pool: pg.Pool, taskId: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM rollout_batch_task_items WHERE task_id = $1`,
    [taskId],
  );
  return rows[0]?.n ?? 0;
}

/**
 * Enumerate the task's target tenants into items (idempotent, runs once).
 * Pinned tenants (operator-locked image) are materialised directly as
 * `pinned` items so the worker never touches them.
 */
async function enumerateRolloutBatchTargets(
  pool: pg.Pool,
  task: RolloutBatchTaskRecord,
): Promise<number> {
  const { rows } = await pool.query<{ tenant_id: string; k8s_namespace: string }>(
    `SELECT tenant_id, k8s_namespace FROM tenants
      WHERE status NOT IN ('destroyed') AND k8s_namespace IS NOT NULL
      ORDER BY created_at`,
  );
  const overrides = await getOverrideMap(pool, task.service);

  for (const row of rows) {
    const pinned = overrides.has(row.tenant_id);
    await pool.query(
      `INSERT INTO rollout_batch_task_items (task_id, tenant_id, namespace, deployment, status)
       VALUES ($1, $2, $3, $4, $5)`,
      [task.id, row.tenant_id, row.k8s_namespace, `${task.service}-${row.tenant_id}`, pinned ? 'pinned' : 'pending'],
    );
  }
  await pool.query(`UPDATE rollout_batch_tasks SET total_count = $1 WHERE id = $2`, [
    rows.length,
    task.id,
  ]);
  return rows.length;
}

/** Claim the next pending item (defensive SKIP LOCKED for future replicas). */
async function claimNextRolloutBatchItem(
  pool: pg.Pool,
  taskId: string,
): Promise<RolloutBatchItemRecord | null> {
  const { rows } = await pool.query<RolloutBatchItemRecord>(
    `WITH next AS (
       SELECT id FROM rollout_batch_task_items
       WHERE task_id = $1 AND status = 'pending'
       ORDER BY id
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE rollout_batch_task_items i
     SET status = 'running', attempts = attempts + 1,
         started_at = COALESCE(started_at, NOW()), updated_at = NOW()
     FROM next
     WHERE i.id = next.id
     RETURNING i.*`,
    [taskId],
  );
  return rows[0] ?? null;
}

/** Recreate a single tenant's Deployment, classifying the outcome. */
async function applyRolloutToTenant(
  namespace: string,
  deploymentName: string,
  image: string,
): Promise<RolloutItemOutcome> {
  const current = await getDeployment(namespace, deploymentName);
  if (!current) {
    return { status: 'skipped', error: 'deployment not found' };
  }
  const container = (current.spec?.template?.spec?.containers ?? []).find(
    (c: any) => c.name === deploymentName,
  );
  if (container?.image === image) {
    return { status: 'already_current', error: null };
  }
  const updated = await updateDeploymentImageRecreate(namespace, deploymentName, image);
  if (!updated) {
    return { status: 'skipped', error: 'deployment not found' };
  }
  return { status: 'succeeded', error: null };
}

/** Persist one item outcome + atomically bump the task's counter. */
async function recordRolloutBatchItemResult(
  pool: pg.Pool,
  taskId: string,
  tenantId: string,
  outcome: RolloutItemOutcome,
): Promise<void> {
  await pool.query(
    `UPDATE rollout_batch_task_items
     SET status = $1, error = $2, finished_at = NOW(), updated_at = NOW()
     WHERE task_id = $3 AND tenant_id = $4 AND status = 'running'`,
    [outcome.status, outcome.error, taskId, tenantId],
  );
  const column: Record<RolloutItemOutcome['status'], string> = {
    succeeded: 'succeeded_count',
    already_current: 'already_current_count',
    skipped: 'skipped_count',
    failed: 'failed_count',
  };
  await pool.query(
    `UPDATE rollout_batch_tasks SET ${column[outcome.status]} = ${column[outcome.status]} + 1 WHERE id = $1`,
    [taskId],
  );
}

async function renewRolloutBatchLease(
  pool: pg.Pool,
  taskId: string,
  leaseSeconds: number,
): Promise<void> {
  await pool.query(
    `UPDATE rollout_batch_tasks SET lease_expires_at = NOW() + ($2::int * interval '1 second') WHERE id = $1`,
    [taskId, leaseSeconds],
  );
}

/** Recompute the task counters from the authoritative items table. */
async function recountRolloutBatch(pool: pg.Pool, taskId: string): Promise<RolloutBatchCountRow> {
  const { rows } = await pool.query<RolloutBatchCountRow>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'succeeded')      AS succeeded_count,
       COUNT(*) FILTER (WHERE status = 'already_current') AS already_current_count,
       COUNT(*) FILTER (WHERE status = 'pinned')          AS pinned_count,
       COUNT(*) FILTER (WHERE status = 'skipped')         AS skipped_count,
       COUNT(*) FILTER (WHERE status = 'failed')          AS failed_count
     FROM rollout_batch_task_items WHERE task_id = $1`,
    [taskId],
  );
  // COUNT(*) 返回 bigint，node-postgres 默认把 int8 解析为字符串，显式 Number() 归一。
  const r = rows[0];
  return {
    succeeded_count: Number(r?.succeeded_count ?? 0),
    already_current_count: Number(r?.already_current_count ?? 0),
    pinned_count: Number(r?.pinned_count ?? 0),
    skipped_count: Number(r?.skipped_count ?? 0),
    failed_count: Number(r?.failed_count ?? 0),
  };
}

async function getRolloutBatchTaskById(
  pool: pg.Pool,
  taskId: string,
): Promise<RolloutBatchTaskRecord | null> {
  const { rows } = await pool.query<RolloutBatchTaskRecord>(
    `SELECT * FROM rollout_batch_tasks WHERE id = $1`,
    [taskId],
  );
  return rows[0] ?? null;
}

async function finishRolloutBatchTask(
  pool: pg.Pool,
  taskId: string,
  status: RolloutBatchTaskStatus,
  error: string | null,
): Promise<RolloutBatchTaskRecord | null> {
  const counts = await recountRolloutBatch(pool, taskId);
  await pool.query(
    `UPDATE rollout_batch_tasks
     SET status = $1, succeeded_count = $2, already_current_count = $3,
         pinned_count = $4, skipped_count = $5, failed_count = $6,
         error = $7, lease_owner = NULL, lease_expires_at = NULL, finished_at = NOW()
     WHERE id = $8`,
    [
      status,
      counts.succeeded_count,
      counts.already_current_count,
      counts.pinned_count,
      counts.skipped_count,
      counts.failed_count,
      error,
      taskId,
    ],
  );
  return getRolloutBatchTaskById(pool, taskId);
}

function toTaskView(t: RolloutBatchTaskRecord): RolloutBatchTaskView {
  return {
    id: t.id,
    service: t.service,
    image: t.image,
    tag: t.tag,
    status: t.status,
    totalCount: t.total_count,
    succeededCount: t.succeeded_count,
    alreadyCurrentCount: t.already_current_count,
    pinnedCount: t.pinned_count,
    skippedCount: t.skipped_count,
    failedCount: t.failed_count,
    error: t.error,
    createdAt: t.created_at.toISOString(),
    startedAt: t.started_at?.toISOString() ?? null,
    finishedAt: t.finished_at?.toISOString() ?? null,
  };
}

/** Full run of one claimed task. Publishes snapshot/item/task/done to SSE. */
export async function executeRolloutBatchTask(
  pool: pg.Pool,
  config: ProvisioningConfig,
  broker: SseBroker,
  task: RolloutBatchTaskRecord,
): Promise<void> {
  const taskId = task.id;
  try {
    if ((await countRolloutBatchItems(pool, taskId)) === 0) {
      await enumerateRolloutBatchTargets(pool, task);
    }
    const current = (await getRolloutBatchTaskById(pool, taskId)) ?? task;
    broker.publish(taskId, 'snapshot', {
      taskId,
      status: current.status,
      totalCount: current.total_count,
      succeededCount: current.succeeded_count,
      alreadyCurrentCount: current.already_current_count,
      pinnedCount: current.pinned_count,
      skippedCount: current.skipped_count,
      failedCount: current.failed_count,
      error: current.error,
    });

    for (;;) {
      const item = await claimNextRolloutBatchItem(pool, taskId);
      if (!item) break; // no pending items left

      let outcome: RolloutItemOutcome;
      try {
        outcome = await applyRolloutToTenant(
          item.namespace,
          item.deployment,
          task.image,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // 404-ish = deployment 不存在（老租户无该 service）
        const skipped = /404|not found/i.test(message);
        outcome = {
          status: skipped ? 'skipped' : 'failed',
          error: skipped ? 'deployment not found' : message,
        };
      }
      await recordRolloutBatchItemResult(pool, taskId, item.tenant_id, outcome);
      await renewRolloutBatchLease(pool, taskId, config.rolloutBatchLeaseSeconds ?? 600);

      broker.publish(taskId, 'item', {
        taskId,
        tenantId: item.tenant_id,
        deployment: item.deployment,
        status: outcome.status,
        error: outcome.error,
      });
    }

    const finished = await getRolloutBatchTaskById(pool, taskId);
    if (finished) {
      const counts = await recountRolloutBatch(pool, taskId);
      const finalStatus: RolloutBatchTaskStatus =
        counts.failed_count === 0
          ? 'succeeded'
          : counts.succeeded_count + counts.already_current_count + counts.skipped_count === 0
            ? 'failed'
            : 'partial';
      await finishRolloutBatchTask(pool, taskId, finalStatus, null);
    }

    const done = await getRolloutBatchTaskById(pool, taskId);
    if (done) {
      broker.publish(taskId, 'task', {
        taskId,
        status: done.status,
        totalCount: done.total_count,
        succeededCount: done.succeeded_count,
        alreadyCurrentCount: done.already_current_count,
        pinnedCount: done.pinned_count,
        skippedCount: done.skipped_count,
        failedCount: done.failed_count,
        error: done.error,
      });
    }
    broker.publish(taskId, 'done', { taskId });
    broker.close(taskId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[rollout-batch] executeTask ${taskId} failed:`, message);
    await finishRolloutBatchTask(pool, taskId, 'failed', message);
    broker.publish(taskId, 'task', { taskId, status: 'failed', error: message });
    broker.publish(taskId, 'done', { taskId });
    broker.close(taskId);
  }
}

// ── Queries (REST) ──

export async function getRolloutBatchDetail(
  pool: pg.Pool,
  taskId: string,
): Promise<{ task: RolloutBatchTaskView; items: Array<{ tenantId: string; deployment: string; status: string; error: string | null }> } | null> {
  const task = await getRolloutBatchTaskById(pool, taskId);
  if (!task) return null;
  const { rows } = await pool.query<RolloutBatchItemRecord>(
    `SELECT * FROM rollout_batch_task_items WHERE task_id = $1 ORDER BY id`,
    [taskId],
  );
  return {
    task: toTaskView(task),
    items: rows.map((r) => ({
      tenantId: r.tenant_id,
      deployment: r.deployment,
      status: r.status,
      error: r.error,
    })),
  };
}

export async function listRolloutBatchTasks(
  pool: pg.Pool,
  opts: { limit?: number; offset?: number; status?: string } = {},
): Promise<{ tasks: RolloutBatchTaskView[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const params: unknown[] = [limit, offset];
  let where = '';
  let countWhere = '';
  if (opts.status) {
    params.push(opts.status);
    where = 'WHERE status = $3';
    countWhere = 'WHERE status = $1';
  }
  const { rows } = await pool.query<RolloutBatchTaskRecord>(
    `SELECT * FROM rollout_batch_tasks ${where} ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    params,
  );
  const { rows: countRows } = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM rollout_batch_tasks ${countWhere}`,
    opts.status ? [opts.status] : [],
  );
  return { tasks: rows.map(toTaskView), total: countRows[0]?.n ?? 0 };
}

/** Cooperative cancel: pending → cancelled; running → flag checked between items. */
export async function requestCancelRolloutBatch(pool: pg.Pool, taskId: string): Promise<boolean> {
  const task = await getRolloutBatchTaskById(pool, taskId);
  if (!task) return false;
  if (task.status === 'pending') {
    await pool.query(`UPDATE rollout_batch_tasks SET status = 'cancelled' WHERE id = $1`, [taskId]);
  } else if (task.status === 'running') {
    await pool.query(`UPDATE rollout_batch_tasks SET cancel_requested = TRUE WHERE id = $1`, [taskId]);
  }
  return true;
}

/**
 * Recycle running tasks whose lease expired, resetting their in-flight items
 * back to pending so a re-claim resumes from where the dead worker left off.
 */
export async function reapStaleRolloutBatchTasks(pool: pg.Pool): Promise<number> {
  await pool.query(
    `UPDATE rollout_batch_task_items i
     SET status = 'pending', started_at = NULL
     FROM rollout_batch_tasks t
     WHERE i.task_id = t.id
       AND i.status = 'running'
       AND t.status = 'running'
       AND t.lease_expires_at < NOW()`,
  );
  const { rowCount } = await pool.query(
    `UPDATE rollout_batch_tasks
     SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL
     WHERE status = 'running' AND lease_expires_at < NOW()`,
  );
  return rowCount ?? 0;
}

/** Prune FINISHED tasks older than `retentionDays` (items cascade on delete). */
export async function pruneOldRolloutBatchTasks(
  pool: pg.Pool,
  retentionDays = 30,
): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM rollout_batch_tasks
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
export function startRolloutBatchWorker(
  pool: pg.Pool,
  config: ProvisioningConfig,
  broker: SseBroker,
): NodeJS.Timeout {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const task = await claimNextRolloutBatchTask(pool, config.rolloutBatchLeaseSeconds ?? 600);
      if (task) await executeRolloutBatchTask(pool, config, broker, task);
    } catch (err) {
      console.error('[rollout-batch] worker tick failed:', err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), config.rolloutBatchWorkerIntervalMs ?? 500);
  timer.unref();
  void tick();
  return timer;
}

/** Reaper loop recycling expired-running tasks. Returns the interval handle. */
export function startRolloutBatchReaper(
  pool: pg.Pool,
  intervalMs = 30_000,
): NodeJS.Timeout {
  const reap = async (): Promise<void> => {
    try {
      const n = await reapStaleRolloutBatchTasks(pool);
      if (n > 0) console.log(`[rollout-batch] reaper recycled ${n} stale task(s)`);
    } catch (err) {
      console.error('[rollout-batch] reaper tick failed:', err);
    }
  };
  const timer = setInterval(() => void reap(), intervalMs);
  timer.unref();
  return timer;
}

/** Daily pruner removing finished tasks older than the retention window. */
export function startRolloutBatchPruner(
  pool: pg.Pool,
  retentionDays = 30,
  intervalMs = 24 * 60 * 60 * 1000,
): NodeJS.Timeout {
  const prune = async (): Promise<void> => {
    try {
      const n = await pruneOldRolloutBatchTasks(pool, retentionDays);
      if (n > 0) console.log(`[rollout-batch] pruner deleted ${n} finished task(s) older than ${retentionDays}d`);
    } catch (err) {
      console.error('[rollout-batch] pruner tick failed:', err);
    }
  };
  const timer = setInterval(() => void prune(), intervalMs);
  timer.unref();
  return timer;
}

// Re-export for the routes (terminal check lives in types).
export { isTerminalRolloutBatchStatus };
