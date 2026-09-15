/**
 * LLM Egress Proxy — the tenant's ONLY path to upstream LLM APIs.
 *
 * OpenClaw's provider baseUrl points at this gateway
 * (`/v1/llm/<provider>/...`) — the rewrite happens in provisioning-service's
 * pushLlmProviders. The proxy:
 *
 *   1. Intercepts "查余额"-style messages → synthesizes a balance reply
 *      (zero token cost, status=synthesized).
 *   2. Blocks calls when the tenant's balance is exhausted → synthesizes a
 *      recharge hint (status=blocked). Both syntheses emit a *valid* OpenAI
 *      chat completion (SSE when streaming) so OpenClaw treats them as a
 *      normal model reply and streams them to the user — never an error.
 *   3. Otherwise transparently proxies to the real upstream (Authorization
 *      passthrough), tee-ing the SSE stream to extract the final usage chunk
 *      (OpenClaw always sends stream_options.include_usage) and reports
 *      input/output tokens to credits-ledger (fire-and-forget).
 *
 * Routes are registered BEFORE the global rate limiter and the 1MB JSON
 * parser — LLM contexts can be large and call frequency follows the agent
 * loop, not human users.
 */

import { randomUUID } from 'node:crypto';
import express, { type Request, type Response, type Express } from 'express';
import type { GatewayConfig } from '../config.js';
import {
  isBalanceQuery,
  fetchCustomerBalance,
  formatBalanceReply,
} from './balance-helpers.js';

const BALANCE_CACHE_TTL_MS = 15_000;
const SSE_TAIL_MAX = 65_536; // keep the last 64KB of the stream for usage parse

export interface LlmProxyHooks {
  /** Injectable for tests: called after every request is accounted. */
  onReport?: (event: UsageReportEvent) => void;
  fetchImpl?: typeof fetch;
}

export interface UsageReportEvent {
  tenantId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  latencyMs: number;
  status: 'ok' | 'error' | 'blocked' | 'synthesized';
  requestId: string;
}

interface ParsedChatBody {
  model?: string;
  stream?: boolean;
  messages?: Array<{ role?: string; content?: unknown }>;
}

