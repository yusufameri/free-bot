import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { TranscriptStore } from "./transcript-store.ts";

interface TestFrame {
  kind: string;
}

function isFrame(value: unknown): value is TestFrame {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { kind?: unknown }).kind === "string"
  );
}

function transcript(name = "transcript.jsonl"): string {
  return join(mkdtempSync(join(tmpdir(), "freebot-transcript-")), name);
}

function lines(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
}

function reopen(path: string): TranscriptStore<TestFrame> {
  return new TranscriptStore<TestFrame>({ file: path, isFrame });
}

describe("TranscriptStore", () => {
  test("a written transcript comes back with the same frames, in seq order", () => {
    const path = transcript();
    const first = new TranscriptStore<TestFrame>({ file: path, isFrame });
    expect(first.append(1, { kind: "run.started" })).toBe("appended");
    expect(first.append(2, { kind: "tool_call.result" })).toBe("appended");
    first.close();

    expect(lines(path)).toEqual([
      '{"seq":1,"frame":{"kind":"run.started"}}',
      '{"seq":2,"frame":{"kind":"tool_call.result"}}',
    ]);

    const second = reopen(path);
    expect(second.loadReport).toEqual({
      count: 2,
      lastSeq: 2,
      tornTrailingLine: false,
      refused: null,
    });
    expect(second.since(0)).toEqual([
      { seq: 1, frame: { kind: "run.started" } },
      { seq: 2, frame: { kind: "tool_call.result" } },
    ]);
    // The replayed log is the same log, so the audit the stream reports is the file's own order.
    expect(second.audit()).toMatchObject({
      firstSeq: 1,
      lastSeq: 2,
      count: 2,
      gaps: [],
      duplicates: [],
      rejected: 0,
    });
  });

  test("a reopen resumes the seq space at the file's tail", () => {
    const path = transcript();
    const first = new TranscriptStore<TestFrame>({ file: path, isFrame });
    for (let seq = 1; seq <= 3; seq += 1) first.append(seq, { kind: `frame-${seq}` });
    first.close();

    const second = reopen(path);
    expect(second.lastSeq).toBe(3);
    expect(second.lastSeq + 1).toBe(4);
    expect(second.append(4, { kind: "frame-4" })).toBe("appended");
    expect(second.lastSeq).toBe(4);

    // A client that reconnected with the pre-restart tail gets exactly what it missed, and a
    // client that had seen nothing replays from the start of the same one seq space.
    expect(second.since(3)).toEqual([{ seq: 4, frame: { kind: "frame-4" } }]);
    expect(second.since(0).map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
  });

  test("a frame the log refuses is not written", () => {
    const path = transcript();
    const store = new TranscriptStore<TestFrame>({ file: path, isFrame });
    store.append(1, { kind: "a" });

    expect(store.append(1, { kind: "replayed" })).toBe("duplicate");
    expect(store.append(3, { kind: "ahead" })).toBe("gap");
    expect(store.append(2, { kind: "b" })).toBe("appended");

    expect(lines(path)).toEqual([
      '{"seq":1,"frame":{"kind":"a"}}',
      '{"seq":2,"frame":{"kind":"b"}}',
    ]);
  });

  test("a torn trailing line is dropped, repaired, and reported", () => {
    const path = transcript();
    const store = reopen(path);
    store.append(1, { kind: "kept" });
    store.close();
    appendFileSync(path, '{"seq":2,"frame":{"kind":"half');

    const second = reopen(path);
    expect(second.loadReport).toEqual({
      count: 1,
      lastSeq: 1,
      tornTrailingLine: true,
      refused: null,
    });
    expect(lines(path)).toEqual(['{"seq":1,"frame":{"kind":"kept"}}']);

    // The repair is what makes the next append a complete record rather than a joined one.
    expect(second.append(2, { kind: "next" })).toBe("appended");
    expect(reopen(path).since(0)).toEqual([
      { seq: 1, frame: { kind: "kept" } },
      { seq: 2, frame: { kind: "next" } },
    ]);
  });

  test("a line the replay cannot use stops it there and truncates the file", () => {
    const path = transcript();
    const store = reopen(path);
    store.append(1, { kind: "kept" });
    store.close();
    appendFileSync(path, "not json at all\n");
    appendFileSync(path, '{"seq":3,"frame":{"kind":"after-the-hole"}}\n');

    const second = reopen(path);
    expect(second.loadReport).toEqual({
      count: 1,
      lastSeq: 1,
      tornTrailingLine: false,
      refused: { line: 2, reason: "not a transcript record" },
    });
    expect(lines(path)).toEqual(['{"seq":1,"frame":{"kind":"kept"}}']);
    // The repair rewrites the file rather than editing it in place, and the copy it swaps in is the
    // only thing left in the directory: no neighbour file survives the swap.
    expect(readdirSync(dirname(path))).toEqual(["transcript.jsonl"]);
    expect(second.append(2, { kind: "repaired" })).toBe("appended");
  });

  test("a record whose frame is not a frame is refused, not replayed", () => {
    const path = transcript();
    const store = reopen(path);
    store.append(1, { kind: "kept" });
    store.close();
    appendFileSync(path, '{"seq":2,"frame":{"kind":7}}\n');

    const second = reopen(path);
    expect(second.loadReport.count).toBe(1);
    expect(second.loadReport.refused).toEqual({ line: 2, reason: "not a transcript record" });
    expect(second.lastSeq).toBe(1);
  });

  test("a write that fails leaves the log where it was", () => {
    const base = mkdtempSync(join(tmpdir(), "freebot-transcript-"));
    const blocked = join(base, "blocked");
    const store = new TranscriptStore<TestFrame>({
      file: join(blocked, "transcript.jsonl"),
      isFrame,
    });
    // The directory the append would create is a file by the time it asks for it, so the append
    // reaches the disk step and fails there.
    writeFileSync(blocked, "");

    expect(() => store.append(1, { kind: "never-written" })).toThrow();
    // The frame is not in the log either, so nothing a reader was told about can go missing on the
    // next boot: the memory is only ever as far as the disk.
    expect(store.lastSeq).toBe(0);
    expect(store.count).toBe(0);
    expect(store.since(0)).toEqual([]);
    expect(store.audit()).toMatchObject({ lastSeq: 0, count: 0, rejected: 0 });
    expect(store.verdict(1)).toBe("appended");
  });

  test("a transcript with no file persists nothing and reports nothing", () => {
    const store = new TranscriptStore<TestFrame>({ isFrame });
    expect(store.append(1, { kind: "a" })).toBe("appended");
    expect(store.lastSeq).toBe(1);
    expect(store.path).toBeUndefined();
    expect(store.loadReport).toEqual({
      count: 0,
      lastSeq: 0,
      tornTrailingLine: false,
      refused: null,
    });
  });
});
