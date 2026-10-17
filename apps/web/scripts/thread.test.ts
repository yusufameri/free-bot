// Behavior tests for the shared thread model, driven by the real committed fixtures: the model is
// exercised the way the surface exercises it (one wire message at a time, in order).

import { describe, expect, test } from "bun:test";
import {
  applyMessage,
  initialState,
  type ThreadState,
  textOf,
} from "../../../packages/ui/src/thread.ts";
import { GATED_CALL, GATED_GRANT, loadFixture } from "./fixture.ts";

function reduce(messages: ReturnType<typeof loadFixture>): ThreadState {
  let state = initialState();
  for (const message of messages) state = applyMessage(state, message);
  return state;
}

describe("the allow fixture", () => {
  const messages = loadFixture("allow");
  const state = reduce(messages);

  test("every message applied, dense to the fixture's head", () => {
    expect([state.applied, state.lastSeq, state.duplicatesIgnored]).toEqual([90, 90, 0]);
  });

  test("the run's own prompt is the first thing the thread shows", () => {
    expect(state.prompt).toBe("smoke: the recorded three-step task");
    expect(state.runId).toBe("run-smoke-a");
  });

  test("four turns, one text run each, the last one closing the exchange", () => {
    expect(state.text.map((run) => [run.turn, run.text.length])).toEqual([
      [1, 90],
      [2, 630],
      [3, 182],
      [4, 144],
    ]);
    expect(textOf(state).endsWith("spike exchange complete.")).toBe(true);
    expect(state.text.at(-1)?.text).toBe(
      "turn-4-chunk-0 turn-4-chunk-1 turn-4-chunk-2 turn-4-chunk-3 turn-4-chunk-4 turn-4-chunk-5 turn-4-chunk-6 turn-4-chunk-7 spike exchange complete.",
    );
  });

  test("every tool call ended in a terminal status with its literal output", () => {
    expect(
      state.toolCards.map((card) => [card.toolCallId, card.status, card.output, card.durationMs]),
    ).toEqual([
      ["call_spike_1", "done", "echo: one", 201],
      ["call_spike_2", "done", "echo: two", 211],
      ["call_spike_3", "done", "echo: three", 211],
    ]);
  });

  test("the gate's verdict landed on the governed card", () => {
    const gated = state.toolCards.find((card) => card.toolCallId === GATED_CALL);
    expect(gated?.decision).toEqual({ allow: true, code: null, detail: null });
    expect(gated?.command).toBe(`spike_echo {"note":"two","delay_ms":200}`);
  });

  test("the approval carries the decision and the grant it minted", () => {
    expect(
      state.approvals.map((card) => [card.approvalId, card.decision, card.resolution]),
    ).toEqual([["ap-call_spike_2", "allow", `grant ${GATED_GRANT} issued`]]);
    expect(state.awaiting).toBe(null);
  });

  test("the grant lifecycle is on the record, issued then consumed by the call", () => {
    expect(state.grants.map((grant) => [grant.grantId, grant.state, grant.detail])).toEqual([
      [GATED_GRANT, "issued", "expires at 1792221610280"],
      [GATED_GRANT, "consumed", "consumed by call_spike_2"],
    ]);
  });

  test("the run finished by itself", () => {
    expect([state.done, state.failed, state.error]).toEqual([true, null, null]);
  });
});

describe("the deny fixture", () => {
  const state = reduce(loadFixture("deny"));

  test("the refused call never ran, so its card has no output", () => {
    const gated = state.toolCards.find((card) => card.toolCallId === GATED_CALL);
    expect([gated?.status, gated?.output, gated?.durationMs]).toEqual(["denied", null, null]);
  });

  test("the refusal is on the approval card and the gate code is on the record", () => {
    expect(state.approvals.map((card) => [card.decision, card.resolution])).toEqual([
      ["deny", "no grant issued"],
    ]);
    const gated = state.toolCards.find((card) => card.toolCallId === GATED_CALL);
    expect(gated?.decision).toEqual({
      allow: false,
      code: "no_grant",
      detail: "no grant: the approval card was denied",
    });
    expect(state.grants).toEqual([]);
  });
});

describe("ordering", () => {
  test("a seq already applied is counted and dropped, never rendered twice", () => {
    const messages = loadFixture("allow");
    const first = messages[0];
    if (first === undefined) throw new Error("empty fixture");
    let state = initialState();
    for (const message of messages) state = applyMessage(state, message);
    const replayed = applyMessage(state, first);
    expect([replayed.applied, replayed.duplicatesIgnored, replayed.lastSeq]).toEqual([90, 1, 90]);
  });

  test("a gap throws instead of rendering a transcript with a hole in it", () => {
    const [first, second, third] = loadFixture("allow");
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error("fixture too short");
    }
    let state = applyMessage(initialState(), first);
    expect(() => applyMessage(state, third)).toThrow("gap: expected seq 2, got 3");
    state = applyMessage(state, second);
    expect(state.lastSeq).toBe(2);
  });

  test("a stream gap marker is reported as a stream error", () => {
    const state = applyMessage(initialState(), {
      v: 1,
      type: "stream.gap",
      payload: { expected: 4, got: 6 },
    });
    expect(state.error).toBe("gap: expected seq 4, got 6");
  });
});