export function registerLlmProxy(app: Express, config: GatewayConfig, hooks: LlmProxyHooks = {}) {
  const fetchImpl = hooks.fetchImpl ?? fetch;

  // ── per-pod balance cache (fail-open) ──
  let balanceCache: { at: number; value: number | null } = { at: 0, value: null };

  async function getCachedBalance(): Promise<number | null> {
    if (Date.now() - balanceCache.at < BALANCE_CACHE_TTL_MS) return balanceCache.value;
    try {
      const res = await fetchImpl(
        `${config.creditsLedgerUrl.replace(/\/$/, '')}/v1/accounts/${config.keyConfig.creditsAccountId}/balance`,
        {
          signal: AbortSignal.timeout(3_000),
          headers: config.creditsLedgerToken
            ? { Authorization: `Bearer ${config.creditsLedgerToken}` }
            : {},
        },
      );
      if (!res.ok) return null; // fail-open
      const { balance } = await res.json() as { balance: number };
      balanceCache = { at: Date.now(), value: balance };
      return balance;
    } catch {
      return null; // fail-open: ledger down must not block LLM traffic
    }
  }

  function report(ev: UsageReportEvent) {
    hooks.onReport?.(ev);
    if (!config.creditsLedgerUrl) return;
    // fire-and-forget — accounting must never break the reply path
    void fetchImpl(`${config.creditsLedgerUrl.replace(/\/$/, '')}/v1/billing/llm-usage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.creditsLedgerToken ? { Authorization: `Bearer ${config.creditsLedgerToken}` } : {}),
      },
      body: JSON.stringify({
        tenantId: ev.tenantId,
        accountId: config.keyConfig.creditsAccountId,
        provider: ev.provider,
        model: ev.model,
        inputTokens: ev.inputTokens,
        outputTokens: ev.outputTokens,
        cacheHitTokens: ev.cacheHitTokens,
        cacheMissTokens: ev.cacheMissTokens,
        latencyMs: ev.latencyMs,
        status: ev.status,
        source: 'proxy',
        requestId: ev.requestId,
      }),
      signal: AbortSignal.timeout(5_000),
    }).catch(err => {
      console.warn(`[llm-proxy] usage report failed: ${err instanceof Error ? err.message : err}`);
    });
  }

  app.all(
    '/v1/llm/:provider/*',
    express.raw({ type: '*/*', limit: '16mb' }),
    async (req: Request, res: Response) => {
      const provider = String(req.params.provider || '');
      const subPath = String(req.params[0] || '');
      const upstreamBase = config.llmUpstreams[provider];
      const started = Date.now();
      const requestId = randomUUID();

      if (!upstreamBase) {
        res.status(404).json({ code: 'PROVIDER_NOT_FOUND', message: `provider '${provider}' is not configured on this gateway` });
        return;
      }

      // ── parse body (best effort; GET/models has none) ──
      let parsed: ParsedChatBody | null = null;
      const raw = Buffer.isBuffer(req.body) ? req.body : null;
      if (raw && raw.length > 0) {
        try { parsed = JSON.parse(raw.toString('utf8')) as ParsedChatBody; } catch { parsed = null; }
      }
      const model = (parsed?.model && typeof parsed.model === 'string') ? parsed.model : 'unknown';
      const isChatCall = Array.isArray(parsed?.messages) && (parsed!.messages!.length ?? 0) > 0;

      const mkReport = (status: UsageReportEvent['status'], inTok = 0, outTok = 0, hitTok = 0, missTok = 0) => ({
        tenantId: config.tenantId, provider, model,
        inputTokens: inTok, outputTokens: outTok,
        cacheHitTokens: hitTok, cacheMissTokens: missTok,
        latencyMs: Date.now() - started, status, requestId,
      });

      // ── interception 1: balance keyword (chat calls only) ──
      // Length guard: real balance queries are short; sub-agent/system contexts
      // can be hundreds of chars and must never trip the keyword regex (e.g.
      // "不消耗 Apollo" contains "消耗" and previously triggered a false
      // synthesized balance reply).
      const lastUserText = extractLastUserText(parsed);
      if (isChatCall && lastUserText && lastUserText.length <= 40 && isBalanceQuery(lastUserText)) {
        const info = await fetchCustomerBalance(
          config.creditsLedgerUrl, config.keyConfig.creditsAccountId, config.creditsLedgerToken, fetchImpl,
        );
        if (info) {
          const text = formatBalanceReply(info);
          respondSynthesized(res, parsed, model, text);
          report(mkReport('synthesized'));
          return;
        }
        // balance fetch failed → fall through to the real model (fail-open)
      }

      // ── interception 2: exhausted balance (chat calls only) ──
      let balanceCheckMs = 0;
      if (isChatCall) {
        const tBal = Date.now();
        const balance = await getCachedBalance();
        balanceCheckMs = Date.now() - tBal;
        if (balance !== null && balance <= 0) {
          const text = '⚠️ 您的账户额度已用完，暂时无法继续对话。请联系客服或前往充值页面补充额度后重试。';
          respondSynthesized(res, parsed, model, text);
          report(mkReport('blocked'));
          return;
        }
      }

      // ── transparent proxy ──
      const upstreamUrl = subPath
        ? `${upstreamBase}/${subPath}${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`
        : upstreamBase;

      const fwdHeaders: Record<string, string> = {};
      const ct = req.headers['content-type'];
      if (ct) fwdHeaders['content-type'] = ct;
      const auth = req.headers['authorization'];
      if (auth) fwdHeaders['authorization'] = auth;
      const accept = req.headers['accept'];
      if (accept) fwdHeaders['accept'] = accept;

      let upstreamRes: Response | globalThis.Response;
      let fetchMs = 0;
      try {
        const tFetch = Date.now();
        upstreamRes = await fetchImpl(upstreamUrl, {
          method: req.method,
          headers: fwdHeaders,
          body: raw && raw.length > 0 ? new Uint8Array(raw) : undefined,
          signal: AbortSignal.timeout(300_000),
        });
        fetchMs = Date.now() - tFetch;
      } catch (err: any) {
        console.warn(`[llm-proxy] upstream unreachable: ${err?.message || err}`);
        res.status(502).json({ code: 'UPSTREAM_UNREACHABLE', message: 'LLM upstream is unreachable' });
        report(mkReport('error'));
        return;
      }

      res.status(upstreamRes.status);
      const upstreamCt = upstreamRes.headers.get('content-type');
      if (upstreamCt) res.setHeader('content-type', upstreamCt);

      const bodyStream = (upstreamRes as globalThis.Response).body;
      if (!bodyStream) { res.end(); return; }

      const isSSE = (upstreamCt || '').includes('text/event-stream');

      if (isSSE) {
        // SSE hygiene: flush headers immediately and disable any intermediate
        // proxy buffering so chunks reach OpenClaw as they arrive.
        res.setHeader('cache-control', 'no-cache');
        res.setHeader('connection', 'keep-alive');
        res.setHeader('x-accel-buffering', 'no');
        res.flushHeaders();

        // Stream chunks through as they arrive; keep a tail buffer to parse
        // the final usage chunk once the stream completes.
        const reader = bodyStream.getReader();
        const slowChunkLogThresholdMs = Number(process.env.LLM_PROXY_SLOW_CHUNK_MS || 1000);
        let tail = '';
        let chunkCount = 0;
        let firstChunkAt = 0;
        let lastChunkAt = 0;
        let maxIntervalMs = 0;
        let maxReadToWriteMs = 0;
        let drainCount = 0;
        try {
          for (;;) {
            const tReadDone = Date.now();
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = Buffer.from(value);
            const tWriteDone = Date.now();
            const readToWrite = tWriteDone - tReadDone;
            if (readToWrite > maxReadToWriteMs) maxReadToWriteMs = readToWrite;
            if (firstChunkAt === 0) firstChunkAt = tReadDone;
            if (lastChunkAt > 0) {
              const interval = tReadDone - lastChunkAt;
              if (interval > maxIntervalMs) maxIntervalMs = interval;
              if (interval >= slowChunkLogThresholdMs) {
                console.warn(`[llm-proxy][stream] slow chunk: +${interval}ms since last (chunk #${chunkCount}) provider=${provider} model=${model} requestId=${requestId}`);
              }
            }
            lastChunkAt = tReadDone;
            chunkCount++;
            if (!res.write(chunk)) {
              // backpressure: downstream (OpenClaw) is not draining fast enough
              drainCount++;
              const tDrainStart = Date.now();
              await new Promise<void>(resolve => res.once('drain', resolve));
              const drainMs = Date.now() - tDrainStart;
              if (drainMs >= slowChunkLogThresholdMs) {
                console.warn(`[llm-proxy][stream] downstream backpressure: drain waited ${drainMs}ms (chunk #${chunkCount}) provider=${provider} model=${model} requestId=${requestId}`);
              }
            }
            tail = (tail + chunk.toString('utf8')).slice(-SSE_TAIL_MAX);
          }
          res.end();
          const tEnd = Date.now();
          const ttft = firstChunkAt > 0 ? firstChunkAt - started : -1;
          const avgInterval = chunkCount > 1 ? (lastChunkAt - firstChunkAt) / (chunkCount - 1) : 0;
          console.log(
            `[llm-proxy][stream] done provider=${provider} model=${model} requestId=${requestId} ` +
            `balance=${balanceCheckMs}ms fetch=${fetchMs}ms ttft=${ttft}ms ` +
            `chunks=${chunkCount} total=${tEnd - started}ms avgInterval=${avgInterval.toFixed(1)}ms ` +
            `maxInterval=${maxIntervalMs}ms maxReadToWrite=${maxReadToWriteMs}ms drains=${drainCount}`,
          );
        } catch (err: any) {
          console.warn(`[llm-proxy] stream failed mid-flight: ${err?.message || err}`);
          res.end();
          report(mkReport('error'));
          return;
        }
        const usage = parseSseUsage(tail);
        report(mkReport('ok', usage.inputTokens, usage.outputTokens, usage.cacheHitTokens, usage.cacheMissTokens));
        return;
      }

      // Non-streaming: buffer, parse usage, forward.
      const buf = Buffer.from(await new globalThis.Response(bodyStream).arrayBuffer());
      res.setHeader('content-length', String(buf.length));
      res.end(buf);
      if (!upstreamRes.ok) {
        report(mkReport('error'));
        return;
      }
      const usage = parseJsonUsage(buf.toString('utf8'));
      report(mkReport('ok', usage.inputTokens, usage.outputTokens, usage.cacheHitTokens, usage.cacheMissTokens));
    },
  );
}

