/**
 * LLM push async task — admin REST + SSE endpoints.
 *
 *   GET  /v1/admin/llm-push-tasks                   历史任务列表
 *   GET  /v1/admin/llm-push-tasks/:taskId           任务详情 + 逐租户 items
 *   GET  /v1/admin/llm-push-tasks/:taskId/stream    SSE 进度订阅
 *   POST /v1/admin/llm-push-tasks/:taskId/retry     重试失败租户
 *   POST /v1/admin/llm-push-tasks/:taskId/cancel    协作式取消
 *
 * The SSE stream is a plain Express route writing `text/event-stream` frames;
 * the same-origin fetch carries the Authorization header (browsers can't send
 * custom headers over EventSource, which is why the admin SPA uses fetch +
 * ReadableStream — see lib/sse.ts).
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import type pg from 'pg';
import type { SseBroker } from '../services/sse-broker.js';
import { isTerminalTaskStatus } from '../services/llm-push-types.js';
import {
  listTasks,
  getTaskDetail,
  retryFailedItems,
  requestCancel,
} from '../services/llm-push-task.js';

export function createLlmPushRoutes(
  pool: pg.Pool,
  broker: SseBroker,
  authMiddleware?: (req: Request, res: Response, next: NextFunction) => void,
) {
  const router = Router();
  if (authMiddleware) {
    router.use(authMiddleware);
  }

  // GET /v1/admin/llm-push-tasks — history list
  router.get('/v1/admin/llm-push-tasks', async (req: Request, res: Response) => {
    try {
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      const offset = req.query.offset ? Number(req.query.offset) : undefined;
      const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined;
      const result = await listTasks(pool, { limit, offset, status });
      res.json(result);
    } catch (err) {
      console.error('list llm-push-tasks failed:', err);
      res.status(500).json({ code: 'INTERNAL' });
    }
  });

  // GET /v1/admin/llm-push-tasks/:taskId — detail + items
  router.get('/v1/admin/llm-push-tasks/:taskId', async (req: Request, res: Response) => {
    try {
      const detail = await getTaskDetail(pool, req.params.taskId);
      if (!detail) {
        res.status(404).json({ code: 'NOT_FOUND', message: '任务不存在' });
        return;
      }
      res.json(detail);
    } catch (err) {
      console.error('get llm-push-task failed:', err);
      res.status(500).json({ code: 'INTERNAL' });
    }
  });

  // GET /v1/admin/llm-push-tasks/:taskId/stream — SSE progress
  router.get('/v1/admin/llm-push-tasks/:taskId/stream', async (req: Request, res: Response) => {
    const { taskId } = req.params;
    let detail;
    try {
      detail = await getTaskDetail(pool, taskId);
    } catch (err) {
      console.error('llm-push stream detail failed:', err);
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
    res.write(
      `event: snapshot\ndata: ${JSON.stringify({
        taskId,
        status: detail.task.status,
        totalCount: detail.task.totalCount,
        succeededCount: detail.task.succeededCount,
        failedCount: detail.task.failedCount,
        skippedCount: detail.task.skippedCount,
        error: detail.task.error,
      })}\n\n`,
    );

    // Already terminal → close immediately (no live updates will follow).
    if (isTerminalTaskStatus(detail.task.status)) {
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

  // POST /v1/admin/llm-push-tasks/:taskId/retry
  router.post('/v1/admin/llm-push-tasks/:taskId/retry', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { tenantIds?: unknown };
      const tenantIds = Array.isArray(body.tenantIds)
        ? body.tenantIds.map((x) => String(x))
        : undefined;
      const resetCount = await retryFailedItems(pool, req.params.taskId, tenantIds);
      res.json({ ok: true, resetCount });
    } catch (err) {
      console.error('retry llm-push-task failed:', err);
      res.status(500).json({ code: 'INTERNAL' });
    }
  });

  // POST /v1/admin/llm-push-tasks/:taskId/cancel
  router.post('/v1/admin/llm-push-tasks/:taskId/cancel', async (req: Request, res: Response) => {
    try {
      const ok = await requestCancel(pool, req.params.taskId);
      if (!ok) {
        res.status(404).json({ code: 'NOT_FOUND', message: '任务不存在' });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      console.error('cancel llm-push-task failed:', err);
      res.status(500).json({ code: 'INTERNAL' });
    }
  });

  return router;
}
