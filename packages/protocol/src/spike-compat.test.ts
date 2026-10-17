/**
 * Compatibility: the literal U0.10 spike traffic validates under v1.
 *
 * The fixture (`fixtures/spike-display-frames-a.jsonl`) is the spike's own display traffic for
 * the committed U0.7 transcript, byte-for-byte what `bun spikes/web-stream/run.ts` streamed to the
 * page during the 59/59 CDP run. This test maps every frame through the documented adapter
 * (`scripts/spike-map.ts`) and proves each mapped message parses and round-trips under v1, with
 * the spike's own field values preserved.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DisplayFrame } from "../../../spikes/web-stream/envelope.ts";
import { mapSpikeSession, spikeActionHash } from "../scripts/spike-map.ts";
import { actionHashSchema, type EventMessage, parseMessage, serializeMessage } from "./index.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const FIXTURE = join(root, "packages/protocol/fixtures/spike-display-frames-a.jsonl");

/** The clock the mapping stamps; the spike's frames carry no time of their own. */
const START_TS = 1_792_221_550_000;
const STEP_MS = 5;
const GATED_CALL = "call_spike_2";

function readFrames(): DisplayFrame[] {
  return readFileSync(FIXTURE, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as DisplayFrame);
}

/** The hash the gate would mint for the spike's gated call, from the recorded command. */
function gatedActionHash(frames: readonly DisplayFrame[]): string {
  const call = frames.find(
    (frame) => frame.type === "tool_call" && frame.payload.toolCallId === GATED_CALL,
  );
  if (call === undefined || call.type !== "tool_call") {
    throw new Error(`fixture has no tool_call for ${GATED_CALL}`);
  }
  return spikeActionHash(call.payload.command, call.payload.toolName);
}

function mapWith(answer?: "allow" | "deny") {
  const frames = readFrames();
  return mapSpikeSession(frames, {
    runId: "run-spike-a",
    prompt: "spike: the recorded three-step task",
    startTs: START_TS,
    stepMs: STEP_MS,
    answerWindowMs: 60_000,
    grantWindowMs: 60_000,
    actionHash: gatedActionHash(frames),
    ...(answer === undefined ? {} : { answer }),
  });
}

const byType = (messages: readonly EventMessage[], type: EventMessage["type"]): EventMessage[] =>
  messages.filter((message) => message.type === type);

describe("the fixture is the recorded spike traffic", () => {
  test("84 frames, dense seq, four turns, one gated call", () => {
    const frames = readFrames();
    expect(frames.length).toBe(84);
    expect(frames.map((frame) => frame.seq)).toEqual(
      Array.from({ length: 84 }, (_, index) => index + 1),
    );
    expect(frames.filter((frame) => frame.type === "turn_start").length).toBe(4);
    expect(frames.filter((frame) => frame.type === "tool_call").length).toBe(3);
    expect(frames.filter((frame) => frame.type === "approval_request").length).toBe(1);
    expect(
      frames.filter(
        (frame) =>
          frame.type === "tool_call" &&
          frame.payload.destructive &&
          frame.payload.toolCallId === GATED_CALL,
      ).length,
    ).toBe(1);
  });
});

