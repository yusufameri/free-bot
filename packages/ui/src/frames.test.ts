// Behavior tests for the frame contract: the pairwise-distinctness guard and the rule that a
// caption may not describe a state its frame does not show. Both were real defects in U0.11, whose
// denial frame had quietly become a second copy of the terminal one.

import { describe, expect, test } from "bun:test";
import {
  type Capture,
  collapsedPairs,
  describeFacts,
  FRAME_SPECS,
  type FrameFacts,
  specFor,
  unmetClaims,
} from "./frames.ts";

/**
 * The intended shape of each key state, as facts the page would report. The live capture is what
 * the CDP harness asserts; this table exists so the spec logic and the distinctness guard are
 * testable without a browser.
 */
const INTENDED: Array<[string, FrameFacts]> = [
  [
    "01-idle",
    {
      lastSeq: 0,
      done: false,
      frameCount: 0,
      turns: 0,
      cards: [],
      approvals: [],
      deltas: [],
      resume: null,
      streamEnd: null,
    },
  ],
  [
    "02-streaming",
    {
      lastSeq: 8,
      done: false,
      frameCount: 8,
      turns: 1,
      cards: [],
      approvals: [],
      deltas: ["turn-1-chunk-0 "],
      resume: null,
      streamEnd: null,
    },
  ],
  [
    "03-tool-running",
    {
      lastSeq: 10,
      done: false,
      frameCount: 10,
      turns: 1,
      cards: [["call_spike_1", "running"]],
      approvals: [],
      deltas: ["turn-1-chunk-0 "],
      resume: null,
      streamEnd: null,
    },
  ],
  [
    "04-resumed-after-kill",
    {
      lastSeq: 33,
      done: false,
      frameCount: 33,
      turns: 2,
      cards: [["call_spike_1", "done"]],
      approvals: [],
      deltas: ["turn-1-chunk-0 "],
      resume: 33,
      streamEnd: null,
    },
  ],
  [
    "05-approval-pending",
    {
      lastSeq: 55,
      done: false,
      frameCount: 55,
      turns: 2,
      cards: [
        ["call_spike_1", "done"],
        ["call_spike_2", "awaiting approval"],
      ],
      approvals: [null],
      deltas: ["turn-1-chunk-0 "],
      resume: 33,
      streamEnd: null,
    },
  ],
  [
    "06-post-approval",
    {
      lastSeq: 58,
      done: false,
      frameCount: 58,
      turns: 2,
      cards: [
        ["call_spike_1", "done"],
        ["call_spike_2", "running"],
      ],
      approvals: ["allow"],
      deltas: ["turn-1-chunk-0 "],
      resume: 33,
      streamEnd: null,
    },
  ],
  [
    "07-done",
    {
      lastSeq: 90,
      done: true,
      frameCount: 90,
      turns: 4,
      cards: [
        ["call_spike_1", "done"],
        ["call_spike_2", "done"],
        ["call_spike_3", "done"],
      ],
      approvals: ["allow"],
      deltas: ["spike exchange complete."],
      resume: 33,
      streamEnd: "stream complete",
    },
  ],
  [
    "08-denied",
    {
      lastSeq: 58,
      done: false,
      frameCount: 58,
      turns: 2,
      cards: [
        ["call_spike_1", "done"],
        ["call_spike_2", "denied"],
      ],
      approvals: ["deny"],
      deltas: ["turn-2-chunk-0 "],
      resume: null,
      streamEnd: null,
    },
  ],
];

function frame(name: string, facts: FrameFacts, bytes: number): Capture {
  return { name, file: `${name}-0.png`, bytes, sha256: "0".repeat(64), facts };
}

describe("collapsedPairs", () => {
  test("two frames that show the same page are reported, whatever their bytes", () => {
    const facts = INTENDED[6]?.[1];
    if (facts === undefined) throw new Error("missing intended facts");
    const captures = [frame("06-post-approval", facts, 110688), frame("07-done", facts, 110797)];
    expect(collapsedPairs(captures)).toEqual(["06-post-approval/07-done"]);
  });

  test("the intended key states are pairwise distinct", () => {
    const captures = INTENDED.map(([name, facts]) => frame(name, facts, 1));
    expect(collapsedPairs(captures)).toEqual([]);
  });

  test("frames differing only in the assistant text are still distinct", () => {
    const facts = INTENDED[1]?.[1];
    if (facts === undefined) throw new Error("missing intended facts");
    const captures = [
      frame("a", { ...facts, deltas: [...facts.deltas, "more"] }, 1),
      frame("b", facts, 2),
    ];
    expect(collapsedPairs(captures)).toEqual([]);
  });
});

describe("captions", () => {
  test("every intended key state satisfies its own caption's claims", () => {
    for (const [name, facts] of INTENDED) {
      expect([name, unmetClaims(specFor(name), facts)]).toEqual([name, []]);
    }
  });

  test("a caption naming a state the frame does not show reports the unmet claims", () => {
    const done = INTENDED[6]?.[1];
    if (done === undefined) throw new Error("missing intended facts");
    expect(unmetClaims(specFor("08-denied"), done)).toEqual([
      "the approval card shows the deny decision",
      "a tool card shows denied",
      "the run has not finished",
    ]);
  });

  test("the pending caption fails on a frame whose approval is already decided", () => {
    const allowed = INTENDED[5]?.[1];
    if (allowed === undefined) throw new Error("missing intended facts");
    expect(unmetClaims(specFor("05-approval-pending"), allowed)).toEqual([
      "one approval card is waiting",
      "the governed card waits for the answer",
    ]);
  });
});

describe("describeFacts", () => {
  test("one readable line, literal", () => {
    const pending = INTENDED[4]?.[1];
    if (pending === undefined) throw new Error("missing intended facts");
    expect(describeFacts(pending)).toBe(
      'last seq 55 · done false · turns 2 · cards [call_spike_1:done call_spike_2:awaiting approval] · approvals [pending] · resume 33 · stream end - · text "turn-1-chunk-0 "',
    );
  });
});

describe("the frame inventory", () => {
  test("eight named states, in capture order", () => {
    expect(FRAME_SPECS.map((spec) => spec.name)).toEqual(INTENDED.map(([name]) => name));
  });

  test("every spec carries at least one claim and a caption", () => {
    expect(
      FRAME_SPECS.map((spec) => [spec.name, spec.claims.length > 0, spec.caption.length > 0]),
    ).toEqual(FRAME_SPECS.map((spec) => [spec.name, true, true]));
  });
});
