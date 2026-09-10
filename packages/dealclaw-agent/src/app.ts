import express, { type Request } from 'express';
import helmet from 'helmet';
import { Readable } from 'node:stream';
import {
  OpenClawRuntimeClient,
  type AgentExecutionContext,
  type RuntimeClient,
} from './openclaw-runtime.js';

const PAYLOAD_VERSION = process.env.DEALCLAW_PAYLOAD_VERSION ?? 'dealclaw-base.v1';

export function createApp(options: { runtime?: RuntimeClient } = {}) {
  const runtime = options.runtime ?? new OpenClawRuntimeClient();
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '1mb' }));

  app.get('/healthz', async (_req, res) => {
    const health = await runtime.health();
    res.status(health.ok ? 200 : 503).json({
      ok: health.ok,
      service: 'dealclaw-agent',
      runtime: 'openclaw',
      payloadVersion: PAYLOAD_VERSION,
      runtimeDetail: health.detail,
    });
  });

  app.post('/execute', async (req, res) => {
    const text = extractIncomingText(req.body);
    if (!text) {
      res.status(400).json({ code: 'EMPTY_MESSAGE', message: 'A non-empty text message is required' });
      return;
    }

    const context = executionContext(req);

    try {
      const result = await runtime.execute(text, context);
      res.json({
        type: 'agent_response',
        intent: 'openclaw_runtime',
        pipeline: ['openclaw/dealclaw'],
        result: {
          summary: result.text,
          actionItems: [],
        },
        creditsUsed: { total: 0 },
        confidence: 1,
        runtime: {
          engine: 'openclaw',
          agentId: result.agentId,
          responseId: result.responseId,
          model: result.model,
          payloadVersion: PAYLOAD_VERSION,
        },
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error('[openclaw-runtime] execution failed:', detail);
      res.status(502).json({
        code: 'AGENT_RUNTIME_UNAVAILABLE',
        message: 'DealClaw runtime is temporarily unavailable',
      });
    }
  });

  /**
   * Streaming execute — pipes OpenClaw's `/v1/responses` SSE (stream=true)
   * straight through to the caller. Same input contract as /execute, but the
   * response is `text/event-stream` with OpenAI Responses API delta events
   * (response.output_text.delta / response.completed ...). Callers MUST NOT
   * buffer; this is a pass-through.
   */
  app.post('/execute/stream', async (req, res) => {
    const body = req.body as any;
    const text = extractIncomingText(body) || stringValue(body?.message);
    if (!text) {
      res.status(400).json({ code: 'EMPTY_MESSAGE', message: 'A non-empty text message is required' });
      return;
    }

    const context = executionContext(req);
    try {
      const { body: stream } = await runtime.executeStream(text, context);
      res.setHeader('content-type', 'text/event-stream; charset=utf-8');
      res.setHeader('cache-control', 'no-cache, no-transform');
      res.setHeader('connection', 'keep-alive');
      res.setHeader('x-accel-buffering', 'no'); // disable proxy buffering (nginx)
      res.flushHeaders();

      const nodeStream = Readable.fromWeb(stream as any);
      nodeStream.on('error', (err) => {
        console.error('[openclaw-runtime] stream error:', err.message);
        if (!res.writableEnded) res.end();
      });
      nodeStream.pipe(res);
      // Client disconnect → tear down the upstream fetch so OpenClaw stops.
      res.on('close', () => nodeStream.destroy());
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error('[openclaw-runtime] stream failed:', detail);
      if (!res.headersSent) {
        res.status(502).json({
          code: 'AGENT_RUNTIME_UNAVAILABLE',
          message: 'DealClaw runtime is temporarily unavailable',
        });
      } else {
        res.end();
      }
    }
  });

  return app;
}

export function extractIncomingText(body: unknown): string {
  const value = body as any;
  const normalized = value?.intent?.text;
  if (typeof normalized === 'string' && normalized.trim()) return normalized.trim();

  const event = value?.event;
  const msg = event?.message ?? event?.event?.message ?? event?.data?.event?.message;
  if (!msg || (msg.msg_type && msg.msg_type !== 'text')) return '';

  try {
    const content = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
    if (typeof content?.text === 'string') return content.text.trim();
    if (typeof msg.text === 'string') return msg.text.trim();
  } catch {
    if (typeof msg.text === 'string') return msg.text.trim();
  }
  return '';
}

function executionContext(req: Request): AgentExecutionContext {
  const header = (name: string) => {
    const value = req.header(name);
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  };

  return {
    tenantId: header('X-DealClaw-Tenant-ID') ?? stringValue((req.body as any)?.tenantId) ?? 'default',
    userId: header('X-DealClaw-User-ID') ?? extractFeishuUserId(req.body) ?? 'anonymous',
    channel: header('X-DealClaw-Channel') ?? 'feishu',
    planTier: header('X-DealClaw-Plan-Tier'),
  };
}

function extractFeishuUserId(body: unknown): string | undefined {
  const value = body as any;
  const event = value?.event;
  const sender = event?.sender ?? event?.event?.sender ?? event?.data?.event?.sender;
  return stringValue(sender?.sender_id?.open_id) ?? stringValue(sender?.sender_id?.user_id);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
