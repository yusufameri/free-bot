import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import toolGate from "../extension/tool-gate.ts";
import type { ExtensionUiRequestFrame, PiInboundFrame, ToolExecutionEndEvent } from "./frames.ts";
import { fixtureInboundFrames, parseFixture } from "./frames.ts";
import {
  allowTools,
  decideToolCall,
  decodeToolGateDecision,
  defaultDenyGate,
  encodeToolGateRequest,
  GATE_DIALOG_TIMEOUT_MS,
  TOOL_GATE_TITLE,
  type ToolCallContext,
  type ToolGate,
} from "./gate.ts";
import { PiSession, type PiSessionOptions } from "./session.ts";
import { createReplayTransport } from "./transport.ts";

const call: ToolCallContext = { toolCallId: "call_1", toolName: "echo", args: { text: "hi" } };

const gateDialog = (
  id: string,
  context: ToolCallContext,
  timeout?: number,
): ExtensionUiRequestFrame => ({
  type: "extension_ui_request",
  id,
  method: "input",
  title: TOOL_GATE_TITLE,
  placeholder: encodeToolGateRequest(context),
  ...(timeout === undefined ? {} : { timeout }),
});

const flush = () => Bun.sleep(30);

async function runDialog(frames: PiInboundFrame[], options: PiSessionOptions = {}) {
  const transport = createReplayTransport(frames);
  const session = new PiSession(transport, options);
  transport.drain();
  await flush();
  return { session, transport };
}

const answered = (transport: { sent: string[] }) =>
  transport.sent.map((line) => JSON.parse(line) as Record<string, unknown>);

describe("tool gate decisions", () => {
  test("allowTools allows what it names and denies everything else", async () => {
    const gate = allowTools(["echo"]);
    expect(await decideToolCall(gate, call)).toEqual({ allow: true });
    expect(await decideToolCall(gate, { ...call, toolName: "bash" })).toEqual({
      allow: false,
      reason: "default deny: no rule for tool bash",
    });
  });

  test("the default gate denies every call", async () => {
    expect(await decideToolCall(defaultDenyGate, call)).toEqual({
      allow: false,
      reason: "default deny: no rule for tool echo",
    });
  });

  test("a throwing handler yields a denial carrying the thrown text", async () => {
    const gate: ToolGate = () => {
      throw new Error("boom");
    };
    expect(await decideToolCall(gate, call)).toEqual({
      allow: false,
      reason: "gate handler threw: boom",
    });
  });

  test("the extension decodes anything but a decision as a denial", () => {
    expect(decodeToolGateDecision(undefined)).toEqual({
      allow: false,
      reason: "no gate decision: dialog cancelled or timed out",
    });
    expect(decodeToolGateDecision("not json")).toEqual({
      allow: false,
      reason: "malformed gate decision: not json",
    });
    expect(decodeToolGateDecision('{"allow":false}')).toEqual({
      allow: false,
      reason: "denied without a reason",
    });
    expect(decodeToolGateDecision('{"allow":true}')).toEqual({ allow: true });
  });
});

describe("dialogs over the RPC extension UI sub-protocol", () => {
  test("an allowed call answers the dialog with the encoded allow", async () => {
    const { session, transport } = await runDialog([gateDialog("gate-1", call, 1000)], {
      gate: allowTools(["echo"]),
    });
    expect(answered(transport)).toEqual([
      { type: "extension_ui_response", id: "gate-1", value: '{"allow":true}' },
    ]);
    expect(session.toolGates).toEqual([{ dialogId: "gate-1", toolName: "echo", outcome: "allow" }]);
  });

  test("a denied call answers with the reason, and the extension maps it to a block", async () => {
    const gate: ToolGate = () => ({ allow: false, reason: "policy says no" });
    const { session, transport } = await runDialog([gateDialog("gate-2", call, 1000)], { gate });
    expect(answered(transport)).toEqual([
      {
        type: "extension_ui_response",
        id: "gate-2",
        value: '{"allow":false,"reason":"policy says no"}',
      },
    ]);
    expect(decodeToolGateDecision('{"allow":false,"reason":"policy says no"}')).toEqual({
      allow: false,
      reason: "policy says no",
    });
    expect(session.toolGates).toEqual([
      { dialogId: "gate-2", toolName: "echo", outcome: "deny", reason: "policy says no" },
    ]);
  });

  test("a dialog without a timeout is denied on arrival, never left to block Pi", async () => {
    const { session, transport } = await runDialog([gateDialog("gate-3", call)], {
      gate: allowTools(["echo"]),
    });
    expect(answered(transport)).toEqual([
      { type: "extension_ui_response", id: "gate-3", cancelled: true },
    ]);
    expect(session.toolGates).toEqual([
      {
        dialogId: "gate-3",
        toolName: "echo",
        outcome: "deny",
        reason: "dialog carried no timeout",
      },
    ]);
  });

  test("a malformed dialog payload is denied on arrival", async () => {
    const malformed: ExtensionUiRequestFrame = {
      type: "extension_ui_request",
      id: "gate-4",
      method: "input",
      title: TOOL_GATE_TITLE,
      placeholder: "not json",
      timeout: 1000,
    };
    const { session, transport } = await runDialog([malformed], { gate: allowTools(["echo"]) });
    expect(answered(transport)).toEqual([
      { type: "extension_ui_response", id: "gate-4", cancelled: true },
    ]);
    expect(session.toolGates).toEqual([
      {
        dialogId: "gate-4",
        toolName: null,
        outcome: "deny",
        reason: "malformed tool gate request",
      },
    ]);
  });

  test("a gate that never answers is denied at the dialog's own deadline", async () => {
    const gate: ToolGate = () => new Promise(() => {});
    const { session, transport } = await runDialog([gateDialog("gate-5", call, 20)], { gate });
    expect(answered(transport)).toEqual([
      { type: "extension_ui_response", id: "gate-5", cancelled: true },
    ]);
    expect(session.toolGates).toEqual([
      { dialogId: "gate-5", toolName: "echo", outcome: "deny", reason: "dialog timeout" },
    ]);
  });

  test("a late allow is dropped and never reaches Pi", async () => {
    const gate: ToolGate = () =>
      new Promise((resolve) => {
        setTimeout(() => resolve({ allow: true }), 60);
      });
    const { session, transport } = await runDialog([gateDialog("gate-6", call, 20)], { gate });
    await Bun.sleep(120);
    expect(answered(transport)).toEqual([
      { type: "extension_ui_response", id: "gate-6", cancelled: true },
    ]);
    expect(session.toolGates).toEqual([
      { dialogId: "gate-6", toolName: "echo", outcome: "deny", reason: "dialog timeout" },
      {
        dialogId: "gate-6",
        toolName: "echo",
        outcome: "deny",
        reason: "late answer dropped: allow",
      },
    ]);
  });
});

