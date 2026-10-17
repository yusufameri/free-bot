/**
 * The agent's send buffer. Frames enter in seq order as the supervisor emits them; the server's
 * ack trims everything at or below it. On a tunnel rejoin the agent replays `pending()` (all
 * frames the log may not hold yet), which is at-least-once delivery: the server's ingest is
 * idempotent, so a frame the ack window lost is suppressed there rather than stored twice.
 */

import type { SeqFrame } from "@freebot/core";

export class Outbox<TFrame> {
  readonly #frames: SeqFrame<TFrame>[] = [];
  #acked = 0;

  /** The highest seq the control plane has confirmed durable. */
  get acked(): number {
    return this.#acked;
  }

  get size(): number {
    return this.#frames.length;
  }

  push(entry: SeqFrame<TFrame>): void {
    this.#frames.push(entry);
  }

  ack(seq: number): void {
    if (seq <= this.#acked) return;
    this.#acked = seq;
    let drop = 0;
    while (drop < this.#frames.length && (this.#frames[drop]?.seq ?? 0) <= seq) drop += 1;
    this.#frames.splice(0, drop);
  }

  /** Everything not yet confirmed durable, in emission order. */
  pending(): SeqFrame<TFrame>[] {
    return [...this.#frames];
  }

  /** The unconfirmed frames after `seq`; the resend path for a nack. */
  since(seq: number): SeqFrame<TFrame>[] {
    return this.#frames.filter((entry) => entry.seq > seq);
  }
}