// ── helpers ──

function extractLastUserText(parsed: ParsedChatBody | null): string | null {
  if (!parsed?.messages?.length) return null;
  for (let i = parsed.messages.length - 1; i >= 0; i--) {
    const m = parsed.messages[i];
    if (m?.role === 'user') {
      const c = m.content;
      if (typeof c === 'string') return c.trim();
      if (Array.isArray(c)) {
        const text = c.filter((p: any) => p?.type === 'text').map((p: any) => String(p.text || '')).join(' ').trim();
        if (text) return text;
      }
      return null;
    }
  }
  return null;
}

interface Tokens { inputTokens: number; outputTokens: number; cacheHitTokens: number; cacheMissTokens: number }

function parseSseUsage(tail: string): Tokens {
  // Find the LAST `data: {...}` line containing a usage object.
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') continue;
    try {
      const obj = JSON.parse(payload);
      if (obj?.usage && typeof obj.usage === 'object') return normalizeUsage(obj.usage);
    } catch { /* partial chunk at buffer edge — keep scanning */ }
  }
  return { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 };
}

function parseJsonUsage(body: string): Tokens {
  try {
    const obj = JSON.parse(body);
    if (obj?.usage) return normalizeUsage(obj.usage);
  } catch { /* not JSON */ }
  return { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 };
}

