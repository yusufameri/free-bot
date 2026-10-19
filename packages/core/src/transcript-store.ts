/**
 * The thread transcript: a `SeqLog` whose frames are also on disk, one line each, replayed at boot.
 *
 * A thread's frames live in a `SeqLog` in memory, so a restart that only reopened the run journal
 * would bring back every run record and no conversation to show beside it. This store is the same
 * log, with the frames kept: `{"seq":N,"frame":{...}}` per line, appended in seq order, replayed
 * into the log at boot. It is a `SeqLog` rather than something holding one, so the durable copy sits
 * under the log's own decision: a frame the log refused (a duplicate, a gap, a malformed payload)
 * never reaches the disk, and there is no second path that appends a frame the page would lose on
 * the next restart. A client's `last_seen_seq` keeps meaning the same thing across a restart,
 * because the resumed log's tail is the file's tail.
 *
 * A line the replay cannot use stops it there. The rest of the file may well be good records, but
 * their seqs sit after a hole this process will never fill, so the file is truncated to the last
 * record that survived and the refusal is reported instead of thrown: a transcript that is partly
 * readable is a conversation worth showing, and the alternative is a server that will not boot.
 */

import { JsonlFile } from "./jsonl.ts";
import { type SeqAppend, SeqLog } from "./seq-log.ts";

/** One line of the transcript, as it sits on disk. */
export interface TranscriptRecord<TFrame> {
  seq: number;
  frame: TFrame;
}

/** What the boot replay found: how much it kept, and the first line it could not use. */
export interface TranscriptLoadReport {
  /** Records replayed into the log. */
  count: number;
  /** The tail of the seq space after the replay; a client rejoins from exactly here. */
  lastSeq: number;
  /** The file ended in a half-written record, which was dropped and the file repaired. */
  tornTrailingLine: boolean;
  /**
   * The first line the replay refused, by file line number, with why. Null when every line was
   * used. The file is truncated to the record before it, so the next append continues from the tail
   * the log actually kept.
   */
  refused: { line: number; reason: string } | null;
}

export interface TranscriptStoreOptions<TFrame> {
  /** The transcript path, or undefined for a transcript that persists nothing. */
  readonly file?: string;
  /**
   * The frame guard. A transcript is external data by the time it is read back, so the shape is
   * parsed at this boundary rather than asserted, and the store stays generic over the frame type
   * its caller serves.
   */
  readonly isFrame: (value: unknown) => value is TFrame;
}

export class TranscriptStore<TFrame> extends SeqLog<TFrame> {
  readonly #file: JsonlFile;
  readonly #isFrame: (value: unknown) => value is TFrame;
  readonly #loadReport: TranscriptLoadReport;

  constructor(options: TranscriptStoreOptions<TFrame>) {
    super();
    this.#file = new JsonlFile(options.file);
    this.#isFrame = options.isFrame;
    this.#loadReport = this.#replay();
  }

  get path(): string | undefined {
    return this.#file.path;
  }

  get loadReport(): TranscriptLoadReport {
    return this.#loadReport;
  }

  /**
   * The log's verdict on the frame, which is also the file's: only a frame it would take is written.
   *
   * The disk is settled before the log's tail moves. A frame the log would refuse is never written,
   * and a write that throws never reaches the log, so the in-memory tail cannot come out ahead of
   * the file: a reader is only ever told about a seq the disk holds, and the next boot replays the
   * whole of this log rather than the prefix of it the last write got through.
   */
  override append(seq: number, frame: TFrame): SeqAppend {
    if (this.verdict(seq) !== "appended") return super.append(seq, frame);
    this.#file.append(JSON.stringify({ seq, frame } satisfies TranscriptRecord<TFrame>));
    return super.append(seq, frame);
  }

  close(): void {
    this.#file.close();
  }

  /**
   * Rebuild the log from the file. This calls the log's own append, not this override's: the lines
   * are already written, and only the in-memory side of the pair needs rebuilding.
   */
  #replay(): TranscriptLoadReport {
    const loaded = this.#file.read();
    let count = 0;
    let refused: TranscriptLoadReport["refused"] = null;
    for (const [index, line] of loaded.lines.entries()) {
      const parsed = this.#parse(line);
      if (parsed === null) {
        refused = { line: index + 1, reason: "not a transcript record" };
        break;
      }
      const outcome = super.append(parsed.seq, parsed.frame);
      if (outcome !== "appended") {
        refused = { line: index + 1, reason: `the log refused it: ${outcome}` };
        break;
      }
      count += 1;
    }
    if (refused !== null) this.#file.replace(loaded.lines.slice(0, refused.line - 1));
    return {
      count,
      lastSeq: this.lastSeq,
      tornTrailingLine: loaded.tornTrailingLine,
      refused,
    };
  }

  #parse(line: string): TranscriptRecord<TFrame> | null {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return null;
    }
    if (typeof value !== "object" || value === null) return null;
    const { seq, frame } = value as { seq?: unknown; frame?: unknown };
    if (!Number.isSafeInteger(seq) || !this.#isFrame(frame)) return null;
    return { seq: seq as number, frame };
  }
}
