/**
 * SSE broker — in-memory pub/sub between the LLM push worker and open HTTP
 * streaming responses (Server-Sent Events).
 *
 * Single-instance design: the worker and the SSE route run in the same
 * process, so a plain `Map<taskId, Set<Response>>` suffices. Publishing
 * writes the SSE frame directly to every subscribed response; subscribers
 * that have gone away are pruned lazily.
 *
 * Future multi-replica note: this in-memory broker does NOT fan out across
 * processes. Scaling out would require either sticky sessions (route the SSE
 * connection to the replica that owns the task) or PG LISTEN/NOTIFY to
 * broadcast events between replicas — out of scope for v1 (see system_design
 * §11 待确认事项 4).
 */
import type { Response } from 'express';

export class SseBroker {
  private readonly subscribers = new Map<string, Set<Response>>();

  /** Attach a streaming response to a task's fan-out set. */
  subscribe(taskId: string, res: Response): void {
    let set = this.subscribers.get(taskId);
    if (!set) {
      set = new Set();
      this.subscribers.set(taskId, set);
    }
    set.add(res);
  }

  /** Detach a response (client disconnect / stream end). */
  unsubscribe(taskId: string, res: Response): void {
    const set = this.subscribers.get(taskId);
    if (!set) return;
    set.delete(res);
    if (set.size === 0) this.subscribers.delete(taskId);
  }

  /**
   * Write one SSE frame to every subscriber. `id` is optional (auto-increment
   * is the route's concern); passing it emits the `id:` line for reconnect
   * reconciliation. Failures are swallowed — a dead socket must not break
   * the worker.
   */
  publish(taskId: string, event: string, payload: unknown, id?: number): void {
    const set = this.subscribers.get(taskId);
    if (!set || set.size === 0) return;
    const idLine = id != null ? `id: ${id}\n` : '';
    const frame = `event: ${event}\n${idLine}data: ${JSON.stringify(payload)}\n\n`;
    for (const res of set) {
      try {
        res.write(frame);
      } catch {
        // Socket already closed — the route's 'close' handler will prune it.
      }
    }
  }

  /** Terminate all subscribers for a task (task reached terminal state). */
  close(taskId: string): void {
    const set = this.subscribers.get(taskId);
    if (!set) return;
    for (const res of set) {
      try {
        res.end();
      } catch {
        // noop
      }
    }
    this.subscribers.delete(taskId);
  }
}
