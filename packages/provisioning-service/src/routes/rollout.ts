/**
 * Rollout batch async task — admin REST + SSE endpoints.
 *
 *   GET  /v1/admin/rollout-batch-tasks                    历史任务列表
 *   GET  /v1/admin/rollout-batch-tasks/:taskId            任务详情 + 逐租户 items
 *   GET  /v1/admin/rollout-batch-tasks/:taskId/stream     SSE 进度订阅
 *   POST /v1/admin/rollout-batch-tasks/:taskId/cancel     协作式取消
 *
 * Mirrors routes/llm-push.ts so the admin SPA has one consistent surface for
 * async-deployment progress. The enqueue/detail/stream endpoints under
 * /v1/tenants/batch/deployment/* (routes/tenants.ts) remain the ops-agent
 * (service-token) surface; these admin endpoints reuse the same service
 * functions and the same SseBroker.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import type pg from 'pg';
import type { SseBroker } from '../services/sse-broker.js';
import { isTerminalRolloutBatchStatus } from '../services/rollout-batch-types.js';
import {
  listRolloutBatchTasks,
  getRolloutBatchDetail,
  requestCancelRolloutBatch,
} from '../services/rollout-batch-task.js';

export function createRolloutRoutes(
  pool: pg.Pool,
  broker: SseBroker,
  authMiddleware?: (req: Request, res: Response, next: NextFunction) => void,
) {
  const router = Router();
  if (authMiddleware) {
    router.use(authMiddleware);
  }

  // GET /v1/admin/rollout-batch-tasks — history list
  router.get('/v1/admin/rollout-batch-tasks', async (req: Request, res: Response) => {
    try {
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      const offset = req.query.offset ? Number(req.query.offset) : undefined;
      const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined;
      const result = await listRolloutBatchTasks(pool, { limit, offset, status });
      res.json(result);
    } catch (err) {
      console.error('list rollout-batch-tasks failed:', err);
      res.status(500).json({ code: 'INTERNAL' });
    }
  });

  // GET /v1/admin/rollout-batch-tasks/:taskId — detail + items
  router.get('/v1/admin/rollout-batch-tasks/:taskId', async (req: Request, res: Response) => {
    try {
      const detail = await getRolloutBatchDetail(pool, req.params.taskId);
      if (!detail) {
        res.status(404).json({ code: 'NOT_FOUND', message: '任务不存在' });
        return;
      }
      res.json(detail);
    } catch (err) {
      console.error('get rollout-batch-task failed:', err);
      res.status(500).json({ code: 'INTERNAL' });
    }
  });

  // GET /v1/admin/rollout-batch-tasks/:taskId/stream — SSE progress
  router.get('/v1/admin/rollout-batch-tasks/:taskId/stream', async (req: Request, res: Response) => {
    const { taskId } = req.params;
    let detail;
    try {
      detail = await getRolloutBatchDetail(pool, taskId);
    } catch (err) {
      console.error('rollout stream detail failed:', err);
      res.status(500).json({ code: 'INTERNAL' });
      return;
    }
    if (!detail) {
      res.status(404).json({ code: 'NOT_FOUND', message: '任务不存在' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    broker.subscribe(taskId, res);

    // First frame: snapshot so late subscribers align with current state.
    const t = detail.task;
    res.write(
      `event: snapshot\ndata: ${JSON.stringify({
        taskId,
        status: t.status,
        totalCount: t.totalCount,
        succeededCount: t.succeededCount,
        alreadyCurrentCount: t.alreadyCurrentCount,
        pinnedCount: t.pinnedCount,
        skippedCount: t.skippedCount,
        failedCount: t.failedCount,
        error: t.error,
      })}\n\n`,
    );

    // Already terminal → close immediately (no live updates will follow).
    if (isTerminalRolloutBatchStatus(t.status)) {
      res.write(`event: done\ndata: ${JSON.stringify({ taskId })}\n\n`);
      res.end();
      broker.unsubscribe(taskId, res);
      return;
    }

    // Heartbeat keeps proxies/ALB from idling the connection out.
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 15_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      broker.unsubscribe(taskId, res);
    });
  });

  // POST /v1/admin/rollout-batch-tasks/:taskId/cancel
  router.post('/v1/admin/rollout-batch-tasks/:taskId/cancel', async (req: Request, res: Response) => {
    try {
      const ok = await requestCancelRolloutBatch(pool, req.params.taskId);
      if (!ok) {
        res.status(404).json({ code: 'NOT_FOUND', message: '任务不存在' });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      console.error('cancel rollout-batch-task failed:', err);
      res.status(500).json({ code: 'INTERNAL' });
    }
  });

  return router;
}