describe("the gate extension's tool_call handler", () => {
  type ToolCallEvent = {
    type: "tool_call";
    toolCallId: string;
    toolName: string;
    input: unknown;
    parentToolCallId?: string;
  };
  type Handler = (event: ToolCallEvent, ctx: unknown) => Promise<unknown>;

  function loadHandler(): Handler {
    const handlers: Handler[] = [];
    const fakePi = {
      on(event: string, handler: Handler) {
        if (event === "tool_call") handlers.push(handler);
        return () => {};
      },
    };
    toolGate(fakePi as unknown as ExtensionAPI);
    const handler = handlers[0];
    if (handler === undefined) throw new Error("extension registered no tool_call handler");
    return handler;
  }

  function ctxReturning(answer: string | undefined) {
    const asked: Array<{
      title: string;
      placeholder: string | undefined;
      timeout: number | undefined;
    }> = [];
    const ctx = {
      ui: {
        input: (title: string, placeholder?: string, opts?: { timeout?: number }) => {
          asked.push({ title, placeholder, timeout: opts?.timeout });
          return Promise.resolve(answer);
        },
      },
    };
    return { asked, ctx };
  }

  const event: ToolCallEvent = {
    type: "tool_call",
    toolCallId: "call_7",
    toolName: "echo",
    input: { text: "hi" },
    parentToolCallId: "call_6",
  };

  test("it asks over an input dialog that always carries a timeout, and allows on an allow", async () => {
    const { asked, ctx } = ctxReturning('{"allow":true}');
    const result = await loadHandler()(event, ctx);
    expect(result).toBeUndefined();
    expect(asked).toEqual([
      {
        title: TOOL_GATE_TITLE,
        placeholder:
          '{"toolCallId":"call_7","toolName":"echo","args":{"text":"hi"},"parentToolCallId":"call_6"}',
        timeout: GATE_DIALOG_TIMEOUT_MS,
      },
    ]);
  });

  test("it blocks with the bridge's reason on a denial", async () => {
    const { ctx } = ctxReturning('{"allow":false,"reason":"policy says no"}');
    expect(await loadHandler()(event, ctx)).toEqual({
      block: true,
      reason: "denied by freebot gate: policy says no",
    });
  });

  test("it blocks when the dialog dies unanswered", async () => {
    const { ctx } = ctxReturning(undefined);
    expect(await loadHandler()(event, ctx)).toEqual({
      block: true,
      reason: "denied by freebot gate: no gate decision: dialog cancelled or timed out",
    });
  });
});

describe("fail-closed", () => {
  test("with the gate throwing, the call is denied and the recorded block path is an error result with no execution", async () => {
    // Half (a), this bridge's behavior: a throwing handler produces a denial on the wire.
    const gate: ToolGate = () => {
      throw new Error("boom");
    };
    const { transport } = await runDialog([gateDialog("gate-9", call, 1000)], { gate });
    expect(answered(transport)[0]?.value).toBe(
      '{"allow":false,"reason":"gate handler threw: boom"}',
    );

    // Half (b), Pi's recorded behavior (U0.2 transcript): a denied call comes back as a
    // tool_execution_end with isError true and no durationMs, and the tool's execute() never ran
    // (its output string appears nowhere in the transcript). The live version of this path is the
    // keyed smoke script, which parks without gate G1's key.
    const fixture = new URL("../fixtures/rpc-handshake.jsonl", import.meta.url);
    const text = await Bun.file(fixture).text();
    const frames = fixtureInboundFrames(parseFixture(text));
    const blocked = frames.filter(
      (frame): frame is ToolExecutionEndEvent =>
        frame.type === "tool_execution_end" && frame.toolName === "gated_blocked",
    );
    expect(blocked.length).toBe(1);
    expect(blocked[0]?.isError).toBe(true);
    expect(blocked[0]?.durationMs).toBeUndefined();
    expect(blocked[0]?.result.content[0]?.text).toBe("blocked by gate-spike: always deny");
    expect(text).not.toContain("gated_blocked executed");
  });
});
