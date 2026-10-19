/**
 * The event log: append in seq order, replay from any `last_seen_seq`, and audit the run for
 * gaps and duplicates.
 *
 * Ingest is idempotent: a replayed frame the log already holds is suppressed, not stored twice.
 * A frame that skips ahead of the log is refused (the caller asks the source to resend from
 * `lastSeq + 1`) so a hole can never be written into the log in the first place. `audit()`
 * recomputes both invariants from the stored entries rather than trusting the ingest counters.
 */

import type { SeqFrame } from "./tunnel.ts";

export interface SeqAudit {
  /** Seq of the first stored frame; 1 for a run that started clean. */
  firstSeq: number | null;
  lastSeq: number;
  count: number;
  /** Missing seqs inside [firstSeq, lastSeq]; empty is the invariant. */
  gaps: number[];
  /** Seqs stored more than once; empty is the invariant. */
  duplicates: number[];
  /** Replayed frames refused because the log already held them (lost-ack window). */
  suppressedAtIngest: number[];
  /** Frames refused because earlier seqs were missing, and what was expected instead. */
  gapEvents: Array<{ expected: number; got: number }>;
  /** Payloads refused as malformed, truncated, or carrying a non-seq. */
  rejected: number;
}

export type SeqAppend = "appended" | "duplicate" | "gap" | "rejected";

export class SeqLog<TFrame> {
  readonly #entries: SeqFrame<TFrame>[] = [];
  readonly #suppressedAtIngest: number[] = [];
  readonly #gapEvents: Array<{ expected: number; got: number }> = [];
  #rejected = 0;
  #lastSeq = 0;

  get lastSeq(): number {
    return this.#lastSeq;
  }

  get count(): number {
    return this.#entries.length;
  }

  /**
   * The verdict `append` would reach for this seq, recording nothing. A store that keeps its frames
   * somewhere else asks this first so it can settle that copy before the log's tail moves: the rule
   * is written here once and both callers read it, rather than each keeping its own copy of it.
   */
  verdict(seq: number): SeqAppend {
    if (!Number.isSafeInteger(seq) || seq < 1) return "rejected";
    if (seq <= this.#lastSeq) return "duplicate";
    if (seq > this.#lastSeq + 1) return "gap";
    return "appended";
  }

  append(seq: number, frame: TFrame): SeqAppend {
    const outcome = this.verdict(seq);
    switch (outcome) {
      case "rejected":
        this.#rejected += 1;
        break;
      case "duplicate":
        this.#suppressedAtIngest.push(seq);
        break;
      case "gap":
        this.#gapEvents.push({ expected: this.#lastSeq + 1, got: seq });
        break;
      case "appended":
        this.#entries.push({ seq, frame });
        this.#lastSeq = seq;
        break;
    }
    return outcome;
  }

  /** Refuse one malformed payload without letting it touch the log. */
  reject(): void {
    this.#rejected += 1;
  }

  /** Exactly the frames after `lastSeenSeq`; the rejoin contract. */
  since(lastSeenSeq: number): SeqFrame<TFrame>[] {
    return this.#entries.filter((entry) => entry.seq > lastSeenSeq);
  }

  audit(): SeqAudit {
    const gaps: number[] = [];
    const duplicates: number[] = [];
    const seen = new Set<number>();
    let previous: number | null = null;
    for (const entry of this.#entries) {
      if (seen.has(entry.seq)) duplicates.push(entry.seq);
      seen.add(entry.seq);
      if (previous !== null && entry.seq !== previous + 1) {
        for (let missing = previous + 1; missing < entry.seq; missing += 1) gaps.push(missing);
      }
      previous = entry.seq;
    }
    return {
      firstSeq: this.#entries[0]?.seq ?? null,
      lastSeq: this.#lastSeq,
      count: this.#entries.length,
      gaps,
      duplicates,
      suppressedAtIngest: [...this.#suppressedAtIngest],
      gapEvents: [...this.#gapEvents],
      rejected: this.#rejected,
    };
  }
}
