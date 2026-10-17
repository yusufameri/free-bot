// Behavior tests for the committed-frame distinctness guard: the check that caught the
// denial frame which had quietly become a second copy of the terminal one.

import { describe, expect, test } from "bun:test";
import { type Capture, collapsedPairs, type FrameFacts } from "./frames.ts";

/** The page at the end of the run: the state both the denial frame and the done frame showed. */
const terminal: FrameFacts = {
  lastSeq: 38,
  done: true,
  frameCount: 38,
  turns: 6,
  cards: [
    ["call_step_1", "done"],
    ["call_step_2", "done"],
    ["call_step_3", "done"],
    ["call_step_4", "denied"],
    ["call_step_5", "denied"],
  ],
  approvals: ["allow", "deny"],
  deltas: ["calling ", "bash ", "calling ", "bash ", "calling ", "bash ", "script complete."],
  resume: 18,
  streamEnd: "stream complete",
};

/** The page at the refusal with turn 6 parked: the denial moment, before the stream ends. */
const parked: FrameFacts = {
  ...terminal,
  lastSeq: 35,
  frameCount: 35,
  done: false,
  deltas: terminal.deltas.slice(0, 6),
  streamEnd: null,
};

function frame(name: string, facts: FrameFacts, bytes: number): Capture {
  return { name, file: `${name}-0.png`, bytes, sha256: "0".repeat(64), facts };
}

describe("collapsedPairs", () => {
  test("two frames that show the same page are reported, whatever their bytes", () => {
    const captures = [frame("06-denied", terminal, 110688), frame("07-done", terminal, 110797)];
    expect(collapsedPairs(captures)).toEqual(["06-denied/07-done"]);
  });

  test("the parked refusal state is distinct from the terminal state", () => {
    const captures = [frame("06-denied", parked, 108800), frame("07-done", terminal, 110797)];
    expect(collapsedPairs(captures)).toEqual([]);
  });

  test("frames differing only in the assistant text are still distinct", () => {
    const captures = [
      frame("a", { ...terminal, deltas: [...terminal.deltas, "more"] }, 1),
      frame("b", terminal, 2),
    ];
    expect(collapsedPairs(captures)).toEqual([]);
  });
});
