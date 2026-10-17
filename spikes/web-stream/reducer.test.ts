import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DisplayFrame, StreamState } from "./envelope.ts";
import { displayFrames, parseTranscript } from "./map.ts";
import { applyFrame, initialState, markResumed } from "./reducer.ts";

const fixture = fileURLToPath(
  new URL("../../packages/verify/artifacts/tunnel/bf0a4e6/transcript.jsonl", import.meta.url),
);
const lines = parseTranscript(readFileSync(fixture, "utf8"), "a");

function mapped(): DisplayFrame[] {
  return [...displayFrames(lines, { destructiveToolCallId: "call_spike_2" })];
}

function applyAll(state: StreamState, frames: DisplayFrame[]): StreamState {
  let next = state;
  for (const frame of frames) next = applyFrame(next, frame);
  return next;
}

describe("mapping the recorded transcript", () => {
  test("maps scenario a into 84 seq-dense display frames", () => {
    const frames = mapped();
    expect(frames.length).toBe(84);
    expect(frames[0]).toEqual({ seq: 1, type: "turn_start", payload: { turn: 1 } });
    expect(frames[83]?.type).toBe("stream_end");
    expect(frames[83]?.seq).toBe(84);
  });

  test("gates the marked destructive call with approval frames", () => {
    const frames = mapped();
    expect(frames[7]).toEqual({
      seq: 8,
      type: "tool_call",
      payload: {
        toolCallId: "call_spike_1",
        toolName: "spike_echo",
        command: 'spike_echo {"note":"one","delay_ms":200}',
        destructive: false,
      },
    });
    expect(frames[51]).toEqual({
      seq: 52,
      type: "tool_call",
      payload: {
        toolCallId: "call_spike_2",
        toolName: "spike_echo",
        command: 'spike_echo {"note":"two","delay_ms":200}',
        destructive: true,
      },
    });
    expect(frames[52]).toEqual({
      seq: 53,
      type: "approval_request",
      payload: {
        approvalId: "ap-call_spike_2",
        toolCallId: "call_spike_2",
        command: 'spike_echo {"note":"two","delay_ms":200}',
      },
    });
    expect(frames[53]).toEqual({
      seq: 54,
      type: "approval_resolved",
      payload: { approvalId: "ap-call_spike_2", decision: null },
    });
    expect(frames[54]?.type).toBe("tool_result");
    const result = frames[54];
    if (result?.type !== "tool_result") throw new Error("expected tool_result at seq 55");
    expect(result.payload).toEqual({
      toolCallId: "call_spike_2",
      ok: true,
      denied: false,
      output: "echo: two",
      durationMs: 211,
    });
  });

  test("carries real tool output and duration for the ungated calls", () => {
    const frames = mapped();
    const first = frames[8];
    if (first?.type !== "tool_result") throw new Error("expected tool_result at seq 9");
    expect(first.payload).toEqual({
      toolCallId: "call_spike_1",
      ok: true,
      denied: false,
      output: "echo: one",
      durationMs: 201,
    });
    const third = frames[70];
    if (third?.type !== "tool_result") throw new Error("expected tool_result at seq 71");
    expect(third.payload).toEqual({
      toolCallId: "call_spike_3",
      ok: true,
      denied: false,
      output: "echo: three",
      durationMs: 211,
    });
  });
});

describe("the reducer", () => {
  test("holds still at the approval gate: seq 53, awaiting, card waiting", () => {
    const state = applyAll(initialState(), mapped().slice(0, 53));
    expect(state.lastSeq).toBe(53);
    expect(state.frameCount).toBe(53);
    expect(state.awaitingApproval).toBe(true);
    expect(state.toolCards.map((card) => card.status)).toEqual(["done", "awaiting approval"]);
    expect(state.error).toBeNull();
  });

  test("the allow path finishes the gated call with its output", () => {
    const frames = mapped();
    let state = applyAll(initialState(), frames.slice(0, 53));
    const resolved = frames[53];
    if (resolved?.type !== "approval_resolved") throw new Error("expected approval_resolved");
    state = applyFrame(state, {
      ...resolved,
      payload: { ...resolved.payload, decision: "allow" },
    });
    expect(state.awaitingApproval).toBe(false);
    expect(state.toolCards[1]?.status).toBe("running");
    const result = frames[54];
    if (result?.type !== "tool_result") throw new Error("expected tool_result");
    state = applyFrame(state, result);
    expect(state.toolCards[1]?.status).toBe("done");
    expect(state.toolCards[1]?.output).toBe("echo: two");
    expect(state.toolCards[1]?.durationMs).toBe(211);
  });

  test("the deny path marks the card denied with no output", () => {
    const frames = mapped();
    let state = applyAll(initialState(), frames.slice(0, 53));
    const resolved = frames[53];
    if (resolved?.type !== "approval_resolved") throw new Error("expected approval_resolved");
    state = applyFrame(state, {
      ...resolved,
      payload: { ...resolved.payload, decision: "deny" },
    });
    expect(state.toolCards[1]?.status).toBe("denied");
    const result = frames[54];
    if (result?.type !== "tool_result") throw new Error("expected tool_result");
    state = applyFrame(state, {
      ...result,
      payload: {
        toolCallId: "call_spike_2",
        ok: false,
        denied: true,
        output: "denied: user denied approval",
        durationMs: null,
      },
    });
    expect(state.toolCards[1]?.status).toBe("denied");
    expect(state.toolCards[1]?.output).toBeNull();
    expect(state.toolCards[0]?.output).toBe("echo: one");
  });

  test("a full replay ends done with the literal shape of the run", () => {
    const state = applyAll(initialState(), mapped());
    expect(state.lastSeq).toBe(84);
    expect(state.frameCount).toBe(84);
    expect(state.duplicatesIgnored).toBe(0);
    expect(state.turns).toEqual([1, 2, 3, 4]);
    expect(state.toolCards.map((card) => card.toolCallId)).toEqual([
      "call_spike_1",
      "call_spike_2",
      "call_spike_3",
    ]);
    expect(state.done).toBe(true);
    expect(state.error).toBeNull();
  });

  test("resending seen seqs changes nothing and counts as duplicates", () => {
    const frames = mapped();
    let state = applyAll(initialState(), frames);
    const before = { frameCount: state.frameCount, lastSeq: state.lastSeq };
    for (const frame of frames.slice(27, 30)) state = applyFrame(state, frame);
    expect(state.frameCount).toBe(before.frameCount);
    expect(state.lastSeq).toBe(before.lastSeq);
    expect(state.duplicatesIgnored).toBe(3);
  });

  test("a gap fails loudly with the expected literal message", () => {
    const frames = mapped();
    const state = applyAll(initialState(), frames.slice(0, 3));
    expect(() => applyFrame(state, { seq: 6, type: "stream_end", payload: {} })).toThrow(
      "gap: expected seq 4, got 6",
    );
  });

  test("a seq that passed unseen is an out-of-order error", () => {
    const state: StreamState = { ...initialState(), lastSeq: 5 };
    expect(() => applyFrame(state, { seq: 3, type: "stream_end", payload: {} })).toThrow(
      "out of order: seq 3 already passed but was never seen",
    );
  });

  test("markResumed records the resume point without touching the stream", () => {
    const state = markResumed(initialState(), 30);
    expect(state.resumedFrom).toBe(30);
    expect(state.lastSeq).toBe(0);
    expect(state.frameCount).toBe(0);
  });
});
