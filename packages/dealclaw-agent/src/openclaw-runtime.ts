import { createHash } from 'node:crypto';

export interface AgentExecutionContext {
  tenantId: string;
  userId: string;
  channel: string;
  planTier?: string;
}

export interface RuntimeResult {
  text: string;
  responseId?: string;
  model?: string;
  agentId: string;
}

export interface RuntimeClient {
  health(): Promise<{ ok: boolean; detail?: string }>;
  execute(text: string, context: AgentExecutionContext): Promise<RuntimeResult>;
}

interface OpenResponsesBody {
  id?: string;
  model?: string;
  output_text?: string;
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  error?: { message?: string };
}

export class OpenClawRuntimeClient implements RuntimeClient {
  private readonly baseUrl: string;
  private readonly agentId: string;
  private readonly timeoutMs: number;

  constructor(options: { baseUrl?: string; agentId?: string; timeoutMs?: number } = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.OPENCLAW_RUNTIME_URL ?? 'http://127.0.0.1:18790').replace(/\/$/, '');
    this.agentId = options.agentId ?? process.env.OPENCLAW_AGENT_ID ?? 'dealclaw';
    this.timeoutMs = options.timeoutMs ?? Number(process.env.OPENCLAW_RUNTIME_TIMEOUT_MS ?? 120_000);
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const response = await fetch(`${this.baseUrl}/readyz`, {
        signal: AbortSignal.timeout(2_000),
      });
      return { ok: response.ok, detail: response.ok ? 'gateway-ready' : `gateway-http-${response.status}` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async execute(text: string, context: AgentExecutionContext): Promise<RuntimeResult> {
    const sessionKey = stableSessionKey(context);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-openclaw-agent-id': this.agentId,
      'x-openclaw-session-key': sessionKey,
      'x-openclaw-message-channel': sanitizeChannel(context.channel),
    };
    // The gateway enforces Bearer auth whenever a non-empty token exists
    // (2026-08-24+ provisioning always sets one). Missing it yields 401 →
    // the /execute bridge surfaces 502. Legacy fleets with an empty token
    // run the gateway in auth=none mode, so omit the header for them.
    const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    if (gatewayToken) headers['authorization'] = `Bearer ${gatewayToken}`;

    const response = await fetch(`${this.baseUrl}/v1/responses`, {
      method: 'POST',
      signal: AbortSignal.timeout(this.timeoutMs),
      headers,
      body: JSON.stringify({
        model: `openclaw/${this.agentId}`,
        input: text,
        user: stableUser(context),
        stream: false,
      }),
    });

    const raw = await response.text();
    let body: OpenResponsesBody;
    try {
      body = JSON.parse(raw) as OpenResponsesBody;
    } catch {
      throw new Error(`OpenClaw returned non-JSON response (HTTP ${response.status})`);
    }

    if (!response.ok) {
      throw new Error(body.error?.message ?? `OpenClaw request failed (HTTP ${response.status})`);
    }

    const output = extractOutputText(body);
    if (!output) throw new Error('OpenClaw response contained no assistant text');

    return {
      text: output,
      responseId: body.id,
      model: body.model,
      agentId: this.agentId,
    };
  }
}

export function extractOutputText(body: OpenResponsesBody): string {
  if (typeof body.output_text === 'string' && body.output_text.trim()) return body.output_text.trim();

  return (body.output ?? [])
    .flatMap(item => item.content ?? [])
    .filter(part => part.type === 'output_text' && typeof part.text === 'string')
    .map(part => part.text!.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function stableSessionKey(context: AgentExecutionContext): string {
  const digest = createHash('sha256')
    .update(`${context.tenantId}\0${context.channel}\0${context.userId}`)
    .digest('hex')
    .slice(0, 32);
  return `dealclaw-http-${digest}`;
}

function stableUser(context: AgentExecutionContext): string {
  return createHash('sha256')
    .update(`${context.tenantId}\0${context.userId}`)
    .digest('hex');
}

function sanitizeChannel(channel: string): string {
  return channel.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 40) || 'api';
}