function normalizeUsage(u: any): Tokens {
  const inp = Number(u?.input_tokens ?? u?.prompt_tokens ?? 0) || 0;
  const out = Number(u?.output_tokens ?? u?.completion_tokens ?? 0) || 0;
  const cacheHit = Number(u?.prompt_cache_hit_tokens ?? u?.prompt_tokens_details?.cached_tokens ?? 0) || 0;
  const cacheMiss = Number(u?.prompt_cache_miss_tokens ?? 0) || 0;
  return { inputTokens: inp, outputTokens: out, cacheHitTokens: cacheHit, cacheMissTokens: cacheMiss };
}

/**
 * Emit a *valid* OpenAI chat completion carrying `text` — SSE when the caller
 * asked to stream (OpenClaw always does), plain JSON otherwise. The model
 * receives what looks like a normal assistant reply, so the agent loop
 * terminates naturally and the user sees the message, never an error.
 */
function respondSynthesized(res: Response, parsed: ParsedChatBody | null, model: string, text: string): void {
  const id = `chatcmpl-dcproxy-${randomUUID().slice(0, 8)}`;
  const created = Math.floor(Date.now() / 1000);
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  if (parsed?.stream) {
    res.status(200);
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('connection', 'keep-alive');
    const chunk = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    chunk({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] });
    chunk({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    chunk({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {} }], usage });
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  res.status(200).json({
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage,
  });
}
