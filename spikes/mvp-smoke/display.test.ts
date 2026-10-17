// Behavior tests for the display stream: the live pi-frame mapping and the durable display log.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PiInboundFrame } from "@freebot/pi-bridge";
import { DisplayLog, initialMapperState, isDestructive, mapPiFrame } from "./display.ts";

function displayPath(): string {
  return join(mkdtempSync(join(tmpdir(), "freebot-mvp-display-")), "display.jsonl");
}

describe("isDestructive", () => {
  test("a bash command that names rm needs a human", () => {
    expect(isDestructive("bash", { command: "rm -f /scratch/task/doomed.txt" })).toBe(true);
    expect(isDestructive("bash", { command: "sleep 3 && echo two" })).toBe(false);
    expect(isDestructive("write", { path: "/tmp/x", content: "rm -rf /" })).toBe(false);
  });
});

describe("mapPiFrame", () => {
  test("turns count up and end with the current turn number", () => {
    const state = initialMapperState();
    expect(mapPiFrame({ type: "turn_start" } as PiInboundFrame, state)).toEqual({
      type: "turn_start",
      payload: { turn: 1 },
    });
    expect(mapPiFrame({ type: "turn_start" } as PiInboundFrame, state)).toEqual({
      type: "turn_start",
      payload: { turn: 2 },
    });
    expect(mapPiFrame({ type: "turn_end" } as PiInboundFrame, state)).toEqual({
      type: "turn_end",
      payload: { turn: 2 },
    });
  });

  test("only text deltas map; thinking and toolcall deltas drop", () => {
    const state = initialMapperState();
    const delta = (assistantMessageEvent: Record<string, unknown>) =>
      ({ type: "message_update", assistantMessageEvent }) as PiInboundFrame;
    expect(mapPiFrame(delta({ type: "text_delta", delta: "one " }), state)).toEqual({
      type: "message_delta",
      payload: { text: "one " },
    });
    expect(mapPiFrame(delta({ type: "thinking_delta", delta: "hmm" }), state)).toBeNull();
    expect(mapPiFrame(delta({ type: "toolcall_delta", delta: "{}" }), state)).toBeNull();
  });

  test("a tool call card carries the literal command and the destructive verdict", () => {
    const state = initialMapperState();
    expect(
      mapPiFrame(
        {
          type: "tool_execution_start",
          toolCallId: "call_step_2",
          toolName: "bash",
          args: { command: "rm -f /scratch/task/doomed.txt" },
        } as PiInboundFrame,
        state,
      ),
    ).toEqual({
      type: "tool_call",
      payload: {
        toolCallId: "call_step_2",
        toolName: "bash",
        command: 'bash {"command":"rm -f /scratch/task/doomed.txt"}',
        destructive: true,
      },
    });
  });

  test("a denied call's result carries no output", () => {
    const state = initialMapperState();
    state.denied.add("call_step_4");
    expect(
      mapPiFrame(
        {
          type: "tool_execution_end",
          toolCallId: "call_step_4",
          toolName: "bash",
          result: { content: [{ type: "text", text: "denied by freebot gate: ..." }] },
          isError: true,
        } as PiInboundFrame,
        state,
      ),
    ).toEqual({
      type: "tool_result",
      payload: {
        toolCallId: "call_step_4",
        ok: false,
        denied: true,
        output: "",
        durationMs: null,
      },
    });
  });
});

describe("DisplayLog", () => {
  test("emits dense seqs, reloads verbatim, and audits clean", () => {
    const path = displayPath();
    const log = new DisplayLog(path);
    log.emit({ type: "turn_start", payload: { turn: 1 } });
    log.emit({ type: "message_delta", payload: { text: "one " } });
    log.emit({ type: "stream_end", payload: {} });
    expect(log.lastSeq).toBe(3);

    const reloaded = new DisplayLog(path);
    expect(reloaded.count).toBe(3);
    expect(reloaded.since(1).map((frame) => frame.seq)).toEqual([2, 3]);
    expect(reloaded.audit().gaps).toEqual([]);
    expect(reloaded.audit().duplicates).toEqual([]);
    expect(readFileSync(path, "utf8").trim().length > 0).toBe(true);

    reloaded.emit({ type: "turn_start", payload: { turn: 2 } });
    expect(reloaded.since(3)).toEqual([{ seq: 4, type: "turn_start", payload: { turn: 2 } }]);
  });
});
