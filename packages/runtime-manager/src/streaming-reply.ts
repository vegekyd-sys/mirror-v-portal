import type * as lark from "@larksuiteoapi/node-sdk";
import { mayBecomeSilent } from "./reply-sentinel.js";
import type { Store } from "./store.js";
export class StreamingReply {
  private text = "";
  private sent = "";
  private status = "";
  private publicSnapshot = "";
  /** Narration the agent wrote before its tool calls, in order. It stays above the answer. */
  private notes: string[] = [];
  /** Provisional text of the message being generated; real output text replaces it. */
  private preview = "";
  private body() { return this.text || this.preview || this.publicSnapshot; }
  private content() { return [...this.notes, this.body(), this.status].filter(Boolean).join("\n\n"); }
  progress(status: string, snapshot?: string) {
    if (this.closed || this.failed) return;
    this.status = status;
    if (snapshot !== undefined) this.publicSnapshot = snapshot;
    this.schedule();
  }
  showPreview(text: string) {
    if (this.closed || this.failed) return;
    // An attachment line is delivered as a file at the end, never shown as text.
    this.preview = text.replace(/^[ \t]*MEDIA:.*$/gm, "").trim();
    this.schedule();
  }
  /** The preview (or streamed text) turned out to be narration: keep it as a note above the answer. */
  commentary(text: string, retract = 0) {
    if (this.closed || this.failed) return;
    if (retract > 0) this.text = this.text.slice(0, Math.max(0, this.text.length - retract));
    if (this.notes[this.notes.length - 1] !== text) this.notes.push(text);
    this.preview = "";
    this.schedule();
  }
  private sequence = 0;
  private cardId?: string;
  private messageId?: string;
  private scheduled = false;
  private lastFlushAt = 0;
  private work: Promise<void> = Promise.resolve();
  private failed = false;
  private closed = false;
  constructor(
    readonly store: Store,
    readonly api: lark.Client,
    readonly runId: string,
    readonly tenantId: string,
    readonly parentMessageId: string,
  ) {}
  push(delta: string) {
    if (this.closed || this.failed) return;
    this.text += delta;
    this.schedule();
  }
  private schedule() {
    // V latest-snapshot patch: retain only the newest cumulative text while
    // an API call is in flight, rather than queuing every obsolete frame.
    if (this.scheduled) return;
    this.scheduled = true;
    this.work = this.work.then(async () => {
      try {
        while (
          !this.closed &&
          this.content() &&
          this.content() !== this.sent &&
          // Hold back while the text could still resolve to a silence marker;
          // once published it cannot be unsaid.
          !((this.text || this.preview) && mayBecomeSilent(this.text || this.preview) && !this.publicSnapshot && !this.status && !this.notes.length)
        ) {
          const delay = Math.max(0, 150 - (Date.now() - this.lastFlushAt));
          if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
          if (this.closed) break;
          this.lastFlushAt = Date.now();
          await this.flush();
        }
      } finally {
        this.scheduled = false;
      }
    }).catch(async () => {
      this.failed = true;
      await this.store.event(this.tenantId, "feishu-stream-error", {}, this.runId).catch(() => {});
    });
  }
  private async load() {
    if (this.cardId) return;
    const { rows } = await this.store.pool.query(
      "SELECT * FROM elastic_streams WHERE run_id=$1",
      [this.runId],
    );
    if (rows[0]) {
      this.cardId = rows[0].card_id;
      this.messageId = rows[0].message_id;
      this.sequence = Number(rows[0].sequence);
    }
  }
  private async flush() {
    await this.load();
    const content = this.content();
    if (!content || content === this.sent) return;
    // Card content is bounded; the durable final-reply path handles longer output.
    if (content.length > 28000) throw Error("STREAM_TOO_LONG");
    if (!this.cardId) {
      const r = await this.api.cardkit.v1.card.create({
        data: {
          type: "card_json",
          data: JSON.stringify({
            schema: "2.0",
            config: {
              streaming_mode: true,
              update_multi: true,
              streaming_config: {
                print_frequency_ms: { default: 70 },
                print_step: { default: 1 },
                print_strategy: "fast",
              },
            },
            body: {
              elements: [{ tag: "markdown", element_id: "answer", content }],
            },
          }),
        },
      });
      if (r.code !== 0 || !r.data?.card_id) throw Error("CARD_CREATE_FAILED");
      this.cardId = r.data.card_id;
      await this.store.pool.query(
        "INSERT INTO elastic_streams(run_id,card_id,sequence) VALUES($1,$2,0) ON CONFLICT(run_id) DO NOTHING",
        [this.runId, this.cardId],
      );
    }
    if (!this.messageId) {
      const r = await this.api.im.message.reply({
        path: { message_id: this.parentMessageId },
        data: {
          msg_type: "interactive",
          content: JSON.stringify({
            type: "card",
            data: { card_id: this.cardId },
          }),
          uuid: this.runId,
        },
      });
      if (r.code !== 0 || !r.data?.message_id) throw Error("CARD_SEND_FAILED");
      this.messageId = r.data.message_id;
      await this.store.pool.query(
        "UPDATE elastic_streams SET message_id=$2 WHERE run_id=$1",
        [this.runId, this.messageId],
      );
      await this.store.event(
        this.tenantId,
        "feishu-first-content",
        {
          at: Date.now(),
          messageId: this.messageId,
          characters: content.length,
          contentKind: this.text || this.publicSnapshot ? "assistant" : this.notes.length ? "commentary" : this.preview ? "preview" : "tool-status",
        },
        this.runId,
      );
    }
    const sequence = ++this.sequence;
    await this.store.pool.query(
      "UPDATE elastic_streams SET sequence=$2 WHERE run_id=$1",
      [this.runId, sequence],
    );
    const r = await this.api.cardkit.v1.cardElement.content({
      path: { card_id: this.cardId, element_id: "answer" },
      data: { content, sequence, uuid: `${this.runId}:${sequence}` },
    });
    if (r.code !== 0) throw Error("CARD_UPDATE_FAILED");
    this.sent = content;
    await this.store.event(
      this.tenantId,
      "feishu-stream-update",
      { at: Date.now(), characters: content.length, sequence },
      this.runId,
    );
  }
  /**
   * Abandon the reply without publishing anything.
   *
   * Used when the agent's answer turns out to be a silence marker. Any in-flight
   * work is awaited so a queued flush cannot land after the decision to stay
   * quiet; nothing further is sent because `closed` gates every write.
   */
  async discard(): Promise<void> {
    this.closed = true;
    await this.work.catch(() => {});
  }
  async finish(output: string): Promise<boolean> {
    this.closed = true;

    await this.work;
    this.text = output;
    this.status = "";
    this.publicSnapshot = "";
    this.preview = "";
    // The narration stays in the final card, above the answer, as the user saw it stream.
    const final = [...this.notes, output].filter(Boolean).join("\n\n");
    try {
      await this.load();
      if (!this.cardId) await this.flush();
      if (!this.cardId || final.length > 28000)
        throw Error("FINAL_CARD_UNAVAILABLE");
      const sequence = ++this.sequence;
      await this.store.pool.query(
        "UPDATE elastic_streams SET sequence=$2 WHERE run_id=$1",
        [this.runId, sequence],
      );
      const r = await this.api.cardkit.v1.card.update({
        path: { card_id: this.cardId },
        data: {
          sequence,
          uuid: `${this.runId}:${sequence}`,
          card: {
            type: "card_json",
            data: JSON.stringify({
              schema: "2.0",
              config: { streaming_mode: false, update_multi: true },
              body: {
                elements: [
                  { tag: "markdown", element_id: "answer", content: final },
                ],
              },
            }),
          },
        },
      });
      if (r.code !== 0) return false;
      return true;
    } catch {
      if (this.cardId) {
        try {
          const sequence = ++this.sequence;
          await this.store.pool.query(
            "UPDATE elastic_streams SET sequence=$2 WHERE run_id=$1",
            [this.runId, sequence],
          );
          await this.api.cardkit.v1.card.settings({
            path: { card_id: this.cardId },
            data: {
              sequence,
              settings: JSON.stringify({ config: { streaming_mode: false } }),
            },
          });
        } catch {}
      }
      return false;
    }
  }
}
