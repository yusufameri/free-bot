// The fixtures are committed evidence, so the tests assert their literal shape rather than
// re-deriving it: density, one run, the gate's messages in the order a gate emits them, and the
// v1 schema's own acceptance of every line.

import { describe, expect, test } from "bun:test";
import { parseMessage } from "../../../packages/protocol/src/index.ts";
import {
  buildFixtures,
  FIXTURE_FILES,
  type FixtureVariant,
  GATED_APPROVAL,
  GATED_CALL,
  GATED_GRANT,
  loadFixture,
} from "./fixture.ts";

const VARIANTS: FixtureVariant[] = ["allow", "deny"];

describe("the committed fixtures", () => {
  test("regenerating reproduces both files byte for byte", () => {
    const fresh = buildFixtures();
    expect(Object.keys(fresh)).toEqual(["allow", "deny"]);
    expect([fresh.allow.split("\n").length - 1, fresh.deny.split("\n").length - 1]).toEqual([
      90, 88,
    ]);
  });

  test("dense seq from 1, one run, a strictly increasing clock", () => {
    for (const variant of VARIANTS) {
      const messages = loadFixture(variant);
      expect([
        variant,
        messages.map((message) => message.seq),
        [...new Set(messages.map((message) => message.runId))],
        messages.every(
          (message, index) => index === 0 || message.ts > (messages[index - 1]?.ts ?? 0),
        ),
      ]).toEqual([
        variant,
        Array.from({ length: messages.length }, (_, index) => index + 1),
        ["run-smoke-a"],
        true,
      ]);
    }
  });

  test("every line is a v1 message with a seq, and the v1 schema is what says so", () => {
    for (const variant of VARIANTS) {
      for (const message of loadFixture(variant)) {
        const parsed = parseMessage(JSON.parse(JSON.stringify(message)) as unknown);
        expect([variant, parsed.v, "seq" in parsed]).toEqual([variant, 1, true]);
      }
    }
  });

  test("the session opens with the prompt and closes with the run boundary", () => {
    const messages = loadFixture("allow");
    expect(messages[0]).toEqual({
      v: 1,
      seq: 1,
      ts: 1792221550000,
      runId: "run-smoke-a",
      type: "run.started",
      payload: { prompt: "smoke: the recorded three-step task" },
    });
    expect(messages.at(-1)?.type).toBe("run.finished");
  });

  test("the allow fixture mints a grant, issues it, then consumes it on the gated call", () => {
    const messages = loadFixture("allow");
    expect(messages.find((message) => message.type === "approval.resolved")).toEqual({
      v: 1,
      seq: 56,
      ts: 1792221550275,
      runId: "run-smoke-a",
      type: "approval.resolved",
      payload: {
        approvalId: GATED_APPROVAL,
        decision: "allow",
        grant: {
          grantId: GATED_GRANT,
          actionHash: "v1:sha256:2adc5e1730b51d9ff4985d24d64898cdaa80a195cd948fbd3f474c9eed376fed",
          expiresAt: 1792221610275,
          state: "issued",
        },
      },
    });
    expect(
      messages
        .filter((message) => message.type === "grant.lifecycle")
        .map((message) => message.payload.state),
    ).toEqual(["issued", "consumed"]);
  });

  test("the deny fixture records a refusal with no grant and no tool output", () => {
    const messages = loadFixture("deny");
    expect(messages.find((message) => message.type === "approval.resolved")?.payload).toEqual({
      approvalId: GATED_APPROVAL,
      decision: "deny",
    });
    expect(messages.filter((message) => message.type === "grant.lifecycle")).toEqual([]);
    expect(messages.find((message) => message.type === "tool_call.result")?.payload).toEqual({
      toolCallId: "call_spike_1",
      ok: true,
      denied: false,
      output: "echo: one",
      durationMs: 201,
    });
    expect(
      messages.find(
        (message) =>
          message.type === "tool_call.result" && message.payload.toolCallId === GATED_CALL,
      )?.payload,
    ).toEqual({
      toolCallId: GATED_CALL,
      ok: false,
      denied: true,
      output: "denied: user denied approval",
      durationMs: null,
    });
  });

  test("the gate's verdict precedes the result it governs, once per call", () => {
    for (const variant of VARIANTS) {
      const messages = loadFixture(variant);
      const decisions = messages.filter((message) => message.type === "tool_call.decision");
      expect(decisions.map((message) => message.payload.toolCallId)).toEqual([
        "call_spike_1",
        GATED_CALL,
        "call_spike_3",
      ]);
      const verdict = messages.find(
        (message) =>
          message.type === "tool_call.decision" && message.payload.toolCallId === GATED_CALL,
      );
      const result = messages.find(
        (message) =>
          message.type === "tool_call.result" && message.payload.toolCallId === GATED_CALL,
      );
      expect([
        variant,
        verdict !== undefined && result !== undefined && verdict.seq < result.seq,
      ]).toEqual([variant, true]);
    }
  });

  test("the gate's messages are ordered consent, verdict, result, for both paths", () => {
    expect(
      loadFixture("allow")
        .filter((message) => message.seq >= 54 && message.seq <= 60)
        .map((message) => message.type),
    ).toEqual([
      "tool_call.requested",
      "approval.requested",
      "approval.resolved",
      "grant.lifecycle",
      "tool_call.decision",
      "tool_call.result",
      "grant.lifecycle",
    ]);
    expect(
      loadFixture("deny")
        .filter((message) => message.seq >= 54 && message.seq <= 58)
        .map((message) => message.type),
    ).toEqual([
      "tool_call.requested",
      "approval.requested",
      "approval.resolved",
      "tool_call.decision",
      "tool_call.result",
    ]);
  });

  test("the fixture paths name the files the replay server reads", () => {
    expect(Object.values(FIXTURE_FILES)).toEqual([
      "apps/web/fixtures/smoke-run-allow.jsonl",
      "apps/web/fixtures/smoke-run-deny.jsonl",
    ]);
  });
});