describe("every spike frame maps into v1", () => {
  const mapping = mapWith("allow");

  test("the run boundary is synthesized once, and the answered placeholder resolves", () => {
    expect(mapping.pendingCount).toBe(0);
    expect(byType(mapping.messages, "approval.resolved").length).toBe(1);
    expect(byType(mapping.messages, "run.started").length).toBe(1);
    expect(byType(mapping.messages, "run.finished").length).toBe(1);
    expect(mapping.messages[0]?.type).toBe("run.started");
    expect(mapping.messages.at(-1)?.type).toBe("run.finished");
  });

  test("the kind counts match the recorded frames", () => {
    expect(byType(mapping.messages, "turn.started").length).toBe(4);
    expect(byType(mapping.messages, "turn.ended").length).toBe(4);
    expect(byType(mapping.messages, "message.text.delta").length).toBe(67);
    expect(byType(mapping.messages, "tool_call.requested").length).toBe(3);
    expect(byType(mapping.messages, "tool_call.result").length).toBe(3);
    expect(byType(mapping.messages, "approval.requested").length).toBe(1);
    expect(byType(mapping.messages, "approval.resolved").length).toBe(1);
    expect(mapping.messages.length).toBe(85);
  });

  test("the mapped seqs are dense from 1", () => {
    expect(mapping.messages.map((message) => message.seq)).toEqual(
      Array.from({ length: mapping.messages.length }, (_, index) => index + 1),
    );
  });

  test("every mapped message parses and round-trips under v1", () => {
    for (const message of mapping.messages) {
      expect(parseMessage(message)).toEqual(message);
      expect(parseMessage(JSON.parse(serializeMessage(message)))).toEqual(message);
    }
  });

  test("the spike's own field values survive byte for byte", () => {
    const frames = readFrames();
    const deltas = frames.filter((frame) => frame.type === "message_delta");
    const mappedDeltas = byType(mapping.messages, "message.text.delta");
    expect(mappedDeltas.length).toBe(deltas.length);
    const text = (frame: DisplayFrame): string =>
      frame.type === "message_delta" ? frame.payload.text : "";
    expect(
      mappedDeltas.map((message) =>
        message.type === "message.text.delta" ? message.payload.text : "",
      ),
    ).toEqual(deltas.map(text));

    const call = frames.find(
      (frame) => frame.type === "tool_call" && frame.payload.toolCallId === GATED_CALL,
    );
    const mappedCall = byType(mapping.messages, "tool_call.requested").find(
      (message) =>
        message.type === "tool_call.requested" && message.payload.toolCallId === GATED_CALL,
    );
    expect(mappedCall).toEqual({
      v: 1,
      seq: 53,
      ts: START_TS + 52 * STEP_MS,
      runId: "run-spike-a",
      type: "tool_call.requested",
      payload: {
        toolCallId: GATED_CALL,
        toolName: "spike_echo",
        command: call?.type === "tool_call" ? call.payload.command : "",
        destructive: true,
      },
    });

    const results = frames.filter((frame) => frame.type === "tool_result");
    const mappedResults = byType(mapping.messages, "tool_call.result");
    expect(mappedResults.length).toBe(results.length);
    for (const [index, frame] of results.entries()) {
      const mapped = mappedResults[index];
      if (
        frame.type !== "tool_result" ||
        mapped === undefined ||
        mapped.type !== "tool_call.result"
      ) {
        throw new Error("fixture and mapping disagree on tool results");
      }
      expect(mapped.payload).toEqual({
        toolCallId: frame.payload.toolCallId,
        ok: frame.payload.ok,
        denied: frame.payload.denied,
        output: frame.payload.output,
        durationMs: frame.payload.durationMs,
      });
    }
  });
});

describe("the approval the spike proved, both paths", () => {
  test("the recorded request becomes an approval.requested with the real action hash", () => {
    const frames = readFrames();
    const request = byType(mapWith("allow").messages, "approval.requested")[0];
    if (request === undefined || request.type !== "approval.requested") {
      throw new Error("no approval.requested in the mapping");
    }
    const hash = gatedActionHash(frames);
    expect(hash).toBe("v1:sha256:2adc5e1730b51d9ff4985d24d64898cdaa80a195cd948fbd3f474c9eed376fed");
    expect(actionHashSchema.safeParse(hash).success).toBe(true);
    expect(request.payload.actionHash).toBe(hash);
    expect(request.payload.approvalId).toBe(`ap-${GATED_CALL}`);
    expect(request.payload.command).toContain("spike_echo");
  });

  test("allow resolves the placeholder with an issued grant, deny resolves it with none", () => {
    const allow = byType(mapWith("allow").messages, "approval.resolved")[0];
    const deny = byType(mapWith("deny").messages, "approval.resolved")[0];
    expect(allow).toEqual({
      v: 1,
      seq: 55,
      ts: START_TS + 54 * STEP_MS,
      runId: "run-spike-a",
      type: "approval.resolved",
      payload: {
        approvalId: `ap-${GATED_CALL}`,
        decision: "allow",
        grant: {
          grantId: `grant-ap-${GATED_CALL}`,
          actionHash: gatedActionHash(readFrames()),
          expiresAt: START_TS + 54 * STEP_MS + 60_000,
          state: "issued",
        },
      },
    });
    expect(deny).toEqual({
      v: 1,
      seq: 55,
      ts: START_TS + 54 * STEP_MS,
      runId: "run-spike-a",
      type: "approval.resolved",
      payload: { approvalId: `ap-${GATED_CALL}`, decision: "deny" },
    });
  });

  test("an unanswered placeholder maps to the pending state alone", () => {
    const mapping = mapWith();
    expect(mapping.pendingCount).toBe(1);
    expect(byType(mapping.messages, "approval.resolved").length).toBe(0);
    expect(byType(mapping.messages, "approval.requested").length).toBe(1);
  });
});
