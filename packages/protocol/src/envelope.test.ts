/**
 * Envelope behavior: every kind round-trips, the taxonomy is closed, the version tag pins v1, the
 * seq rules hold, and the unknown-key policy does exactly what docs/protocol.md claims.
 */

import { describe, expect, test } from "bun:test";
import {
  EVENT_TYPES,
  type EventPayloads,
  type EventType,
  type Message,
  parseMessage,
  STREAM_TYPES,
  type StreamPayloads,
  type StreamType,
  safeParseMessage,
  serializeMessage,
} from "./index.ts";

const TS = 1_792_221_550_000;
const RUN = "run-1";
const HASH = `v1:sha256:${"a".repeat(64)}`;

const runExamples: { [K in EventType]: EventPayloads[K] } = {
  "run.started": { prompt: "count the files in /workspace" },
  "run.finished": {},
  "run.failed": { reason: "pi exited 1" },
  "turn.started": { turn: 1 },
  "turn.ended": { turn: 1 },
  "message.text.delta": { text: "hello " },
  "tool_call.requested": {
    toolCallId: "call_1",
    toolName: "bash",
    command: 'bash {"command":"ls -la"}',
    destructive: true,
  },
  "tool_call.decision": {
    toolCallId: "call_1",
    allow: false,
    code: "no_grant",
    detail: `no grant for action ${HASH}`,
  },
  "tool_call.result": {
    toolCallId: "call_1",
    ok: false,
    denied: true,
    output: "denied: no grant",
    durationMs: null,
  },
  "approval.requested": {
    approvalId: "ap-1",
    toolCallId: "call_1",
    command: 'bash {"command":"ls -la"}',
    actionHash: HASH,
    expiresAt: TS + 60_000,
  },
  "approval.resolved": {
    approvalId: "ap-1",
    decision: "allow",
    grant: { grantId: "grant-1", actionHash: HASH, expiresAt: TS + 60_000, state: "issued" },
  },
  "grant.lifecycle": {
    state: "consumed",
    grantId: "grant-1",
    actionHash: HASH,
    consumedBy: "call_1",
    at: TS,
  },
};

const streamExamples: { [K in StreamType]: StreamPayloads[K] } = {
  "stream.hello": { firstSeq: null, lastSeq: 0 },
  "stream.resumed": { fromSeq: 30, toSeq: 84 },
  "stream.gap": { expected: 31, got: 33 },
};

// The kind-to-payload pairing is a runtime fact; parseMessage in the test body validates it, and
// it fails the test if an example ever pairs the wrong payload with a kind.
function runMessage(type: EventType): Message {
  return { v: 1, seq: 1, ts: TS, runId: RUN, type, payload: runExamples[type] } as Message;
}

function streamMessage(type: StreamType): Message {
  return { v: 1, type, payload: streamExamples[type] } as Message;
}

describe("round trip", () => {
  for (const type of EVENT_TYPES) {
    test(`${type} parses, serializes, and reparses equal`, () => {
      const message = runMessage(type);
      const parsed = parseMessage(message);
      expect(parsed).toEqual(message);
      expect(JSON.parse(serializeMessage(parsed))).toEqual(parsed);
      expect(Object.keys(parsed).sort()).toEqual(["payload", "runId", "seq", "ts", "type", "v"]);
    });
  }

  for (const type of STREAM_TYPES) {
    test(`${type} parses, serializes, and reparses equal`, () => {
      const message = streamMessage(type);
      const parsed = parseMessage(message);
      expect(parsed).toEqual(message);
      expect(JSON.parse(serializeMessage(parsed))).toEqual(parsed);
      expect(Object.keys(parsed).sort()).toEqual(["payload", "type", "v"]);
    });
  }
});

describe("taxonomy", () => {
  test("the run-scoped kinds are exactly the v1 taxonomy", () => {
    expect(EVENT_TYPES).toEqual([
      "run.started",
      "run.finished",
      "run.failed",
      "turn.started",
      "turn.ended",
      "message.text.delta",
      "tool_call.requested",
      "tool_call.decision",
      "tool_call.result",
      "approval.requested",
      "approval.resolved",
      "grant.lifecycle",
    ]);
  });

  test("stream markers are exactly the three resume markers", () => {
    expect(STREAM_TYPES).toEqual(["stream.hello", "stream.resumed", "stream.gap"]);
  });
});

