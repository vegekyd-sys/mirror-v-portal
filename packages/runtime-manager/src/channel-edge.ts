import type { Run, Tenant } from "./store.js";
import type { MediaFile } from "./provider.js";

/**
 * A messaging surface the elastic runtime can serve.
 *
 * The sandbox is paused between messages, so nothing that must stay connected
 * can live inside it — OpenClaw's own channel plugins assume a long-lived
 * process and cannot be used here. Each edge therefore runs in the manager,
 * holds whatever connection or poll its protocol needs, and wakes a sandbox
 * only once a message has actually arrived.
 */
export interface ChannelEdge {
  /** Value stored in elastic_runs.channel for messages from this surface. */
  readonly channel: string;
  /** Bring the surface up once at boot: restore connections, resume polls. */
  start?(): void | Promise<void>;
  /** Begin receiving for a tenant. Must be idempotent: called on boot and on every rebind. */
  connect(tenant: Tenant): void | Promise<void>;
  /** Stream a fragment of the agent's reply back to the user. */
  delta(run: Run, text: string): void;
  /** Report execution progress (typing, tool steps, completion). */
  progress(run: Run, kind: string, data: unknown): void;
  /**
   * Deliver files the agent attached to this turn, already read out of the
   * sandbox. Optional: a surface that cannot carry attachments simply omits it.
   */
  media?(run: Run, files: MediaFile[]): void;
  /** Release connections; the process is shutting down. */
  close(): void;
}

/**
 * Dispatches by run.channel so the manager stays channel-agnostic.
 *
 * Replies route strictly by the channel the message arrived on: a run from
 * WeCom must never be answered through Feishu, so an unknown channel is
 * dropped rather than falling back to any connected edge.
 */
export class EdgeRouter {
  private readonly byChannel = new Map<string, ChannelEdge>();
  constructor(edges: ChannelEdge[]) {
    for (const edge of edges) {
      if (this.byChannel.has(edge.channel))
        throw new Error(`DUPLICATE_CHANNEL_EDGE:${edge.channel}`);
      this.byChannel.set(edge.channel, edge);
    }
  }
  get channels() {
    return [...this.byChannel.keys()];
  }
  edge(channel: string) {
    return this.byChannel.get(channel);
  }
  async start() {
    for (const edge of this.byChannel.values()) await edge.start?.();
  }
  /** Offer the tenant to every edge; each decides whether it has credentials for it. */
  async connect(tenant: Tenant) {
    for (const edge of this.byChannel.values()) await edge.connect(tenant);
  }
  delta(run: Run, text: string) {
    this.byChannel.get(run.channel)?.delta(run, text);
  }
  progress(run: Run, kind: string, data: unknown) {
    this.byChannel.get(run.channel)?.progress(run, kind, data);
  }
  media(run: Run, files: MediaFile[]) {
    this.byChannel.get(run.channel)?.media?.(run, files);
  }
  close() {
    for (const edge of this.byChannel.values()) edge.close();
  }
}
