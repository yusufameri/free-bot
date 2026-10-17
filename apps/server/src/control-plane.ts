/**
 * The control plane's state: one `SeqLog` of v1 events plus the run table the API reads.
 *
 * `packages/core`'s `SeqLog` stays the only place a seq becomes durable; this class mints the
 * control-plane's own events (a start, a cancel) and appends them through it, so the ordering and
 * refusal rules a replayed tunnel frame gets are the same rules these get. Nothing forks the log.
 *
 * The log is also the stream's only buffer. A subscriber that falls behind does not consume a
 * queue: it re-reads `log.since(cursor)`, so a slow or late reader can never drop an event, and a
 * `lastSeq` watermark resumes it exactly. Subscribers wait on a wake-up that an append fires.
 */

import { randomUUID } from "node:crypto";
import { SeqLog } from "@freebot/core";
import { type EventMessage, PROTOCOL_VERSION, type RunStatus } from "@freebot/protocol";

export interface RunRecord {
  runId: string;
  prompt: string;
  status: RunStatus;
  startedAt: number;
  /** Set at the terminal event; null while the run is running. */
  endedAt: number | null;
}

export class ControlPlane {
  readonly log = new SeqLog<EventMessage>();

  readonly #runs = new Map<string, RunRecord>();

  /** One entry per subscriber currently waiting for an append. */
  readonly #waiters = new Set<() => void>();

  get subscriberCount(): number {
    return this.#waiters.size;
  }

  /**
   * Mint a run and log its start. The prompt travels in the event, so the log describes the run
   * without a second source of truth.
   */
  startRun(prompt: string): RunRecord {
    const startedAt = Date.now();
    const runId = `run_${randomUUID()}`;
    const record: RunRecord = {
      runId,
      prompt,
      status: "running",
      startedAt,
      endedAt: null,
    };
    this.#runs.set(runId, record);
    this.#append({
      v: PROTOCOL_VERSION,
      seq: this.log.lastSeq + 1,
      ts: startedAt,
      runId,
      type: "run.started",
      payload: { prompt },
    });
    return record;
  }

  /**
   * End a run as failed, which is the v1 taxonomy's arm for "ended without completing". A cancel
   * for a run that already ended is not an error: it returns the record untouched, so a retried
   * cancel converges.
   */
  cancelRun(runId: string): RunRecord | undefined {
    const record = this.#runs.get(runId);
    if (record === undefined) return undefined;
    if (record.status !== "running") return record;
    const endedAt = Date.now();
    record.status = "failed";
    record.endedAt = endedAt;
    this.#append({
      v: PROTOCOL_VERSION,
      seq: this.log.lastSeq + 1,
      ts: endedAt,
      runId,
      type: "run.failed",
      payload: { reason: "cancelled by operator" },
    });
    return record;
  }

  getRun(runId: string): RunRecord | undefined {
    return this.#runs.get(runId);
  }

  /**
   * The log's messages after `lastSeq`, in seq order, then live. Replay and subscribe happen in one
   * synchronous step, so nothing can slip between them in Bun's single-threaded model.
   *
   * A returned iterator (the socket closed) leaves in the `finally`, so no waiter outlives its
   * subscriber.
   */
  async *stream(lastSeq: number, signal: AbortSignal | undefined): AsyncGenerator<EventMessage> {
    let cursor = lastSeq;
    while (signal?.aborted !== true) {
      for (const entry of this.log.since(cursor)) {
        cursor = entry.seq;
        yield entry.frame;
      }
      const wake = this.#nextAppend(signal);
      try {
        await wake.promise;
      } finally {
        wake.drop();
      }
    }
  }

  #append(message: EventMessage): void {
    const outcome = this.log.append(message.seq, message);
    if (outcome !== "appended") {
      throw new Error(`log refused ${message.type} at seq ${message.seq}: ${outcome}`);
    }
    for (const wake of [...this.#waiters]) wake();
  }

  /** Resolves on the next append, or as soon as `signal` aborts. */
  #nextAppend(signal: AbortSignal | undefined): { promise: Promise<void>; drop: () => void } {
    let wake!: () => void;
    const promise = new Promise<void>((resolve) => {
      wake = resolve;
    });
    const drop = () => {
      this.#waiters.delete(stop);
      signal?.removeEventListener("abort", stop);
    };
    const stop = () => {
      drop();
      wake();
    };
    this.#waiters.add(stop);
    signal?.addEventListener("abort", stop);
    return { promise, drop };
  }
}