describe("rejections", () => {
  test("an unknown kind names the accepted discriminator values", () => {
    const result = safeParseMessage({
      v: 1,
      seq: 1,
      ts: TS,
      runId: RUN,
      type: "tool_execution_start",
      payload: {},
    });
    expect(result.success).toBe(false);
    const message = result.success ? "" : result.error.issues[0]?.message;
    expect(message).toBe(
      "Invalid discriminator value. Expected 'run.started' | 'run.finished' | 'run.failed' | 'turn.started' | 'turn.ended' | 'message.text.delta' | 'tool_call.requested' | 'tool_call.decision' | 'tool_call.result' | 'approval.requested' | 'approval.resolved' | 'grant.lifecycle' | 'stream.hello' | 'stream.resumed' | 'stream.gap'",
    );
  });

  test("a missing seq is refused", () => {
    const result = safeParseMessage({
      v: 1,
      ts: TS,
      runId: RUN,
      type: "run.finished",
      payload: {},
    });
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.issues[0]?.message).toBe(
      "Invalid input: expected number, received undefined",
    );
  });

  test("seq 0 is refused; 0 is a cursor, never a message", () => {
    const result = safeParseMessage({ ...runMessage("run.finished"), seq: 0 });
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.issues[0]?.message).toBe(
      "Too small: expected number to be >0",
    );
  });

  test("a non-integer and a string seq are refused", () => {
    const float = safeParseMessage({ ...runMessage("run.finished"), seq: 1.5 });
    expect(float.success ? "" : float.error.issues[0]?.message).toBe(
      "Invalid input: expected int, received number",
    );
    const text = safeParseMessage({ ...runMessage("run.finished"), seq: "1" });
    expect(text.success ? "" : text.error.issues[0]?.message).toBe(
      "Invalid input: expected number, received string",
    );
  });

  test("version 2 is refused by the v1 tag", () => {
    const result = safeParseMessage({ ...runMessage("run.finished"), v: 2 });
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.issues[0]?.message).toBe("Invalid input: expected 1");
  });

  test("a run-scoped kind without a runId is refused", () => {
    const result = safeParseMessage({ v: 1, seq: 1, ts: TS, type: "run.finished", payload: {} });
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.issues[0]?.message).toBe(
      "Invalid input: expected string, received undefined",
    );
  });

  test("a missing payload is refused, an empty payload is legal", () => {
    const result = safeParseMessage({ v: 1, seq: 1, ts: TS, runId: RUN, type: "run.finished" });
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.issues[0]?.message).toBe(
      "Invalid input: expected object, received undefined",
    );
    expect(
      parseMessage({ v: 1, seq: 1, ts: TS, runId: RUN, type: "run.finished", payload: {} }),
    ).toEqual({
      v: 1,
      seq: 1,
      ts: TS,
      runId: RUN,
      type: "run.finished",
      payload: {},
    });
  });

  test("a denial without its reason code is refused", () => {
    const result = safeParseMessage({
      ...runMessage("tool_call.decision"),
      payload: { toolCallId: "call_1", allow: false },
    });
    expect(result.success).toBe(false);
    const issues = result.success ? [] : result.error.issues.map((issue) => issue.message);
    expect(issues).toContain("Invalid input: expected string, received undefined");
  });

  test("a denial whose detail is empty is refused", () => {
    const result = safeParseMessage({
      ...runMessage("tool_call.decision"),
      payload: { toolCallId: "call_1", allow: false, code: "no_grant", detail: "" },
    });
    expect(result.success).toBe(false);
    const issues = result.success ? [] : result.error.issues.map((issue) => issue.message);
    expect(issues).toContain("Too small: expected string to have >=1 characters");
  });

  test("a reason code outside the nine is refused", () => {
    const result = safeParseMessage({
      ...runMessage("tool_call.decision"),
      payload: { toolCallId: "call_1", allow: false, code: "vibes", detail: "no" },
    });
    expect(result.success).toBe(false);
    const issues = result.success ? [] : result.error.issues.map((issue) => issue.message);
    expect(issues).toContain(
      'Invalid option: expected one of "unknown_tool"|"no_grant"|"grant_mismatch"|"grant_expired"|"grant_consumed"|"grant_tombstoned"|"grant_forged"|"malformed_action"|"grant_store_error"',
    );
  });

  test("an action hash that is not v1:sha256:<64 hex> is refused", () => {
    const result = safeParseMessage({
      ...runMessage("approval.requested"),
      payload: { ...runExamples["approval.requested"], actionHash: "sha256:abc" },
    });
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.issues[0]?.message).toBe(
      "Invalid string: must match pattern /^v1:sha256:[0-9a-f]{64}$/",
    );
  });

  test("an approval decision that is neither allow nor deny is refused", () => {
    const result = safeParseMessage({
      ...runMessage("approval.resolved"),
      payload: { approvalId: "ap-1", decision: "maybe" },
    });
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.issues[0]?.message).toBe(
      "Invalid discriminator value. Expected 'allow' | 'deny'",
    );
  });

  test("a grant state outside the four lifecycle states is refused", () => {
    const result = safeParseMessage({
      ...runMessage("grant.lifecycle"),
      payload: { state: "revoked", grantId: "grant-1", actionHash: HASH, at: TS },
    });
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.issues[0]?.message).toBe(
      "Invalid discriminator value. Expected 'issued' | 'consumed' | 'expired' | 'rewound'",
    );
  });

  test("a consumed grant without its consumer is refused", () => {
    const result = safeParseMessage({
      ...runMessage("grant.lifecycle"),
      payload: { state: "consumed", grantId: "grant-1", actionHash: HASH, at: TS },
    });
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.issues[0]?.message).toBe(
      "Invalid input: expected string, received undefined",
    );
  });

  test("a negative resume point is refused", () => {
    const result = safeParseMessage({
      ...streamMessage("stream.resumed"),
      payload: { fromSeq: -1, toSeq: 84 },
    });
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.issues[0]?.message).toBe(
      "Too small: expected number to be >=0",
    );
  });
});

