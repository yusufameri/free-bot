import { describe, expect, test } from "bun:test";
import { type SeqAudit, type SeqLog, SeqLog as SeqLogClass } from "./seq-log.ts";

function fresh(): SeqLog<string> {
  return new SeqLogClass<string>();
}

function appendAll(log: SeqLog<string>, upto: number): void {
  for (let seq = 1; seq <= upto; seq += 1) log.append(seq, `f${seq}`);
}

function seqs(log: SeqLog<string>, since = 0): number[] {
  return log.since(since).map((entry) => entry.seq);
}

function cleanAudit(log: SeqLog<string>): SeqAudit {
  return log.audit();
}

describe("SeqLog append and audit", () => {
  test("in-order appends stay one contiguous run", () => {
    const log = fresh();
    appendAll(log, 5);

    expect(cleanAudit(log)).toEqual({
      firstSeq: 1,
      lastSeq: 5,
      count: 5,
      gaps: [],
      duplicates: [],
      suppressedAtIngest: [],
      gapEvents: [],
      rejected: 0,
    });
  });

  test("a replayed frame is suppressed, never stored twice", () => {
    const log = fresh();
    appendAll(log, 3);

    expect(log.append(2, "replayed")).toBe("duplicate");
    expect(log.append(3, "replayed")).toBe("duplicate");

    const audit = cleanAudit(log);
    expect(audit.count).toBe(3);
    expect(audit.lastSeq).toBe(3);
    expect(audit.suppressedAtIngest).toEqual([2, 3]);
    expect(audit.duplicates).toEqual([]);
    expect(seqs(log)).toEqual([1, 2, 3]);
  });

  test("a frame that skips ahead is refused, then heals after the resend", () => {
    const log = fresh();
    appendAll(log, 2);

    expect(log.append(5, "ahead")).toBe("gap");
    expect(cleanAudit(log)).toEqual({
      firstSeq: 1,
      lastSeq: 2,
      count: 2,
      gaps: [],
      duplicates: [],
      suppressedAtIngest: [],
      gapEvents: [{ expected: 3, got: 5 }],
      rejected: 0,
    });

    appendAll(log, 5);
    expect(seqs(log)).toEqual([1, 2, 3, 4, 5]);
    expect(cleanAudit(log).gaps).toEqual([]);
  });

  test("non-seqs are rejected without touching the log", () => {
    const log = fresh();

    expect(log.append(0, "zero")).toBe("rejected");
    expect(log.append(-1, "negative")).toBe("rejected");
    expect(log.append(1.5, "fractional")).toBe("rejected");
    expect(log.append(Number.NaN, "nan")).toBe("rejected");
    expect(cleanAudit(log)).toEqual({
      firstSeq: null,
      lastSeq: 0,
      count: 0,
      gaps: [],
      duplicates: [],
      suppressedAtIngest: [],
      gapEvents: [],
      rejected: 4,
    });

    expect(log.append(1, "f1")).toBe("appended");
    expect(log.lastSeq).toBe(1);
  });

  test("reject() counts a malformed payload without storing anything", () => {
    const log = fresh();
    appendAll(log, 2);

    log.reject();
    log.reject();

    const audit = cleanAudit(log);
    expect(audit.rejected).toBe(2);
    expect(audit.count).toBe(2);
    expect(audit.lastSeq).toBe(2);
  });
});

describe("SeqLog replay from last_seen_seq", () => {
  test("since returns exactly the frames after the mark", () => {
    const log = fresh();
    appendAll(log, 6);

    expect(log.since(0).map((entry) => entry.frame)).toEqual(["f1", "f2", "f3", "f4", "f5", "f6"]);
    expect(seqs(log, 2)).toEqual([3, 4, 5, 6]);
    expect(log.since(2).map((entry) => entry.frame)).toEqual(["f3", "f4", "f5", "f6"]);
    expect(seqs(log, 6)).toEqual([]);
    expect(seqs(log, 99)).toEqual([]);
  });

  test("a mid-stream disconnect replays exactly what the client missed", () => {
    const log = fresh();
    appendAll(log, 2);
    const deliveredBeforeDisconnect = log.since(0).map((entry) => entry.seq);
    expect(deliveredBeforeDisconnect).toEqual([1, 2]);

    appendAll(log, 5);
    const lastSeenSeq = deliveredBeforeDisconnect.length;

    expect(seqs(log, lastSeenSeq)).toEqual([3, 4, 5]);
    expect(cleanAudit(log).gaps).toEqual([]);
    expect(cleanAudit(log).duplicates).toEqual([]);
  });
});