describe("unknown keys strip", () => {
  test("an extra envelope key is dropped, not refused", () => {
    const parsed = parseMessage({ ...runMessage("run.finished"), debug: "leftover" });
    expect(Object.keys(parsed).sort()).toEqual(["payload", "runId", "seq", "ts", "type", "v"]);
  });

  test("an extra payload key is dropped, and the required ones survive", () => {
    const parsed = parseMessage({
      ...runMessage("message.text.delta"),
      payload: { text: "hi", future_field: 7 },
    });
    expect(parsed.payload).toEqual({ text: "hi" });
  });

  test("a key smuggled past the discriminant is gone after parse", () => {
    const parsed = parseMessage({
      ...runMessage("turn.started"),
      payload: { turn: 1, extra: true },
    });
    expect(parsed.type).toBe("turn.started");
    expect(parsed.payload).toEqual({ turn: 1 });
  });

  test("a deny carrying a grant parses, and the grant is stripped away", () => {
    const parsed = parseMessage({
      ...runMessage("approval.resolved"),
      payload: {
        approvalId: "ap-1",
        decision: "deny",
        grant: { grantId: "grant-1", actionHash: HASH, expiresAt: TS + 60_000, state: "issued" },
      },
    });
    expect(parsed).toEqual({
      v: 1,
      seq: 1,
      ts: TS,
      runId: RUN,
      type: "approval.resolved",
      payload: { approvalId: "ap-1", decision: "deny" },
    });
  });

  test("a seq smuggled onto a stream marker is stripped", () => {
    const parsed = parseMessage({ ...streamMessage("stream.hello"), seq: 84 });
    expect(Object.keys(parsed).sort()).toEqual(["payload", "type", "v"]);
  });
});
